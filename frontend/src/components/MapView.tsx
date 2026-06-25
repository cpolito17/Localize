import { Loader } from "@googlemaps/js-api-loader";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { useEffect, useRef } from "react";
import { photoUrl } from "../api";
import { scoreColor } from "../score";
import type { AppConfig, SearchResult } from "../types";

interface Props {
  config: AppConfig;
  initialCenter: { lat: number; lng: number };
  results: SearchResult[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMapReady: (map: google.maps.Map) => void;
  onIdle: (bounds: google.maps.LatLngBoundsLiteral) => void;
}

const INITIAL_ZOOM = 13; // neighborhood/metro scale (§5)

export default function MapView({
  config,
  initialCenter,
  results,
  selectedId,
  onSelect,
  onMapReady,
  onIdle,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  const callbacksRef = useRef({ onSelect, onIdle });
  callbacksRef.current = { onSelect, onIdle };

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    const loader = new Loader({ apiKey: config.mapsBrowserKey, version: "weekly" });
    Promise.all([loader.importLibrary("maps"), loader.importLibrary("marker")]).then(([mapsLib]) => {
      if (cancelled || !containerRef.current) return;
      const map = new mapsLib.Map(containerRef.current, {
        center: initialCenter,
        zoom: INITIAL_ZOOM,
        mapId: config.mapId,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        gestureHandling: "greedy",
      });
      mapRef.current = map;
      infoRef.current = new google.maps.InfoWindow({ disableAutoPan: false });
      clustererRef.current = new MarkerClusterer({
        map,
        markers: [],
        renderer: {
          render: ({ count, position }) =>
            new google.maps.marker.AdvancedMarkerElement({
              position,
              content: clusterElement(count),
              zIndex: 1000 + count,
            }),
        },
      });
      map.addListener("idle", () => {
        const b = map.getBounds();
        if (b) callbacksRef.current.onIdle(b.toJSON());
      });
      map.addListener("click", () => infoRef.current?.close());
      onMapReady(map);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild markers when results change.
  useEffect(() => {
    const map = mapRef.current;
    const clusterer = clustererRef.current;
    if (!map || !clusterer) return;
    infoRef.current?.close();
    clusterer.clearMarkers();
    markersRef.current.clear();

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const markers = results.map((r, i) => {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        position: { lat: r.lat, lng: r.lng },
        content: pinElement(r, reduced ? 0 : i),
        title: r.name,
        zIndex: r.score,
      });
      marker.addListener("click", () => {
        callbacksRef.current.onSelect(r.placeId);
        openBubble(r, marker);
      });
      markersRef.current.set(r.placeId, marker);
      return marker;
    });
    clusterer.addMarkers(markers);
  }, [results]);

  // Card -> pin sync (§7.2): highlight and center the selected pin.
  useEffect(() => {
    markersRef.current.forEach((marker, id) => {
      const el = marker.content as HTMLElement;
      el.classList.toggle("pin-selected", id === selectedId);
      if (id === selectedId) {
        marker.zIndex = 999;
        mapRef.current?.panTo(marker.position as google.maps.LatLngLiteral);
      } else {
        const r = results.find((x) => x.placeId === id);
        marker.zIndex = r ? r.score : 0;
      }
    });
  }, [selectedId, results]);

  function openBubble(r: SearchResult, marker: google.maps.marker.AdvancedMarkerElement) {
    const info = infoRef.current;
    const map = mapRef.current;
    if (!info || !map) return;
    info.setContent(bubbleElement(r));
    info.open({ map, anchor: marker });
  }

  return <div className="mapview" ref={containerRef} />;
}

/** Custom pin (§8): score-scale color, drop-and-settle animation, staggered. */
function pinElement(r: SearchResult, staggerIndex: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "pin pin-drop";
  el.style.setProperty("--pin-color", scoreColor(r.score));
  el.style.animationDelay = `${Math.min(staggerIndex * 40, 600)}ms`;
  el.innerHTML = `<span class="pin-score">${r.score}</span><span class="pin-tip"></span>`;
  return el;
}

function clusterElement(count: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "cluster";
  el.textContent = String(count);
  return el;
}

/** Pin tap bubble (§7.2): name, score badge, rating, thumbnail. */
function bubbleElement(r: SearchResult): HTMLElement {
  const el = document.createElement("div");
  el.className = "bubble";
  const rating =
    r.rating != null
      ? `<span class="bubble-rating">★ ${r.rating.toFixed(1)} (${r.userRatingCount.toLocaleString()})</span>`
      : "";
  const photo = r.photoName
    ? `<img class="bubble-photo" src="${photoUrl(r.photoName, 160)}" alt="" />`
    : "";
  el.innerHTML = `
    ${photo}
    <div class="bubble-text">
      <strong class="bubble-name"></strong>
      <div class="bubble-meta">
        <span class="bubble-score" style="background:${scoreColor(r.score)}">${r.score}</span>
        ${rating}
      </div>
    </div>`;
  (el.querySelector(".bubble-name") as HTMLElement).textContent = r.name;
  return el;
}
