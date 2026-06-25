import { AnimatePresence, motion } from "framer-motion";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import BottomSheet from "./components/BottomSheet";
import DetailPanel from "./components/DetailPanel";
import MapView from "./components/MapView";
import ResultsList, { SortMode } from "./components/ResultsList";
import SearchBar from "./components/SearchBar";
import type { AppConfig, Bounds, SearchResult } from "./types";

const DEFAULT_QUERY = "local shops";
const SPARSE_THRESHOLD = 4;

type Phase = "boot" | "locate" | "manual-location" | "ready" | "no-key";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const fn = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return mobile;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);

  const [results, setResults] = useState<SearchResult[]>([]);
  const [pivot, setPivot] = useState<{ brand: string; category: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [moved, setMoved] = useState(false);
  const [sort, setSort] = useState<SortMode>("score");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  const mapRef = useRef<google.maps.Map | null>(null);
  const lastQueryRef = useRef(DEFAULT_QUERY);
  const lastBoundsRef = useRef<Bounds | null>(null);
  const searchOnNextIdleRef = useRef(false);
  const userLocRef = useRef<{ lat: number; lng: number } | null>(null);
  const isMobile = useIsMobile();

  // Boot: config, then geolocate (§5).
  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg);
        if (!cfg.mapsBrowserKey) {
          setPhase("no-key");
          return;
        }
        setPhase("locate");
        if (!navigator.geolocation) {
          setPhase("manual-location");
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            userLocRef.current = loc;
            setCenter(loc);
            setPhase("ready");
          },
          () => setPhase("manual-location"),
          { timeout: 8000, maximumAge: 300000 }
        );
      })
      .catch(() => setPhase("no-key"));
  }, []);

  const runSearch = useCallback(async (query: string, bounds: Bounds) => {
    lastQueryRef.current = query;
    lastBoundsRef.current = bounds;
    setLoading(true);
    setSearchError(null);
    setMoved(false);
    setSelectedId(null);
    try {
      const data = await api.search(query, bounds, userLocRef.current);
      setResults(data.results);
      setPivot(data.pivot);
    } catch (e) {
      setResults([]);
      setPivot(null);
      setSearchError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setLoading(false);
      setHasSearched(true);
    }
  }, []);

  // Map idle: run the automatic first search, honor a queued zoom-out
  // search, otherwise toggle "Search this area" when the viewport moved (§5).
  const handleIdle = useCallback(
    (bounds: google.maps.LatLngBoundsLiteral) => {
      if (!lastBoundsRef.current || searchOnNextIdleRef.current) {
        searchOnNextIdleRef.current = false;
        runSearch(lastQueryRef.current, bounds);
        return;
      }
      const last = lastBoundsRef.current;
      const latSpan = last.north - last.south || 1e-9;
      const lngSpan = last.east - last.west || 1e-9;
      const movedNow =
        Math.abs(bounds.north - last.north) / latSpan > 0.02 ||
        Math.abs(bounds.south - last.south) / latSpan > 0.02 ||
        Math.abs(bounds.east - last.east) / lngSpan > 0.02 ||
        Math.abs(bounds.west - last.west) / lngSpan > 0.02;
      setMoved(movedNow);
    },
    [runSearch]
  );

  function searchThisArea() {
    const b = mapRef.current?.getBounds();
    if (b) runSearch(lastQueryRef.current, b.toJSON());
  }

  function handleQuery(q: string) {
    const b = mapRef.current?.getBounds();
    if (b) runSearch(q, b.toJSON());
  }

  function zoomOutAndSearch() {
    const map = mapRef.current;
    if (!map) return;
    searchOnNextIdleRef.current = true;
    map.setZoom((map.getZoom() ?? 13) - 2);
  }

  async function handleManualLocation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = (e.currentTarget.elements.namedItem("location") as HTMLInputElement).value.trim();
    if (!input) return;
    setGeoError(null);
    try {
      const loc = await api.geocode(input);
      setCenter({ lat: loc.lat, lng: loc.lng });
      setPhase("ready");
    } catch (err) {
      setGeoError(err instanceof Error ? err.message : "Couldn't find that location.");
    }
  }

  if (phase === "boot") return <div className="boot" />;

  if (phase === "no-key") {
    return (
      <Hero tagline={config?.tagline}>
        <p className="hero-note">
          The backend isn't configured with Google Maps API keys yet. Set{" "}
          <code>GOOGLE_MAPS_BROWSER_KEY</code> and <code>GOOGLE_MAPS_SERVER_KEY</code> and restart.
        </p>
      </Hero>
    );
  }

  if (phase === "locate") {
    return (
      <Hero tagline={config?.tagline}>
        <p className="hero-note hero-pulse">Finding what's near you…</p>
      </Hero>
    );
  }

  if (phase === "manual-location" || !center || !config) {
    return (
      <Hero tagline={config?.tagline}>
        <form className="hero-locate" onSubmit={handleManualLocation}>
          <input
            name="location"
            type="text"
            placeholder="Enter a city, neighborhood, or address"
            aria-label="Your location"
            autoFocus
          />
          <button type="submit" className="btn btn-primary">
            Go
          </button>
        </form>
        {geoError && <p className="hero-error">{geoError}</p>}
      </Hero>
    );
  }

  const sparse = hasSearched && !loading && !searchError && results.length < SPARSE_THRESHOLD;

  const listProps = {
    results,
    sort,
    onSortChange: setSort,
    selectedId,
    onSelect: setSelectedId,
    onOpenDetail: setDetailId,
    loading,
    sparse,
    onZoomOut: zoomOutAndSearch,
    pivot,
  };

  return (
    <div className={`app ${isMobile ? "app-mobile" : "app-desktop"}`}>
      {!isMobile && (
        <aside className="sidebar">
          <header className="sidebar-header">
            <Logo />
            <p className="tagline">{config.tagline}</p>
            <SearchBar compact={false} onSearch={handleQuery} />
          </header>
          {searchError ? <ErrorNote message={searchError} /> : <ResultsList {...listProps} />}
        </aside>
      )}

      <div className="map-area">
        <MapView
          config={config}
          initialCenter={center}
          results={results}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMapReady={(m) => {
            mapRef.current = m;
          }}
          onIdle={handleIdle}
        />

        {isMobile && (
          <div className="mobile-top">
            <SearchBar compact onSearch={handleQuery} />
          </div>
        )}

        <AnimatePresence>
          {moved && !loading && (
            <motion.button
              className="search-area-btn"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              onClick={searchThisArea}
            >
              Search this area
            </motion.button>
          )}
        </AnimatePresence>

        {loading && (
          <div className="loading-pill" role="status">
            <span className="loading-dot" />
            Searching nearby…
          </div>
        )}
      </div>

      {isMobile && (
        <BottomSheet>
          {searchError ? <ErrorNote message={searchError} /> : <ResultsList {...listProps} />}
        </BottomSheet>
      )}

      <DetailPanel placeId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function Logo() {
  return (
    <h1 className="logo">
      <svg viewBox="0 0 100 100" width="26" height="26" aria-hidden="true">
        <circle cx="50" cy="50" r="46" fill="#2F7A4F" />
        <path
          d="M50 86 C40 72 30 61 30 46 a20 20 0 1 1 40 0 C70 61 60 72 50 86Z"
          fill="none"
          stroke="#FAF7F0"
          strokeWidth="7"
        />
        <circle cx="50" cy="45" r="8" fill="#FAF7F0" />
      </svg>
      Localize
    </h1>
  );
}

function Hero({ tagline, children }: { tagline?: string; children: React.ReactNode }) {
  return (
    <div className="hero">
      <motion.div
        className="hero-inner"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <Logo />
        <p className="tagline tagline-hero">{tagline ?? "Find it nearby. Keep it local."}</p>
        {children}
      </motion.div>
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="error-note">
      <p>{message}</p>
    </div>
  );
}
