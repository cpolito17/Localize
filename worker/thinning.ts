import type { Bounds, Candidate } from "./types";

function quality(candidate: Candidate): [number, number] {
  return [(candidate.rating ?? 0) * Math.log10(candidate.userRatingCount + 1), candidate.userRatingCount];
}

function sortByQuality(candidates: Candidate[]): void {
  candidates.sort((left, right) => {
    const a = quality(left);
    const b = quality(right);
    return b[0] - a[0] || b[1] - a[1];
  });
}

export function thinResults(results: Candidate[], bounds: Bounds, cap: number, grid: number): Candidate[] {
  const denylisted = results.filter((result) => result.denylisted);
  const candidates = results.filter((result) => !result.denylisted);
  const slots = Math.max(0, cap - denylisted.length);
  if (candidates.length <= slots) return [...candidates, ...denylisted];

  const latSpan = bounds.north - bounds.south || 1e-9;
  const lngSpan = bounds.east - bounds.west || 1e-9;
  const cells = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const row = Math.min(
      grid - 1,
      Math.max(0, Math.floor(((candidate.lat - bounds.south) / latSpan) * grid))
    );
    const column = Math.min(
      grid - 1,
      Math.max(0, Math.floor(((candidate.lng - bounds.west) / lngSpan) * grid))
    );
    const key = `${row},${column}`;
    const cell = cells.get(key) ?? [];
    cell.push(candidate);
    cells.set(key, cell);
  }
  for (const cell of cells.values()) sortByQuality(cell);

  const kept: Candidate[] = [];
  for (let depth = 0; kept.length < slots; depth += 1) {
    const layer = [...cells.values()].flatMap((cell) => (cell[depth] ? [cell[depth]] : []));
    if (layer.length === 0) break;
    sortByQuality(layer);
    kept.push(...layer.slice(0, slots - kept.length));
  }
  return [...kept, ...denylisted];
}
