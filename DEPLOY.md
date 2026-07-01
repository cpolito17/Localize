# Deploying Localize to `charliepolito.com/localize`

Localize runs as a single **Cloudflare Worker** that both serves the built
frontend and answers the API under `/localize/api/*`. The Google **Places (New)**
and **Geocoding** calls happen inside the Worker with a secret server key; the
browser only ever sees a locked-down Maps-JavaScript key. The whole path is
gated by **Cloudflare Access** (Google login), so only you can reach the app or
spend your API quota.

```
Browser ──▶ Cloudflare Access (Google login, allow: your email)
             │
             ▼
        charliepolito.com/localize/*  (Worker route)
             ├── /localize/            → static assets (React build)
             └── /localize/api/*       → Worker: Places/Geocoding + Localize score
                                          ├── secret GOOGLE_MAPS_SERVER_KEY
                                          └── KV "localize-cache" (location counts)
```

What's already been done for you:

- Backend logic ported from Python/FastAPI to a TypeScript Worker (`worker/`).
- SQLite cache replaced by a **KV namespace** `localize-cache`
  (`id b8e682c64b15403093a321d0e8443426`, already wired into `wrangler.toml`).
- Frontend rebuilt for the `/localize/` base path (`frontend/dist/localize/`).
- `wrangler deploy --dry-run` passes.

The steps below are the parts that need your Google Cloud + Cloudflare
dashboards and your login. Do them in order.

---

## 0. Prerequisites

- The domain `charliepolito.com` is an active, **proxied** (orange-cloud) zone
  in the same Cloudflare account as your `portfolio` Worker. (It is — this is
  where your portfolio site lives.)
- Node 20 + npm (already installed).

---

## 1. Google Cloud — two restricted keys

Your README's design uses **two** keys, and this deployment relies on it. The
single key you have now has all three APIs enabled, which is unsafe to ship to a
browser. Create a clean split.

> ⚠️ **The key you pasted in chat is now in this conversation's history.** Treat
> it as exposed. The safest move is to **delete/rotate it** and make two fresh
> keys below. At minimum, apply the restrictions below so the leaked value is
> useless off your domain.

In **Google Cloud Console → APIs & Services**:

1. **Enable APIs** (APIs & Services → Library), if not already:
   *Maps JavaScript API*, *Places API (New)*, *Geocoding API*.

2. **Server key** — Credentials → Create credentials → API key.
   - Name it `localize-server`.
   - **Application restrictions:** *None*. (Cloudflare Workers egress from
     shared IPs, so IP restriction isn't viable; this key stays secret in the
     Worker instead of being exposed anywhere.)
   - **API restrictions → Restrict key:** *Places API (New)* + *Geocoding API* only.

3. **Browser key** — Create credentials → API key.
   - Name it `localize-browser`.
   - **Application restrictions:** *Websites (HTTP referrers)*, add:
     - `https://charliepolito.com/*`
     - `https://charliepolito.com/localize/*`
   - **API restrictions → Restrict key:** *Maps JavaScript API* only.

4. *(Optional, removes the "for development only" map watermark)* Maps → **Map
   Management** → create a Map ID (type: JavaScript, Vector). Put its value in
   `wrangler.toml` under `GOOGLE_MAPS_MAP_ID`.

Keep the two key strings handy for step 3.

---

## 2. Google OAuth client for the login gate

Cloudflare Access needs a Google OAuth client to run "Sign in with Google."
(This is separate from the Maps keys above.)

In **Google Cloud Console → APIs & Services → Credentials**:

1. Configure the **OAuth consent screen** if you haven't (User type: External;
   add yourself as a test user, or Publish).
2. Create credentials → **OAuth client ID** → *Web application*, name
   `localize-access`.
3. You need your Cloudflare **team name** first (step 4 sets it). Once you know
   it (`<team>.cloudflareaccess.com`), set:
   - **Authorized JavaScript origins:** `https://<team>.cloudflareaccess.com`
   - **Authorized redirect URI:** `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
4. Copy the **Client ID** and **Client secret** for step 4.

> Prefer zero extra setup? Cloudflare Access also offers **one-time PIN** (email
> code) with no OAuth client at all. If you'd rather skip this step, use OTP in
> step 4 and restrict the policy to your email — same protection, no Google
> client. You asked for Google, so it's the default here.

---

## 3. Deploy the Worker

From the repo root (`Localize/`):

```sh
# Authenticate wrangler to your Cloudflare account (opens a browser).
npx wrangler login

# Store the two keys as encrypted secrets (paste each value when prompted).
npx wrangler secret put GOOGLE_MAPS_SERVER_KEY      # the localize-server key
npx wrangler secret put GOOGLE_MAPS_BROWSER_KEY     # the localize-browser key

# Build the frontend, typecheck the Worker, and deploy.
npm run deploy
```

`npm run deploy` builds `frontend/dist/localize`, runs `tsc` over the Worker,
and `wrangler deploy` — which uploads the Worker and attaches the routes
`charliepolito.com/localize` and `charliepolito.com/localize/*`.

**Coexistence with your portfolio:** these routes are more specific than
whatever serves the apex, so Cloudflare sends only `/localize/*` to this Worker
and leaves the rest of `charliepolito.com` on `portfolio`. If `wrangler deploy`
complains it can't attach the route, it's because there's no proxied DNS record
for the apex to hang the route on — ensure `charliepolito.com` has a proxied
record (it should, since the portfolio site resolves).

At this point `https://charliepolito.com/localize/` loads, but it's **not yet
protected** and search will work for anyone who finds it. Do step 4 before
sharing the URL.

---

## 4. Cloudflare Access — Google login, only you

In the Cloudflare dashboard → **Zero Trust** (one-time: pick a team name →
that's your `<team>.cloudflareaccess.com`; go back and finish step 2's redirect
URI if you set it as a placeholder):

1. **Settings → Authentication → Login methods → Add new → Google.**
   Paste the OAuth **Client ID** and **Client secret** from step 2. Save, then
   **Test**.

2. **Access → Applications → Add an application → Self-hosted.**
   - **Application name:** `Localize`
   - **Session duration:** your choice (e.g. 24h).
   - **Public hostname / path:**
     - Subdomain/domain: `charliepolito.com`
     - **Path:** `localize` &nbsp;(this scopes Access to `/localize` and below,
       leaving the rest of your site untouched)
   - **Identity providers:** enable **Google** (uncheck others if you like).

3. **Add a policy:**
   - Name: `Only me`
   - Action: **Allow**
   - Include → **Emails** → `cpolito@umich.edu` (add any others here later).

Save. Now every hit to `charliepolito.com/localize/*` — pages *and* API — is
forced through Google login and allowed only for your email.

---

## 5. Verify

1. Open an incognito window → `https://charliepolito.com/localize/`.
   You should be bounced to Google, sign in as `cpolito@umich.edu`, then land on
   the app.
2. Allow location (or type a city) → run a search → pins should appear with
   Localize scores. Try `Home Depot` to see the pivot-to-local behavior.
3. Sign in as a *different* Google account → you should be **denied**.
4. `curl https://charliepolito.com/localize/api/health` (no auth) → you should
   get Cloudflare Access's login redirect, **not** a JSON response. That
   confirms the API itself is gated.

---

## Local development

```sh
# Terminal A — run the Worker + assets locally on :8787
npm run dev            # builds the frontend, then `wrangler dev`
# open http://localhost:8787/localize/

# Provide local secrets to `wrangler dev` via an untracked .dev.vars file:
#   GOOGLE_MAPS_SERVER_KEY="..."
#   GOOGLE_MAPS_BROWSER_KEY="..."
```

`.dev.vars` is git-ignored. For frontend hot-reload instead, run
`wrangler dev` in one terminal and `npm --prefix frontend run dev` in another,
then open the Vite URL at `/localize/` (its dev proxy forwards `/localize/api`
to `:8787`). Cloudflare Access does not apply locally — that's edge-only.

The original Python backend (`backend/`) and `docker-compose.yml` are left in
place as the reference implementation and for its unit tests; they aren't used
by the Cloudflare deployment.

---

## Notes & knobs

- **API-cost safety.** Access blocks anonymous traffic, so nobody but you can
  trigger Places/Geocoding calls. On top of that, results are scored only for
  the displayed set and location-counts are cached in KV for 30 days.
- **Workers subrequest limit.** A cold-cache search fans out one Places lookup
  per displayed business. To stay under the Workers Free ceiling (50 subrequests
  per request), the location-count search reads a single page (20 results)
  instead of the backend's three — see `worker/config.ts` (`COUNT_MAX_RESULTS`).
  Effect: chains with 9–20 nearby locations still score as regional, and the big
  national brands are caught by the denylist hard cap regardless. On Workers
  Paid (1000 subrequests) you can raise it back to 60.
- **Rotating the exposed key.** After the two new keys work, delete the original
  key in Google Cloud so the value pasted in chat can't be used.
- **Editing the denylist.** `worker/denylist.json` (kept in sync with
  `backend/app/denylist.json`). Re-run `npm run deploy` after edits.
- **Map ID.** `DEMO_MAP_ID` works but shows a watermark; set a real Map ID in
  `wrangler.toml` (step 1.4) to remove it.
