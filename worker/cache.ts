// KV cache for derived classifications (§6), replacing the SQLite cache.
//
// Stores only our derived data (normalized name -> location count), never
// Google display content. TTL is enforced by KV's expirationTtl.
import { CACHE_TTL_SECONDS } from "./config";

const PREFIX = "count:";

export class ClassificationCache {
  constructor(private readonly kv: KVNamespace) {}

  async getCount(normalizedName: string): Promise<number | null> {
    const raw = await this.kv.get(PREFIX + normalizedName);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  async setCount(normalizedName: string, count: number): Promise<void> {
    await this.kv.put(PREFIX + normalizedName, String(count), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  }
}
