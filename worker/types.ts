export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

// Wrangler generates every configured binding in worker-configuration.d.ts.
// Secrets are intentionally absent from wrangler.jsonc, so this intersection
// supplies only their names while retaining the generated binding surface.
export type WorkerEnv = Env & {
  GOOGLE_MAPS_SERVER_KEY?: string;
  GOOGLE_MAPS_BROWSER_KEY?: string;
  RATE_LIMIT_SECRET?: string;
};

export interface LatLng {
  lat: number;
  lng: number;
}

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

export class HttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfter?: number
  ) {
    super(detail);
  }
}
