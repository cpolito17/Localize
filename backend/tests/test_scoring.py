import asyncio

import pytest

from app.cache import ClassificationCache
from app.denylist import Denylist
from app.scoring import Scorer, tier_for_score


class FakePlaces:
    """Stands in for PlacesClient in the location-count search."""

    def __init__(self, locations_by_name: dict[str, int]):
        self.locations_by_name = locations_by_name
        self.search_calls = 0

    async def search_text(self, query, rect=None, max_results=60):
        self.search_calls += 1
        n = self.locations_by_name.get(query, 1)
        return [
            {"displayName": {"text": query.title()}, "id": f"p{i}"}
            for i in range(min(n, max_results))
        ]


@pytest.fixture
def scorer(tmp_path):
    def make(locations: dict[str, int]):
        fake = FakePlaces(locations)
        cache = ClassificationCache(str(tmp_path / "cache.db"))
        return Scorer(Denylist.load(), cache, fake), fake

    return make


def classify(scorer, name, website=None, types=None, rating_count=100):
    return asyncio.run(
        scorer.classify(name, website, types or [], rating_count, (42.28, -83.74))
    )


def test_denylisted_bigbox_forced_to_band(scorer):
    s, _ = scorer({})
    cls = classify(s, "The Home Depot", "https://www.homedepot.com/l/123")
    assert 15 <= cls.score <= 39
    assert cls.denylisted_brand == "Home Depot"
    assert "national" in cls.reason.lower() or "big-box" in cls.reason.lower()


def test_denylisted_ecommerce_forced_to_bottom(scorer):
    s, _ = scorer({})
    cls = classify(s, "Amazon Fresh", "https://www.amazon.com")
    assert 0 <= cls.score <= 14
    assert cls.tier == "E-commerce giant"


def test_single_location_is_top_band(scorer):
    s, _ = scorer({"joes hardware": 1})
    cls = classify(s, "Joe's Hardware")
    assert 90 <= cls.score <= 100
    assert cls.location_count == 1
    assert "independently operated" in cls.reason


def test_small_chain_band(scorer):
    s, _ = scorer({"ann arbor running co": 3})
    cls = classify(s, "Ann Arbor Running Co")
    assert 70 <= cls.score <= 89
    assert cls.location_count == 3


def test_regional_chain_band(scorer):
    s, _ = scorer({"midwest mart": 15})
    cls = classify(s, "Midwest Mart")
    assert 40 <= cls.score <= 69


def test_many_locations_treated_as_national(scorer):
    s, _ = scorer({"everywhere store": 60})
    cls = classify(s, "Everywhere Store")
    assert 15 <= cls.score <= 39


def test_modifiers_nudge_down(scorer):
    s, _ = scorer({"big mart": 1, "small shop": 1})
    plain = classify(s, "Small Shop")
    dept = classify(s, "Big Mart", types=["department_store"], rating_count=5000)
    assert dept.score < plain.score
    assert plain.score - dept.score <= 10  # tiebreakers, not drivers


def test_count_is_cached(scorer):
    s, fake = scorer({"joes hardware": 1})
    classify(s, "Joe's Hardware")
    calls_after_first = fake.search_calls
    classify(s, "Joe's Hardware")
    assert fake.search_calls == calls_after_first


def test_zero_verified_locations_is_provisional(scorer):
    s, _ = scorer({"unverified shop": 0})
    cls = classify(s, "Unverified Shop")
    assert cls.score == 70
    assert cls.location_count is None
    assert "provisional" in cls.reason


def test_location_count_cache_is_scoped_to_geo_bucket(scorer):
    s, fake = scorer({"joes hardware": 1})
    asyncio.run(s.classify("Joe's Hardware", None, [], 10, (42.28, -83.74)))
    asyncio.run(s.classify("Joe's Hardware", None, [], 10, (34.05, -118.24)))
    assert fake.search_calls == 2


def test_denylist_check_needs_no_search(scorer):
    s, fake = scorer({})
    classify(s, "Walmart Supercenter")
    assert fake.search_calls == 0


def test_tier_labels():
    assert tier_for_score(95) == "Independent local business"
    assert tier_for_score(75) == "Small local chain"
    assert tier_for_score(50) == "Regional chain"
    assert tier_for_score(25) == "National chain / big-box"
    assert tier_for_score(5) == "E-commerce giant"
