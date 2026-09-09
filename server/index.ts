import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

// New DB for the review-placement UX. Keeps the old tour DB around for
// easy revert. Drop this file to start over. In prod (Fly.io) the DB
// lives on a persistent volume mounted at /data.
const DB_PATH = process.env.DB_PATH ?? "grubmaps-review.db";
const db = new Database(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

// ---- schema ------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS interests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,        -- 'osm' for Nominatim results
    source_id TEXT NOT NULL,     -- Nominatim osm_type + osm_id, or place_id
    name TEXT NOT NULL,
    address TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    city TEXT,                   -- e.g. 'Milwaukee', 'San Diego'
    category TEXT,               -- Nominatim class/type combo, informational
    created_at INTEGER NOT NULL,
    UNIQUE(source, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
  CREATE INDEX IF NOT EXISTS idx_businesses_geo ON businesses(lat, lng);

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    interest_id TEXT NOT NULL REFERENCES interests(id),
    tag TEXT NOT NULL,
    verdict INTEGER NOT NULL CHECK (verdict IN (-1, 0, 1)),
    created_at INTEGER NOT NULL,
    ip_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_business ON reviews(business_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_interest ON reviews(interest_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at);

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('legit','dispute','protip')),
    ip_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (review_id, ip_hash, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_review_id ON reactions(review_id);

  -- FTS5 index over review.tag for craving search.
  CREATE VIRTUAL TABLE IF NOT EXISTS reviews_fts USING fts5(
    tag,
    content='reviews',
    content_rowid='id'
  );
`);

// FTS triggers must be created outside the CREATE VIRTUAL TABLE statement.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS reviews_ai AFTER INSERT ON reviews BEGIN
    INSERT INTO reviews_fts(rowid, tag) VALUES (new.id, new.tag);
  END;
  CREATE TRIGGER IF NOT EXISTS reviews_ad AFTER DELETE ON reviews BEGIN
    INSERT INTO reviews_fts(reviews_fts, rowid, tag) VALUES('delete', old.id, old.tag);
  END;
  CREATE TRIGGER IF NOT EXISTS reviews_au AFTER UPDATE ON reviews BEGIN
    INSERT INTO reviews_fts(reviews_fts, rowid, tag) VALUES('delete', old.id, old.tag);
    INSERT INTO reviews_fts(rowid, tag) VALUES (new.id, new.tag);
  END;
`);

// Seed interests. INSERT OR REPLACE so name/emoji/color updates take effect on restart.
const SEED_INTERESTS: { id: string; name: string; emoji: string; color: string }[] = [
  { id: "food",       name: "Food",       emoji: "🍔", color: "#22863a" },
  { id: "coffee",     name: "Coffee",     emoji: "☕", color: "#6f4e37" },
  { id: "bars",       name: "Bars",       emoji: "🍺", color: "#f59e0b" },
  { id: "cocktails",  name: "Cocktails",  emoji: "🍸", color: "#ec4899" },
  { id: "wine",       name: "Wine",       emoji: "🍷", color: "#7f1d1d" },
  { id: "cigars",     name: "Cigars",     emoji: "🚬", color: "#4a3524" },
  { id: "sweets",     name: "Sweets",     emoji: "🍰", color: "#f472b6" },
];
const seedStmt = db.prepare(
  "INSERT OR REPLACE INTO interests (id, name, emoji, color, sort_order) VALUES (?, ?, ?, ?, ?)",
);
SEED_INTERESTS.forEach((i, idx) => seedStmt.run(i.id, i.name, i.emoji, i.color, idx));
// Prune any interest ids that used to exist but are no longer seeded
// (e.g. removed "culture"/"music"). Reviews FK'd to a missing interest
// would be an issue, but pruning is safe on a dev DB with sim data —
// the sim only uses interests from CRAVING_TO_INTEREST which excludes
// these anyway.
const KEEP_IDS = SEED_INTERESTS.map((i) => `'${i.id}'`).join(",");
db.exec(`DELETE FROM interests WHERE id NOT IN (${KEEP_IDS});`);

// ---- utility -----------------------------------------------------------
const IP_SALT = process.env.IP_SALT ?? "grubmaps-dev-salt";
const hashIp = (ip: string) =>
  createHash("sha256").update(ip + IP_SALT).digest("hex").slice(0, 32);

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REVIEWS = 30;
const RATE_MAX_REACTIONS = 200;
const reviewRateBuckets = new Map<string, number[]>();
const reactionRateBuckets = new Map<string, number[]>();
const checkRate = (bucket: Map<string, number[]>, ipHash: string, max: number) => {
  const now = Date.now();
  const timestamps = (bucket.get(ipHash) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (timestamps.length >= max) return false;
  timestamps.push(now);
  bucket.set(ipHash, timestamps);
  return true;
};

const MIN_WORDS = 1;
const MAX_WORDS = 8;
const MAX_CHARS = 60;
const MAX_NAME_LEN = 32;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const REACTION_KINDS = ["legit", "dispute", "protip"] as const;
type ReactionKind = (typeof REACTION_KINDS)[number];
const isReactionKind = (v: unknown): v is ReactionKind =>
  typeof v === "string" && (REACTION_KINDS as readonly string[]).includes(v);

const countsForReview = (reviewId: number) => {
  const rows = db
    .query("SELECT kind, COUNT(*) AS n FROM reactions WHERE review_id = ? GROUP BY kind")
    .all(reviewId) as { kind: ReactionKind; n: number }[];
  const out = { legit: 0, dispute: 0, protip: 0 };
  for (const r of rows) out[r.kind] = r.n;
  return out;
};

const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

// Latest review + total count for a business id. Returns nulls when the
// business has never been reviewed (or isn't in our DB at all).
type ReviewStats = {
  review_count: number;
  latest_review: {
    id: number; verdict: number; tag: string; interest_id: string;
    created_at: number; display_name: string | null;
  } | null;
};
const reviewStatsFor = (businessId: string): ReviewStats => {
  const latest = db.query(
    `SELECT r.id, r.verdict, r.tag, r.interest_id, r.created_at, u.display_name
     FROM reviews r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.business_id = ?
     ORDER BY r.created_at DESC
     LIMIT 1`,
  ).get(businessId) as {
    id: number; verdict: number; tag: string; interest_id: string;
    created_at: number; display_name: string | null;
  } | null;
  const countRow = db
    .query("SELECT COUNT(*) AS n FROM reviews WHERE business_id = ?")
    .get(businessId) as { n: number };
  return { review_count: countRow.n, latest_review: latest };
};

// ---- Nominatim wrapper -------------------------------------------------
// Nominatim requires a descriptive User-Agent. Their usage policy caps
// requests at ~1/sec; we do minimal caching to be a good citizen.
const NOMINATIM_UA = "grubmaps-dev/0.1 (personal-tour experiment)";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const nominatimCache = new Map<string, { at: number; value: unknown }>();
const NOMINATIM_TTL_MS = 5 * 60 * 1000;

async function nominatim<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${NOMINATIM_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = url.toString();
  const cached = nominatimCache.get(key);
  if (cached && Date.now() - cached.at < NOMINATIM_TTL_MS) return cached.value as T;

  const res = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as T;
  nominatimCache.set(key, { at: Date.now(), value: json });
  return json;
}

// ---- Overpass wrapper --------------------------------------------------
// Overpass exposes real OSM tags (cuisine=italian, amenity=restaurant),
// which is what we need for "italian" → all italian restaurants in the
// city. Free, polite rate limits. Longer TTL because city cuisine sets
// change slowly.
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const overpassCache = new Map<string, { at: number; value: unknown }>();
const OVERPASS_TTL_MS = 60 * 60 * 1000; // 1h

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

async function overpass(query: string): Promise<OverpassElement[]> {
  const cached = overpassCache.get(query);
  if (cached && Date.now() - cached.at < OVERPASS_TTL_MS) return cached.value as OverpassElement[];
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "User-Agent": NOMINATIM_UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { elements: OverpassElement[] };
  const elements = json.elements ?? [];
  overpassCache.set(query, { at: Date.now(), value: elements });
  return elements;
}

// City bounding box lookup (S, W, N, E). Cached for the process lifetime.
const cityBboxCache = new Map<string, [number, number, number, number]>();
async function cityBbox(city: string): Promise<[number, number, number, number] | null> {
  const key = city.trim().toLowerCase();
  if (cityBboxCache.has(key)) return cityBboxCache.get(key)!;
  try {
    const hits = await nominatim<Array<NominatimHit & { boundingbox?: string[] }>>("/search", {
      city, format: "json", limit: "1",
    });
    const bb = hits[0]?.boundingbox;
    if (!bb || bb.length !== 4) return null;
    // Nominatim returns [south, north, west, east] as strings.
    const bbox: [number, number, number, number] = [
      Number(bb[0]), Number(bb[2]), Number(bb[1]), Number(bb[3]),
    ];
    cityBboxCache.set(key, bbox);
    return bbox;
  } catch {
    return null;
  }
}

// Turn an Overpass element into the same Business shape we use everywhere else.
const elementToBusiness = (el: OverpassElement) => {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat ?? 0;
  const lon = el.lon ?? el.center?.lon ?? 0;
  const addr = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:suburb"] ?? tags["addr:neighbourhood"] ?? null,
    tags["addr:city"] ?? null,
    tags["addr:state"] ?? null,
  ].filter((p) => p && p.length > 0).join(", ");
  return {
    id: `osm:${el.type}:${el.id}`,
    source: "osm" as const,
    source_id: `${el.type}:${el.id}`,
    name: tags.name ?? "(unnamed)",
    address: addr.length > 0 ? addr : null,
    city: tags["addr:city"] ?? null,
    lat, lng: lon,
    category: [tags.amenity, tags.cuisine].filter(Boolean).join(":") || null,
  };
};

// Build an Overpass query for the given cuisines + amenities in a bbox.
// Empty cuisines → just the amenity types (e.g. "restaurant" alone).
const AMENITY_DEFAULTS = ["restaurant", "cafe", "fast_food", "bar", "pub"];
function buildOverpassQuery(
  bbox: [number, number, number, number],
  cuisines: string[],
  amenities: string[],
): string {
  const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
  const amenityRegex = (amenities.length > 0 ? amenities : AMENITY_DEFAULTS).join("|");
  const clauses: string[] = [];
  if (cuisines.length > 0) {
    // OSM cuisine tags can be semicolon-separated ("italian;pizza"), so use ~
    // for a substring/regex match.
    const cuisineRegex = cuisines.join("|");
    for (const el of ["node", "way"]) {
      clauses.push(`${el}[amenity~"${amenityRegex}"][cuisine~"${cuisineRegex}",i](${bboxStr});`);
    }
  } else {
    for (const el of ["node", "way"]) {
      clauses.push(`${el}[amenity~"${amenityRegex}"](${bboxStr});`);
    }
  }
  return `[out:json][timeout:20];(${clauses.join("")});out center 60;`;
}

type NominatimHit = {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
    state?: string;
    country?: string;
    country_code?: string;
    postcode?: string;
    road?: string;
    suburb?: string;
    neighbourhood?: string;
    house_number?: string;
  };
};

const cityOf = (a?: NominatimHit["address"]) =>
  a?.city ?? a?.town ?? a?.village ?? a?.municipality ?? a?.county ?? null;

const shortAddress = (a?: NominatimHit["address"]) => {
  if (!a) return null;
  const parts = [
    [a.house_number, a.road].filter(Boolean).join(" "),
    a.suburb ?? a.neighbourhood ?? null,
    cityOf(a),
    a.state,
  ].filter((p) => p && p.length > 0);
  return parts.join(", ");
};

const businessIdFor = (hit: NominatimHit) =>
  hit.osm_type && hit.osm_id != null
    ? `osm:${hit.osm_type}:${hit.osm_id}`
    : `osm:place:${hit.place_id}`;

// ---- LLM intent classifier --------------------------------------------
type Intent = "named" | "craving" | "ambiguous";
type ClassifierResult = {
  intent: Intent;
  named_query?: string;      // canonical business name if intent=named or ambiguous
  craving_query?: string;    // craving keyword phrase if intent=craving or ambiguous
  poi_terms?: string[];      // place-database search phrases for craving (chain names, synonyms, categories)
  cuisines?: string[];       // OSM cuisine tag values (e.g. ["italian","pizza"])
  amenities?: string[];      // OSM amenity types (e.g. ["restaurant","fast_food"])
  reason?: string;
};

async function classifyIntent(q: string, city: string | null): Promise<ClassifierResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // No key → fall back to heuristic: two title-cased words → named; else craving.
    const words = q.trim().split(/\s+/);
    const looksNamed = words.length <= 4 && words.every((w) => /^[A-Z]/.test(w));
    return looksNamed
      ? { intent: "named", named_query: q.trim(), reason: "heuristic (no LLM)" }
      : { intent: "craving", craving_query: q.trim(), poi_terms: [q.trim()], reason: "heuristic (no LLM)" };
  }
  const system =
    'You classify short search queries typed into a local-food-review app.\n' +
    'Given the query and the user\'s current city, return strict JSON:\n' +
    '{"intent":"named"|"craving"|"ambiguous","named_query":"...","craving_query":"...","poi_terms":["...","..."],"cuisines":["..."],"amenities":["..."],"reason":"..."}\n\n' +
    '- "named": the query is a distinctive brand or business name, even if it contains a category word. Examples: "Discourse Coffee", "Din Tai Fung", "Cousins Subs", "Shake Shack", "Blue Bottle Coffee", "Jimmy John\'s", "In-N-Out Burger". If the two-or-more-word combination together forms a recognizable brand, choose "named" — do NOT mark it ambiguous just because one word is a category noun.\n' +
    '- "craving": the query is a bare cuisine, dish, mood, or descriptor with no proper-noun brand token. Examples: "great tacos", "hangover food", "cozy date night", "subs", "pho", "coffee".\n' +
    '- "ambiguous": use ONLY when the query is a single ambiguous word/phrase that is BOTH a well-known brand AND a bare category noun with no additional qualifier. Reserve this bucket sparingly. If in doubt, choose "named" over "ambiguous".\n\n' +
    'For craving/ambiguous intents, populate cuisines[] and amenities[] using OpenStreetMap tag values (these become an Overpass query against real OSM cuisine/amenity tags):\n' +
    '  cuisines: OSM cuisine values — pick from italian, pizza, chinese, sushi, japanese, mexican, taco, thai, indian, vietnamese, pho, korean, mediterranean, greek, turkish, lebanese, ramen, noodle, burger, sandwich, seafood, bbq, breakfast, brunch, american, french, ethiopian, spanish, tapas, steak, vegetarian, vegan, coffee_shop, ice_cream, chicken, pub_food, wine_bar. Include synonyms — "subs" → ["sandwich"], "italian" → ["italian","pizza"], "tacos" → ["mexican","taco"].\n' +
    '  amenities: OSM amenity values — pick from restaurant, cafe, fast_food, bar, pub, ice_cream, biergarten. Default to ["restaurant","cafe","fast_food","bar","pub"] if the query doesn\'t narrow it. Coffee → ["cafe"]. Bars → ["bar","pub"]. Fast food/subs → ["fast_food","restaurant"].\n\n' +
    'poi_terms: for craving/ambiguous, also return 4-8 short phrases for a name-based place lookup (chain names + cuisine words) — this catches spots not tagged with cuisine. Examples:\n' +
    '  "subs" → ["subs","subway","sandwich shop","jimmy johns","jersey mikes","cousins subs","potbelly"]\n' +
    '  "tacos" → ["taco","taco bell","chipotle","taqueria"]\n' +
    '  "italian" → ["italian","pizza","ristorante","trattoria","pizzeria"]\n' +
    'Prefer regional chains where you can. Keep terms short (1-3 words).\n\n' +
    'Always include named_query and craving_query when intent is "ambiguous". ' +
    'Return only the JSON, no prose. If the query is a single common food/drink noun, prefer "craving".';
  const user = `city: ${city ?? "(unknown)"}\nquery: ${q}`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TEXT_MODEL ?? "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as ClassifierResult;
    if (parsed.intent !== "named" && parsed.intent !== "craving" && parsed.intent !== "ambiguous") {
      throw new Error(`bad intent: ${parsed.intent}`);
    }
    return parsed;
  } catch (err) {
    console.warn("classifier failed, falling back to craving:", err);
    return { intent: "craving", craving_query: q.trim(), reason: `fallback: ${String(err)}` };
  }
}

// ---- app ---------------------------------------------------------------
const app = new Hono();
app.use("/*", cors({ origin: "*", allowHeaders: ["Content-Type", "X-User-Id"] }));

// ---- interests ---------------------------------------------------------
app.get("/api/interests", (c) => {
  const rows = db
    .query("SELECT id, name, emoji, color FROM interests ORDER BY sort_order ASC")
    .all();
  return c.json(rows);
});

// ---- users -------------------------------------------------------------
app.post("/api/users", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
  const { id, display_name } = body as Record<string, unknown>;
  if (typeof display_name !== "string" || display_name.trim().length === 0)
    return c.json({ error: "display_name required" }, 400);
  const trimmed = display_name.trim();
  if (trimmed.length > MAX_NAME_LEN) return c.json({ error: "display_name too long" }, 400);
  const useId = typeof id === "string" && id.length > 0 && id.length <= 64 ? id : randomUUID();
  const existing = db.query("SELECT id FROM users WHERE id = ?").get(useId);
  if (existing) {
    db.query("UPDATE users SET display_name = ? WHERE id = ?").run(trimmed, useId);
  } else {
    db.query("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)").run(
      useId, trimmed, Date.now(),
    );
  }
  return c.json({ id: useId, display_name: trimmed }, 201);
});

app.get("/api/users/:id", (c) => {
  const id = c.req.param("id");
  const row = db.query("SELECT id, display_name FROM users WHERE id = ?").get(id);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

// ---- places (Nominatim wrappers) ---------------------------------------
// Autocomplete for the business picker.
app.get("/api/places/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const city = (c.req.query("city") ?? "").trim();
  if (q.length < 2) return c.json([]);
  const limit = Math.max(1, Math.min(10, Number(c.req.query("limit") ?? 8)));
  const params: Record<string, string> = {
    q: city ? `${q}, ${city}` : q,
    format: "json",
    addressdetails: "1",
    limit: String(limit),
    dedupe: "1",
  };
  try {
    const hits = await nominatim<NominatimHit[]>("/search", params);
    const rows = hits.map((h) => ({
      source: "osm" as const,
      source_id: h.osm_type && h.osm_id != null ? `${h.osm_type}:${h.osm_id}` : `place:${h.place_id}`,
      id: businessIdFor(h),
      name: h.display_name.split(",")[0]!.trim(),
      display_name: h.display_name,
      address: shortAddress(h.address),
      city: cityOf(h.address),
      lat: Number(h.lat),
      lng: Number(h.lon),
      category: [h.class, h.type].filter(Boolean).join(":") || null,
    }));
    return c.json(rows);
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

// POI search by category keyword for the empty-fallback flywheel.
// Uses Nominatim's amenity/cuisine hints via free-text query scoped by city.
app.get("/api/pois/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const city = (c.req.query("city") ?? "").trim();
  if (q.length < 2) return c.json([]);
  const limit = Math.max(1, Math.min(20, Number(c.req.query("limit") ?? 12)));
  const params: Record<string, string> = {
    q: city ? `${q}, ${city}` : q,
    format: "json",
    addressdetails: "1",
    limit: String(limit),
    dedupe: "1",
  };
  try {
    const hits = await nominatim<NominatimHit[]>("/search", params);
    const rows = hits.map((h) => ({
      id: businessIdFor(h),
      name: h.display_name.split(",")[0]!.trim(),
      address: shortAddress(h.address),
      city: cityOf(h.address),
      lat: Number(h.lat),
      lng: Number(h.lon),
      category: [h.class, h.type].filter(Boolean).join(":") || null,
      source: "osm" as const,
      source_id: h.osm_type && h.osm_id != null ? `${h.osm_type}:${h.osm_id}` : `place:${h.place_id}`,
    }));
    return c.json(rows);
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

// Reverse-geocode lat/lng → city name (+ full address) for the city chip.
app.get("/api/city/reverse", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ error: "lat/lng required" }, 400);
  try {
    const hit = await nominatim<NominatimHit>("/reverse", {
      lat: String(lat),
      lon: String(lng),
      format: "json",
      addressdetails: "1",
      zoom: "10",
    });
    return c.json({
      city: cityOf(hit.address),
      state: hit.address?.state ?? null,
      country: hit.address?.country ?? null,
      display: hit.display_name,
      lat: Number(hit.lat),
      lng: Number(hit.lon),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

// ---- businesses --------------------------------------------------------
type BusinessRow = {
  id: string; source: string; source_id: string; name: string;
  address: string | null; lat: number; lng: number;
  city: string | null; category: string | null; created_at: number;
};

const upsertBusiness = (b: Omit<BusinessRow, "created_at">): BusinessRow => {
  const existing = db.query("SELECT * FROM businesses WHERE id = ?").get(b.id) as BusinessRow | null;
  if (existing) return existing;
  const now = Date.now();
  db.query(
    `INSERT INTO businesses (id, source, source_id, name, address, lat, lng, city, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.id, b.source, b.source_id, b.name, b.address, b.lat, b.lng, b.city, b.category, now);
  return { ...b, created_at: now };
};

// POST /api/businesses — upsert a business the client picked from autocomplete.
app.post("/api/businesses", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
  const b = body as Partial<BusinessRow>;
  if (typeof b.id !== "string" || typeof b.name !== "string" ||
      typeof b.lat !== "number" || typeof b.lng !== "number" ||
      typeof b.source !== "string" || typeof b.source_id !== "string") {
    return c.json({ error: "id, name, lat, lng, source, source_id required" }, 400);
  }
  const row = upsertBusiness({
    id: b.id, source: b.source, source_id: b.source_id, name: b.name,
    address: b.address ?? null, lat: b.lat, lng: b.lng,
    city: b.city ?? null, category: b.category ?? null,
  });
  return c.json(row, 201);
});

// GET /api/businesses/:id → business + its reviews (with reaction counts).
app.get("/api/businesses/:id", (c) => {
  const id = c.req.param("id");
  const business = db.query("SELECT * FROM businesses WHERE id = ?").get(id) as BusinessRow | null;
  if (!business) return c.json({ error: "not found" }, 404);
  const reviews = db
    .query(
      `SELECT r.id, r.user_id, r.business_id, r.interest_id, r.tag, r.verdict, r.created_at,
              u.display_name,
              COALESCE(SUM(CASE WHEN a.kind = 'legit'   THEN 1 END), 0) AS legit,
              COALESCE(SUM(CASE WHEN a.kind = 'dispute' THEN 1 END), 0) AS dispute,
              COALESCE(SUM(CASE WHEN a.kind = 'protip'  THEN 1 END), 0) AS protip
       FROM reviews r
       LEFT JOIN reactions a ON a.review_id = r.id
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.business_id = ?
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
    )
    .all(id);
  return c.json({ business, reviews });
});

// ---- reviews -----------------------------------------------------------
type ReviewRow = {
  id: number; user_id: string; business_id: string; interest_id: string;
  tag: string; verdict: number; created_at: number;
};

type ReviewWithMeta = ReviewRow & {
  lat: number; lng: number; business_name: string; business_address: string | null;
  business_city: string | null;
  display_name: string; legit: number; dispute: number; protip: number;
};

const SELECT_REVIEWS_BASE = `
  SELECT r.id, r.user_id, r.business_id, r.interest_id, r.tag, r.verdict, r.created_at,
         b.lat, b.lng, b.name AS business_name, b.address AS business_address, b.city AS business_city,
         u.display_name,
         COALESCE(SUM(CASE WHEN a.kind = 'legit'   THEN 1 END), 0) AS legit,
         COALESCE(SUM(CASE WHEN a.kind = 'dispute' THEN 1 END), 0) AS dispute,
         COALESCE(SUM(CASE WHEN a.kind = 'protip'  THEN 1 END), 0) AS protip
  FROM reviews r
  JOIN businesses b ON b.id = r.business_id
  LEFT JOIN reactions a ON a.review_id = r.id
  LEFT JOIN users u ON u.id = r.user_id
`;

app.get("/api/reviews", (c) => {
  const interest = c.req.query("interest");
  const user = c.req.query("user");
  const business = c.req.query("business");
  const city = c.req.query("city");
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (interest) { conds.push("r.interest_id = ?"); args.push(interest); }
  if (user)     { conds.push("r.user_id = ?");     args.push(user); }
  if (business) { conds.push("r.business_id = ?"); args.push(business); }
  if (city)     { conds.push("b.city = ?");         args.push(city); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .query(
      `${SELECT_REVIEWS_BASE}
       ${where}
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT 5000`,
    )
    .all(...args) as ReviewWithMeta[];
  return c.json(rows);
});

app.post("/api/reviews", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "X-User-Id required" }, 401);
  const userRow = db.query("SELECT id, display_name FROM users WHERE id = ?").get(userId) as
    | { id: string; display_name: string }
    | null;
  if (!userRow) return c.json({ error: "unknown user" }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);

  const { business_id, tag, verdict, interest_id } = body as Record<string, unknown>;
  if (typeof business_id !== "string" || business_id.length === 0)
    return c.json({ error: "business_id required" }, 400);
  const business = db.query("SELECT * FROM businesses WHERE id = ?").get(business_id) as BusinessRow | null;
  if (!business) return c.json({ error: "unknown business_id" }, 400);
  if (typeof tag !== "string") return c.json({ error: "tag required" }, 400);
  const trimmed = tag.trim();
  if (trimmed.length === 0) return c.json({ error: "tag required" }, 400);
  if (trimmed.length > MAX_CHARS) return c.json({ error: `tag must be ≤ ${MAX_CHARS} characters` }, 400);
  const words = wordCount(trimmed);
  if (words < MIN_WORDS || words > MAX_WORDS)
    return c.json({ error: `tag must be ${MIN_WORDS}-${MAX_WORDS} words` }, 400);
  if (verdict !== 1 && verdict !== 0 && verdict !== -1)
    return c.json({ error: "verdict must be 1 (yum), 0 (meh), or -1 (yuck)" }, 400);
  if (typeof interest_id !== "string" || interest_id.length === 0)
    return c.json({ error: "interest_id required" }, 400);
  const interestExists = db.query("SELECT 1 FROM interests WHERE id = ?").get(interest_id);
  if (!interestExists) return c.json({ error: "unknown interest_id" }, 400);

  const ipHash = hashIp(clientIp(c));
  if (!checkRate(reviewRateBuckets, ipHash, RATE_MAX_REVIEWS))
    return c.json({ error: "rate limit exceeded" }, 429);

  const now = Date.now();
  const result = db
    .query(
      `INSERT INTO reviews (user_id, business_id, interest_id, tag, verdict, created_at, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(userRow.id, business_id, interest_id, trimmed, verdict, now, ipHash) as { id: number };

  return c.json(
    {
      id: result.id,
      user_id: userRow.id,
      display_name: userRow.display_name,
      business_id,
      business_name: business.name,
      business_address: business.address,
      business_city: business.city,
      interest_id,
      lat: business.lat,
      lng: business.lng,
      tag: trimmed,
      verdict,
      created_at: now,
      legit: 0,
      dispute: 0,
      protip: 0,
    },
    201,
  );
});

// ---- reactions ---------------------------------------------------------
const parseReactionRequest = async (c: Context) => {
  const reviewId = Number(c.req.param("id"));
  if (!Number.isInteger(reviewId) || reviewId <= 0)
    return { err: c.json({ error: "invalid review id" }, 400) as Response };
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object")
    return { err: c.json({ error: "invalid body" }, 400) as Response };
  const kind = (body as Record<string, unknown>).kind;
  if (!isReactionKind(kind)) return { err: c.json({ error: "invalid kind" }, 400) as Response };
  const exists = db.query("SELECT 1 FROM reviews WHERE id = ?").get(reviewId);
  if (!exists) return { err: c.json({ error: "review not found" }, 404) as Response };
  return { reviewId, kind, ipHash: hashIp(clientIp(c)) };
};

app.post("/api/reviews/:id/reactions", async (c) => {
  const parsed = await parseReactionRequest(c);
  if ("err" in parsed) return parsed.err;
  const { reviewId, kind, ipHash } = parsed;

  if (!checkRate(reactionRateBuckets, ipHash, RATE_MAX_REACTIONS))
    return c.json({ error: "rate limit exceeded" }, 429);

  db.transaction(() => {
    db.query("DELETE FROM reactions WHERE review_id = ? AND ip_hash = ?").run(reviewId, ipHash);
    db.query("INSERT INTO reactions (review_id, kind, ip_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(reviewId, kind, ipHash, Date.now());
  })();

  return c.json({ id: reviewId, reactions: countsForReview(reviewId) });
});

app.delete("/api/reviews/:id/reactions", async (c) => {
  const parsed = await parseReactionRequest(c);
  if ("err" in parsed) return parsed.err;
  const { reviewId, kind, ipHash } = parsed;
  db.query("DELETE FROM reactions WHERE review_id = ? AND kind = ? AND ip_hash = ?")
    .run(reviewId, kind, ipHash);
  return c.json({ id: reviewId, reactions: countsForReview(reviewId) });
});

// ---- search (LLM classifier + route) -----------------------------------
// POST /api/search { q, city } →
//   { intent, named?: { business, closestBusinessId? }, craving?: { businesses: [...] }, fallback?: { pois: [...] } }
app.post("/api/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
  const q = String((body as Record<string, unknown>).q ?? "").trim();
  const city = (body as Record<string, unknown>).city;
  const cityStr = typeof city === "string" && city.length > 0 ? city : null;
  if (!q) return c.json({ error: "q required" }, 400);

  const cls = await classifyIntent(q, cityStr);
  const namedQ = cls.named_query ?? q;
  const cravingQ = cls.craving_query ?? q;

  // Pre-fetch the city bounding box so every Nominatim + Overpass call
  // below stays strictly within it. Without this, searches like "pad thai"
  // pull hits from across the country and the client's fitBounds shows
  // the whole USA.
  const cityBboxCoords = cityStr ? await cityBbox(cityStr) : null;
  // Nominatim viewbox format: minLon,maxLat,maxLon,minLat  (W,N,E,S).
  // Our cityBbox returns [S, W, N, E], so re-order for the API.
  const nominatimBoundParams: Record<string, string> = cityBboxCoords
    ? {
        viewbox: `${cityBboxCoords[1]},${cityBboxCoords[2]},${cityBboxCoords[3]},${cityBboxCoords[0]}`,
        bounded: "1",
      }
    : {};

  // Return every matching location (chains like "Cousins Subs" have many).
  // Cap at 10 so the map isn't overwhelmed if Nominatim goes wide. Each
  // business is enriched with review_count + latest_review if we've seen
  // it before, so the client can render reviewed pins in full color and
  // un-reviewed ones as the greyed "be the first" state.
  const findNamed = async () => {
    const hits = await nominatim<NominatimHit[]>("/search", {
      q: cityStr ? `${namedQ}, ${cityStr}` : namedQ,
      format: "json", addressdetails: "1", limit: "10", dedupe: "1",
      ...nominatimBoundParams,
    }).catch(() => [] as NominatimHit[]);
    const bases = hits.map((h) => ({
      id: businessIdFor(h),
      source: "osm" as const,
      source_id: h.osm_type && h.osm_id != null ? `${h.osm_type}:${h.osm_id}` : `place:${h.place_id}`,
      name: h.display_name.split(",")[0]!.trim(),
      address: shortAddress(h.address),
      city: cityOf(h.address),
      lat: Number(h.lat),
      lng: Number(h.lon),
      category: [h.class, h.type].filter(Boolean).join(":") || null,
    }));
    return bases.map((b) => ({ ...b, ...reviewStatsFor(b.id) }));
  };

  const findCraving = () => {
    // FTS5 match, filtered to the current city. Businesses join for city + lat/lng.
    // Return the latest review per business so the pin can render the real
    // verdict + tag (not the greyed "no reviews" fallback style).
    const cityClause = cityStr ? "AND b.city = ?" : "";
    const args: (string | number)[] = [ftsQuery(cravingQ)];
    if (cityStr) args.push(cityStr);
    const rows = db.query(
      `SELECT b.id, b.source, b.source_id, b.name, b.address, b.city, b.lat, b.lng, b.category,
              (SELECT COUNT(*) FROM reviews r2 WHERE r2.business_id = b.id) AS review_count,
              latest.id           AS latest_review_id,
              latest.verdict      AS latest_verdict,
              latest.tag          AS latest_tag,
              latest.interest_id  AS latest_interest_id,
              latest.created_at   AS latest_created_at,
              latest_user.display_name AS latest_display_name
       FROM (
         SELECT DISTINCT r.business_id
         FROM reviews_fts f
         JOIN reviews r ON r.id = f.rowid
         WHERE reviews_fts MATCH ?
       ) hit
       JOIN businesses b ON b.id = hit.business_id
       LEFT JOIN reviews latest ON latest.id = (
         SELECT r3.id FROM reviews r3
         WHERE r3.business_id = b.id
         ORDER BY r3.created_at DESC LIMIT 1
       )
       LEFT JOIN users latest_user ON latest_user.id = latest.user_id
       WHERE 1=1 ${cityClause}
       ORDER BY review_count DESC
       LIMIT 50`,
    ).all(...args) as (BusinessRow & {
      review_count: number;
      latest_review_id: number | null;
      latest_verdict: number | null;
      latest_tag: string | null;
      latest_interest_id: string | null;
      latest_created_at: number | null;
      latest_display_name: string | null;
    })[];
    return rows.map((row) => ({
      id: row.id, source: row.source, source_id: row.source_id,
      name: row.name, address: row.address, city: row.city,
      lat: row.lat, lng: row.lng, category: row.category,
      review_count: row.review_count,
      latest_review: row.latest_review_id
        ? {
            id: row.latest_review_id,
            verdict: row.latest_verdict,
            tag: row.latest_tag,
            interest_id: row.latest_interest_id,
            created_at: row.latest_created_at,
            display_name: row.latest_display_name,
          }
        : null,
    }));
  };

  if (cls.intent === "named") {
    const named = await findNamed();
    // Keep the legacy single-value field for older clients; new clients use `named_list`.
    return c.json({ intent: "named", classifier: cls, named: named[0] ?? null, named_list: named });
  }

  if (cls.intent === "craving") {
    // Craving searches now union three sources for the broadest coverage:
    //   1. FTS5 hits — reviewed spots whose tag text matches the craving.
    //   2. Overpass cuisine query — real OSM cuisine=X tagged restaurants
    //      in the city bbox. Free, curated, cuisine-accurate.
    //   3. Nominatim name-based expansion — chain names + synonyms from
    //      the LLM (catches spots not tagged with cuisine, e.g. Cousins Subs).
    // All three are merged, deduped by business_id, sorted (reviewed
    // first), capped at 30 pins.
    const ftsHits = findCraving();
    const bbox = cityBboxCoords;
    const cuisines = (cls.cuisines ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const amenities = (cls.amenities ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const terms = Array.from(new Set(
      (cls.poi_terms ?? [cravingQ]).map((t) => t.trim()).filter((t) => t.length > 0),
    )).slice(0, 8);

    // Overpass: real cuisine tags in the city bbox.
    let overpassBusinesses: ReturnType<typeof elementToBusiness>[] = [];
    if (bbox && (cuisines.length > 0 || amenities.length > 0)) {
      try {
        const query = buildOverpassQuery(bbox, cuisines, amenities);
        const elements = await overpass(query);
        overpassBusinesses = elements
          .map(elementToBusiness)
          .filter((b) => b.name !== "(unnamed)" && b.lat !== 0 && b.lng !== 0);
      } catch (err) { console.warn("overpass failed:", err); }
    }

    // Nominatim: name-based expansion for chains + generic terms.
    // Scoped strictly to the city bbox via viewbox+bounded so a
    // craving search like "pad thai" doesn't drag in results from
    // across the country.
    const nominatimDedup = new Map<string, NominatimHit>();
    await Promise.all(terms.map(async (term) => {
      try {
        const hits = await nominatim<NominatimHit[]>("/search", {
          q: cityStr ? `${term}, ${cityStr}` : term,
          format: "json", addressdetails: "1", limit: "10", dedupe: "1",
          ...nominatimBoundParams,
        });
        for (const h of hits) {
          const id = businessIdFor(h);
          if (!nominatimDedup.has(id)) nominatimDedup.set(id, h);
        }
      } catch { /* per-term nominatim failure is non-fatal */ }
    }));
    const nominatimBusinesses = Array.from(nominatimDedup.values()).map((h) => ({
      id: businessIdFor(h),
      source: "osm" as const,
      source_id: h.osm_type && h.osm_id != null ? `${h.osm_type}:${h.osm_id}` : `place:${h.place_id}`,
      name: h.display_name.split(",")[0]!.trim(),
      address: shortAddress(h.address),
      city: cityOf(h.address),
      lat: Number(h.lat),
      lng: Number(h.lon),
      category: [h.class, h.type].filter(Boolean).join(":") || null,
    }));

    // Merge all three sources, dedupe by business id, enrich with review
    // stats, sort reviewed spots first, cap at 30.
    const dedup = new Map<string, { id: string; source: string; source_id: string; name: string; address: string | null; city: string | null; lat: number; lng: number; category: string | null }>();
    // FTS5 hits go in first — they're the strongest signal (a real reviewer said this place matches).
    for (const b of ftsHits) if (!dedup.has(b.id)) dedup.set(b.id, b);
    for (const b of overpassBusinesses) if (!dedup.has(b.id)) dedup.set(b.id, b);
    for (const b of nominatimBusinesses) if (!dedup.has(b.id)) dedup.set(b.id, b);

    const enriched = Array.from(dedup.values()).map((b) => ({ ...b, ...reviewStatsFor(b.id) }));
    enriched.sort((a, z) => (z.review_count ?? 0) - (a.review_count ?? 0));
    const businesses = enriched.slice(0, 30);

    return c.json({
      intent: "craving",
      classifier: cls,
      craving: {
        businesses,
        sources: {
          fts5: ftsHits.length,
          overpass: overpassBusinesses.length,
          nominatim: nominatimBusinesses.length,
        },
      },
    });
  }

  // ambiguous → return both possibilities for the UI to disambiguate.
  // Override: if Nominatim returns multiple exact-name matches and we have
  // no craving hits, the classifier was over-cautious — treat as named.
  // Guards against "cousins subs" firing the disambig modal just because
  // "subs" is a category word.
  const [namedList, craving] = await Promise.all([findNamed(), Promise.resolve(findCraving())]);
  const nameLower = namedQ.trim().toLowerCase();
  const exactMatches = namedList.filter((b) => b.name.toLowerCase() === nameLower);
  if (exactMatches.length >= 2 && craving.length === 0) {
    return c.json({
      intent: "named",
      classifier: { ...cls, reason: `${cls.reason ?? ""} (server override: exact-name matches)` },
      named: namedList[0] ?? null,
      named_list: namedList,
    });
  }
  return c.json({
    intent: "ambiguous",
    classifier: cls,
    named: namedList[0] ?? null,
    named_list: namedList,
    craving: { businesses: craving },
  });
});

// Escape / normalize a user query for FTS5. FTS5 supports prefix matches
// with `word*`; we split on whitespace and OR them together.
function ftsQuery(q: string): string {
  const words = q.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"*`);
  return words.length > 0 ? words.join(" OR ") : '""';
}

// ---- synthesis (LLM-summarized cluster text) ---------------------------
// POST /api/synthesize { tags: string[] } → { synthesis: string }
// Distills 2-20 short review tags into one 3-6 word "voice of the crowd"
// phrase used as the label on cluster pins. Cached aggressively by the
// sorted-tag hash so panning/zooming that regroups the same members
// doesn't re-hit OpenAI.
const synthesisCache = new Map<string, { at: number; value: string }>();
const SYNTHESIS_TTL_MS = 24 * 60 * 60 * 1000; // 24h; tags rarely change

app.post("/api/synthesize", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
  const rawTags = (body as Record<string, unknown>).tags;
  if (!Array.isArray(rawTags)) return c.json({ error: "tags array required" }, 400);
  const tags = rawTags
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim())
    .slice(0, 20);
  if (tags.length === 0) return c.json({ synthesis: "" });
  if (tags.length === 1) return c.json({ synthesis: tags[0] });

  const key = createHash("sha256").update([...tags].sort().join("|")).digest("hex").slice(0, 24);
  const hit = synthesisCache.get(key);
  if (hit && Date.now() - hit.at < SYNTHESIS_TTL_MS) return c.json({ synthesis: hit.value, cached: true });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Graceful fallback with no LLM: use the first tag.
    return c.json({ synthesis: tags[0], fallback: "no-key" });
  }

  const system =
    'You distill multiple short food reviews into ONE punchy phrase (3-6 words, no period, no quotes) that captures the crowd\'s combined take on a cluster of nearby restaurants. The phrase goes on a map label, so make it evocative and readable.\n\n' +
    'Examples:\n' +
    '["best carbonara","great pizza","italian gem"] → loved for italian classics\n' +
    '["amazing pho","great banh mi","solid ramen"] → asian noodle destination\n' +
    '["cold beer great vibes","best old fashioned","excellent negroni"] → cocktail hotspot\n' +
    '["decent pasta forgettable sauce","overpriced tourist trap","microwaved lasagna energy"] → skip the italian here\n' +
    '["best al pastor east side","carne asada is life","salsa bar is chef\'s kiss"] → east side taco heaven\n\n' +
    'Return only the phrase, lowercase preferred, no quotes.';

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TEXT_MODEL ?? "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 40,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(tags) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? tags[0]!;
    const synthesis = raw.replace(/^["'`]|["'`]$/g, "").slice(0, 60);
    synthesisCache.set(key, { at: Date.now(), value: synthesis });
    return c.json({ synthesis });
  } catch (err) {
    console.warn("synthesis failed:", err);
    return c.json({ synthesis: tags[0], fallback: String(err) });
  }
});

// ---- static asset serving (production only) ----------------------------
// When STATIC_DIR is set (e.g. STATIC_DIR=web/dist in Fly.io), this Hono
// process also serves the built Vue app. Local dev leaves STATIC_DIR
// unset and Vite handles the frontend on :5173.
const STATIC_DIR = process.env.STATIC_DIR;
if (STATIC_DIR) {
  app.use("/*", serveStatic({ root: STATIC_DIR }));
  // SPA fallback — any unmatched GET returns index.html so the client
  // router can take over.
  app.get("*", serveStatic({ path: `${STATIC_DIR}/index.html` }));
}

const port = Number(process.env.PORT ?? 3001);
console.log(`grubmaps-review api listening on http://localhost:${port}` +
  (STATIC_DIR ? ` (also serving static files from ${STATIC_DIR})` : ""));
export default { port, fetch: app.fetch };
