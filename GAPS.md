# GAPS.md — Known weaknesses, ordered by severity

An honest audit as of 2026-07-07. Each item: what it is, where it lives, why it matters, and a fix scoped small enough to execute as a single task. Architecture context is in [PROJECT.md](PROJECT.md).

---

## 1. Unauthenticated, unthrottled endpoints that spend real money — **HIGH (security / cost)**

**What:** Every backend endpoint is public and has no rate limiting. One `POST /api/search` can trigger up to 3 paginated Places text-search calls plus up to 36 wide-area location-count searches (cache-cold), all billed to the operator's Google account. `/api/photo` and `/api/geocode` are also free relays for anyone. The app is designed to be self-hosted on the public internet (nginx on port 8080), so a trivial curl loop — or just being found by scanners — can run up a real Google Cloud bill or exhaust quota, taking the app down.

**Where:** `backend/app/main.py` (all routes), `frontend/nginx.conf` (no limits there either).

**Why it matters:** This is the single most likely way the operator gets hurt in production. Everything else on this list degrades the product; this one costs money.

**Fix (single task):** Add a small in-memory token-bucket rate limiter as a FastAPI middleware in a new `backend/app/ratelimit.py`, keyed on client IP (trust `X-Forwarded-For`'s first hop only when the request comes from the nginx proxy). Suggested budgets: 10 searches/min/IP, 60 photos/min/IP, 10 geocodes/min/IP; return 429 with a `detail` message. Also add `limit_req` in `nginx.conf` as a second layer (e.g. `limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;` on `location /api/`). No external dependencies needed. Add tests with `fastapi.testclient.TestClient`.

---

## 2. Denylist prefix matching produces brand false positives — **HIGH (product trust)**

**What:** `match_business` matches when a business name *starts with* a denylisted name + space (`n.startswith(bn + " ")`, `backend/app/denylist.py:67`). Short names/aliases make this over-eager: alias `"napa"` (NAPA Auto Parts) matches **"Napa Valley Wine Tours"**; brand `"gap"` matches **"Gap Fillers Drywall"**; `"target"` matches **"Target Archery Range"**. Any such business gets hard-capped at score 25 and labeled "on the national-retailer list" — a false accusation, and the spec (§2) says a wrong score "breaks the entire premise."

**Where:** `backend/app/denylist.py` (`match_business`), `backend/app/denylist.json` (the short aliases: `napa`, `gap`, `target`, `ross`, `aldi`, `ulta`…).

**Why it matters:** Trust is the product. A genuinely local winery labeled as NAPA Auto Parts is exactly the failure mode the spec warns about, and Napa-the-place makes it a certainty in one entire region of California.

**Fix (single task):** In `match_business`, require an **exact** normalized match for names/aliases shorter than a threshold (e.g. < 6 characters or single-word), keeping the prefix rule only for longer multi-word names; additionally remove the bare `"napa"` alias from `denylist.json` (keep "napa auto parts"). Add regression tests to `backend/tests/test_denylist.py`: "Napa Valley Wine Tours" → no match, "Gap Fillers Drywall" → no match, while "Walmart Supercenter" and "NAPA Auto Parts" still match.

---

## 3. Network-level Google failures return 500, not 502 — **MEDIUM (robustness)**

**What:** `main.py` catches only `httpx.HTTPStatusError` around Google calls. Timeouts, DNS failures, connection resets (`httpx.TimeoutException`, `httpx.ConnectError` — all subclasses of `httpx.HTTPError` but *not* of `HTTPStatusError`) escape as unhandled exceptions → raw 500 with no useful message, and the frontend shows "Request failed (500)".

**Where:** `backend/app/main.py:119-126` (`/api/search`), `:171-174` (`/api/place`), `:235-238` (`/api/geocode`); `/api/photo` (`:221`) has no try at all, so a photo fetch timeout 500s.

**Why it matters:** Transient network blips are routine in production; every one currently looks like a backend bug and gives users a worthless error.

**Fix (single task):** Broaden the catches to `httpx.HTTPError`, mapping to `HTTPException(502, "Couldn't reach Google Places — try again.")`; wrap the `places.photo()` call the same way. Add a test that monkeypatches `PlacesClient.search_text` to raise `httpx.ConnectError` and asserts a 502.

---

## 4. `/api/photo` accepts path-traversal in the photo name — **MEDIUM (security)**

**What:** The `name` param is interpolated into the Google URL (`f"{PLACES_BASE}/{photo_name}/media"`, `backend/app/places.py:103`) after only checking `startswith("places/")` and `"/photos/" in name` (`main.py:218`). A crafted name containing `../` segments (e.g. `places/x/photos/../../<other-path>`) can redirect the server-key-authenticated GET to a different `places.googleapis.com` path. Blast radius is limited to GET endpoints on that host, but it lets an outsider make requests *as the operator's server key* to endpoints the app never intended, and the response body is relayed back.

**Where:** `backend/app/main.py:215-228`, `backend/app/places.py:100-106`.

**Why it matters:** It's the one place untrusted input reaches a privileged outbound request. Cheap to close, embarrassing to leave.

**Fix (single task):** Validate with a strict regex before calling Google: `^places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_.-]+$` (reject anything with `/../`, `%`, or extra segments) and reject otherwise with 400. Add TestClient tests: a legitimate-shaped name passes validation; `places/a/photos/../../v1/foo` and `places/a/photos/x%2F..` get 400.

---

## 5. `.env.example` is referenced but doesn't exist — **MEDIUM (broken onboarding, trivial fix)**

**What:** README setup step 2 says `cp .env.example .env`; there is no `.env.example` anywhere in the repo. A new operator's documented setup path fails at step 2, and the full set of supported variables (`GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_MAP_ID`, `LOCALIZE_PORT`) is only discoverable by reading `docker-compose.yml` and `config.py`.

**Where:** repo root (missing file); `README.md:29`.

**Fix (single task):** Create `.env.example` at the repo root with the four variables, empty values for the two keys, defaults noted in comments for `GOOGLE_MAPS_MAP_ID` (`DEMO_MAP_ID`) and `LOCALIZE_PORT` (`8080`). `.gitignore` already ignores `.env` but also ignores `.env.*` — add an exception line `!.env.example` so the file can actually be committed.

---

## 6. Zero matching locations scores as "independent, 95" — and non-Latin names break scoring entirely — **MEDIUM (score honesty)**

**What:** Two related problems in the count heuristic:
- `_count_locations` returns `max(1, count)` (`backend/app/scoring.py:157`), so when the wide-area name search finds *nothing matching* (name mangled by normalization, Google returning different naming), the business is confidently labeled "1 location found in this area — independently operated" with score 95. Unknown ≠ independent; the spec demands honesty over generosity.
- `normalize_name` strips everything outside `[a-z0-9& ]` (`backend/app/denylist.py:7`), so a fully non-Latin name ("이마트", "商店") normalizes to the **empty string**: the count search queries Places with `""`, every empty-normalized business shares the single cache key `""`, and accented names get mangled ("Café Zola" → "caf zola") making count matching unreliable.

**Where:** `backend/app/scoring.py` (`_count_locations`, `classify`), `backend/app/denylist.py` (`normalize_name`).

**Why it matters:** The app "works anywhere Google Places does" (spec §1), and in any non-English-speaking area the flagship number is currently garbage — plus shared cache keys silently cross-contaminate scores.

**Fix (single task):** (a) In `normalize_name`, keep Unicode letters/digits instead of ASCII-only (`[^\w& ]` with `re.UNICODE`, then lowercase) — note this changes cache keys, which is fine (cache repopulates). (b) In `Scorer.classify`, if the normalized name is empty **or** the raw search returned zero matching results, return a distinct neutral classification (e.g. score 75, reason "couldn't verify other locations — treated as a small local business") instead of the 95 band, and don't cache the empty key. Update/add tests in `test_scoring.py`.

---

## 7. Location-count cache ignores geography — **MEDIUM (score honesty at scale)**

**What:** The count is computed in a fixed ~2°×2.5° box around whatever viewport center *first* asked, then cached for 30 days keyed by name alone (`backend/app/cache.py`). A 10-store Seattle chain looked up from Miami counts 0→1 and shows "1 location in this area — independently operated" (score 95); conversely a common shop name ("Corner Store") counted once in a dense metro caps every same-named independent elsewhere. Distinct businesses that share a name are indistinguishable by design.

**Where:** `backend/app/cache.py` (key schema), `backend/app/scoring.py:137-157`, `backend/app/config.py:16-17`.

**Why it matters:** It's a systematic, silent wrong-score generator once users search in more than one metro. Same-name collisions are the fundamental limit of the heuristic (acceptable v1 per spec), but the *stale-region* half is fixable cheaply.

**Fix (single task):** Add a coarse geo bucket to the cache key: round the search center to a ~1° grid cell and make the primary key `(normalized_name, geo_bucket)` — new table schema, keep it a drop-in (delete old DB file / `CREATE TABLE IF NOT EXISTS` with the new name `location_counts_v2`). Also include the geo bucket in `Scorer._count_locks` keys. Update tests.

---

## 8. No tests for the API layer, `places.py`, or any frontend code — **MEDIUM (coverage)**

**What:** The 21 backend tests cover `denylist`, `scoring`, and `thinning` well — but `main.py` (the search orchestration: pivot merge + dedupe, candidate mapping, `businessStatus` filtering, distance computation, sort order, photo-name validation, error mapping) has **zero** tests, `places.py` (pagination, field masks, rect building) has zero, and the frontend has no tests or even a test runner. The most-load-bearing single function in the repo (`/api/search`) is unverified.

**Where:** `backend/tests/` (missing `test_api.py`), `frontend/` (no test setup).

**Why it matters:** The critical path is exactly the untested part; any refactor of `main.py` is currently flying blind. (Also: `pytest-asyncio` is declared in `requirements-dev.txt` but unused — tests call `asyncio.run` directly.)

**Fix (single task):** Add `backend/tests/test_api.py` using `fastapi.testclient.TestClient` with a fake `PlacesClient` injected via `app.state` (mirror `FakePlaces` from `test_scoring.py`). Cover: normal search response shape and sort; brand-pivot query returns `pivot` and includes the brand result; non-operational places dropped; `/api/photo` name validation; 502 mapping when the fake raises. Frontend testing can be a separate later task (Vitest + a `score.ts` unit test is the cheap start).

---

## 9. Committed build artifacts and a stray database — **LOW-MEDIUM (hygiene)**

**What:** `backend/localize-cache.db` (an empty-but-real SQLite file, created by running the backend locally) and `frontend/tsconfig.tsbuildinfo` (TypeScript incremental build state) are tracked in git. `.gitignore` covers neither. The cache DB will show up as perpetually-dirty the moment anyone runs the backend locally; a future commit could accidentally publish real cached data.

**Where:** `backend/localize-cache.db`, `frontend/tsconfig.tsbuildinfo`, `.gitignore`.

**Fix (single task):** `git rm --cached backend/localize-cache.db frontend/tsconfig.tsbuildinfo`, add `*.db`, `*.tsbuildinfo` to `.gitignore`, commit. (Keep `frontend/package-lock.json` — that one *should* be tracked.)

---

## 10. No CI — **LOW-MEDIUM (process)**

**What:** Nothing runs the tests or the TypeScript build on push. The repo has exactly one commit; regressions will land silently.

**Where:** missing `.github/workflows/`.

**Fix (single task):** Add `.github/workflows/ci.yml` with two jobs: (1) backend — Python 3.12, `pip install -r backend/requirements-dev.txt`, `pytest backend/tests`; (2) frontend — Node 20, `npm ci`, `npm run build` in `frontend/` (the build runs `tsc -b`, which is the type check). No deploy step.

---

## 11. Viewport/count rectangles break near the antimeridian and poles — **LOW (rare geography, silent failure)**

**What:** Longitudes are never wrapped/clamped: the count box (`scoring.py:145-150`) clamps latitude but can produce `west < -180` or `east > 180`; a map viewport crossing the antimeridian gives `east < west`, which makes `thin_results`' `lng_span` negative (every cell computation inverts; results collapse into edge cells) and produces an invalid Places `locationRestriction` rectangle. Fiji, Chukotka, and parts of Alaska are affected.

**Where:** `backend/app/scoring.py:145-150`, `backend/app/thinning.py:26-32`, `backend/app/main.py` (Bounds model does no validation).

**Fix (single task):** In the `Bounds` pydantic model add a validator requiring `-90 ≤ south < north ≤ 90` and lng within `[-180, 180]`, returning 422 otherwise; in `scoring._count_locations` clamp west/east to `[-180, 180]`. Full antimeridian *support* is not worth building for v1 — rejecting cleanly beats corrupting silently. Add a test.

---

## 12. Blocking SQLite calls on the event loop; `_count_locks` grows forever — **LOW (perf/memory)**

**What:** `ClassificationCache` does synchronous `sqlite3` I/O (with `commit()` per write) directly inside async handlers — each call blocks the entire event loop briefly; under a burst of cache-cold searches that's up to 36 sequential blocking commits per request interleaved into everything else. Separately, `Scorer._count_locks` (`scoring.py:65`) adds an `asyncio.Lock` per unique business name and never evicts — unbounded slow memory growth on a long-lived server.

**Where:** `backend/app/cache.py`, `backend/app/scoring.py:65,139`.

**Why it matters:** Real but small at this app's scale — SQLite ops are sub-millisecond. It's the kind of thing that bites only under load, at which point item #1 has already bitten harder.

**Fix (single task):** Wrap `get_count`/`set_count` bodies in `asyncio.to_thread` (make them async, update the two call sites in `scoring.py` and add a lock around the shared connection), and cap `_count_locks` by deleting the entry in a `finally` once the lock is released and unheld. Keep it simple; do not introduce an async ORM.

---

## 13. Boot-time error conflation: any `/api/config` failure claims "keys not configured" — **LOW (UX misdiagnosis)**

**What:** `App.tsx` maps *any* rejection of `api.config()` — backend down, nginx misroute, network blip — to the `no-key` phase (`App.tsx:76`), whose message tells the operator to set API keys they may well have set. Also, the failed-search state and detail-panel errors show raw `detail` strings from the backend, which is fine, but there's no retry affordance at boot.

**Where:** `frontend/src/App.tsx:51-77,155-164`.

**Fix (single task):** Split the failure cases: only enter `no-key` when config loads successfully with an empty `mapsBrowserKey`; on fetch failure show a distinct "Can't reach the Localize backend" hero with a Retry button that re-runs the boot effect.

---

## 14. `mapsUrl` misdetects iPads; misc small frontend nits — **LOW**

**What:**
- `mapsUrl` (`frontend/src/score.ts:37`) sniffs `/iPhone|iPad|iPod/` — modern iPadOS reports as `Macintosh`, so iPads get Google Maps URLs instead of Apple Maps. (Desktop Macs arguably *should* get Apple Maps too, which the current check also doesn't do.)
- `MapView` selection effect does `results.find(...)` inside a `forEach` over markers — O(n²); harmless at n=36, just noise.
- `ResultsList` re-sorts a copied array every render; fine, but memoizable.
- The bottom sheet's content only scrolls at the `full` snap (`BottomSheet.tsx:78`) — at `half`, long lists are clipped with no scroll, which reads as a bug on mobile.

**Where:** `frontend/src/score.ts:36-45`, `frontend/src/components/MapView.tsx:107-119`, `frontend/src/components/ResultsList.tsx:41-45`, `frontend/src/components/BottomSheet.tsx:78`.

**Fix (single task):** Update `mapsUrl` platform check to `(/iPhone|iPad|iPod/.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1))`; allow scrolling at `half` snap by applying the scroll class for both `half` and `full`. Leave the micro-perf items unless touching those files anyway.

---

## 15. Inconsistencies & half-finished edges (catch-all) — **LOW**

- **ESLint disable comment without ESLint**: `MapView.tsx:76` carries `// eslint-disable-next-line react-hooks/exhaustive-deps`, but no ESLint config or dependency exists anywhere. Either add ESLint (flat config + `eslint-plugin-react-hooks`, a `lint` script) or delete the comment. There is also no formatter config (Prettier) — formatting is currently by convention only.
- **`pytest-asyncio` declared, never used** (`backend/requirements-dev.txt:3`) — remove it, or adopt `@pytest.mark.asyncio` instead of `asyncio.run` wrappers in `test_scoring.py`.
- **`totalFound` is returned by `/api/search` and typed in `types.ts` but never rendered** — either surface it ("showing 36 of 58 found") or drop it from both sides.
- **`SearchBar.initialValue` prop is accepted but never passed** by any caller — the mobile pill doesn't show the active query, so after searching, the box is blank. Consider wiring `lastQueryRef` through, or delete the prop.
- **Backend has no `/` route** — hitting the backend directly (not via nginx) 404s at root; harmless, but a redirect to `/api/health` would aid debugging.
- **Docker containers run as root; no `HEALTHCHECK`s**; compose `depends_on` has no condition (nginx can briefly 502 while backend boots). All standard hardening, none urgent for a personal server.
- **No favicon/robots for the backend, no request logging config** — uvicorn defaults only; fine for v1, listed for completeness.

**Fix:** Each bullet is independently a small task; batch the first two (tooling) together if desired.

---

## What is *not* a gap (so nobody "fixes" it)

- **No LLM** in query interpretation/scoring — spec-mandated constraint.
- **No CORS headers** — same-origin by architecture (nginx/Vite proxy). Adding CORS would only widen exposure.
- **Big-box results shown, never filtered** — core product decision; the thinning code's "denylisted always kept" branch is intentional.
- **Map created imperatively / markers outside React** — correct pattern for Google Maps JS.
- **Denylist requires a restart to reload** — accepted operational simplicity for v1.
- **No accounts/persistence** — v1 scope, spec §3.
