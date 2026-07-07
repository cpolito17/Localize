# CLAUDE.md — Localize

Web app steering purchases toward locally-owned businesses. FastAPI backend proxying Google Places API (New) + React/Vite/Google Maps frontend, shipped via Docker Compose (nginx serves the SPA and proxies `/api` → backend).

- **[PROJECT.md](PROJECT.md)** — architecture, data flow, design decisions, what's load-bearing. Read before structural changes.
- **[GAPS.md](GAPS.md)** — known bugs/debt ordered by severity, each with a scoped fix. Check before "discovering" an issue.
- **[localize-spec.md](localize-spec.md)** — the product spec; §2 (trust), §3 (settled decisions), §9 (don't-build list) are binding.

## Commands

```sh
# Backend (from backend/; Python 3.12)
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
GOOGLE_MAPS_SERVER_KEY=... GOOGLE_MAPS_BROWSER_KEY=... .venv/bin/python -m uvicorn app.main:app --reload   # :8000
.venv/bin/python -m pytest tests            # unit tests — no API keys needed

# Frontend (from frontend/; Node 20)
npm install
npm run dev                                 # :5173, proxies /api → localhost:8000
npm run build                               # tsc -b && vite build — this IS the type check / "lint"

# Full stack (repo root; needs real keys in .env)
docker compose up --build -d                # app on :8080
```

There is no ESLint/Prettier/CI configured (see GAPS.md #10/#15). `npm run build` is the only frontend check; `pytest` is the only backend check. Run both before committing.

## Conventions

- **Backend:** flat modules in `backend/app/` (`main` routes/orchestration, `places` Google client, `scoring`, `denylist`, `thinning`, `cache`, `config`). Only 3 runtime deps (fastapi, uvicorn, httpx) — don't add dependencies casually. Shared objects live on `app.state`, built in `lifespan`. Errors: raise `HTTPException` with a human-readable `detail`; Google failures map to 502. Constants/tunables go in `config.py` or module-top constants with a spec-section comment (e.g. `(§6)`).
- **Frontend:** all app state is plain `useState`/`useRef` in `App.tsx` — no state library, no router; keep it that way. Components in `src/components/`, one per file, typed props interfaces. API calls only through `src/api.ts`. Styling is plain CSS in `src/styles.css` using the CSS variables at the top — no CSS-in-JS, no frameworks. Every animation must respect reduced motion (`useReducedMotion` or the `prefers-reduced-motion` media query).
- **Types:** `frontend/src/types.ts` mirrors backend response shapes **by hand**. Any change to an `/api/*` response must update both sides in the same commit.
- **Tests:** backend tests in `backend/tests/`, pytest, fakes over mocks (see `FakePlaces` in `test_scoring.py`); async code tested via `asyncio.run` wrappers, not pytest-asyncio marks.

## Gotchas

- **No API keys → app won't run end-to-end**, by design (frontend shows a "not configured" hero). Unit tests don't need keys. README's `cp .env.example .env` is broken — the file doesn't exist yet (GAPS.md #5); compose reads `.env` at repo root.
- **`normalize_name()` in `denylist.py` is the keystone**: denylist matching, the SQLite cache key, and the location-count comparison all use it. Changing it silently invalidates/skews cached scores — if you must change it, bump the cache table name.
- **Thinning runs BEFORE scoring** (cost control): `thinning.py` ranks by rating×log(reviews) because scores don't exist yet. Don't "fix" it to sort by score.
- **Denylisted results must survive thinning** — the always-keep branch in `thin_results` is a product decision (big-box shown for contrast), not a bug.
- **`MapView.tsx` intentionally violates React idioms**: map created once (empty dep array), markers managed imperatively, callbacks read via `callbacksRef` to dodge stale closures. Correct for Google Maps JS — don't refactor to render-driven.
- **Two internal/external field pairs**: candidate `denylisted` is internal and deleted before responding (`denylistedBrand` is the public field). Score sort comes from the backend; distance sort is client-side re-sorting.
- **The brand pivot fires only on an exact normalized query match** ("home depot" pivots to "hardware store"; "home depot near me" doesn't). Intentional.
- **`max(1, count)` in `scoring.py`** means "zero matches" scores as independent/95 — known honesty gap (GAPS.md #6); don't extend the pattern.
- **SQLite path differs by environment**: Docker uses `/data/localize-cache.db` (volume); local dev writes `backend/localize-cache.db` — never commit it (one is wrongly tracked already; GAPS.md #9).
- **`tests/` are excluded from the Docker image** via `.dockerignore` — pytest won't run inside the container.

## Rules

- **No LLM calls anywhere** — scoring, query interpretation, and thinning are deterministic by spec. Never add one.
- **Never expose the server key**: `GOOGLE_MAPS_SERVER_KEY` stays backend-only; photos are proxied through `/api/photo` for exactly this reason. Only `mapsBrowserKey` may reach the browser (via `/api/config`).
- **Never cache Google display content** (photos, reviews, ratings, names) — Google ToS. Cache only derived data (name → location count), as `cache.py` does.
- **Don't add CORS** — the app is same-origin by architecture (nginx/Vite proxy `/api`).
- **Score framework is fixed** (spec §6): the 5 bands, the 3 signals (denylist cap, location count, minor modifiers), and the one-line "why" shown with every score. Thresholds/penalties in `scoring.py`/`config.py` are tunable; the framework isn't. Modifiers must stay small ("tiebreakers, not drivers" — there's a test enforcing ≤10 pts).
- **One color scale**: `scoreColor()` in `frontend/src/score.ts` colors both badges and map pins. Never define a second score→color mapping.
- **`denylist.json` is operator data** — safe to edit freely (schema: `brand`, `aliases`, `domains`, `kind` = `bigbox`|`ecommerce`, `category`); backend restart required to reload. Beware short aliases → false-positive prefix matches (GAPS.md #2).
- **Field masks in `places.py` are a billing surface** — adding fields costs money per request; change deliberately.
- **Don't build v2 features** (accounts, saved state, owner claims, in-app reviews, monetization — spec §9), and don't add speculative abstractions; the spec mandates the simplest thing that works.
- **Generated/derived files — never hand-edit**: `frontend/package-lock.json` (npm-managed, keep tracked), `frontend/tsconfig.tsbuildinfo` and `*.db` files (build/runtime artifacts, shouldn't be tracked at all).
