# Crave — Design Doc

*Working title: Grubmaps. Product name: Crave. This branch is the personal-tour experiment.*

## Why this exists

Every food-review app has become the same thing: a noisy, algorithm-optimized, ad-cluttered feed where the best places drown under sponsored placements and gamed 4.5-star reviews written by people who ordered once. Yelp is a marketing surface. Google Reviews is a data-collection substrate. Neither one tells you what your friend who *actually* eats out three nights a week thinks is worth going out of your way for.

**Crave is a personal + tribal tour of the good stuff.** You pin the spots you love, in your own words, with a verdict (Yum / Meh / Yuck). You see what other people with similar taste have pinned. The map is the primary surface — because eating is a place-based activity, and lists are what search engines gave us, not what humans actually want.

Three commitments the design enforces:

1. **Deliberate authoring over accidental capture.** You can't tap the map to drop a pin. Every review is intentionally attached to a real business you searched for.
2. **Distillation over prose.** Reviews are 1–8 words. "Best carne asada tacos." "Solid meh." "Overrated but the room is beautiful." Short takes force you to say what you actually think.
3. **Real places over free-form coordinates.** Every review is anchored to an OpenStreetMap-identified business — meaning reviews aggregate cleanly, chains show every location, and the map is a real index instead of a graffiti wall.

## Who it's for

**The food-curious local.** Someone who eats out several times a week, keeps a mental Rolodex of their favorite spots, and wishes they had a way to remember which taco truck had that one dish, or share the "actually good" list with a friend visiting from out of town. They want a personal restaurant journal that doubles as a social recommendation engine — without becoming a chore.

**Their friends and tribe.** People who trust *this person* more than they trust the aggregate wisdom of Yelp. A shared tour is the primary artifact — "here's what Anupam thinks is worth eating in Milwaukee" is a more useful thing to send someone than a list of 4.5-star restaurants.

**The traveler.** Landing in a new city, they want the tour that locals-who-eat-out give — filtered by cuisine, mood, or a specific spot they've heard about. Not the top-of-search-results hits everyone else eats at.

## The core UX

The app opens on the map, centered on the user's city. Nine 3D-rendered category icons run across the top (Food, Coffee, Bars, Cocktails, Wine, Cigars, Sweets, Culture, Music) — tapping one filters the map to only that interest. A search bar at the top and a big red "+ REVIEW" button at the bottom-center are the two verbs.

There are four main flows:

### 1. Onboarding

First visit shows a lightweight login modal — no password, no email, just a display name ("what should we call you?"). A UUID is minted, stored in localStorage, and passed on every write via `X-User-Id`. Not real auth; a prototype convenience. The city is auto-detected from GPS on first load (via a Nominatim reverse-geocode) and cached; a chip in the search bar lets you change it manually.

### 2. Browse

The default state. Pick an interest from the top row; the map re-fetches pins for that category. Pins show the reviewer's verdict emoji (😋 / 🫤 / 💩) and their short take rotated slightly for personality. The "everyone / my tour" toggle switches between the community feed and just the current user's pins.

### 3. Search — three intents

Typing into the search bar hits a `gpt-4o-mini` classifier that decides what the user meant:

- **Named place** ("Discourse Coffee", "Cousins Subs") → resolves to a real business via OpenStreetMap Nominatim. Single hit: map flies to it and the detail sheet opens automatically. Multiple hits (chains): all locations drop as pins, sheet opens on the most-reviewed one.

- **Craving / cuisine** ("italian", "tacos", "hangover food") → the classifier extracts OSM `cuisine` and `amenity` tags plus a set of chain-name expansion terms. The server unions three sources:
  1. Local FTS5 hits (community reviews whose tag text matches),
  2. Overpass API results (real OSM-tagged restaurants in the city bbox),
  3. Nominatim name-based expansion (catches chains missing cuisine tags).
  All three merged, deduped by business id, sorted with reviewed spots first, capped at 30 pins. Reviewed spots render in full color with their review tag; unreviewed render greyed with a "❔" as the "be the first" prompt.

- **Ambiguous** ("blue bottle" — a chain or a category?) → a disambiguation modal offers both options; user picks one.

### 4. Author a review

Two entry points, both deliberate:

- **The floating "+ REVIEW" FAB** at bottom-center → business-picker modal (autocomplete against Nominatim) → pick a real business → review modal.
- **From a detail sheet** — every business detail sheet has a "Write a review" / "Be the first to review" CTA, so you can review whatever you're currently looking at.

The review modal has three fields: **category** (which interest bucket), **verdict** (Yum / Meh / Yuck), and **your take** (1–8 words). Submit posts to the server and the pin lands on the map immediately.

## Architecture

**Frontend** — Vue 3 + TypeScript, Vite, MapLibre GL for the map, OpenFreeMap Positron tiles (with minor roads faded by zoom and non-major road labels filtered out for a cleaner "map recedes, pins pop" aesthetic).

**Backend** — Bun runtime + Hono for HTTP + SQLite (via `bun:sqlite`) with FTS5 for full-text search over review tags. Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`).

**Place data** — OpenStreetMap, hit two different ways:
- **Nominatim** — name-based search, geocoding, reverse-geocoding. Free, rate-limited, no key.
- **Overpass API** — structured tag queries (`amenity=restaurant AND cuisine=italian` in a bbox). Free, better for category searches, slower per query. Cached for an hour.

**LLM classifier** — `gpt-4o-mini` in JSON mode, temperature 0, called once per search. Returns intent, plus `cuisines[]`, `amenities[]`, and `poi_terms[]` for craving expansions. Cost is ~$0.0001 per search. Heuristic fallback if no OpenAI key is set (title-cased short queries → named, else craving).

**3D icons** — the nine interest icons are rendered by `gpt-image-1` using a shared style reference (a cinematic App Store-style sushi icon in `.context/style-refs/food-icon.png`). Generated once via `bun run icons:gen`, with a manifest (`web/public/food-icons/manifest.json`) capturing the exact prompt + SHAs so regeneration is traceable. Icons use transparent-alpha PNGs so the frame/gradient stays composable in CSS.

## Data model

```
users        — id (uuid), display_name, created_at
interests    — id, name, emoji, color, sort_order   (seeded from server)
businesses   — id ("osm:node:12345"), source, source_id,
                name, address, lat, lng, city, category, created_at
reviews      — id, user_id → users, business_id → businesses,
                interest_id → interests, tag, verdict (-1|0|1),
                created_at, ip_hash
reactions    — id, review_id → reviews, kind (legit|dispute|protip),
                ip_hash, created_at
reviews_fts  — FTS5 virtual table over reviews.tag  (triggered sync)
```

A **business** is a real place identified by its OSM `type:id`. This is the single most important architectural decision — earlier iterations pinned reviews to raw lat/lng and produced a graffiti-wall map where the same restaurant might have five overlapping pins. Anchoring on business identity means reviews aggregate cleanly, chains show every location, and the detail sheet has a stable entity to bind to.

## Key design decisions and their rationale

**Map is browse-only.** No tap-to-drop. Reviews always start from a business identity — either you search for it, or you FAB → pick it. This trades a moment of friction for a much healthier data model (no lat/lng orphans, no accidental pins while panning) and forces the mental model that reviews are *about places*, not coordinates.

**1–8 word takes.** Length limit forces the reviewer to distill. "Best mole in the neighborhood." "Overpriced, worth it." "Skip the fish, get the tacos." Long-form review platforms optimize for scrollable content; Crave optimizes for signal density.

**Community first, place database second.** When you search "italian", any spot with real community reviews leads visually (full color, actual tag text). Only after the reviewed ones does the wider Overpass-tagged list fill in as greyed "be the first" candidates. The map is a Trojan horse for reviews — every greyed pin is an invitation to author.

**City-scoped everything.** Reviews are filtered to your current city. Overpass queries run against the city's bounding box. Search results only return spots in that city. Traveling? Change the city chip.

**Nine curated interests.** Not free-form tags — a fixed short list forces coherence and makes tribal filtering meaningful. "What's Anupam's coffee list in San Diego" is a query the system answers cleanly; "what's Anupam's rated-4-stars-and-up list" would be noise.

**LLM at query time, not enrichment time.** Rather than pre-generating menu descriptions for every restaurant in the city (expensive, brittle, freshness burden), we let the LLM interpret the *query* at runtime. It knows Cousins Subs from Jimmy John's, translates "tacos" to `cuisine=mexican` and expands the chain names. Real cuisine data comes from OSM's curated `cuisine` tags for free.

## What's intentionally out of scope

- **Real auth** — anyone can spoof `X-User-Id`. Fine for a prototype where the point is evaluating the UX; not fine for a public deployment.
- **Following / social graph** — you can see everyone's pins or your own, no in-between yet.
- **Ratings, prices, hours** — verdict is a 3-value axis (Yum / Meh / Yuck), not a 5-star scale. No price filter. No open-now filter. If it becomes needed, Overpass exposes `opening_hours` and `price_range` tags.
- **User-created interests** — the nine-category list is fixed.
- **Menu-item enrichment** — deferred until real usage shows which spots matter enough to enrich. The lazy path (enrich on first review or view, cache forever) is the intended future work if the current cuisine-tag coverage feels too coarse.

## Roadmap sketch

- **Reactions on reviews in the detail sheet** — the old fire/dispute/protip fan popover was tied to per-review pins; needs to be rebuilt as inline buttons on each review row in the sheet.
- **Compound-craving re-ranking** — "italian subs" currently returns italian restaurants + pizza places. A second LLM pass could reason over the 30 candidates and rank sub shops with italian offerings on top.
- **Lazy per-business enrichment** — first time a business is reviewed or viewed, generate a 1-paragraph description (menu highlights, vibe) via LLM. Cache in `businesses.description`, index by FTS5. Coverage grows organically with real user attention.
- **Semantic search over enriched descriptions** — for queries like "cozy date night" that don't map to any tag. `sqlite-vec` inside the existing SQLite file, one embedding per description.
- **Real auth + shared tours** — the moment two humans want to view each other's list, this becomes necessary.
