# Localize

*Find it nearby. Keep it local.*

A web app that redirects everyday purchases toward locally-owned businesses. Search by brand ("Home Depot"), category ("furniture"), or product ("AA batteries") and get nearby businesses ranked by a transparent 0–100 **Localize score** — genuinely local, independently-owned shops rise to the top, while big-box and e-commerce options stay visible with their (low) scores for honest contrast.

Built per [localize-spec.md](localize-spec.md).

## Stack

- **Frontend** — React + Vite, Google Maps JavaScript API (browser, referrer-restricted key), Framer Motion.
- **Deployment (live)** — a single **Cloudflare Worker** (`worker/`) serves the built frontend and the API under `/localize/api/*`, with Places (New) + Geocoding called server-side using a secret key and derived location-counts cached in **KV**. Access is gated by **Cloudflare Access** (Google login). See **[DEPLOY.md](DEPLOY.md)** for the full runbook.
- **Reference backend** — the original Python / FastAPI service (`backend/`) and `docker-compose.yml`. Same logic and scoring, kept for local development and its unit tests; not used by the Cloudflare deployment.

## Deploy to Cloudflare (`charliepolito.com/localize`)

Follow **[DEPLOY.md](DEPLOY.md)** — it covers the two restricted Google keys, the
Google login gate via Cloudflare Access, storing secrets, and `npm run deploy`.
Quick version once keys and Access are set up:

```sh
npx wrangler login
npx wrangler secret put GOOGLE_MAPS_SERVER_KEY
npx wrangler secret put GOOGLE_MAPS_BROWSER_KEY
npm run deploy
```

## Setup (reference Docker/FastAPI stack)

### 1. Google Maps Platform

Create (or reuse) a Google Cloud project with billing, enable **Maps JavaScript API**, **Places API (New)**, and **Geocoding API**, then create two keys:

| Key | Restriction | APIs |
|---|---|---|
| Server key | IP addresses (your server's egress IP) | Places API (New), Geocoding API |
| Browser key | HTTP referrers (your app's domain) | Maps JavaScript API only |

### 2. Configure

```sh
cp .env.example .env
# fill in GOOGLE_MAPS_SERVER_KEY and GOOGLE_MAPS_BROWSER_KEY
```

### 3. Run

```sh
docker compose up --build -d
```

The app is served on `http://localhost:8080` (change with `LOCALIZE_PORT`).

## Local development (no Docker)

```sh
# backend (http://localhost:8000)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
GOOGLE_MAPS_SERVER_KEY=... GOOGLE_MAPS_BROWSER_KEY=... .venv/bin/python -m uvicorn app.main:app --reload

# frontend (http://localhost:5173, proxies /api to :8000)
cd frontend
npm install && npm run dev

# backend tests
cd backend && .venv/bin/python -m pytest tests
```

## The Localize score

| Score | Meaning |
|---|---|
| 90–100 | Single-location, independently-owned, physical store |
| 70–89 | Small local chain (a few locations, one metro) |
| 40–69 | Regional chain |
| 15–39 | National chain / big-box with physical stores |
| 0–14 | National / multinational e-commerce giants |

Three deterministic signals, no LLM, no black box:

1. **Brand denylist** (hard cap) — [backend/app/denylist.json](backend/app/denylist.json), operator-maintained. Known big-box/e-commerce brands are forced into the bottom bands by name or website domain. Each entry also carries the alternative-category keyword used to pivot brand searches ("Home Depot" → local hardware stores).
2. **Location count** — a wide-area Places search on the business's normalized name; one location → independent, a few → small chain, dozens → regional/national. Computed only for displayed results and cached (30 days, SQLite).
3. **Minor modifiers** — small nudges (big-format store types, unusually high review volume for one location). Tiebreakers, not drivers.

Every score comes with a one-line "why," shown in the detail view.

## Editing the denylist

Add/remove entries in `backend/app/denylist.json` and restart the backend. Each entry: `brand`, optional `aliases` (alternate names), `domains` (website match), `kind` (`bigbox` | `ecommerce`), and `category` (the local-alternative search used when someone searches the brand itself).
