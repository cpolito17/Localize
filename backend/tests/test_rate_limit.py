import sqlite3

import pytest

from app.rate_limit import LimitRule, UsageLimiter, UsageLimitExceeded


def test_limit_is_atomic_and_resets(tmp_path):
    current = [120.0]
    limiter = UsageLimiter(str(tmp_path / "limits.db"), "test-secret", lambda: current[0])
    rules = [
        LimitRule("search:user", "visitor", 2, 60),
        LimitRule("search:global", "global", 10, 86400),
    ]

    limiter.consume(rules, "slow down")
    limiter.consume(rules, "slow down")
    with pytest.raises(UsageLimitExceeded) as exc:
        limiter.consume(rules, "slow down")
    assert exc.value.retry_after == 60

    # A rejected request must not increment the other rule.
    row = limiter._conn.execute(
        "SELECT count FROM usage_limits WHERE scope='search:global'"
    ).fetchone()
    assert row == (2,)

    current[0] = 181.0
    limiter.consume(rules, "slow down")
    limiter.close()


def test_subjects_are_keyed_hashes(tmp_path):
    limiter = UsageLimiter(str(tmp_path / "limits.db"), "secret-a")
    first = limiter.subject("ip", "203.0.113.8")
    second = limiter.subject("ip", "203.0.113.8")
    other_key = UsageLimiter(str(tmp_path / "other.db"), "secret-b")
    assert first == second
    assert first != other_key.subject("ip", "203.0.113.8")
    assert "203.0.113.8" not in first
    limiter.close()
    other_key.close()


def test_database_does_not_store_raw_subject(tmp_path):
    path = tmp_path / "limits.db"
    limiter = UsageLimiter(str(path), "secret")
    subject = limiter.subject("visitor", "raw-browser-id")
    limiter.consume([LimitRule("test", subject, 2, 60)], "limited")
    limiter.close()

    conn = sqlite3.connect(path)
    stored = conn.execute("SELECT subject FROM usage_limits").fetchone()[0]
    assert stored == subject
    assert stored != "raw-browser-id"
