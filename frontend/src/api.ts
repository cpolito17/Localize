import type { AppConfig, Bounds, PlaceDetails, SearchResponse } from "./types";

// Vite's BASE_URL is "/localize/" in the built app, so API calls resolve to
// /localize/api/* — served by the Worker behind Cloudflare Access.
const API_BASE = `${import.meta.env.BASE_URL}api`;

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
  config: () => request<AppConfig>(`${API_BASE}/config`),

  search: (query: string, bounds: Bounds, userLocation: { lat: number; lng: number } | null) =>
    request<SearchResponse>(`${API_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, bounds, userLocation }),
    }),

  place: (placeId: string) =>
    request<PlaceDetails>(`${API_BASE}/place/${encodeURIComponent(placeId)}`),

  geocode: (q: string) =>
    request<{ lat: number; lng: number; formattedAddress: string }>(
      `${API_BASE}/geocode?q=${encodeURIComponent(q)}`
    ),
};

export function photoUrl(name: string, width = 480): string {
  return `${API_BASE}/photo?name=${encodeURIComponent(name)}&w=${width}`;
}
