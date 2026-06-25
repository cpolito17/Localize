"""Thin async client for Google Places API (New) and the Geocoding API."""
import httpx

PLACES_BASE = "https://places.googleapis.com/v1"
GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"

SEARCH_FIELDS = ",".join(
    f"places.{f}"
    for f in (
        "id",
        "displayName",
        "location",
        "rating",
        "userRatingCount",
        "types",
        "primaryType",
        "websiteUri",
        "googleMapsUri",
        "photos",
        "businessStatus",
    )
) + ",nextPageToken"

DETAILS_FIELDS = ",".join(
    (
        "id",
        "displayName",
        "formattedAddress",
        "location",
        "rating",
        "userRatingCount",
        "types",
        "websiteUri",
        "googleMapsUri",
        "regularOpeningHours",
        "photos",
        "reviews",
        "businessStatus",
    )
)


class PlacesClient:
    def __init__(self, api_key: str, http: httpx.AsyncClient):
        self.api_key = api_key
        self.http = http

    def _headers(self, field_mask: str) -> dict:
        return {
            "X-Goog-Api-Key": self.api_key,
            "X-Goog-FieldMask": field_mask,
            "Content-Type": "application/json",
        }

    async def search_text(
        self,
        query: str,
        rect: dict | None = None,
        max_results: int = 60,
    ) -> list[dict]:
        """Text search, optionally restricted to a viewport rectangle.

        rect: {"south":..,"west":..,"north":..,"east":..}. Follows
        nextPageToken up to max_results (Google caps text search at ~60).
        """
        results: list[dict] = []
        token: str | None = None
        while True:
            body: dict = {"textQuery": query, "pageSize": 20}
            if rect:
                body["locationRestriction"] = {
                    "rectangle": {
                        "low": {"latitude": rect["south"], "longitude": rect["west"]},
                        "high": {"latitude": rect["north"], "longitude": rect["east"]},
                    }
                }
            if token:
                body["pageToken"] = token
            resp = await self.http.post(
                f"{PLACES_BASE}/places:searchText",
                json=body,
                headers=self._headers(SEARCH_FIELDS),
            )
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("places", []))
            token = data.get("nextPageToken")
            if not token or len(results) >= max_results:
                break
        return results[:max_results]

    async def details(self, place_id: str) -> dict:
        resp = await self.http.get(
            f"{PLACES_BASE}/places/{place_id}",
            headers=self._headers(DETAILS_FIELDS),
        )
        resp.raise_for_status()
        return resp.json()

    async def photo(self, photo_name: str, max_width: int) -> httpx.Response:
        """Fetch photo bytes (the media endpoint 302s to the image)."""
        return await self.http.get(
            f"{PLACES_BASE}/{photo_name}/media",
            params={"maxWidthPx": max_width, "key": self.api_key},
            follow_redirects=True,
        )

    async def geocode(self, address: str) -> dict | None:
        resp = await self.http.get(
            GEOCODE_URL, params={"address": address, "key": self.api_key}
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])
        if not results:
            return None
        top = results[0]
        loc = top["geometry"]["location"]
        return {
            "lat": loc["lat"],
            "lng": loc["lng"],
            "formattedAddress": top.get("formatted_address", address),
        }
