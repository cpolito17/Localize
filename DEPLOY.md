# Localize deployment runbook

The production app is one Cloudflare Worker named `localize`. It serves the Vite build and the API on:

- `https://charliepolito.com/localize`
- `https://charliepolito.com/localize/*`

The route is intentionally more specific than the portfolio Worker's `charliepolito.com/*` fallback.

## 1. Configure Google Cloud safeguards

Use two keys:

| Key | Application restriction | API restriction |
| --- | --- | --- |
| Browser key | HTTP referrers: `https://charliepolito.com/*` | Maps JavaScript API only |
| Server key | Keep only as a Worker secret; Cloudflare Workers do not have one stable egress IP to allowlist | Places API (New) and Geocoding API only |

Set conservative per-day quotas for all three enabled APIs and enable billing-budget alerts. The Worker has its own D1 counter, but Google Cloud quotas are the independent hard stop if the Worker state or route is ever misconfigured.

## 2. Provision D1 once

```bash
npx wrangler d1 create localize-state
```

Copy the returned `database_id` into the `DB` entry in `wrangler.jsonc`. Do not create a second database when one already exists.

Apply the schema:

```bash
npm run migrate:remote
```

The migration is idempotent and creates:

- `location_counts_v2` for 30-day classification caching
- `usage_limits` for atomic browser, IP, global, and Google-call counters

## 3. Store secrets

```bash
npx wrangler secret put GOOGLE_MAPS_SERVER_KEY
npx wrangler secret put GOOGLE_MAPS_BROWSER_KEY
npx wrangler secret put RATE_LIMIT_SECRET
```

`RATE_LIMIT_SECRET` must contain at least 32 random characters. Rotating it invalidates existing visitor cookies and changes all future IP hashes; it does not reveal or recover previous IP addresses.

List secret names without revealing values:

```bash
npx wrangler secret list
```

## 4. Validate and deploy

```bash
npm ci
npm --prefix frontend ci
npm run check
npm run deploy:dry-run
npm run deploy
```

`npm run deploy` reapplies any pending D1 migrations before publishing the Worker.

Verify:

```text
https://charliepolito.com/localize/
https://charliepolito.com/localize/api/health
```

The health endpoint reports only whether required secrets are configured; it never returns their values.

## 5. Public access

After the new deployment and health check succeed, remove the Cloudflare Access application or policy that protects `charliepolito.com/localize*`. This is separate from the Worker route and is the final step that opens the site.

Do not remove the gate before all three Google quotas, API restrictions, Worker secrets, D1 binding, and route limits are confirmed.

## Default safety budgets

| Control | Default |
| --- | ---: |
| Browser burst | 3 requests/minute/action |
| IP burst | 12 requests/minute/action |
| Browser searches | 8/day |
| IP searches | 32/day |
| All-site searches | 40/day |
| All server-side Google calls | 300/day |

Defaults live in `wrangler.jsonc` and `worker/config.ts`. Raising the search budget without considering classification calls can exhaust the Google-call ceiling first.

## Rollback

Use Cloudflare's Worker deployment history or Wrangler's version/deployment commands to restore the last known-good release. Keep the D1 database: schema migrations are additive, and rolling back code does not require deleting counters or cached classifications.

If costs or abuse spike, the fastest safe containment is to re-enable the Access policy or disable the two Localize routes; neither action requires deleting data or rotating Google keys.
