# PROJECT.md — Localize

*The onboarding doc. Read this before touching anything. Operational commands and rules live in [CLAUDE.md](CLAUDE.md); known problems live in [GAPS.md](GAPS.md); the original product spec is [localize-spec.md](localize-spec.md).*

## What this is

Localize is a single-page web app that redirects everyday purchases toward locally-owned businesses. A user searches the way they think about a purchase — a brand ("Home Depot"), a category ("furniture"), or a product ("AA batteries") — and gets nearby businesses on a map and in a list, each with a **Localize score** (0–100) saying how "local" it is. Independently-owned single-location shops score ~90+; national big-box chains ~25; e-commerce giants ~5. Big-box results are deliberately *shown* with their low scores rather than hidden — the contrast is the persuasion.

It's for ordinary shoppers who would prefer local but won't do the research. There are no accounts, no persistence between sessions, no monetization. Mobile-first. Built as v1 against a detailed spec (`localize-spec.md`) whose core value is stated in §2: **trust is the product** — every score must be honest and explainable in one sentence, and every business must be real and operating. When making tradeoffs, prefer a shorter honest result list over a longer padded one.

One deliberate constraint you must not "fix": **there is no LLM anywhere**. Query interpretation, scoring, and result thinning are all deterministic. This is a settled product decision (spec §3).

## Tech stack and why

| Piece | Choice | Why |
|---|---|---|
| Backend | Python 3.12 + FastAPI + httpx + uvicorn | Spec-recommended; the backend is pure API orchestration (proxy Google, score, cache), which async FastAPI fits. Only 3 runtime deps. |
| Data source | Google Places API (New) + Geocoding API | The single source of truth for businesses. The *New* Places API specifically, because its text search accepts a rectangular `locationRestriction` — the whole "viewport is the search area" model depends on that. |
| Cache | SQLite (stdlib `sqlite3`, one table) | Caches only *derived* data (normalized name → location count, 30-day TTL). Google's terms prohibit caching their display content, so photos/reviews/ratings are fetched live every time. SQLite because it's one file, zero ops, on a personal server. |
| Frontend | React 18 + TypeScript + Vite | Spec-fixed React; Vite for fast dev with a `/api` proxy. No state library — plain `useState`/`useRef` in one ~300-line `App.tsx` is genuinely enough for this app's state. |
| Map | Google Maps JavaScript API via `@googlemaps/js-api-loader`, `AdvancedMarkerElement`, `@googlemaps/markerclusterer` | Spec-fixed. Advanced markers allow fully custom DOM pins (score-colored). Clusterer keeps zoomed-out maps legible. |
| Animation | Framer Motion | The spec makes motion part of the brand (spring bottom sheet, staggered cards, filling score dials). All animation respects `prefers-reduced-motion`. |
| Deployment | Docker Compose: nginx container (static frontend + `/api` reverse proxy) + backend container | Self-hosted on a personal Linux server. nginx makes the app same-origin so there's no CORS anywhere — that's intentional, don't add CORS middleware. |

**Two Google API keys, and the distinction is security-critical:** a **server key** (IP-restricted; Places New + Geocoding) that lives only in the backend, and a **browser key** (HTTP-referrer-restricted; Maps JS API *only*) that the backend hands to the frontend via `/api/config`. The browser key being visible in network traffic is expected and safe *only because* of its restrictions. Never let the server key reach the frontend.

## Architecture

```
Browser (React SPA)
  │  loads Maps JS with browser key (from /api/config)
  │
  │  /api/* (same origin)
  ▼
nginx (frontend container, port 8080→80)
  │  serves built SPA, proxies /api/ → backend:8000
  ▼
FastAPI backend (backend container)
  ├─ /api/config   → app name, tagline, browser key, map id
  ├─ /api/health
  ├─ /api/search   → the core endpoint (POST: query + viewport bounds + user location)
  ├─ /api/place/{id} → detail view data (address, hours, reviews, score breakdown)
  ├─ /api/photo    → proxies Places photo bytes (so the server key never leaks)
  └─ /api/geocode  → manual-location fallback
        │
        ▼ (server key)
  Google Places API (New) + Geocoding API
        │
  SQLite cache (/data/localize-cache.db in Docker)
     only: normalized_name → location_count, 30-day TTL
```

### Backend modules (`backend/app/`)

- **`main.py`** — FastAPI app, request/response shaping, and the search orchestration (see "the search flow" below). Everything wired in `lifespan`: one shared `httpx.AsyncClient`, `PlacesClient`, `ClassificationCache`, `Denylist`, `Scorer`, all hung on `app.state`.
- **`places.py`** — thin async Google client. `search_text` follows `nextPageToken` pagination (20/page, ~60 max), takes an optional viewport rectangle. Also `details`, `photo`, `geocode`. Field masks are constants at the top — Google bills by field, so don't add fields casually.
- **`denylist.py` + `denylist.json`** — signal 1 of the score. ~80 operator-curated brands, each with `aliases`, website `domains`, `kind` (`bigbox`|`ecommerce`), and a `category` keyword. `normalize_name()` here is the canonical name normalizer used *everywhere* (matching, cache keys, count queries) — change it and every cached key silently misses. `match_query` (exact normalized match → search pivot) and `match_business` (name exact-or-word-prefix, or website-domain suffix match → hard score cap).
- **`scoring.py`** — the Localize score. Denylisted → fixed 5 (ecommerce) or 25 (bigbox). Otherwise: wide-area (~2°×2.5° box around the search center) Places name search, count results whose normalized name matches; count → banded base score (1→95, ≤4→82, ≤8→72, ≤20→55, ≤40→45, else 30); then small penalties (big-format store type −4; ≥4000 reviews on a single location −5); floor 15 for non-denylisted. Every classification carries a one-line `reason` and a `breakdown` list — the transparency requirement. Per-name `asyncio.Lock`s prevent duplicate concurrent count searches.
- **`cache.py`** — the SQLite table. `get_count` returns `None` past TTL; `set_count` upserts.
- **`thinning.py`** — pure function, viewport thinning (spec §5). Denylisted results are *always* kept (product decision: contrast must survive thinning). The rest: bucket into a 6×6 grid over the viewport, sort each cell by `rating × log10(reviews+1)`, take round-robin best-per-cell until the cap (36). This runs *before* scoring, so it uses rating/reviews as a quality proxy — scores don't exist yet by design (cost control).

### The search flow (the critical path)

`POST /api/search` in `main.py:104` is the heart of the app:

1. **Pivot check** — if the query exactly matches a denylisted brand (normalized), swap the query for the brand's `category` ("Home Depot" → "hardware store"), *and additionally* search the brand itself (max 20) so it appears for contrast; merge, dedupe by place id.
2. **Text search** — Places text search restricted to the viewport rectangle, up to ~60 results.
3. **Candidate mapping** — `_candidate()` drops non-`OPERATIONAL` businesses (the "real and currently operating" trust requirement) and flattens the Places shape.
4. **Thin** to ≤36 with geographic spread; denylisted survive unconditionally.
5. **Score only the displayed set** (cost control, spec §6), ≤8 concurrent count searches via semaphore; results cached 30 days.
6. **Distance** from user location (or viewport center) via haversine; sort by score desc, rating/review tiebreak.

Response: `{results, totalFound, pivot}`. The frontend re-sorts client-side when the user toggles "Nearest".

### Frontend structure (`frontend/src/`)

- **`App.tsx`** — all app state and the boot sequence: fetch `/api/config` → geolocate (8s timeout) → fall back to a manual-location hero form (geocoded via backend). On map ready, the first `idle` event triggers an automatic search for `"local shops"` so the user never sees an empty screen. Phases: `boot | locate | manual-location | ready | no-key`. Desktop = sidebar + map; mobile (`max-width: 767px`) = map + `BottomSheet`.
- **"Search this area"** — the map's `idle` event compares new bounds to the last-searched bounds; >2% shift in any edge shows the button. `zoomOutAndSearch()` (sparse-results CTA) sets a ref flag so the *next* idle auto-searches.
- **`MapView.tsx`** — the only Google-Maps-aware component. Map created once (empty dep array, deliberate); markers rebuilt on every result change and fed to the clusterer. Custom DOM pins colored by score, CSS drop-and-settle animation, staggered. Pin↔card selection sync both ways (`selectedId` in App is the single source of truth). Note the `callbacksRef` pattern: listeners are registered once, so callbacks are read through a ref to avoid stale closures — keep that pattern if you touch listeners.
- **`score.ts`** — `scoreColor()`: the single red→amber→green ramp used by badges AND pins (spec: one scale, defined once). Also `formatDistance` and `mapsUrl` (Apple Maps on iOS, Google Maps elsewhere).
- **Components** — `ResultsList` (sort toggle, pivot note, sparse/empty state, skeletons), `ResultCard` (photo, stars, `ScoreBadge`, website / open-in-maps), `ScoreBadge` (animated SVG ring dial — the signature element), `DetailPanel` (fetches `/api/place/{id}`; shows the "why this score" breakdown — where trust is earned), `BottomSheet` (three snap points: peek/half/full, spring-animated, velocity-biased snapping), `SearchBar`, `Stars`.
- **`styles.css`** — one plain-CSS file (~900 lines), design tokens as CSS variables at the top. No CSS framework, no CSS-in-JS. The palette is from spec §8.

## Key design decisions (and their reasoning)

1. **Score = three deterministic signals only** (denylist hard cap, location count, minor modifiers). Deliberate: explainable in a sentence, operator-controllable, no inference. The bands and signals are *fixed by spec*; internal thresholds in `scoring.py` are tunable.
2. **Denylist does double duty** — it both caps scores and drives the brand→category search pivot. One JSON file (`backend/app/denylist.json`), operator-edited, requires backend restart to reload (loaded once at startup — intentional simplicity).
3. **Thin before scoring** — each count lookup is a paid Places search, so only the ≤36 displayed candidates are ever scored. This ordering is a cost decision; the quality proxy in `thinning.py` exists because of it.
4. **Cache derived data only** — a Google-terms compliance decision, not a performance shortcut. Don't cache photos, reviews, ratings, or names.
5. **Viewport = search area, no radius slider** — settled in spec §3. Zoom level is the scope control.
6. **Same-origin everything** — nginx proxies `/api`, Vite dev-proxies `/api`; no CORS config exists anywhere and none is needed.
7. **No state library, no router, no backend ORM** — the app is small and the spec explicitly forbids speculative abstraction ("do the simplest thing that works well").
8. **`max(1, count)`** in the count heuristic: a business that Google's name search can't find still exists (we're looking at it), so zero is treated as one. Generous-by-default toward "independent" — see GAPS.md for the honesty tradeoff.

## What's load-bearing vs. safe to change

**Load-bearing — change with care and tests:**
- `denylist.normalize_name()` — cache keys, denylist matching, and count matching all flow through it. Changing it invalidates/skews the cache and the matcher together.
- The `/api/search` orchestration in `main.py` and the response field names — the frontend types in `frontend/src/types.ts` mirror them by hand (no codegen). Change one, change both.
- `thinning.thin_results` invariants: denylisted always kept; cap respected; geographic spread (tests encode these).
- Field masks in `places.py` — they're a billing surface and a data contract.
- `score.ts:scoreColor` — the one shared visual scale; the CSS pin/badge styling assumes it.
- The two-key split and the photo proxy — the reason the server key can't leak.

**Safe to change casually:**
- `denylist.json` entries (that's the point — it's operator data).
- Scoring thresholds/penalties in `scoring.py` constants and `config.py` (`RESULT_CAP`, `GRID_SIZE`, count-box size, TTL) — tunables by design.
- All styling in `styles.css`, animation parameters, copy strings.
- Skeletons, empty states, badge sizes.

## Things that will trip you up

- **You can't run the app end-to-end without real Google API keys** (billing-enabled project, three APIs). Without keys the frontend intentionally shows a "backend isn't configured" hero (`no-key` phase). Backend unit tests need no keys.
- **README references `.env.example`, but the file doesn't exist** in the repo (see GAPS.md). Docker Compose reads `.env` from the repo root for variable substitution.
- **Two SQLite paths**: in Docker it's `/data/localize-cache.db` (named volume, set via `ENV` in the Dockerfile); in local dev it defaults to `./localize-cache.db` in `backend/` — which is how an (empty) `localize-cache.db` ended up committed to git.
- **The pivot only fires on an exact normalized brand match.** "home depot" pivots; "home depot near me" does not. Deliberate minimalism, but surprising.
- **The map component intentionally violates React idioms**: map created once with an empty dependency array, markers managed imperatively outside React, callbacks accessed via `callbacksRef`. This is the correct pattern for Google Maps in React — don't "fix" it into re-render-driven code.
- **`denylisted` is an internal field**: added to candidates for thinning, deleted before the response. The response's `denylistedBrand` (from scoring) is the public one.
- **Distance sort is client-side; score sort order comes from the backend.** The backend always returns score-sorted results.
- **`tests/` are excluded from the Docker image** (`.dockerignore`) — don't try to run pytest inside the backend container.
- **The count search box is fixed (~140×~120 miles at mid-latitudes)** around the *searched viewport's center*, and cached by name only — the count for a chain is whatever region first asked for it. Known honesty limitation, documented in GAPS.md.
- **Semaphore(8)** bounds concurrent Google count searches per request; the per-name locks in `Scorer` prevent duplicate searches for the same brand racing each other within/across requests.

## v2 — designed for, deliberately not built

Accounts/favorites, owner-claimed listings, in-app reviews, monetization, multi-area browsing, richer ownership datasets. Architecture just needs to not preclude these (spec §9). Don't build any of it.
