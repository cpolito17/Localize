# Localize — Project Specification

*Find it nearby. Keep it local.*

---

## How to use this document

This is the build spec for **Localize**, a web app that helps people find locally-owned alternatives to big-box stores and e-commerce giants. It defines the product, the features, and the decisions already made. It intentionally does **not** prescribe file structure, internal architecture, or exact algorithms beyond the external services and logic principles named below — those are yours to design.

Before building: read the whole spec, then ask only the questions that would *materially* change the build (the kind listed in the final section). If nothing is blocking, scope the work and execute it end to end. Don't pause for confirmation on reversible decisions that clearly follow from this spec.

While building: build only what's described here. Do the simplest thing that works well — don't add features, services, abstractions, or "future-proofing" beyond what's specified, and don't add error handling or fallbacks for situations that can't occur. Validate at the real boundaries (user input, the Google APIs) and trust your own internal code. There's a "v2 — design for, don't build" section at the end; treat it as a list of things *not* to build now.

Establish a way to verify the app actually works as you go — containers come up, a real search returns real businesses with real scores on the map, the "Search this area" flow re-queries correctly, "Open in maps" produces a working link — and check against it continuously rather than only at the end. Report progress against what you've actually verified; if something isn't working yet, say so plainly.

---

## 1. What we're building

**Localize** is a search tool that redirects everyday purchases toward locally-owned businesses. The premise: most people default to Walmart, Amazon, Home Depot, and the like not out of loyalty but because it's frictionless — they don't know what local option exists, where it is, or whether it's any good. Localize removes that friction in one place.

The user searches the way they actually think about a purchase — by **brand** ("Home Depot"), by **category** ("furniture," "oil change," "clothing"), or by **specific product** ("AA batteries," "Nintendo Switch") — and Localize returns nearby businesses that can fill that need, ranked so that genuinely local, independently-owned shops rise to the top. Each result shows what it is, what people think of it, how to reach it, and a **Localize score** (0–100) that says, at a glance, how local it is.

**Who it's for:** ordinary shoppers who'd prefer to support local business but won't do the research themselves. The tool does the research in the moment they're about to buy.

**What it enables:** turning a vague "I need X" into a short list of real, nearby, locally-owned places to get X — with enough information (rating, photos, website, directions) to act immediately.

**Scope for v1:** a single-page web app, mobile-first, no user accounts, no saved state between sessions. Geographic coverage follows Google's data, so it works anywhere Google Places does.

---

## 2. The thing that matters most

**Trust is the product.** Localize works only if two things are reliably true for every result: the business is *real and currently operating*, and the **Localize score honestly reflects how local it is.** A score of 92 on a regional chain, or a "local hardware store" that closed last year or sits 40 miles outside the searched area, breaks the entire premise — the user stops believing the tool and goes back to Amazon.

So when trade-offs come up, bias toward **honesty and accuracy over coverage or cleverness.** A shorter list of results the user can trust beats a long list padded with questionable matches. The score should always be explainable in plain terms ("one location in this area, not on the national-retailer list"), never a black box. The whole app is, in effect, a trustworthy answer to "where can I buy this locally?" — everything else is packaging.

---

## 3. Decisions already made

These are settled. You don't need to re-open them; they answer the most likely questions up front.

**Shape & deployment (fixed):**
- A web app with a **backend**, not a static/client-only app. The backend exists primarily to hold API keys, run the scoring lookups, and cache derived results.
- **Containerized with Docker (Docker Compose)**, intended to run self-hosted on a personal Linux server. Keep the deployment simple and self-contained.
- **Frontend:** React, with the **Google Maps JavaScript API** for the map.
- **Backend language:** your call, but **Python with a modern async framework (FastAPI is the recommended default)** unless you have a strong reason otherwise — it fits the API-orchestration and caching work well. Internal architecture and file layout are entirely yours.

**Data source (fixed): Google Places.** This is the single source of truth for businesses — names, photos, ratings and review counts, websites, coordinates, types, and map links all come from it. Use the current-generation **Places API (New)**, because its text search supports restricting results to a rectangular map-viewport region, which the core search flow depends on (see §5). Enable **Maps JavaScript API, Places API (New), and Geocoding API** on the same Google Maps Platform project.

**No LLM anywhere.** Every piece of logic — query interpretation, scoring, result thinning — is deterministic. This is a deliberate constraint, not an omission. Don't introduce an LLM call to "improve" any of it.

**API key handling:** The Places and Geocoding calls run **server-side through the backend** with a key restricted by IP. The Maps JavaScript map runs in the browser and unavoidably needs a browser-exposed key — restrict that one by HTTP referrer and to only the Maps JS API. Keys are supplied via environment variables; never hard-code them.

**Localize score model:** the 0–100 rubric and the three deterministic signals in §6 are settled. The exact internal weights and thresholds are yours to tune, but the bands, the signals, and the "show the score transparently" principle are fixed.

**Search model:** the map viewport *is* the search area, with a "Search this area" button — there is **no radius slider.** Settled; details in §5.

**Show, don't hide, the big-box options.** Big-box and e-commerce results appear in the results with their (low) scores visible, rather than being filtered out. Seeing "Home Depot — 12" sitting beneath five local hardware stores scored 88–95 is more persuasive and more honest than hiding it. This is a core product decision.

**Default sort is by Localize score, highest first**, with a user toggle to sort by distance instead. Settled.

**No persistence, no accounts in v1.** Nothing is saved between sessions.

**Mobile-first.** The app must feel native on a phone; the map-plus-bottom-sheet pattern in §6/§7 is the intended mobile treatment.

---

## 4. Search input handling

The search box accepts three kinds of input and should feel like it "just works" for all of them, with no mode switch the user has to pick.

- **Categories and products** ("furniture," "oil change," "AA batteries," "Nintendo Switch") are passed largely **straight through to Google Places text search**, which already resolves them to relevant local business types well. Don't build a category taxonomy or a product database; lean on Places.
- **Big-box brand names** ("Home Depot," "Best Buy," "PetSmart") are the one case that needs help, because a literal search returns *more of that chain* — the opposite of the point. The **brand denylist (§6) does double duty here:** each known big-box brand carries an associated category keyword (e.g. Home Depot → "hardware / home improvement," Best Buy → "electronics," PetSmart → "pet supplies"). A search that matches a denylisted brand is **pivoted into a category search for local alternatives**, while the brand itself is still shown (with its low score) so the contrast is visible.
- Everything not matching a brand passes through unchanged.

The principle: minimal custom interpretation, maximal reliance on Places' own matching, with the denylist as the only translation layer.

---

## 5. The search experience & result narrowing

This is the heart of the interaction, so it's described in detail — but the *how* (data structures, exact gridding math, clustering library) is yours.

**The viewport is the search area.** On load, the app geolocates the user (browser geolocation), centers the map there at a neighborhood/metro-scale zoom, and **runs one search automatically** so the user never faces an empty screen. A manual location entry (geocoded via the Geocoding API) is the fallback when geolocation is denied or unavailable.

**"Search this area."** When the user pans or zooms the map, a "Search this area" button appears (the moment the map has moved since the last search), exactly like Google Maps. Tapping it re-runs the search against the **current visible map bounds** and refreshes both the pins and the results list. The user's current zoom level *is* how they control scope — zoom into a block for tight coverage, zoom out to a metro for a regional view.

**Narrowing when zoomed out (the "intelligent selection").** A large viewport could contain far more businesses than are useful to list — and Google's text search returns at most roughly 60 results per query anyway, so a wide-area search is *always* a curated sample rather than an enumeration. Embrace that. When the area is large, select the sample deterministically by:
- **Capping** the displayed set to a sensible ceiling (around 30–40).
- **Ranking the sample by Localize score**, using rating and review count as quality tiebreakers — so a zoomed-out view surfaces the standout *local* options across the region, on-mission, rather than a random scatter.
- **Spreading results geographically** so they don't all clump in one neighborhood — conceptually, divide the viewport into a grid and keep the best per cell. The wider the view, the more this matters.
- **Clustering pins visually** at high zoom-out (standard numbered cluster markers that break apart as the user zooms in), so the map stays legible while the list shows the thinned top set.

Net behavior: zoom into a neighborhood → near-complete local coverage there; zoom out to a whole metro → a curated, geographically-spread "best independents around here" view. Same button, scale-aware results.

**Sparse / rural case.** If a search area genuinely has no local alternatives, don't show an empty screen — show whatever exists (including the big-box options) plus a clear prompt to **zoom out and search a wider area**, framed as a next action rather than a dead end.

---

## 6. The Localize score (principles, not formulas)

The score answers one question — *how much does buying here support local, independent business?* — on a 0–100 scale, and it must be explainable in a sentence. Tune the internal numbers yourself; the bands and signals below are the fixed framework.

**The bands:**

| Score | Meaning |
|---|---|
| 90–100 | Single-location, independently-owned, physical store |
| 70–89 | Small local chain (a few locations, one metro) |
| 40–69 | Regional chain |
| 15–39 | National chain / big-box with physical stores |
| 0–14 | National / multinational e-commerce giants (Amazon, Alibaba, Temu, Walmart.com) |

**The score is built from three deterministic signals:**

1. **A curated brand denylist (the hard cap).** A static, editable list of known national big-box retailers and e-commerce giants — by business name *and* by website domain — that the operator maintains. Any result matching it is forced into the bottom bands (e-commerce-only → 0–14, physical big-box → 15–39) regardless of other signals. This same list carries each brand's alternative-category keyword for the search pivot in §4. It's the most reliable signal for exactly the businesses the product most wants to steer away from, and it stays in the operator's control.

2. **A location-count heuristic (the gradient between independent and regional).** For a candidate that isn't on the denylist, run one **wide-area Places search on the business's normalized name and count how many distinct locations come back.** Few or one → independent (top band); a handful → small local chain; a couple dozen → regional; many → treat as national. This is the signal that separates "Joe's Hardware" (one pin) from a twelve-store regional chain, and it's pure counting — no inference. To control cost, **only compute it for candidates actually being displayed** (the thinned top set), and **cache the derived result** (see below).

3. **Minor modifiers (tiebreakers only).** Small nudges from Google Places signals — e.g. a `department_store` / `supermarket` type nudges down, and a single location carrying thousands of reviews (almost always a high-traffic chain) nudges down. Keep these light so the score stays legible; they break ties, they don't drive the result.

**Transparency requirement.** Wherever the score is shown in detail, show a one-line *why* derived from these signals ("1 location in this area · independently operated · not on the national-retailer list"). The score must never feel arbitrary.

**Caching (and a Google terms note).** Cache the **derived classification** — the brand-or-business → score/tier result — keyed by normalized name/domain, so a repeat lookup of a known brand costs nothing and the per-candidate count search isn't repeated. National brands don't change, so this cache is highly effective; it can be pre-seeded from the denylist. Cache *our derived data* and place identifiers, not Google's display content (photos, review text) beyond what Google's terms permit — fetch display content live per search. A lightweight store (e.g. SQLite or Redis) is appropriate; the choice is yours.

---

## 7. Features

### 7.1 Search bar
A single text field that accepts brands, categories, or products (§4). Prominent on load, and on mobile it collapses into a compact pill at the top once a search is active so the map and results own the screen.

### 7.2 Map
Google Maps JavaScript API filling the viewport.
- **Pins colored by Localize band** — so the map itself communicates local-ness at a glance (strong green for top-band independents, fading through amber to a muted grey/red for big-box and e-commerce). The pin color scale and the score-badge color scale are the same scale, defined centrally.
- **Pin ↔ card link:** tapping a pin highlights and scrolls to its card; selecting a card highlights and centers its pin. Selection stays in sync both ways.
- **Pin tap** shows a brief info bubble: name, score badge, rating, a thumbnail.
- Cluster markers when zoomed out (§5).

### 7.3 Results list
A scrollable list of result cards. On **desktop**, beside the map; on **mobile**, a **draggable bottom sheet** over the map (peeks showing the top result, drags up to expand, has a grab handle).
- Sorted by **Localize score, highest first** by default, with a visible toggle to **sort by distance** instead (distance measured from the user's location when available, otherwise from the map center).
- Big-box / e-commerce results are included with their low scores (they naturally fall to the bottom under score sort).

### 7.4 Result card
Each card shows:
- Business **name**.
- **Photo** (with a tasteful placeholder when Google has none).
- **Rating** (stars) and **review count**.
- The **Localize score** as a prominent badge/dial, colored by band.
- A **website link** when one exists.
- An **"Open in maps"** button (§7.6).

### 7.5 Detail view
Tapping a card opens a light panel (a sheet on mobile, a side/overlay panel on desktop) with: address, opening hours, a review snippet or two, more photos if available, and the **"why this score" breakdown** from §6. This is where trust is earned, so make the score explanation clear and human.

### 7.6 Open in maps
A smart, universal handoff that opens the business in the user's preferred maps app — **Apple Maps on iOS, Google Maps elsewhere** — using the place's Google-provided map link or its identifier/coordinates. It should "just open the right app" without the user choosing.

### 7.7 Loading & empty states
- A tasteful loading state while a search runs (see motion notes in §8).
- The sparse/rural empty state from §5 — never a blank dead-end.

---

## 8. UI / UX & design system

**Design language:** modern, warm, and civic — it should feel like a well-made local guide, not a discount-finder or a preachy activism app. Confident and optimistic, gently persuasive by *showing* good local options rather than lecturing. Clean, generous spacing; the businesses and their scores are the heroes.

**Color palette (starting point — refine as needed):**
- Background: warm off-white (`#FAF7F0`)
- Primary: a grounded, confident green (`#2F7A4F`) — "grown here / local"
- Accent: warm terracotta / clay (`#C26B3E`)
- Dark / text: near-black (`#1C1B1A`)
- Panel / card: soft white (`#FFFFFF`) with a gentle shadow
- **Score scale:** a single continuous scale from muted red (`~#B4453A`) at 0, through amber (`~#D9A441`) in the middle, to vivid green (`~#2F9E5E`) at 100. This same scale colors both the score badges and the map pins — it's the app's signature visual language, so define it once and use it everywhere.

**Typography:** a clean, readable sans for UI and body (e.g. Inter or DM Sans), optionally a slightly warmer display face for headings (e.g. Fraunces or Bricolage Grotesque). A tabular/mono treatment for the numeric score reads nicely. Treat these as suggestions, not mandates.

**The score badge** is a signature element: a small circular dial or ring showing the 0–100 number, filled and colored by the score scale, that **animates filling up** when a card appears.

**Map pins:** custom markers in the score-scale color, the selected one larger/elevated.

**Cards:** photo-led, soft shadow, rounded corners, a clear hierarchy with the score badge prominent.

**Motion (tasteful and physical, part of the brand):** pins drop and settle onto the map; result cards stagger in; the "Search this area" button fades in when the map moves; the mobile bottom sheet is spring-animated; the score dials animate filling. Use a capable animation approach so it all feels smooth and intentional — never flashy or gratuitous. Respect reduced-motion preferences.

**Mobile (primary target):** map behind a spring bottom sheet of results; search collapses to a top pill once active; "Search this area" floats above the sheet; everything is thumb-reachable and touch-sized.

---

## 9. v2 — design for, don't build

Leave room for these, but **do not build them now.** Architecture should simply not preclude them.

- User accounts, saved/favorite businesses, and search history (would introduce a real user database).
- Letting business owners "claim" or correct their listing.
- Writing or aggregating reviews within Localize (reviews stay read-from-Google in v1).
- Any monetization (featured listings, referrals, etc.).
- Multi-area / saved-locations browsing beyond the single live map.
- A richer ownership signal than the three deterministic ones (e.g. external chain/franchise datasets) — the current signals are deliberately sufficient for v1.

---

## 10. Confirm before starting

A few items the build needs an answer on before the relevant step:

1. **Google Maps Platform key.** The build requires a Google Cloud project with **Maps JavaScript API, Places API (New), and Geocoding API** enabled and billing configured, with the keys supplied via environment variables (a referrer-restricted browser key and an IP-restricted server key). Confirm this is available before wiring the data layer.
2. **Initial denylist contents.** The brand denylist is operator-owned; confirm whether to ship a reasonable starter list (Walmart, Target, Home Depot, Lowe's, Best Buy, Costco, CVS, Walgreens, Amazon, Alibaba, Temu, and similar, each with an alternative-category keyword) or whether one will be provided.
3. **Name & tagline.** App name is **Localize**. A tagline is open — *"Find it nearby. Keep it local."* is the working default; flag if you'd like a different one before it's baked into the UI.
