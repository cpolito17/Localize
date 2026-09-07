"""The Localize score (§6): denylist hard cap, location-count heuristic,
minor modifiers. Deterministic throughout."""
import asyncio
import weakref
from dataclasses import dataclass, field

from . import config
from .cache import ClassificationCache
from .denylist import Brand, Denylist, normalize_name
from .places import PlacesClient

ECOMMERCE_SCORE = 5
BIGBOX_SCORE = 25

# Place types that indicate big-format retail (minor downward modifier).
BIG_FORMAT_TYPES = {"department_store", "supermarket", "shopping_mall", "warehouse_store"}
BIG_FORMAT_PENALTY = 4

# A single location carrying this many reviews is almost always a
# high-traffic chain outlet (minor downward modifier).
MEGA_REVIEW_THRESHOLD = 4000
MEGA_REVIEW_PENALTY = 5

# location count -> base score (the §6 bands)
def _count_to_score(count: int) -> int:
    if count <= 1:
        return 95
    if count <= 4:
        return 82
    if count <= 8:
        return 72
    if count <= 20:
        return 55
    if count <= 40:
        return 45
    return 30


def tier_for_score(score: int) -> str:
    if score >= 90:
        return "Independent local business"
    if score >= 70:
        return "Small local chain"
    if score >= 40:
        return "Regional chain"
    if score >= 15:
        return "National chain / big-box"
    return "E-commerce giant"


@dataclass
class Classification:
    score: int
    tier: str
    reason: str  # one-line "why" (§6 transparency requirement)
    breakdown: list[str] = field(default_factory=list)
    location_count: int | None = None
    denylisted_brand: str | None = None


class Scorer:
    def __init__(self, denylist: Denylist, cache: ClassificationCache, places: PlacesClient):
        self.denylist = denylist
        self.cache = cache
        self.places = places
        self._count_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )

    def classify_denylisted(self, brand: Brand) -> Classification:
        if brand.kind == "ecommerce":
            return Classification(
                score=ECOMMERCE_SCORE,
                tier=tier_for_score(ECOMMERCE_SCORE),
                reason=f"{brand.brand} is a national e-commerce giant — purchases here don't stay local.",
                breakdown=[
                    f"On the national-retailer list ({brand.brand})",
                    "E-commerce giant — revenue leaves the local economy",
                ],
                denylisted_brand=brand.brand,
            )
        return Classification(
            score=BIGBOX_SCORE,
            tier=tier_for_score(BIGBOX_SCORE),
            reason=f"{brand.brand} is a national big-box chain.",
            breakdown=[
                f"On the national-retailer list ({brand.brand})",
                "National chain with locations across the country",
            ],
            denylisted_brand=brand.brand,
        )

    async def classify(
        self,
        name: str,
        website: str | None,
        types: list[str],
        rating_count: int,
        center: tuple[float, float],
    ) -> Classification:
        brand = self.denylist.match_business(name, website)
        if brand:
            return self.classify_denylisted(brand)

        norm = normalize_name(name)
        if not norm:
            return self._unknown_location_count()

        bucket = self._geo_bucket(center)
        count = self.cache.get_count(norm, bucket)
        if count is None:
            count = await self._count_locations(norm, center, bucket)
            self.cache.set_count(norm, bucket, count)

        if count == 0:
            return self._unknown_location_count()

        score = _count_to_score(count)
        breakdown = []
        if count <= 1:
            breakdown.append("1 location found in this area — independently operated")
        else:
            breakdown.append(f"{count} locations found in the wider area")
        breakdown.append("Not on the national-retailer list")

        if set(types) & BIG_FORMAT_TYPES:
            score -= BIG_FORMAT_PENALTY
            breakdown.append("Big-format store type (slight reduction)")
        if count <= 1 and rating_count >= MEGA_REVIEW_THRESHOLD:
            score -= MEGA_REVIEW_PENALTY
            breakdown.append("Unusually high review volume for one location (slight reduction)")
        score = max(15, min(100, score))

        tier = tier_for_score(score)
        if count <= 1:
            reason = "1 location in this area · independently operated · not on the national-retailer list"
        else:
            reason = f"{count} locations in the wider area · {tier.lower()} · not on the national-retailer list"
        return Classification(
            score=score,
            tier=tier,
            reason=reason,
            breakdown=breakdown,
            location_count=count,
        )

    @staticmethod
    def _geo_bucket(center: tuple[float, float]) -> str:
        """Coarse metro-sized cell so identical names do not leak across regions."""
        lat, lng = center
        return f"{round(lat):+04d}:{round(lng):+04d}"

    @staticmethod
    def _unknown_location_count() -> Classification:
        score = 70
        return Classification(
            score=score,
            tier=tier_for_score(score),
            reason="Other locations could not be verified, so this score is provisional.",
            breakdown=[
                "Location count could not be verified",
                "Not on the national-retailer list",
            ],
            location_count=None,
        )

    async def _count_locations(
        self,
        normalized_name: str,
        center: tuple[float, float],
        bucket: str,
    ) -> int:
        """§6 signal 2: wide-area name search, count matching locations."""
        lock_key = f"{normalized_name}:{bucket}"
        lock = self._count_locks.setdefault(lock_key, asyncio.Lock())
        async with lock:
            cached = self.cache.get_count(normalized_name, bucket)
            if cached is not None:
                return cached
            lat, lng = center
            rect = {
                "south": max(-90.0, lat - config.COUNT_AREA_HALF_LAT),
                "north": min(90.0, lat + config.COUNT_AREA_HALF_LAT),
                "west": max(-180.0, lng - config.COUNT_AREA_HALF_LNG),
                "east": min(180.0, lng + config.COUNT_AREA_HALF_LNG),
            }
            places = await self.places.search_text(
                normalized_name,
                rect,
                max_results=config.COUNT_SEARCH_MAX_RESULTS,
            )
            count = 0
            for p in places:
                pname = normalize_name(p.get("displayName", {}).get("text", ""))
                if pname == normalized_name or pname.startswith(normalized_name + " "):
                    count += 1
            # We deliberately request only one page to cap cost. A full page of
            # exact name matches is enough evidence for the national-chain band.
            if len(places) >= config.COUNT_SEARCH_MAX_RESULTS and count >= len(places):
                return 41
            return count
