import { ClassificationCache } from "./cache";
import {
  APP_NAME,
  BRAND_SEARCH_MAX_RESULTS,
  GRID_SIZE,
  MAX_API_BODY_BYTES,
  RESULT_CAP,
  SEARCH_MAX_RESULTS,
  TAGLINE,
  positiveInt,
  type LimitedAction,
} from "./config";
import { Denylist } from "./denylist";
import { PlacesClient } from "./places";
import { Scorer } from "./scoring";
import { thinResults } from "./thinning";
import {
  HttpError,
  type Bounds,
  type Candidate,
  type LatLng,
  type RawPlace,
  type WorkerEnv,
} from "./types";
import { ipSubject, requireRateLimitSecret, UsageLimiter, visitorForRequest } from "./usage";

const API_PREFIX = "/localize/api";
const PLACE_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;
const PHOTO_NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_.-]+$/;
const denylist = Denylist.load();

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function requireServerKey(
  env: WorkerEnv
): asserts env is WorkerEnv & { GOOGLE_MAPS_SERVER_KEY: string } {
  if (!env.GOOGLE_MAPS_SERVER_KEY) {
    throw new HttpError(503, "The Google Maps service is not configured.");
  }
}

function ownKeysAre(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validBounds(value: unknown): value is Bounds {
  if (!isRecord(value) || !ownKeysAre(value, ["north", "south", "east", "west"])) return false;
  const { north, south, east, west } = value;
  return (
    typeof north === "number" &&
    Number.isFinite(north) &&
    north >= -90 &&
    north <= 90 &&
    typeof south === "number" &&
    Number.isFinite(south) &&
    south >= -90 &&
    south <= 90 &&
    south < north &&
    typeof east === "number" &&
    Number.isFinite(east) &&
    east >= -180 &&
    east <= 180 &&
    typeof west === "number" &&
    Number.isFinite(west) &&
    west >= -180 &&
    west <= 180 &&
    west < east
  );
}

function validLatLng(value: unknown): value is LatLng {
  if (!isRecord(value) || !ownKeysAre(value, ["lat", "lng"])) return false;
  return (
    typeof value.lat === "number" &&
    Number.isFinite(value.lat) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    typeof value.lng === "number" &&
    Number.isFinite(value.lng) &&
    value.lng >= -180 &&
    value.lng <= 180
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json.");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_API_BODY_BYTES)) {
    throw new HttpError(413, "Request body is too large.");
  }
  if (!request.body) throw new HttpError(400, "A JSON request body is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_API_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "Malformed JSON request body.");
  }
}

function queryHasOnly(url: URL, allowed: readonly string[]): boolean {
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => keys.push(key));
  return keys.every((key) => allowed.includes(key)) && allowed.every((key) => url.searchParams.getAll(key).length <= 1);
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const radius = 6_371_000;
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const deltaLat = ((bLat - aLat) * Math.PI) / 180;
  const deltaLng = ((bLng - aLng) * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(deltaLng / 2) ** 2;
  return Math.trunc(2 * radius * Math.asin(Math.sqrt(haversine)));
}

function toCandidate(place: RawPlace): Candidate | null {
  if ((place.businessStatus ?? "OPERATIONAL") !== "OPERATIONAL") return null;
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  if (!place.id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    placeId: place.id,
    name: place.displayName?.text ?? "",
    lat: latitude as number,
    lng: longitude as number,
    rating: typeof place.rating === "number" ? place.rating : null,
    userRatingCount: typeof place.userRatingCount === "number" ? place.userRatingCount : 0,
    types: Array.isArray(place.types) ? place.types : [],
    websiteUri: place.websiteUri ?? null,
    googleMapsUri: place.googleMapsUri ?? null,
    photoName: place.photos?.[0]?.name ?? null,
  };
}

async function withConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

function services(env: WorkerEnv): { places: PlacesClient; scorer: Scorer; limiter: UsageLimiter } {
  const limiter = new UsageLimiter(env);
  const key = env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new HttpError(503, "The Google Maps service is not configured.");
  const places = new PlacesClient(key, limiter);
  const cache = new ClassificationCache(env.DB);
  return { places, scorer: new Scorer(denylist, cache, places), limiter };
}

async function enforceAction(
  action: LimitedAction,
  request: Request,
  env: WorkerEnv,
  visitorSubject: string
): Promise<void> {
  const limiter = new UsageLimiter(env);
  await limiter.consumeAction(action, visitorSubject, await ipSubject(request, env));
}

function getConfig(env: WorkerEnv): Response {
  return json({
    appName: APP_NAME,
    tagline: TAGLINE,
    mapsBrowserKey: env.GOOGLE_MAPS_BROWSER_KEY ?? "",
    mapId: env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
    anonymousDailySearchLimit: positiveInt(env.RATE_LIMIT_SEARCHES_PER_DAY, 8),
  });
}

function getHealth(env: WorkerEnv): Response {
  return json({
    ok: true,
    serverKeyConfigured: Boolean(env.GOOGLE_MAPS_SERVER_KEY),
    rateLimitSecretConfigured: Boolean(env.RATE_LIMIT_SECRET && env.RATE_LIMIT_SECRET.length >= 32),
  });
}

async function postSearch(request: Request, env: WorkerEnv, visitorSubject: string): Promise<Response> {
  requireServerKey(env);
  const body = await readJsonBody(request);
  if (!isRecord(body) || !ownKeysAre(body, ["query", "bounds", "userLocation"])) {
    throw new HttpError(400, "Invalid search request.");
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query.length < 1 || query.length > 200) {
    throw new HttpError(400, "A search query (1–200 chars) is required.");
  }
  if (!validBounds(body.bounds)) throw new HttpError(400, "Valid map bounds are required.");
  if (body.userLocation !== null && body.userLocation !== undefined && !validLatLng(body.userLocation)) {
    throw new HttpError(400, "Invalid user location.");
  }
  await enforceAction("search", request, env, visitorSubject);

  const bounds = body.bounds;
  const userLocation = body.userLocation as LatLng | null | undefined;
  const { places, scorer } = services(env);
  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const brand = denylist.matchQuery(query);
  const raw = await places.searchText(brand ? brand.category : query, bounds, SEARCH_MAX_RESULTS);
  if (brand) {
    const brandRaw = await places.searchText(brand.brand, bounds, BRAND_SEARCH_MAX_RESULTS);
    const seen = new Set(raw.map((place) => place.id));
    raw.push(...brandRaw.filter((place) => !seen.has(place.id)));
  }

  const candidates = raw.flatMap((place) => {
    const candidate = toCandidate(place);
    if (!candidate) return [];
    candidate.denylisted = denylist.matchBusiness(candidate.name, candidate.websiteUri) !== null;
    return [candidate];
  });
  const displayed = thinResults(candidates, bounds, RESULT_CAP, GRID_SIZE);
  await withConcurrency(displayed, 8, async (candidate) => {
    const classification = await scorer.classify(
      candidate.name,
      candidate.websiteUri,
      candidate.types,
      candidate.userRatingCount,
      [centerLat, centerLng]
    );
    Object.assign(candidate, classification);
  });

  const originLat = userLocation?.lat ?? centerLat;
  const originLng = userLocation?.lng ?? centerLng;
  for (const candidate of displayed) {
    candidate.distanceMeters = haversineM(originLat, originLng, candidate.lat, candidate.lng);
    delete candidate.denylisted;
  }
  displayed.sort(
    (left, right) =>
      (right.score ?? 0) - (left.score ?? 0) ||
      (right.rating ?? 0) - (left.rating ?? 0) ||
      right.userRatingCount - left.userRatingCount
  );
  return json({
    results: displayed,
    totalFound: candidates.length,
    pivot: brand ? { brand: brand.brand, category: brand.category } : null,
  });
}

async function getPlace(
  placeId: string,
  request: Request,
  env: WorkerEnv,
  visitorSubject: string
): Promise<Response> {
  requireServerKey(env);
  if (!PLACE_ID_RE.test(placeId)) throw new HttpError(400, "Invalid place ID.");
  await enforceAction("place", request, env, visitorSubject);
  const { places, scorer } = services(env);
  const place = await places.details(placeId);
  const location = place.location ?? { latitude: 0, longitude: 0 };
  const classification = await scorer.classify(
    place.displayName?.text ?? "",
    place.websiteUri,
    place.types ?? [],
    place.userRatingCount ?? 0,
    [location.latitude, location.longitude]
  );
  return json({
    placeId: place.id,
    name: place.displayName?.text ?? "",
    address: place.formattedAddress ?? null,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? 0,
    websiteUri: place.websiteUri ?? null,
    googleMapsUri: place.googleMapsUri ?? null,
    openingHours: place.regularOpeningHours?.weekdayDescriptions ?? [],
    openNow: place.regularOpeningHours?.openNow ?? null,
    photoNames: (place.photos ?? []).slice(0, 6).map((photo) => photo.name),
    reviews: (place.reviews ?? []).slice(0, 3).map((review) => ({
      rating: review.rating ?? null,
      text: review.text?.text ?? "",
      author: review.authorAttribution?.displayName ?? "",
      relativeTime: review.relativePublishTimeDescription ?? "",
    })),
    ...classification,
  });
}

async function getPhoto(
  url: URL,
  request: Request,
  env: WorkerEnv,
  visitorSubject: string
): Promise<Response> {
  requireServerKey(env);
  if (!queryHasOnly(url, ["name", "w"])) throw new HttpError(400, "Invalid photo request.");
  const name = url.searchParams.get("name") ?? "";
  if (name.length > 512 || !PHOTO_NAME_RE.test(name)) throw new HttpError(400, "Invalid photo name.");
  const widthText = url.searchParams.get("w") ?? "640";
  if (!/^\d{2,4}$/.test(widthText)) throw new HttpError(400, "Invalid photo width.");
  const width = Number(widthText);
  if (width < 64 || width > 1600) throw new HttpError(400, "Invalid photo width.");
  await enforceAction("photo", request, env, visitorSubject);
  const { places } = services(env);
  const response = await places.photo(name, width);
  if (!response.ok || !response.body) throw new HttpError(502, "Photo unavailable.");
  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
    },
  });
}

async function getGeocode(
  url: URL,
  request: Request,
  env: WorkerEnv,
  visitorSubject: string
): Promise<Response> {
  requireServerKey(env);
  if (!queryHasOnly(url, ["q"])) throw new HttpError(400, "Invalid geocode request.");
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length < 1 || query.length > 200) throw new HttpError(400, "A location query is required.");
  await enforceAction("geocode", request, env, visitorSubject);
  const { places } = services(env);
  const result = await places.geocode(query);
  if (!result) throw new HttpError(404, "No results for that location.");
  return json(result);
}

function methodNotAllowed(allow: string): Response {
  return json({ detail: "Method not allowed." }, 405, { Allow: allow });
}

async function handleApi(
  request: Request,
  env: WorkerEnv,
  url: URL,
  visitorSubject: string
): Promise<Response> {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (path === `${API_PREFIX}/config`) {
    if (method !== "GET") return methodNotAllowed("GET");
    if (url.search) throw new HttpError(400, "Unexpected query parameters.");
    return getConfig(env);
  }
  if (path === `${API_PREFIX}/health`) {
    if (method !== "GET") return methodNotAllowed("GET");
    if (url.search) throw new HttpError(400, "Unexpected query parameters.");
    return getHealth(env);
  }
  if (path === `${API_PREFIX}/search`) {
    if (url.search) throw new HttpError(400, "Unexpected query parameters.");
    return method === "POST" ? postSearch(request, env, visitorSubject) : methodNotAllowed("POST");
  }
  if (path === `${API_PREFIX}/geocode`) {
    return method === "GET"
      ? getGeocode(url, request, env, visitorSubject)
      : methodNotAllowed("GET");
  }
  if (path === `${API_PREFIX}/photo`) {
    return method === "GET" ? getPhoto(url, request, env, visitorSubject) : methodNotAllowed("GET");
  }
  if (path.startsWith(`${API_PREFIX}/place/`)) {
    if (method !== "GET") return methodNotAllowed("GET");
    if (url.search) throw new HttpError(400, "Unexpected query parameters.");
    let placeId: string;
    try {
      placeId = decodeURIComponent(path.slice(`${API_PREFIX}/place/`.length));
    } catch {
      throw new HttpError(400, "Invalid place ID.");
    }
    return getPlace(placeId, request, env, visitorSubject);
  }
  throw new HttpError(404, "Not found.");
}

function rejectCrossSite(request: Request, url: URL): void {
  if (request.headers.get("Sec-Fetch-Site")?.toLowerCase() === "cross-site") {
    throw new HttpError(403, "Cross-site requests are not allowed.");
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "Cross-site requests are not allowed.");
}

function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function commonSecurityHeaders(headers: Headers): void {
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), payment=(), geolocation=(self)");
}

function apiResponse(response: Response, setCookie?: string | null): Response {
  const headers = new Headers(response.headers);
  commonSecurityHeaders(headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function staticResponse(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  if (url.pathname === "/localize") {
    return Response.redirect(`${url.origin}/localize/${url.search}`, 308);
  }
  if (!url.pathname.startsWith("/localize/")) throw new HttpError(404, "Not found.");

  let response = await env.ASSETS.fetch(request);
  const acceptsHtml = (request.headers.get("Accept") ?? "").includes("text/html");
  const finalSegment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (response.status === 404 && acceptsHtml && !finalSegment.includes(".")) {
    response = await env.ASSETS.fetch(
      new Request(new URL("/localize/index.html", url.origin), {
        method,
        headers: request.headers,
      })
    );
  }

  const headers = new Headers(response.headers);
  commonSecurityHeaders(headers);
  const isHtml = headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
  if (isHtml && method === "GET") {
    const scriptNonce = nonce();
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        `script-src 'nonce-${scriptNonce}' 'strict-dynamic' 'unsafe-eval' https:`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com https://*.ggpht.com",
        "connect-src 'self' https://*.googleapis.com https://*.gstatic.com",
        "worker-src 'self' blob:",
      ].join("; ")
    );
    headers.set("Cache-Control", "no-cache");
    return new HTMLRewriter()
      .on("script", {
        element(element) {
          element.setAttribute("nonce", scriptNonce);
        },
      })
      .transform(new Response(response.body, { status: response.status, headers }));
  }
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
  );
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      let setCookie: string | null = null;
      try {
        rejectCrossSite(request, url);
        requireRateLimitSecret(env);
        const visitor = await visitorForRequest(request, env);
        setCookie = visitor.setCookie;
        return apiResponse(await handleApi(request, env, url, visitor.subject), setCookie);
      } catch (error) {
        if (error instanceof HttpError) {
          const headers: Record<string, string> = error.retryAfter
            ? { "Retry-After": String(error.retryAfter) }
            : {};
          return apiResponse(json({ detail: error.message }, error.status, headers), setCookie);
        }
        console.error(JSON.stringify({ event: "request_failed", path: url.pathname }));
        return apiResponse(json({ detail: "Internal error." }, 500), setCookie);
      }
    }

    try {
      return await staticResponse(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) return apiResponse(json({ detail: error.message }, error.status));
      console.error(JSON.stringify({ event: "asset_request_failed", path: url.pathname }));
      return apiResponse(json({ detail: "Internal error." }, 500));
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
