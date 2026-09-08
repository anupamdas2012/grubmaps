import { Hono } from "hono";
import { cors } from "hono/cors";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

// Fresh DB for the personal-tour experiment. Previous branch used
// grubmaps.db; keeping this separate so old data doesn't confuse us.
const db = new Database("grubmaps-tour.db");
db.exec("PRAGMA foreign_keys = ON");

const EXPECTED_PINS_COLS = ["user_id", "interest_id", "verdict"];
const cols = db.query("PRAGMA table_info(pins)").all() as { name: string }[];
if (cols.length > 0 && !EXPECTED_PINS_COLS.every((c) => cols.some((row) => row.name === c))) {
  db.exec("DROP TABLE IF EXISTS reactions");
  db.exec("DROP TABLE IF EXISTS pins");
}

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

  CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interest_id TEXT NOT NULL REFERENCES interests(id),
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    tag TEXT NOT NULL,
    verdict INTEGER NOT NULL CHECK (verdict IN (-1, 0, 1)),
    created_at INTEGER NOT NULL,
    ip_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pins_created_at ON pins(created_at);
  CREATE INDEX IF NOT EXISTS idx_pins_interest ON pins(interest_id);
  CREATE INDEX IF NOT EXISTS idx_pins_user ON pins(user_id);

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

// Seed interests. INSERT OR REPLACE so name/emoji/color updates take effect on restart.
const SEED_INTERESTS: { id: string; name: string; emoji: string; color: string }[] = [
  { id: "food",       name: "Food",       emoji: "🍔", color: "#22863a" },
  { id: "coffee",     name: "Coffee",     emoji: "☕", color: "#6f4e37" },
  { id: "bars",       name: "Bars",       emoji: "🍺", color: "#f59e0b" },
  { id: "cocktails",  name: "Cocktails",  emoji: "🍸", color: "#ec4899" },
  { id: "wine",       name: "Wine",       emoji: "🍷", color: "#7f1d1d" },
  { id: "cigars",     name: "Cigars",     emoji: "🚬", color: "#4a3524" },
  { id: "sweets",     name: "Sweets",     emoji: "🍰", color: "#f472b6" },
  { id: "culture",    name: "Culture",    emoji: "🎨", color: "#7c3aed" },
  { id: "music",      name: "Music",      emoji: "🎵", color: "#2563eb" },
];
const seedStmt = db.prepare(
  "INSERT OR REPLACE INTO interests (id, name, emoji, color, sort_order) VALUES (?, ?, ?, ?, ?)",
);
SEED_INTERESTS.forEach((i, idx) => seedStmt.run(i.id, i.name, i.emoji, i.color, idx));

const IP_SALT = process.env.IP_SALT ?? "grubmaps-dev-salt";
const hashIp = (ip: string) =>
  createHash("sha256").update(ip + IP_SALT).digest("hex").slice(0, 32);

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PINS = 30;
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

const MIN_WORDS = 1;
const MAX_WORDS = 8;
const MAX_CHARS = 60;
const MAX_NAME_LEN = 32;
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
app.use("/*", cors({ origin: "*", allowHeaders: ["Content-Type", "X-User-Id"] }));

// ---- interests ---------------------------------------------------------
app.get("/api/interests", (c) => {
  const rows = db
    .query("SELECT id, name, emoji, color FROM interests ORDER BY sort_order ASC")
    .all();
  return c.json(rows);
});

// ---- users -------------------------------------------------------------
// POST /api/users { display_name } → creates a user and returns { id, display_name }.
// POST /api/users { id, display_name } → upserts.
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
      useId,
      trimmed,
      Date.now(),
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

// ---- pins --------------------------------------------------------------
type PinRow = {
  id: number;
  user_id: string;
  interest_id: string;
  lat: number;
  lng: number;
  tag: string;
  verdict: number;
  created_at: number;
  display_name: string;
  legit: number;
  dispute: number;
  protip: number;
};

app.get("/api/pins", (c) => {
  const interest = c.req.query("interest");
  const user = c.req.query("user");
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (interest) {
    conds.push("p.interest_id = ?");
    args.push(interest);
  }
  if (user) {
    conds.push("p.user_id = ?");
    args.push(user);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .query(
      `SELECT p.id, p.user_id, p.interest_id, p.lat, p.lng, p.tag, p.verdict,
              p.created_at,
              u.display_name,
              COALESCE(SUM(CASE WHEN r.kind = 'legit'   THEN 1 END), 0) AS legit,
              COALESCE(SUM(CASE WHEN r.kind = 'dispute' THEN 1 END), 0) AS dispute,
              COALESCE(SUM(CASE WHEN r.kind = 'protip'  THEN 1 END), 0) AS protip
       FROM pins p
       LEFT JOIN reactions r ON r.pin_id = p.id
       LEFT JOIN users u ON u.id = p.user_id
       ${where}
       GROUP BY p.id
       ORDER BY p.created_at DESC
       LIMIT 5000`,
    )
    .all(...args) as PinRow[];
  return c.json(rows);
});

app.post("/api/pins", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "X-User-Id required" }, 401);
  const userRow = db.query("SELECT id, display_name FROM users WHERE id = ?").get(userId) as
    | { id: string; display_name: string }
    | null;
  if (!userRow) return c.json({ error: "unknown user" }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);

  const { lat, lng, tag, verdict, interest_id } = body as Record<string, unknown>;
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
  if (typeof interest_id !== "string" || interest_id.length === 0)
    return c.json({ error: "interest_id required" }, 400);
  const interestExists = db.query("SELECT 1 FROM interests WHERE id = ?").get(interest_id);
  if (!interestExists) return c.json({ error: "unknown interest_id" }, 400);

  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = hashIp(ip);
  if (!checkRate(pinRateBuckets, ipHash, RATE_MAX_PINS))
    return c.json({ error: "rate limit exceeded" }, 429);

  const now = Date.now();
  const result = db
    .query(
      `INSERT INTO pins (user_id, interest_id, lat, lng, tag, verdict, created_at, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(userRow.id, interest_id, lat, lng, trimmed, verdict, now, ipHash) as { id: number };

  return c.json(
    {
      id: result.id,
      user_id: userRow.id,
      display_name: userRow.display_name,
      interest_id,
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

// ---- reactions ---------------------------------------------------------
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
console.log(`grubmaps-tour api listening on http://localhost:${port}`);
export default { port, fetch: app.fetch };
