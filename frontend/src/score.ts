/**
 * The score color scale (§8): one continuous ramp from muted red (0)
 * through amber (50) to vivid green (100). Used by badges AND map pins —
 * defined once, here.
 */

const STOPS: Array<[number, [number, number, number]]> = [
  [0, [0xb4, 0x45, 0x3a]],
  [50, [0xd9, 0xa4, 0x41]],
  [100, [0x2f, 0x9e, 0x5e]],
];

export function scoreColor(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  let lo = STOPS[0];
  let hi = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (s >= STOPS[i][0] && s <= STOPS[i + 1][0]) {
      lo = STOPS[i];
      hi = STOPS[i + 1];
      break;
    }
  }
  const t = hi[0] === lo[0] ? 0 : (s - lo[0]) / (hi[0] - lo[0]);
  const rgb = lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function formatDistance(meters: number): string {
  const miles = meters / 1609.34;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/** §7.6: Apple Maps on iOS, Google Maps everywhere else. */
export function mapsUrl(name: string, lat: number, lng: number, googleMapsUri: string | null): string {
  const isApple = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (isApple) {
    return `https://maps.apple.com/?q=${encodeURIComponent(name)}&ll=${lat},${lng}`;
  }
  return (
    googleMapsUri ??
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${lat},${lng}`)}`
  );
}
