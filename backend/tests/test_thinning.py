import random

from app.thinning import thin_results

BOUNDS = {"south": 42.0, "north": 43.0, "west": -84.0, "east": -83.0}


def biz(lat, lng, rating=4.5, reviews=100, denylisted=False, name="x"):
    return {
        "name": name,
        "lat": lat,
        "lng": lng,
        "rating": rating,
        "userRatingCount": reviews,
        "denylisted": denylisted,
    }


def test_no_thinning_when_under_cap():
    results = [biz(42.5, -83.5) for _ in range(10)]
    assert len(thin_results(results, BOUNDS, cap=36, grid=6)) == 10


def test_caps_total():
    rng = random.Random(7)
    results = [
        biz(rng.uniform(42.0, 43.0), rng.uniform(-84.0, -83.0)) for _ in range(120)
    ]
    assert len(thin_results(results, BOUNDS, cap=36, grid=6)) == 36


def test_geographic_spread():
    # 50 great results clumped in one corner, 5 mediocre spread elsewhere:
    # the spread ones must survive thinning to a 20 cap.
    clump = [biz(42.05, -83.95, rating=5.0, reviews=1000) for _ in range(50)]
    spread = [
        biz(42.9, -83.1, rating=3.5, reviews=10, name="far1"),
        biz(42.5, -83.5, rating=3.5, reviews=10, name="far2"),
        biz(42.9, -83.9, rating=3.5, reviews=10, name="far3"),
        biz(42.1, -83.1, rating=3.5, reviews=10, name="far4"),
        biz(42.6, -83.2, rating=3.5, reviews=10, name="far5"),
    ]
    kept = thin_results(clump + spread, BOUNDS, cap=20, grid=6)
    kept_names = {r["name"] for r in kept}
    assert {"far1", "far2", "far3", "far4", "far5"} <= kept_names
    assert len(kept) == 20


def test_denylisted_always_kept():
    rng = random.Random(3)
    results = [
        biz(rng.uniform(42.0, 43.0), rng.uniform(-84.0, -83.0)) for _ in range(100)
    ]
    results.append(biz(42.5, -83.5, rating=3.0, reviews=50000, denylisted=True, name="Walmart"))
    kept = thin_results(results, BOUNDS, cap=30, grid=6)
    assert any(r["name"] == "Walmart" for r in kept)
    assert len(kept) == 30


def test_best_per_cell_wins():
    a = biz(42.5, -83.5, rating=5.0, reviews=500, name="best")
    b = biz(42.5001, -83.5001, rating=3.0, reviews=5, name="worst")
    others = [
        biz(42.0 + 0.17 * i, -84.0 + 0.17 * j, rating=4.0, reviews=50)
        for i in range(6)
        for j in range(6)
    ]
    kept = thin_results([a, b] + others, BOUNDS, cap=30, grid=6)
    names = {r["name"] for r in kept}
    assert "best" in names
