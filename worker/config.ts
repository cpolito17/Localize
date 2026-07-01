// Tunables (port of backend/app/config.py).

export const APP_NAME = "Localize";
export const TAGLINE = "Find it nearby. Keep it local.";

// Display cap and grid for viewport thinning (§5).
export const RESULT_CAP = 36;
export const GRID_SIZE = 6;

// Wide-area box half-size in degrees for the location-count search (§6).
export const COUNT_AREA_HALF_LAT = 1.0;
export const COUNT_AREA_HALF_LNG = 1.25;

// Cached classifications expire after 30 days.
export const CACHE_TTL_SECONDS = 30 * 24 * 3600;

// The location-count search reads a single page (20 results) rather than the
// Python backend's 3 pages. This keeps a cold-cache /search under the Workers
// per-request subrequest ceiling (50 on Free). Chains with >20 nearby
// locations still land in the "regional" band; the largest national brands are
// caught by the denylist hard cap regardless. See DEPLOY.md.
export const COUNT_MAX_RESULTS = 20;
