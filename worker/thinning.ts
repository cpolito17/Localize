// Viewport thinning (§5): cap the displayed set, spread it geographically
// with a grid (best per cell first), keep denylisted results visible.
// Faithful port of backend/app/thinning.py.
import type { Candidate } from "./types";
import type { Bounds } from "./types";

/** Rating-weighted ranking proxy used to pick within cells (scores aren't
 * computed yet at thinning time). Compared lexicographically, descending. */
function qualityKey(r: Candidate): [number, number] {
  const rating = r.rating ?? 0;
  const reviews = r.userRatingCount ?? 0;
  return [rating * Math.log10(reviews + 1), reviews];
}

function keyGreater(a: [number, number], b: [number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

function sortByQualityDesc(arr: Candidate[]): void {
  arr.sort((x, y) => (keyGreater(qualityKey(x), qualityKey(y)) ? -1 : 1));
}

export function thinResults(
  results: Candidate[],
  bounds: Bounds,
  cap: number,
  grid: number
): Candidate[] {
  const denylisted = results.filter((r) => r.denylisted);
  const candidates = results.filter((r) => !r.denylisted);
  const slots = Math.max(0, cap - denylisted.length);
  if (candidates.length <= slots) return [...candidates, ...denylisted];

  const latSpan = bounds.north - bounds.south || 1e-9;
  const lngSpan = bounds.east - bounds.west || 1e-9;

  const cellOf = (r: Candidate): string => {
    const row = Math.min(grid - 1, Math.max(0, Math.floor(((r.lat - bounds.south) / latSpan) * grid)));
    const col = Math.min(grid - 1, Math.max(0, Math.floor(((r.lng - bounds.west) / lngSpan) * grid)));
    return `${row},${col}`;
  };

  const byCell = new Map<string, Candidate[]>();
  for (const r of candidates) {
    const k = cellOf(r);
    const arr = byCell.get(k);
    if (arr) arr.push(r);
    else byCell.set(k, [r]);
  }
  for (const members of byCell.values()) sortByQualityDesc(members);

  // Round-robin: take the best from every cell, then second-best, etc., so
  // results spread across the viewport before any cell gets a second pick.
  const kept: Candidate[] = [];
  let depth = 0;
  while (kept.length < slots) {
    const layer: Candidate[] = [];
    for (const members of byCell.values()) {
      if (depth < members.length) layer.push(members[depth]);
    }
    if (layer.length === 0) break;
    sortByQualityDesc(layer);
    kept.push(...layer.slice(0, slots - kept.length));
    depth += 1;
  }

  return [...kept, ...denylisted];
}
