"""Viewport thinning (§5): cap the displayed set, spread it geographically
with a grid (best per cell first), keep denylisted results visible."""
import math


def quality_key(r: dict) -> tuple:
    """Rating-weighted ranking proxy used to pick within cells.

    Scores aren't computed yet at thinning time (the location-count lookup
    only runs for displayed candidates, §6), so rating x log(reviews) stands
    in. Denylist status is already known and handled by the caller.
    """
    rating = r.get("rating") or 0
    reviews = r.get("userRatingCount") or 0
    return (rating * math.log10(reviews + 1), reviews)


def thin_results(results: list[dict], bounds: dict, cap: int, grid: int) -> list[dict]:
    """results: candidate dicts with lat/lng/rating/userRatingCount/denylisted."""
    denylisted = [r for r in results if r.get("denylisted")]
    candidates = [r for r in results if not r.get("denylisted")]
    slots = max(0, cap - len(denylisted))
    if len(candidates) <= slots:
        return candidates + denylisted

    lat_span = (bounds["north"] - bounds["south"]) or 1e-9
    lng_span = (bounds["east"] - bounds["west"]) or 1e-9

    def cell(r: dict) -> tuple[int, int]:
        row = min(grid - 1, max(0, int((r["lat"] - bounds["south"]) / lat_span * grid)))
        col = min(grid - 1, max(0, int((r["lng"] - bounds["west"]) / lng_span * grid)))
        return (row, col)

    by_cell: dict[tuple[int, int], list[dict]] = {}
    for r in candidates:
        by_cell.setdefault(cell(r), []).append(r)
    for members in by_cell.values():
        members.sort(key=quality_key, reverse=True)

    # Round-robin: take the best from every cell, then second-best, etc.,
    # so results spread across the viewport before any cell gets a second pick.
    kept: list[dict] = []
    depth = 0
    while len(kept) < slots:
        layer = [m[depth] for m in by_cell.values() if depth < len(m)]
        if not layer:
            break
        layer.sort(key=quality_key, reverse=True)
        kept.extend(layer[: slots - len(kept)])
        depth += 1

    return kept + denylisted
