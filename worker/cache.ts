import { CACHE_TTL_SECONDS } from "./config";

export class ClassificationCache {
  constructor(private readonly db: D1Database) {}

  async getCount(normalizedName: string, geoBucket: string): Promise<number | null> {
    const cutoff = Math.floor(Date.now() / 1000) - CACHE_TTL_SECONDS;
    const row = await this.db
      .prepare(
        `SELECT location_count AS locationCount
         FROM location_counts_v2
         WHERE normalized_name = ? AND geo_bucket = ? AND created_at >= ?`
      )
      .bind(normalizedName, geoBucket, cutoff)
      .first<{ locationCount: number }>();
    return row?.locationCount ?? null;
  }

  async setCount(normalizedName: string, geoBucket: string, count: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO location_counts_v2
           (normalized_name, geo_bucket, location_count, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(normalized_name, geo_bucket) DO UPDATE SET
           location_count = excluded.location_count,
           created_at = excluded.created_at`
      )
      .bind(normalizedName, geoBucket, count, Math.floor(Date.now() / 1000))
      .run();
  }
}
