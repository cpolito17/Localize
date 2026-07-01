// Shared shapes for the Localize Worker.

export interface Env {
  // Static-asset binding (the built frontend under frontend/dist).
  ASSETS: Fetcher;
  // KV cache of derived location counts (replaces the old SQLite cache).
  CACHE: KVNamespace;
  // Secret — Places API (New) + Geocoding, used only server-side in the Worker.
  GOOGLE_MAPS_SERVER_KEY: string;
  // Secret — Maps JavaScript API only, referrer-locked; served to the browser.
  GOOGLE_MAPS_BROWSER_KEY: string;
  // Non-secret Map ID for Advanced Markers (defaults to DEMO_MAP_ID).
  GOOGLE_MAPS_MAP_ID?: string;
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Our candidate shape, mapped from a raw Places result. */
export interface Candidate {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  rating: number | null;
  userRatingCount: number;
  types: string[];
  websiteUri: string | null;
  googleMapsUri: string | null;
  photoName: string | null;
  // Enriched during scoring.
  denylisted?: boolean;
  score?: number;
  tier?: string;
  reason?: string;
  breakdown?: string[];
  locationCount?: number | null;
  denylistedBrand?: string | null;
  distanceMeters?: number;
}

export interface Classification {
  score: number;
  tier: string;
  reason: string;
  breakdown: string[];
  locationCount: number | null;
  denylistedBrand: string | null;
}

// A raw Places API (New) place object (only the fields we read).
export interface RawPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  types?: string[];
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
  photos?: Array<{ name: string }>;
  regularOpeningHours?: { weekdayDescriptions?: string[]; openNow?: boolean };
  reviews?: Array<{
    rating?: number;
    text?: { text?: string };
    authorAttribution?: { displayName?: string };
    relativePublishTimeDescription?: string;
  }>;
}

// A thrown error that carries an HTTP status, mirroring FastAPI's HTTPException.
export class HttpError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}
