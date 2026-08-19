import { Hono } from "hono";
import { cors } from "hono/cors";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const db = new Database("grubmaps.db");
db.exec("PRAGMA foreign_keys = ON");

// Schema evolved twice (rating → binary verdict → three-way verdict). CHECK
// constraints can't be ALTERed in SQLite, so if the current table doesn't
// carry the expected constraint we drop it. Dev-only reset.
const EXPECTED_VERDICT_CHECK = "CHECK (verdict IN (-1, 0, 1))";
const pinsRow = db
  .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='pins'")
  .get() as { sql: string } | null;
if (pinsRow && !pinsRow.sql.includes(EXPECTED_VERDICT_CHECK)) {
  db.exec("DROP TABLE IF EXISTS reactions"); // FK-references pins
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

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pin_id INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('legit','dispute','protip')),
    ip_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (pin_id, ip_hash, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_pin_id ON reactions(pin_id);
`);

const IP_SALT = process.env.IP_SALT ?? "grubmaps-dev-salt";
const hashIp = (ip: string) =>
  createHash("sha256").update(ip + IP_SALT).digest("hex").slice(0, 32);

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PINS = 10;
const RATE_MAX_REACTIONS = 200;
const pinRateBuckets = new Map<string, number[]>();
const reactionRateBuckets = new Map<string, number[]>();
const checkRate = (bucket: Map<string, number[]>, ipHash: string, max: number) => {
  const now = Date.now();
  const timestamps = (bucket.get(ipHash) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (timestamps.length >= max) return false;
  timestamps.push(now);
  bucket.set(ipHash, timestamps);
  return true;
};

type PinRow = {
  id: number;
  lat: number;
  lng: number;
  tag: string;
  verdict: number;
  created_at: number;
  legit: number;
  dispute: number;
  protip: number;
};

const MIN_WORDS = 1;
const MAX_WORDS = 8;
const MAX_CHARS = 60;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const REACTION_KINDS = ["legit", "dispute", "protip"] as const;
type ReactionKind = (typeof REACTION_KINDS)[number];
const isReactionKind = (v: unknown): v is ReactionKind =>
  typeof v === "string" && (REACTION_KINDS as readonly string[]).includes(v);

const countsForPin = (pinId: number) => {
  const rows = db
    .query("SELECT kind, COUNT(*) AS n FROM reactions WHERE pin_id = ? GROUP BY kind")
    .all(pinId) as { kind: ReactionKind; n: number }[];
  const out = { legit: 0, dispute: 0, protip: 0 };
  for (const r of rows) out[r.kind] = r.n;
  return out;
};

const app = new Hono();
app.use("/*", cors());

app.get("/api/pins", (c) => {
  const rows = db
    .query(
      `SELECT p.id, p.lat, p.lng, p.tag, p.verdict, p.created_at,
              COALESCE(SUM(CASE WHEN r.kind = 'legit'   THEN 1 END), 0) AS legit,
              COALESCE(SUM(CASE WHEN r.kind = 'dispute' THEN 1 END), 0) AS dispute,
              COALESCE(SUM(CASE WHEN r.kind = 'protip'  THEN 1 END), 0) AS protip
       FROM pins p
       LEFT JOIN reactions r ON r.pin_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC
       LIMIT 5000`,
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
  if (!checkRate(pinRateBuckets, ipHash, RATE_MAX_PINS))
    return c.json({ error: "rate limit exceeded" }, 429);

  const now = Date.now();
  const result = db
    .query(
      "INSERT INTO pins (lat, lng, tag, verdict, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(lat, lng, trimmed, verdict, now, ipHash) as { id: number };

  return c.json(
    {
      id: result.id,
      lat,
      lng,
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

const parseReactionRequest = async (c: Parameters<Parameters<typeof app.post>[1]>[0]) => {
  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId <= 0)
    return { err: c.json({ error: "invalid pin id" }, 400) as Response };
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object")
    return { err: c.json({ error: "invalid body" }, 400) as Response };
  const kind = (body as Record<string, unknown>).kind;
  if (!isReactionKind(kind))
    return { err: c.json({ error: "invalid kind" }, 400) as Response };
  const exists = db.query("SELECT 1 FROM pins WHERE id = ?").get(pinId);
  if (!exists) return { err: c.json({ error: "pin not found" }, 404) as Response };
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return { pinId, kind, ipHash: hashIp(ip) };
};

app.post("/api/pins/:id/reactions", async (c) => {
  const parsed = await parseReactionRequest(c);
  if ("err" in parsed) return parsed.err;
  const { pinId, kind, ipHash } = parsed;

  if (!checkRate(reactionRateBuckets, ipHash, RATE_MAX_REACTIONS))
    return c.json({ error: "rate limit exceeded" }, 429);

  // One reaction per (pin, ip). Clear any prior kind, then insert the new one.
  db.transaction(() => {
    db.query("DELETE FROM reactions WHERE pin_id = ? AND ip_hash = ?").run(pinId, ipHash);
    db.query(
      "INSERT INTO reactions (pin_id, kind, ip_hash, created_at) VALUES (?, ?, ?, ?)",
    ).run(pinId, kind, ipHash, Date.now());
  })();

  return c.json({ id: pinId, reactions: countsForPin(pinId) });
});

app.delete("/api/pins/:id/reactions", async (c) => {
  const parsed = await parseReactionRequest(c);
  if ("err" in parsed) return parsed.err;
  const { pinId, kind, ipHash } = parsed;

  db.query("DELETE FROM reactions WHERE pin_id = ? AND kind = ? AND ip_hash = ?").run(
    pinId,
    kind,
    ipHash,
  );
  return c.json({ id: pinId, reactions: countsForPin(pinId) });
});

const port = Number(process.env.PORT ?? 3001);
console.log(`grubmaps api listening on http://localhost:${port}`);
export default { port, fetch: app.fetch };
