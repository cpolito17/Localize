import { ClassificationCache } from "./cache";
import { COUNT_AREA_HALF_LAT, COUNT_AREA_HALF_LNG, COUNT_SEARCH_MAX_RESULTS } from "./config";
import { type Brand, Denylist, normalizeName } from "./denylist";
import { PlacesClient } from "./places";
import type { Classification } from "./types";

const ECOMMERCE_SCORE = 5;
const BIGBOX_SCORE = 25;
const BIG_FORMAT_TYPES = new Set(["department_store", "supermarket", "shopping_mall", "warehouse_store"]);
const BIG_FORMAT_PENALTY = 4;
const MEGA_REVIEW_THRESHOLD = 4_000;
const MEGA_REVIEW_PENALTY = 5;

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
  private readonly countInFlight = new Map<string, Promise<number>>();

  constructor(
    private readonly denylist: Denylist,
    private readonly cache: ClassificationCache,
    private readonly places: PlacesClient
  ) {}

  classifyDenylisted(brand: Brand): Classification {
    const score = brand.kind === "ecommerce" ? ECOMMERCE_SCORE : BIGBOX_SCORE;
    return {
      score,
      tier: tierForScore(score),
      reason:
        brand.kind === "ecommerce"
          ? `${brand.brand} is a national e-commerce giant — purchases here don't stay local.`
          : `${brand.brand} is a national big-box chain.`,
      breakdown:
        brand.kind === "ecommerce"
          ? [
              `On the national-retailer list (${brand.brand})`,
              "E-commerce giant — revenue leaves the local economy",
            ]
          : [
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

    const normalized = normalizeName(name);
    if (!normalized) return this.unknownLocationCount();
    const count = await this.countLocations(normalized, center);
    if (count === 0) return this.unknownLocationCount();

    let score = countToScore(count);
    const breakdown = [
      count <= 1
        ? "1 location found in this area — independently operated"
        : `${count} locations found in the wider area`,
      "Not on the national-retailer list",
    ];
    if (types.some((type) => BIG_FORMAT_TYPES.has(type))) {
      score -= BIG_FORMAT_PENALTY;
      breakdown.push("Big-format store type (slight reduction)");
    }
    if (count <= 1 && ratingCount >= MEGA_REVIEW_THRESHOLD) {
      score -= MEGA_REVIEW_PENALTY;
      breakdown.push("Unusually high review volume for one location (slight reduction)");
    }
    score = Math.max(15, Math.min(100, score));
    const tier = tierForScore(score);
    return {
      score,
      tier,
      reason:
        count <= 1
          ? "1 location in this area · independently operated · not on the national-retailer list"
          : `${count} locations in the wider area · ${tier.toLowerCase()} · not on the national-retailer list`,
      breakdown,
      locationCount: count,
      denylistedBrand: null,
    };
  }

  private geoBucket(center: [number, number]): string {
    const coordinate = (value: number): string => {
      const rounded = Math.round(value);
      return `${rounded >= 0 ? "+" : "-"}${Math.abs(rounded).toString().padStart(3, "0")}`;
    };
    return `${coordinate(center[0])}:${coordinate(center[1])}`;
  }

  private unknownLocationCount(): Classification {
    const score = 70;
    return {
      score,
      tier: tierForScore(score),
      reason: "Other locations could not be verified, so this score is provisional.",
      breakdown: ["Location count could not be verified", "Not on the national-retailer list"],
      locationCount: null,
      denylistedBrand: null,
    };
  }

  private countLocations(normalized: string, center: [number, number]): Promise<number> {
    const bucket = this.geoBucket(center);
    const key = `${normalized}:${bucket}`;
    const existing = this.countInFlight.get(key);
    if (existing) return existing;
    const pending = this.computeCount(normalized, center, bucket);
    this.countInFlight.set(key, pending);
    return pending.finally(() => this.countInFlight.delete(key));
  }

  private async computeCount(
    normalized: string,
    center: [number, number],
    bucket: string
  ): Promise<number> {
    const cached = await this.cache.getCount(normalized, bucket);
    if (cached !== null) return cached;
    const [lat, lng] = center;
    const rect = {
      south: Math.max(-90, lat - COUNT_AREA_HALF_LAT),
      north: Math.min(90, lat + COUNT_AREA_HALF_LAT),
      west: Math.max(-180, lng - COUNT_AREA_HALF_LNG),
      east: Math.min(180, lng + COUNT_AREA_HALF_LNG),
    };
    const places = await this.places.searchText(normalized, rect, COUNT_SEARCH_MAX_RESULTS);
    let count = places.filter((place) => {
      const placeName = normalizeName(place.displayName?.text ?? "");
      return placeName === normalized || placeName.startsWith(`${normalized} `);
    }).length;
    if (places.length >= COUNT_SEARCH_MAX_RESULTS && count >= places.length) count = 41;
    await this.cache.setCount(normalized, bucket, count);
    return count;
  }
}
