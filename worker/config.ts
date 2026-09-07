export const APP_NAME = "Localize";
export const TAGLINE = "Find it nearby. Keep it local.";

export const RESULT_CAP = 12;
export const GRID_SIZE = 4;
export const SEARCH_MAX_RESULTS = 20;
export const BRAND_SEARCH_MAX_RESULTS = 10;
export const COUNT_SEARCH_MAX_RESULTS = 20;
export const COUNT_AREA_HALF_LAT = 1.0;
export const COUNT_AREA_HALF_LNG = 1.25;
export const CACHE_TTL_SECONDS = 30 * 24 * 3600;
export const MAX_API_BODY_BYTES = 16 * 1024;
export const UPSTREAM_TIMEOUT_MS = 15_000;

export const ACTION_LIMITS = {
  search: { browserDaily: 8, globalDaily: 40 },
  place: { browserDaily: 32, globalDaily: 600 },
  photo: { browserDaily: 120, globalDaily: 2_000 },
  geocode: { browserDaily: 12, globalDaily: 300 },
} as const;

export type LimitedAction = keyof typeof ACTION_LIMITS;

export function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
