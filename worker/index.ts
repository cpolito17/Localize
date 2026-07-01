// Localize on Cloudflare Workers — API + static-asset host for /localize/*.
// Ports backend/app/main.py; the whole route sits behind Cloudflare Access.
import { ClassificationCache } from "./cache";
import { APP_NAME, GRID_SIZE, RESULT_CAP, TAGLINE } from "./config";
import { Denylist } from "./denylist";
import { PlacesClient } from "./places";
import { Scorer } from "./scoring";
import { thinResults } from "./thinning";
import { HttpError, type Bounds, type Candidate, type Env, type LatLng, type RawPlace } from "./types";

const API_PREFIX = "/localize/api";

// The denylist is static data; load it once per isolate.
const denylist = Denylist.load();

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function requireServerKey(env: Env): void {
  if (!env.GOOGLE_MAPS_SERVER_KEY) {
    throw new HttpError(503, "GOOGLE_MAPS_SERVER_KEY is not configured on the backend.");
  }
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6371000.0;
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = ((bLat - aLat) * Math.PI) / 180;
  const dl = ((bLng - aLng) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.trunc(2 * r * Math.asin(Math.sqrt(h)));
}

/** Map a Places result to our candidate shape; drop non-operational. */
function toCandidate(place: RawPlace): Candidate | null {
  const status = place.businessStatus ?? "OPERATIONAL";
  if (status !== "OPERATIONAL") return null;
  const loc = place.location;
  if (!loc) return null;
  const photos = place.photos ?? [];
  return {
    placeId: place.id,
    name: place.displayName?.text ?? "",
    lat: loc.latitude,
    lng: loc.longitude,
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? 0,
    types: place.types ?? [],
    websiteUri: place.websiteUri ?? null,
    googleMapsUri: place.googleMapsUri ?? null,
    photoName: photos.length > 0 ? photos[0].name : null,
  };
}

/** Run tasks with bounded concurrency (mirrors the backend's Semaphore(8)). */
async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

function makeScorer(env: Env): Scorer {
  const places = new PlacesClient(env.GOOGLE_MAPS_SERVER_KEY);
  const cache = new ClassificationCache(env.CACHE);
  return new Scorer(denylist, cache, places);
}

// ---- Handlers -------------------------------------------------------------

function getConfig(env: Env): Response {
  return json({
    appName: APP_NAME,
    tagline: TAGLINE,
    mapsBrowserKey: env.GOOGLE_MAPS_BROWSER_KEY ?? "",
    mapId: env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
  });
}

function getHealth(env: Env): Response {
  return json({ ok: true, serverKeyConfigured: Boolean(env.GOOGLE_MAPS_SERVER_KEY) });
}

function validBounds(b: unknown): b is Bounds {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.north === "number" &&
    typeof o.south === "number" &&
    typeof o.east === "number" &&
    typeof o.west === "number"
  );
}

async function postSearch(request: Request, env: Env): Promise<Response> {
  requireServerKey(env);
  const body = (await request.json().catch(() => null)) as {
    query?: unknown;
    bounds?: unknown;
    userLocation?: unknown;
  } | null;
  if (!body || typeof body.query !== "string" || body.query.length < 1 || body.query.length > 200) {
    throw new HttpError(400, "A search query (1–200 chars) is required.");
  }
  if (!validBounds(body.bounds)) throw new HttpError(400, "Valid map bounds are required.");
  const bounds = body.bounds;
  const userLocation = body.userLocation as LatLng | null | undefined;

  const places = new PlacesClient(env.GOOGLE_MAPS_SERVER_KEY);
  const scorer = makeScorer(env);
  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;

  // §4: a denylisted-brand query pivots to its local-alternative category,
  // while the brand itself is still searched so the contrast stays visible.
  const brand = denylist.matchQuery(body.query);
  const effectiveQuery = brand ? brand.category : body.query;

  const raw = await places.searchText(effectiveQuery, bounds);
  if (brand) {
    const brandRaw = await places.searchText(brand.brand, bounds, 20);
    const seen = new Set(raw.map((p) => p.id));
    for (const p of brandRaw) if (!seen.has(p.id)) raw.push(p);
  }

  const candidates: Candidate[] = [];
  for (const p of raw) {
    const c = toCandidate(p);
    if (c) {
      c.denylisted = denylist.matchBusiness(c.name, c.websiteUri) !== null;
      candidates.push(c);
    }
  }

  const displayed = thinResults(candidates, bounds, RESULT_CAP, GRID_SIZE);

  // Score only the displayed set (§6 cost control); results are cached in KV.
  await withConcurrency(displayed, 8, async (c) => {
    const cls = await scorer.classify(c.name, c.websiteUri, c.types, c.userRatingCount, [
      centerLat,
      centerLng,
    ]);
    c.score = cls.score;
    c.tier = cls.tier;
    c.reason = cls.reason;
    c.breakdown = cls.breakdown;
    c.locationCount = cls.locationCount;
    c.denylistedBrand = cls.denylistedBrand;
  });

  const originLat = userLocation ? userLocation.lat : centerLat;
  const originLng = userLocation ? userLocation.lng : centerLng;
  for (const c of displayed) {
    c.distanceMeters = haversineM(originLat, originLng, c.lat, c.lng);
    delete c.denylisted;
  }

  displayed.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      (b.rating ?? 0) - (a.rating ?? 0) ||
      b.userRatingCount - a.userRatingCount
  );

  return json({
    results: displayed,
    totalFound: candidates.length,
    pivot: brand ? { brand: brand.brand, category: brand.category } : null,
  });
}

async function getPlace(placeId: string, env: Env): Promise<Response> {
  requireServerKey(env);
  const places = new PlacesClient(env.GOOGLE_MAPS_SERVER_KEY);
  const scorer = makeScorer(env);
  const p = await places.details(placeId);

  const loc = p.location ?? { latitude: 0, longitude: 0 };
  const cls = await scorer.classify(
    p.displayName?.text ?? "",
    p.websiteUri,
    p.types ?? [],
    p.userRatingCount ?? 0,
    [loc.latitude, loc.longitude]
  );
  const reviews = (p.reviews ?? []).slice(0, 3).map((r) => ({
    rating: r.rating ?? null,
    text: r.text?.text ?? "",
    author: r.authorAttribution?.displayName ?? "",
    relativeTime: r.relativePublishTimeDescription ?? "",
  }));
  return json({
    placeId: p.id,
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? 0,
    websiteUri: p.websiteUri ?? null,
    googleMapsUri: p.googleMapsUri ?? null,
    openingHours: p.regularOpeningHours?.weekdayDescriptions ?? [],
    openNow: p.regularOpeningHours?.openNow ?? null,
    photoNames: (p.photos ?? []).slice(0, 6).map((ph) => ph.name),
    reviews,
    score: cls.score,
    tier: cls.tier,
    reason: cls.reason,
    breakdown: cls.breakdown,
    locationCount: cls.locationCount,
  });
}

async function getPhoto(url: URL, env: Env): Promise<Response> {
  requireServerKey(env);
  const name = url.searchParams.get("name") ?? "";
  if (!name || name.length < 1) throw new HttpError(400, "A photo name is required.");
  if (!name.startsWith("places/") || !name.includes("/photos/")) {
    throw new HttpError(400, "Invalid photo name.");
  }
  let w = parseInt(url.searchParams.get("w") ?? "640", 10);
  if (!Number.isFinite(w)) w = 640;
  w = Math.max(64, Math.min(1600, w));

  const places = new PlacesClient(env.GOOGLE_MAPS_SERVER_KEY);
  const resp = await places.photo(name, w);
  if (resp.status !== 200) throw new HttpError(502, "Photo unavailable.");
  return new Response(resp.body, {
    status: 200,
    headers: {
      "Content-Type": resp.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

async function getGeocode(url: URL, env: Env): Promise<Response> {
  requireServerKey(env);
  const q = url.searchParams.get("q") ?? "";
  if (!q || q.length < 1 || q.length > 200) throw new HttpError(400, "A location query is required.");
  const places = new PlacesClient(env.GOOGLE_MAPS_SERVER_KEY);
  const result = await places.geocode(q);
  if (result === null) throw new HttpError(404, "No results for that location.");
  return json(result);
}

// ---- Router ---------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === `${API_PREFIX}/config` && method === "GET") return getConfig(env);
  if (path === `${API_PREFIX}/health` && method === "GET") return getHealth(env);
  if (path === `${API_PREFIX}/search` && method === "POST") return postSearch(request, env);
  if (path === `${API_PREFIX}/geocode` && method === "GET") return getGeocode(url, env);
  if (path === `${API_PREFIX}/photo` && method === "GET") return getPhoto(url, env);
  if (path.startsWith(`${API_PREFIX}/place/`) && method === "GET") {
    const placeId = decodeURIComponent(path.slice(`${API_PREFIX}/place/`.length));
    if (placeId) return getPlace(placeId, env);
  }
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ detail: err.message }, err.status);
        return json({ detail: "Internal error." }, 500);
      }
    }

    // Bare /localize -> canonical trailing slash.
    if (path === "/localize") {
      return Response.redirect(`${url.origin}/localize/`, 301);
    }

    // Any other non-API path under /localize that didn't match a built asset:
    // serve the SPA shell. (Hashed assets and /localize/ are served directly
    // by the asset host and never reach here.)
    const indexReq = new Request(new URL("/localize/index.html", url.origin), request);
    return env.ASSETS.fetch(indexReq);
  },
};
