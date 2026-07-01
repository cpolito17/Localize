// Thin client for Google Places API (New) and the Geocoding API.
// Faithful port of backend/app/places.py (httpx -> fetch).
import { HttpError, type Bounds, type RawPlace } from "./types";

const PLACES_BASE = "https://places.googleapis.com/v1";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

const SEARCH_FIELDS =
  [
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
  ]
    .map((f) => `places.${f}`)
    .join(",") + ",nextPageToken";

const DETAILS_FIELDS = [
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
].join(",");

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

export class PlacesClient {
  constructor(private readonly apiKey: string) {}

  private headers(fieldMask: string): HeadersInit {
    return {
      "X-Goog-Api-Key": this.apiKey,
      "X-Goog-FieldMask": fieldMask,
      "Content-Type": "application/json",
    };
  }

  /** Text search, optionally restricted to a viewport rectangle. Follows
   * nextPageToken up to maxResults (Google caps text search at ~60). */
  async searchText(query: string, rect?: Bounds, maxResults = 60): Promise<RawPlace[]> {
    const results: RawPlace[] = [];
    let token: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = { textQuery: query, pageSize: 20 };
      if (rect) {
        body.locationRestriction = {
          rectangle: {
            low: { latitude: rect.south, longitude: rect.west },
            high: { latitude: rect.north, longitude: rect.east },
          },
        };
      }
      if (token) body.pageToken = token;
      const resp = await fetch(`${PLACES_BASE}/places:searchText`, {
        method: "POST",
        headers: this.headers(SEARCH_FIELDS),
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new HttpError(502, `Google Places error: ${resp.status}`);
      const data = (await resp.json()) as { places?: RawPlace[]; nextPageToken?: string };
      if (data.places) results.push(...data.places);
      token = data.nextPageToken;
      if (!token || results.length >= maxResults) break;
    }
    return results.slice(0, maxResults);
  }

  async details(placeId: string): Promise<RawPlace> {
    const resp = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: this.headers(DETAILS_FIELDS),
    });
    if (!resp.ok) throw new HttpError(502, `Google Places error: ${resp.status}`);
    return (await resp.json()) as RawPlace;
  }

  /** Fetch photo bytes (the media endpoint 302s to the image; fetch follows it). */
  async photo(photoName: string, maxWidth: number): Promise<Response> {
    const url = `${PLACES_BASE}/${photoName}/media?maxWidthPx=${maxWidth}&key=${encodeURIComponent(
      this.apiKey
    )}`;
    return fetch(url, { redirect: "follow" });
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${encodeURIComponent(
      this.apiKey
    )}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new HttpError(502, `Geocoding error: ${resp.status}`);
    const data = (await resp.json()) as {
      results?: Array<{
        geometry: { location: { lat: number; lng: number } };
        formatted_address?: string;
      }>;
    };
    const results = data.results ?? [];
    if (results.length === 0) return null;
    const top = results[0];
    const loc = top.geometry.location;
    return { lat: loc.lat, lng: loc.lng, formattedAddress: top.formatted_address ?? address };
  }
}
