# Localize

**Find independent shops nearby and understand why they rank as local.**

[Open Localize](https://charliepolito.com/localize/) · [Charlie Polito's portfolio](https://charliepolito.com/)

Localize turns a brand, category, or product search into nearby alternatives. Results receive a transparent 0–100 score based on a maintained national-brand list, an estimated local location count, and small supporting signals such as store type and review volume.

The public site is intentionally quota-limited. It runs as one Cloudflare Worker with static assets and a D1 database, so there is no always-on server bill.

## What it does

- Searches by product, category, or brand.
- Suggests independent alternatives when a query names a known big-box brand.
- Explains every Localize score in plain language.
- Shows results on a Google map and sorts by score, rating, or distance.
- Opens directions in Apple Maps on iPhone/iPad and Google Maps elsewhere.
- Requires no account and creates no personal profile.

## How scoring works

The score is deterministic; no language model decides whether a business is local.

1. A curated denylist places known national and e-commerce brands in a low score band.
2. For other businesses, Localize estimates how many matching locations exist in a wider surrounding area.
3. Store type and unusually high review volume make small, disclosed adjustments.
4. If the location count cannot be verified, Localize shows a provisional score rather than claiming the business is independent.

Location counts are cached for 30 days by normalized name and coarse geographic region. The product rationale is documented in [localize-spec.md](localize-spec.md).

## Cheap public operation

Paid Google requests are protected in layers:

- 3 requests per minute per signed browser identity.
- A second per-IP burst limit that survives cookie resets; only a keyed hash is stored.
- 8 searches per browser per UTC day.
- An IP daily allowance four times the browser allowance.
- 40 searches per UTC day across the whole deployment.
- A separate 300-call daily ceiling covering every server-side Google request.
- Small result caps and a persistent D1 classification cache.
- Google Cloud API quotas and billing alerts as the independent final stop.

The browser's Maps JavaScript load is not part of the server-side 300-call counter. Its public browser key must be restricted by referrer and API, and the Maps JavaScript API needs its own Google Cloud quota.

These controls make ordinary public use inexpensive; anonymous limits are not identity- or billing-grade authentication. A determined distributed attacker could still consume the Google-side quota. Add Cloudflare Turnstile before raising limits if abuse becomes sustained.

## Architecture

```text
Browser
  ├─ React + Vite interface
  ├─ Google Maps JavaScript API (referrer-restricted browser key)
  └─ /localize/api/*
       └─ Cloudflare Worker
            ├─ request validation + anonymous rate limits
            ├─ Google Places API (New) + Geocoding API
            └─ D1 cache + atomic daily counters
```

The same Worker serves `frontend/dist` at `/localize/` and handles the API. Server credentials stay in encrypted Worker secrets. The original FastAPI, Nginx, SQLite, and Docker Compose implementation remains in `backend/` as a reference and local alternative; it is not used by the public deployment.

## Repository layout

| Path | Purpose |
| --- | --- |
| `worker/` | Production Cloudflare Worker API, scoring, caching, and limits |
| `migrations/` | D1 schema for cached location counts and usage counters |
| `frontend/` | React/Vite interface and static SEO assets |
| `backend/` | Reference FastAPI implementation and Python tests |
| `wrangler.jsonc` | Production routes, assets, D1, rate-limit bindings, and safe defaults |
| `DEPLOY.md` | Deployment, quota, secret, and rollback runbook |

## Local Worker development

Requirements: Node.js 20+ and npm.

```bash
npm ci
npm --prefix frontend ci
npm run migrate:local
```

Create an ignored `.dev.vars` file:

```dotenv
GOOGLE_MAPS_SERVER_KEY=replace-with-a-restricted-server-key
GOOGLE_MAPS_BROWSER_KEY=replace-with-a-referrer-restricted-browser-key
RATE_LIMIT_SECRET=replace-with-at-least-32-random-characters
```

Then run:

```bash
npm run dev
```

Wrangler builds the frontend first and serves the complete app locally.

## Reference Docker/FastAPI stack

Copy `.env.example` to `.env`, fill in restricted keys and a random `RATE_LIMIT_SECRET`, then run:

```bash
docker compose up --build
```

Open <http://localhost:8080/localize/>. This path uses the Python implementation and a local SQLite database.

## Tests and validation

```bash
npm run check
cd backend && python -m pytest -q
npm audit --omit=dev --audit-level=high
```

The Worker tests cover input bounds and the signed, privacy-preserving visitor/IP identities. The Python suite covers the reference API, scoring, caching, and atomic limits. CI runs both implementations, builds the production frontend, and performs a Wrangler deployment dry run.

## Deployment

Follow [DEPLOY.md](DEPLOY.md). The short version, after the D1 binding, secrets, and Google quotas are configured, is:

```bash
npm run deploy
```

## Privacy and security

- Search text, map bounds, and an optional location are sent to this Worker and then to Google Maps Platform.
- Raw IP addresses are used transiently for abuse control but are never stored; D1 receives only keyed hashes and counters.
- The signed visitor cookie is HttpOnly, Secure, SameSite=Lax, and scoped to `/localize`.
- Cross-site API requests are rejected before they can consume a paid call.
- Request bodies, coordinates, identifiers, methods, and outbound destinations are tightly bounded.
- Security headers, upstream timeouts, generic production errors, and secret-only server credentials reduce the public attack surface.

Please report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

No open-source license has been granted. The source is public for portfolio review and learning, but copyright remains with the author.
