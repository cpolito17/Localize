import asyncio
import ipaddress
import math
import re
import secrets
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from . import config
from .cache import ClassificationCache
from .denylist import Denylist
from .places import PlacesClient
from .rate_limit import LimitRule, UsageLimiter, UsageLimitExceeded
from .scoring import Scorer
from .thinning import thin_results


class Bounds(BaseModel):
    north: float = Field(ge=-90, le=90)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    west: float = Field(ge=-180, le=180)

    @model_validator(mode="after")
    def validate_order(self):
        if self.south >= self.north:
            raise ValueError("south must be less than north")
        if self.west >= self.east:
            raise ValueError("antimeridian-crossing bounds are not supported")
        return self


class LatLng(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    bounds: Bounds
    userLocation: LatLng | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    if config.SERVER_KEY and len(config.RATE_LIMIT_SECRET) < 32:
        raise RuntimeError(
            "RATE_LIMIT_SECRET must be at least 32 characters when Google APIs are enabled."
        )
    app.state.http = httpx.AsyncClient(timeout=15.0)
    app.state.cache = ClassificationCache(config.CACHE_DB_PATH)
    app.state.limiter = UsageLimiter(config.CACHE_DB_PATH, config.RATE_LIMIT_SECRET)
    app.state.places = PlacesClient(
        config.SERVER_KEY,
        app.state.http,
        app.state.limiter,
        config.GOOGLE_API_DAILY_LIMIT,
    )
    app.state.denylist = Denylist.load()
    app.state.scorer = Scorer(app.state.denylist, app.state.cache, app.state.places)
    yield
    await app.state.http.aclose()
    app.state.cache.close()
    app.state.limiter.close()


app = FastAPI(
    title="Localize",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

VISITOR_COOKIE = "localize_visitor"
VISITOR_ID_RE = re.compile(r"^[A-Za-z0-9_-]{24,64}$")
PHOTO_NAME_RE = re.compile(r"^places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_.-]+$")
PLACE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,256}$")


@app.exception_handler(UsageLimitExceeded)
async def usage_limit_error(_request: Request, exc: UsageLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": exc.message},
        headers={"Retry-After": str(exc.retry_after), "Cache-Control": "no-store"},
    )


@app.middleware("http")
async def anonymous_visitor(request: Request, call_next):
    if (
        request.url.path.startswith("/api/")
        and request.headers.get("sec-fetch-site", "").lower() == "cross-site"
    ):
        return JSONResponse(
            status_code=403,
            content={"detail": "Cross-site requests are not allowed."},
            headers={"Cache-Control": "no-store"},
        )
    visitor_id = request.cookies.get(VISITOR_COOKIE, "")
    is_new = not VISITOR_ID_RE.fullmatch(visitor_id)
    if is_new:
        visitor_id = secrets.token_urlsafe(24)
    request.state.visitor_id = visitor_id
    response = await call_next(request)
    if is_new:
        response.set_cookie(
            VISITOR_COOKIE,
            visitor_id,
            max_age=365 * 24 * 3600,
            httponly=True,
            secure=True,
            samesite="lax",
            path="/",
        )
    return response


def _client_ip(request: Request) -> str:
    # CF-Connecting-IP is trustworthy when the origin only accepts Cloudflare
    # traffic, as documented in the deployment checklist. Fall back cleanly for
    # local development and direct health checks.
    candidates = (
        request.headers.get("cf-connecting-ip"),
        request.headers.get("x-real-ip"),
        request.client.host if request.client else None,
    )
    for candidate in candidates:
        try:
            if candidate:
                return str(ipaddress.ip_address(candidate.strip()))
        except ValueError:
            continue
    return "unknown"


def _enforce_usage(request: Request, action: str) -> None:
    limits = {
        "search": (
            config.RATE_LIMIT_SEARCHES_PER_DAY,
            config.RATE_LIMIT_SEARCHES_PER_MINUTE,
            config.RATE_LIMIT_GLOBAL_SEARCHES_PER_DAY,
        ),
        "place": (32, 8, 600),
        "photo": (120, 30, 2000),
        "geocode": (12, 4, 300),
    }
    user_daily, user_minute, global_daily = limits[action]
    multiplier = max(1, config.RATE_LIMIT_IP_MULTIPLIER)
    limiter: UsageLimiter = request.app.state.limiter
    visitor = limiter.subject("visitor", request.state.visitor_id)
    client_ip = limiter.subject("ip", _client_ip(request))
    limiter.consume(
        [
            LimitRule(f"{action}:visitor", visitor, user_daily, 86400),
            LimitRule(f"{action}:visitor", visitor, user_minute, 60),
            LimitRule(f"{action}:ip", client_ip, user_daily * multiplier, 86400),
            LimitRule(f"{action}:ip", client_ip, user_minute * multiplier, 60),
            LimitRule(f"{action}:global", "global", global_daily, 86400),
        ],
        "You've reached the public demo limit for this action. Please try again later.",
    )


def _require_server_key():
    if not config.SERVER_KEY:
        raise HTTPException(
            status_code=503,
            detail="GOOGLE_MAPS_SERVER_KEY is not configured on the backend.",
        )


@app.get("/api/config")
async def get_config():
    return {
        "appName": config.APP_NAME,
        "tagline": config.TAGLINE,
        "mapsBrowserKey": config.BROWSER_KEY,
        "mapId": config.MAP_ID,
        "anonymousDailySearchLimit": config.RATE_LIMIT_SEARCHES_PER_DAY,
    }


@app.get("/api/health")
async def health():
    return {"ok": True, "serverKeyConfigured": bool(config.SERVER_KEY)}


def _haversine_m(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> int:
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return int(2 * r * math.asin(math.sqrt(h)))


def _candidate(place: dict) -> dict | None:
    """Map a Places result to our candidate shape; drop non-operational."""
    status = place.get("businessStatus", "OPERATIONAL")
    if status != "OPERATIONAL":
        return None
    loc = place.get("location")
    if not loc:
        return None
    photos = place.get("photos") or []
    return {
        "placeId": place["id"],
        "name": place.get("displayName", {}).get("text", ""),
        "lat": loc["latitude"],
        "lng": loc["longitude"],
        "rating": place.get("rating"),
        "userRatingCount": place.get("userRatingCount", 0),
        "types": place.get("types", []),
        "websiteUri": place.get("websiteUri"),
        "googleMapsUri": place.get("googleMapsUri"),
        "photoName": photos[0]["name"] if photos else None,
    }


@app.post("/api/search")
async def search(req: SearchRequest, request: Request):
    _require_server_key()
    _enforce_usage(request, "search")
    denylist: Denylist = app.state.denylist
    places: PlacesClient = app.state.places
    scorer: Scorer = app.state.scorer
    bounds = req.bounds.model_dump()
    center_lat = (bounds["north"] + bounds["south"]) / 2
    center_lng = (bounds["east"] + bounds["west"]) / 2

    # §4: a denylisted-brand query pivots to its local-alternative category,
    # while the brand itself is still searched so the contrast stays visible.
    brand = denylist.match_query(req.query)
    effective_query = brand.category if brand else req.query

    try:
        raw = await places.search_text(
            effective_query, bounds, max_results=config.SEARCH_MAX_RESULTS
        )
        if brand:
            brand_raw = await places.search_text(
                brand.brand, bounds, max_results=config.BRAND_SEARCH_MAX_RESULTS
            )
            seen = {p["id"] for p in raw}
            raw.extend(p for p in brand_raw if p["id"] not in seen)
    except httpx.HTTPError:
        raise HTTPException(
            status_code=502, detail="Couldn't reach Google Places. Please try again."
        )

    candidates = [c for c in (_candidate(p) for p in raw) if c]
    for c in candidates:
        c["denylisted"] = denylist.match_business(c["name"], c["websiteUri"]) is not None

    displayed = thin_results(candidates, bounds, config.RESULT_CAP, config.GRID_SIZE)

    # Score only the displayed set (§6 cost control); results are cached.
    sem = asyncio.Semaphore(8)

    async def score(c: dict):
        async with sem:
            cls = await scorer.classify(
                c["name"], c["websiteUri"], c["types"], c["userRatingCount"],
                (center_lat, center_lng),
            )
        c["score"] = cls.score
        c["tier"] = cls.tier
        c["reason"] = cls.reason
        c["breakdown"] = cls.breakdown
        c["locationCount"] = cls.location_count
        c["denylistedBrand"] = cls.denylisted_brand

    await asyncio.gather(*(score(c) for c in displayed))

    origin = (req.userLocation.lat, req.userLocation.lng) if req.userLocation else (center_lat, center_lng)
    for c in displayed:
        c["distanceMeters"] = _haversine_m(origin[0], origin[1], c["lat"], c["lng"])
        del c["denylisted"]

    displayed.sort(key=lambda c: (-c["score"], -(c["rating"] or 0), -c["userRatingCount"]))

    return {
        "results": displayed,
        "totalFound": len(candidates),
        "pivot": {"brand": brand.brand, "category": brand.category} if brand else None,
    }


@app.get("/api/place/{place_id}")
async def place_details(place_id: str, request: Request):
    _require_server_key()
    _enforce_usage(request, "place")
    if not PLACE_ID_RE.fullmatch(place_id):
        raise HTTPException(status_code=400, detail="Invalid place ID.")
    places: PlacesClient = app.state.places
    scorer: Scorer = app.state.scorer
    try:
        p = await places.details(place_id)
    except httpx.HTTPError:
        raise HTTPException(
            status_code=502, detail="Couldn't reach Google Places. Please try again."
        )

    loc = p.get("location", {})
    cls = await scorer.classify(
        p.get("displayName", {}).get("text", ""),
        p.get("websiteUri"),
        p.get("types", []),
        p.get("userRatingCount", 0),
        (loc.get("latitude", 0.0), loc.get("longitude", 0.0)),
    )
    reviews = [
        {
            "rating": r.get("rating"),
            "text": (r.get("text") or {}).get("text", ""),
            "author": (r.get("authorAttribution") or {}).get("displayName", ""),
            "relativeTime": r.get("relativePublishTimeDescription", ""),
        }
        for r in (p.get("reviews") or [])[:3]
    ]
    return {
        "placeId": p["id"],
        "name": p.get("displayName", {}).get("text", ""),
        "address": p.get("formattedAddress"),
        "lat": loc.get("latitude"),
        "lng": loc.get("longitude"),
        "rating": p.get("rating"),
        "userRatingCount": p.get("userRatingCount", 0),
        "websiteUri": p.get("websiteUri"),
        "googleMapsUri": p.get("googleMapsUri"),
        "openingHours": (p.get("regularOpeningHours") or {}).get("weekdayDescriptions", []),
        "openNow": (p.get("regularOpeningHours") or {}).get("openNow"),
        "photoNames": [ph["name"] for ph in (p.get("photos") or [])[:6]],
        "reviews": reviews,
        "score": cls.score,
        "tier": cls.tier,
        "reason": cls.reason,
        "breakdown": cls.breakdown,
        "locationCount": cls.location_count,
    }


@app.get("/api/photo")
async def photo(
    request: Request,
    name: str = Query(min_length=1, max_length=512),
    w: int = Query(default=640, ge=64, le=1600),
):
    _require_server_key()
    _enforce_usage(request, "photo")
    if not PHOTO_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="Invalid photo name.")
    places: PlacesClient = app.state.places
    try:
        resp = await places.photo(name, w)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Couldn't reach Google Places.")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Photo unavailable.")
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=86400, s-maxage=604800"},
    )


@app.get("/api/geocode")
async def geocode(request: Request, q: str = Query(min_length=1, max_length=200)):
    _require_server_key()
    _enforce_usage(request, "geocode")
    places: PlacesClient = app.state.places
    try:
        result = await places.geocode(q)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Couldn't reach Google Maps.")
    if result is None:
        raise HTTPException(status_code=404, detail="No results for that location.")
    return result
