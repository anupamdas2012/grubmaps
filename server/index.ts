import { Hono } from "hono";
import { cors } from "hono/cors";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const db = new Database("grubmaps.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    tag TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    created_at INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    place_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pins_created_at ON pins(created_at);

  CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    category TEXT,
    address TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_places_bbox ON places(lat, lng);
`);

// Additive migrations for schemas created by earlier revisions.
const pinCols = db.query("PRAGMA table_info(pins)").all() as { name: string }[];
if (!pinCols.some((c) => c.name === "place_id")) {
  db.exec("ALTER TABLE pins ADD COLUMN place_id TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_pins_place_id ON pins(place_id)");

const IP_SALT = process.env.IP_SALT ?? "grubmaps-dev-salt";
const hashIp = (ip: string) =>
  createHash("sha256").update(ip + IP_SALT).digest("hex").slice(0, 32);

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 10;
const rateBuckets = new Map<string, number[]>();
const checkRate = (ipHash: string): boolean => {
  const now = Date.now();
  const bucket = (rateBuckets.get(ipHash) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) return false;
  bucket.push(now);
  rateBuckets.set(ipHash, bucket);
  return true;
};

type PinRow = {
  id: number;
  lat: number;
  lng: number;
  tag: string;
  rating: number;
  created_at: number;
};

const app = new Hono();
app.use("/*", cors());

app.get("/api/places", (c) => {
  const parseNum = (k: string) => {
    const v = c.req.query(k);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const minLng = parseNum("minLng");
  const minLat = parseNum("minLat");
  const maxLng = parseNum("maxLng");
  const maxLat = parseNum("maxLat");
  if (minLng == null || minLat == null || maxLng == null || maxLat == null) {
    return c.json({ error: "minLng, minLat, maxLng, maxLat required" }, 400);
  }

  const rows = db
    .query(
      `SELECT p.id, p.name, p.lat, p.lng, p.category, p.address,
              AVG(r.rating) AS avg_rating,
              COUNT(r.id)   AS review_count
       FROM places p
       LEFT JOIN pins r ON r.place_id = p.id
       WHERE p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?
       GROUP BY p.id
       LIMIT 5000`,
    )
    .all(minLat, maxLat, minLng, maxLng);
  return c.json(rows);
});

app.get("/api/pins", (c) => {
  const rows = db
    .query(
      "SELECT id, lat, lng, tag, rating, created_at FROM pins ORDER BY created_at DESC LIMIT 5000",
    )
    .all() as PinRow[];
  return c.json(rows);
});

app.post("/api/pins", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);

  const { lat, lng, tag, rating, placeId } = body as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lng !== "number")
    return c.json({ error: "lat/lng required" }, 400);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
    return c.json({ error: "lat/lng out of range" }, 400);
  if (typeof tag !== "string" || tag.trim().length === 0)
    return c.json({ error: "tag required" }, 400);
  if (tag.length > 80) return c.json({ error: "tag too long" }, 400);
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ error: "rating must be integer 1-5" }, 400);
  }
  const placeIdStr =
    typeof placeId === "string" && placeId.length > 0 && placeId.length <= 128
      ? placeId
      : null;

  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = hashIp(ip);
  if (!checkRate(ipHash)) return c.json({ error: "rate limit exceeded" }, 429);

  const now = Date.now();
  const result = db
    .query(
      "INSERT INTO pins (lat, lng, tag, rating, created_at, ip_hash, place_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(lat, lng, tag.trim(), rating, now, ipHash, placeIdStr) as { id: number };

  return c.json(
    { id: result.id, lat, lng, tag: tag.trim(), rating, created_at: now, place_id: placeIdStr },
    201,
  );
});

const port = Number(process.env.PORT ?? 3001);
console.log(`grubmaps api listening on http://localhost:${port}`);
export default { port, fetch: app.fetch };
