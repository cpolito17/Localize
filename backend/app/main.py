import asyncio
import math
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Query, Response
from pydantic import BaseModel, Field

from . import config
from .cache import ClassificationCache
from .denylist import Denylist
from .places import PlacesClient
from .scoring import Scorer
from .thinning import thin_results


class Bounds(BaseModel):
    north: float
    south: float
    east: float
    west: float


class LatLng(BaseModel):
    lat: float
    lng: float


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    bounds: Bounds
    userLocation: LatLng | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=15.0)
    app.state.places = PlacesClient(config.SERVER_KEY, app.state.http)
    app.state.cache = ClassificationCache(config.CACHE_DB_PATH)
    app.state.denylist = Denylist.load()
    app.state.scorer = Scorer(app.state.denylist, app.state.cache, app.state.places)
    yield
    await app.state.http.aclose()


app = FastAPI(title="Localize", lifespan=lifespan)


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
async def search(req: SearchRequest):
    _require_server_key()
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
        raw = await places.search_text(effective_query, bounds)
        if brand:
            brand_raw = await places.search_text(brand.brand, bounds, max_results=20)
            seen = {p["id"] for p in raw}
            raw.extend(p for p in brand_raw if p["id"] not in seen)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Google Places error: {e.response.status_code}")

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
async def place_details(place_id: str):
    _require_server_key()
    places: PlacesClient = app.state.places
    scorer: Scorer = app.state.scorer
    try:
        p = await places.details(place_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Google Places error: {e.response.status_code}")

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
async def photo(name: str = Query(min_length=1), w: int = Query(default=640, ge=64, le=1600)):
    _require_server_key()
    if not name.startswith("places/") or "/photos/" not in name:
        raise HTTPException(status_code=400, detail="Invalid photo name.")
    places: PlacesClient = app.state.places
    resp = await places.photo(name, w)
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Photo unavailable.")
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/api/geocode")
async def geocode(q: str = Query(min_length=1, max_length=200)):
    _require_server_key()
    places: PlacesClient = app.state.places
    try:
        result = await places.geocode(q)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Geocoding error: {e.response.status_code}")
    if result is None:
        raise HTTPException(status_code=404, detail="No results for that location.")
    return result
