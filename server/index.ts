import { Hono } from "hono";
import { cors } from "hono/cors";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const db = new Database("grubmaps.db");

// Schema evolved twice (rating → binary verdict → three-way verdict). CHECK
// constraints can't be ALTERed in SQLite, so if the current table doesn't
// carry the expected constraint we drop it. Dev-only reset.
const EXPECTED_VERDICT_CHECK = "CHECK (verdict IN (-1, 0, 1))";
const pinsRow = db
  .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='pins'")
  .get() as { sql: string } | null;
if (pinsRow && !pinsRow.sql.includes(EXPECTED_VERDICT_CHECK)) {
  db.exec("DROP TABLE pins");
}
db.exec("DROP TABLE IF EXISTS places");

db.exec(`
  CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    tag TEXT NOT NULL,
    verdict INTEGER NOT NULL CHECK (verdict IN (-1, 0, 1)),
    created_at INTEGER NOT NULL,
    ip_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pins_created_at ON pins(created_at);
`);

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
  verdict: number;
  created_at: number;
};

const MIN_WORDS = 1;
const MAX_WORDS = 8;
const MAX_CHARS = 60;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const app = new Hono();
app.use("/*", cors());

app.get("/api/pins", (c) => {
  const rows = db
    .query(
      "SELECT id, lat, lng, tag, verdict, created_at FROM pins ORDER BY created_at DESC LIMIT 5000",
    )
    .all() as PinRow[];
  return c.json(rows);
});

app.post("/api/pins", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);

  const { lat, lng, tag, verdict } = body as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lng !== "number")
    return c.json({ error: "lat/lng required" }, 400);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
    return c.json({ error: "lat/lng out of range" }, 400);
  if (typeof tag !== "string") return c.json({ error: "tag required" }, 400);
  const trimmed = tag.trim();
  if (trimmed.length === 0) return c.json({ error: "tag required" }, 400);
  if (trimmed.length > MAX_CHARS)
    return c.json({ error: `tag must be ≤ ${MAX_CHARS} characters` }, 400);
  const words = wordCount(trimmed);
  if (words < MIN_WORDS || words > MAX_WORDS)
    return c.json({ error: `tag must be ${MIN_WORDS}-${MAX_WORDS} words` }, 400);
  if (verdict !== 1 && verdict !== 0 && verdict !== -1)
    return c.json({ error: "verdict must be 1 (yum), 0 (meh), or -1 (yuck)" }, 400);

  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = hashIp(ip);
  if (!checkRate(ipHash)) return c.json({ error: "rate limit exceeded" }, 429);

  const now = Date.now();
  const result = db
    .query(
      "INSERT INTO pins (lat, lng, tag, verdict, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(lat, lng, trimmed, verdict, now, ipHash) as { id: number };

  return c.json({ id: result.id, lat, lng, tag: trimmed, verdict, created_at: now }, 201);
});

const port = Number(process.env.PORT ?? 3001);
console.log(`grubmaps api listening on http://localhost:${port}`);
export default { port, fetch: app.fetch };
