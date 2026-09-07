"""Persistent, anonymous usage limits for the public demo.

The browser receives a random HttpOnly identifier. Limits are applied to both
that identifier and the connecting IP so clearing a cookie does not reset the
budget. Only keyed hashes are stored; raw IP addresses are never written to
disk. SQLite keeps counters intact across container restarts without adding a
paid service.
"""

from __future__ import annotations

import hashlib
import hmac
import sqlite3
import threading
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class LimitRule:
    scope: str
    subject: str
    limit: int
    window_seconds: int


class UsageLimitExceeded(Exception):
    def __init__(self, retry_after: int, message: str):
        super().__init__(message)
        self.retry_after = max(1, retry_after)
        self.message = message


class UsageLimiter:
    def __init__(self, path: str, secret: str, now=time.time):
        self._secret = (secret or "localize-development-only").encode("utf-8")
        self._now = now
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False, timeout=10)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS usage_limits (
                scope TEXT NOT NULL,
                subject TEXT NOT NULL,
                window_seconds INTEGER NOT NULL,
                window_id INTEGER NOT NULL,
                count INTEGER NOT NULL,
                PRIMARY KEY (scope, subject, window_seconds, window_id)
            )"""
        )
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def subject(self, kind: str, value: str) -> str:
        digest = hmac.new(
            self._secret,
            f"{kind}:{value}".encode("utf-8", "replace"),
            hashlib.sha256,
        ).hexdigest()
        return digest[:32]

    def consume(self, rules: list[LimitRule], message: str) -> None:
        """Atomically consume every rule or none of them."""
        if not rules:
            return
        now = int(self._now())
        rows: list[tuple[LimitRule, int, int]] = []
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                for rule in rules:
                    window_id = now // rule.window_seconds
                    row = self._conn.execute(
                        """SELECT count FROM usage_limits
                           WHERE scope = ? AND subject = ?
                             AND window_seconds = ? AND window_id = ?""",
                        (rule.scope, rule.subject, rule.window_seconds, window_id),
                    ).fetchone()
                    count = int(row[0]) if row else 0
                    if count >= rule.limit:
                        self._conn.rollback()
                        retry_after = ((window_id + 1) * rule.window_seconds) - now
                        raise UsageLimitExceeded(retry_after, message)
                    rows.append((rule, window_id, count))

                for rule, window_id, count in rows:
                    self._conn.execute(
                        """INSERT INTO usage_limits
                           (scope, subject, window_seconds, window_id, count)
                           VALUES (?, ?, ?, ?, ?)
                           ON CONFLICT(scope, subject, window_seconds, window_id)
                           DO UPDATE SET count = excluded.count""",
                        (
                            rule.scope,
                            rule.subject,
                            rule.window_seconds,
                            window_id,
                            count + 1,
                        ),
                    )
                # Keep only current and immediately previous windows.
                self._conn.execute(
                    "DELETE FROM usage_limits WHERE window_id < (? / window_seconds) - 1",
                    (now,),
                )
                self._conn.commit()
            except UsageLimitExceeded:
                raise
            except Exception:
                self._conn.rollback()
                raise
