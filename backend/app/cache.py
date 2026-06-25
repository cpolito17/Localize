"""SQLite cache for derived classifications (§6).

Stores only our derived data (normalized name -> location count), never
Google display content.
"""
import sqlite3
import time

from . import config


class ClassificationCache:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS location_counts (
                normalized_name TEXT PRIMARY KEY,
                location_count INTEGER NOT NULL,
                created_at REAL NOT NULL
            )"""
        )
        self.conn.commit()

    def get_count(self, normalized_name: str) -> int | None:
        row = self.conn.execute(
            "SELECT location_count, created_at FROM location_counts WHERE normalized_name = ?",
            (normalized_name,),
        ).fetchone()
        if row is None:
            return None
        count, created_at = row
        if time.time() - created_at > config.CACHE_TTL_SECONDS:
            return None
        return count

    def set_count(self, normalized_name: str, count: int) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO location_counts VALUES (?, ?, ?)",
            (normalized_name, count, time.time()),
        )
        self.conn.commit()
