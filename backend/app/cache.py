"""SQLite cache for derived classifications (§6).

Stores only our derived data (normalized name -> location count), never
Google display content.
"""
import sqlite3
import threading
import time

from . import config


class ClassificationCache:
    def __init__(self, path: str):
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS location_counts_v2 (
                normalized_name TEXT NOT NULL,
                geo_bucket TEXT NOT NULL,
                location_count INTEGER NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (normalized_name, geo_bucket)
            )"""
        )
        self.conn.commit()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def get_count(self, normalized_name: str, geo_bucket: str) -> int | None:
        with self._lock:
            row = self.conn.execute(
                """SELECT location_count, created_at FROM location_counts_v2
                   WHERE normalized_name = ? AND geo_bucket = ?""",
                (normalized_name, geo_bucket),
            ).fetchone()
        if row is None:
            return None
        count, created_at = row
        if time.time() - created_at > config.CACHE_TTL_SECONDS:
            return None
        return count

    def set_count(self, normalized_name: str, geo_bucket: str, count: int) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO location_counts_v2 VALUES (?, ?, ?, ?)",
                (normalized_name, geo_bucket, count, time.time()),
            )
            self.conn.commit()
