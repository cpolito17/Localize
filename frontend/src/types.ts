export interface AppConfig {
  appName: string;
  tagline: string;
  mapsBrowserKey: string;
  mapId: string;
  anonymousDailySearchLimit: number;
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface SearchResult {
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
  score: number;
  tier: string;
  reason: string;
  breakdown: string[];
  locationCount: number | null;
  denylistedBrand: string | null;
  distanceMeters: number;
}

export interface SearchResponse {
  results: SearchResult[];
  totalFound: number;
  pivot: { brand: string; category: string } | null;
}

export interface Review {
  rating: number | null;
  text: string;
  author: string;
  relativeTime: string;
}

export interface PlaceDetails {
  placeId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  userRatingCount: number;
  websiteUri: string | null;
  googleMapsUri: string | null;
  openingHours: string[];
  openNow: boolean | null;
  photoNames: string[];
  reviews: Review[];
  score: number;
  tier: string;
  reason: string;
  breakdown: string[];
  locationCount: number | null;
}
