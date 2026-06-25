import type { AppConfig, Bounds, PlaceDetails, SearchResponse } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* keep generic message */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  config: () => request<AppConfig>("/api/config"),

  search: (query: string, bounds: Bounds, userLocation: { lat: number; lng: number } | null) =>
    request<SearchResponse>("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, bounds, userLocation }),
    }),

  place: (placeId: string) => request<PlaceDetails>(`/api/place/${encodeURIComponent(placeId)}`),

  geocode: (q: string) =>
    request<{ lat: number; lng: number; formattedAddress: string }>(
      `/api/geocode?q=${encodeURIComponent(q)}`
    ),
};

export function photoUrl(name: string, width = 480): string {
  return `/api/photo?name=${encodeURIComponent(name)}&w=${width}`;
}
