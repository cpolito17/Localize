// The Localize score (§6): denylist hard cap, location-count heuristic, minor
// modifiers. Deterministic throughout. Port of backend/app/scoring.py.
import { ClassificationCache } from "./cache";
import { COUNT_AREA_HALF_LAT, COUNT_AREA_HALF_LNG, COUNT_MAX_RESULTS } from "./config";
import { Brand, Denylist, normalizeName } from "./denylist";
import { PlacesClient } from "./places";
import type { Classification } from "./types";

const ECOMMERCE_SCORE = 5;
const BIGBOX_SCORE = 25;

// Place types that indicate big-format retail (minor downward modifier).
const BIG_FORMAT_TYPES = new Set(["department_store", "supermarket", "shopping_mall", "warehouse_store"]);
const BIG_FORMAT_PENALTY = 4;

// A single location carrying this many reviews is almost always a
// high-traffic chain outlet (minor downward modifier).
const MEGA_REVIEW_THRESHOLD = 4000;
const MEGA_REVIEW_PENALTY = 5;

// location count -> base score (the §6 bands)
function countToScore(count: number): number {
  if (count <= 1) return 95;
  if (count <= 4) return 82;
  if (count <= 8) return 72;
  if (count <= 20) return 55;
  if (count <= 40) return 45;
  return 30;
}

export function tierForScore(score: number): string {
  if (score >= 90) return "Independent local business";
  if (score >= 70) return "Small local chain";
  if (score >= 40) return "Regional chain";
  if (score >= 15) return "National chain / big-box";
  return "E-commerce giant";
}

export class Scorer {
  private countInFlight = new Map<string, Promise<number>>();

  constructor(
    private readonly denylist: Denylist,
    private readonly cache: ClassificationCache,
    private readonly places: PlacesClient
  ) {}

  classifyDenylisted(brand: Brand): Classification {
    if (brand.kind === "ecommerce") {
      return {
        score: ECOMMERCE_SCORE,
        tier: tierForScore(ECOMMERCE_SCORE),
        reason: `${brand.brand} is a national e-commerce giant — purchases here don't stay local.`,
        breakdown: [
          `On the national-retailer list (${brand.brand})`,
          "E-commerce giant — revenue leaves the local economy",
        ],
        locationCount: null,
        denylistedBrand: brand.brand,
      };
    }
    return {
      score: BIGBOX_SCORE,
      tier: tierForScore(BIGBOX_SCORE),
      reason: `${brand.brand} is a national big-box chain.`,
      breakdown: [
        `On the national-retailer list (${brand.brand})`,
        "National chain with locations across the country",
      ],
      locationCount: null,
      denylistedBrand: brand.brand,
    };
  }

  async classify(
    name: string,
    website: string | null | undefined,
    types: string[],
    ratingCount: number,
    center: [number, number]
  ): Promise<Classification> {
    const brand = this.denylist.matchBusiness(name, website);
    if (brand) return this.classifyDenylisted(brand);

    const norm = normalizeName(name);
    const count = await this.countLocations(norm, center);

    let score = countToScore(count);
    const breakdown: string[] = [];
    if (count <= 1) breakdown.push("1 location found in this area — independently operated");
    else breakdown.push(`${count} locations found in the wider area`);
    breakdown.push("Not on the national-retailer list");

    if (types.some((t) => BIG_FORMAT_TYPES.has(t))) {
      score -= BIG_FORMAT_PENALTY;
      breakdown.push("Big-format store type (slight reduction)");
    }
    if (count <= 1 && ratingCount >= MEGA_REVIEW_THRESHOLD) {
      score -= MEGA_REVIEW_PENALTY;
      breakdown.push("Unusually high review volume for one location (slight reduction)");
    }
    score = Math.max(15, Math.min(100, score));

    const tier = tierForScore(score);
    const reason =
      count <= 1
        ? "1 location in this area · independently operated · not on the national-retailer list"
        : `${count} locations in the wider area · ${tier.toLowerCase()} · not on the national-retailer list`;
    return { score, tier, reason, breakdown, locationCount: count, denylistedBrand: null };
  }

  /** §6 signal 2: wide-area name search, count matching locations. Concurrent
   * lookups for the same name within a request are deduped. */
  private countLocations(norm: string, center: [number, number]): Promise<number> {
    const existing = this.countInFlight.get(norm);
    if (existing) return existing;
    const p = this.computeCount(norm, center);
    this.countInFlight.set(norm, p);
    return p.finally(() => this.countInFlight.delete(norm));
  }

  private async computeCount(norm: string, center: [number, number]): Promise<number> {
    const cached = await this.cache.getCount(norm);
    if (cached !== null) return cached;

    const [lat, lng] = center;
    const rect = {
      south: Math.max(-90, lat - COUNT_AREA_HALF_LAT),
      north: Math.min(90, lat + COUNT_AREA_HALF_LAT),
      west: lng - COUNT_AREA_HALF_LNG,
      east: lng + COUNT_AREA_HALF_LNG,
    };
    const places = await this.places.searchText(norm, rect, COUNT_MAX_RESULTS);
    let count = 0;
    for (const p of places) {
      const pname = normalizeName(p.displayName?.text ?? "");
      if (pname === norm || pname.startsWith(norm + " ")) count += 1;
    }
    count = Math.max(1, count);
    await this.cache.setCount(norm, count);
    return count;
  }
}
