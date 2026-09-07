import { UPSTREAM_TIMEOUT_MS } from "./config";
import { HttpError, type Bounds, type RawPlace } from "./types";
import { UsageLimiter } from "./usage";

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
    .map((field) => `places.${field}`)
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
  constructor(
    private readonly apiKey: string,
    private readonly limiter: UsageLimiter
  ) {}

  private headers(fieldMask: string): HeadersInit {
    return {
      "X-Goog-Api-Key": this.apiKey,
      "X-Goog-FieldMask": fieldMask,
      "Content-Type": "application/json",
    };
  }

  private async googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
    await this.limiter.consumeGoogleCall();
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch {
      throw new HttpError(502, "Couldn't reach Google Maps. Please try again.");
    }
    return response;
  }

  async searchText(query: string, rect?: Bounds, maxResults = 20): Promise<RawPlace[]> {
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
      const response = await this.googleFetch(`${PLACES_BASE}/places:searchText`, {
        method: "POST",
        headers: this.headers(SEARCH_FIELDS),
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new HttpError(502, "Google Places is temporarily unavailable.");
      const data = (await response.json()) as { places?: RawPlace[]; nextPageToken?: string };
      results.push(...(data.places ?? []));
      token = data.nextPageToken;
      if (!token || results.length >= maxResults) break;
    }
    return results.slice(0, maxResults);
  }

  async details(placeId: string): Promise<RawPlace> {
    const response = await this.googleFetch(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: this.headers(DETAILS_FIELDS),
    });
    if (!response.ok) throw new HttpError(502, "Google Places is temporarily unavailable.");
    return (await response.json()) as RawPlace;
  }

  async photo(photoName: string, maxWidth: number): Promise<Response> {
    const url =
      `${PLACES_BASE}/${photoName}/media?maxWidthPx=${maxWidth}` +
      `&key=${encodeURIComponent(this.apiKey)}`;
    return this.googleFetch(url, { redirect: "follow" });
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    const url =
      `${GEOCODE_URL}?address=${encodeURIComponent(address)}` +
      `&key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.googleFetch(url);
    if (!response.ok) throw new HttpError(502, "Google Maps is temporarily unavailable.");
    const data = (await response.json()) as {
      results?: Array<{
        geometry?: { location?: { lat?: number; lng?: number } };
        formatted_address?: string;
      }>;
    };
    const top = data.results?.[0];
    const lat = top?.geometry?.location?.lat;
    const lng = top?.geometry?.location?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return { lat, lng, formattedAddress: top?.formatted_address ?? address };
  }
}
