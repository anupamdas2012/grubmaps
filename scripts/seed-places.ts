#!/usr/bin/env bun
/**
 * Seed the places table from Overture Maps' places theme.
 * Overture bundles Foursquare Open Source Places among other public sources.
 * Runs once, then `places` lives in server/grubmaps.db.
 */
import { Database } from "bun:sqlite";
import { spawn } from "bun";
import { resolve } from "node:path";

const RELEASE = process.env.OVERTURE_RELEASE ?? "2026-07-22.0";

// Milwaukee metro bounding box.
const BBOX = { xmin: -88.1, ymin: 42.9, xmax: -87.85, ymax: 43.2 };

// Overture category tokens that count as "food/drink".
const FOOD_TOKENS = [
  "restaurant",
  "cafe",
  "coffee_shop",
  "bakery",
  "bar",
  "pub",
  "brewery",
  "winery",
  "distillery",
  "ice_cream",
  "juice_bar",
  "food_truck",
  "fast_food",
  "diner",
  "deli",
  "tea_room",
  "food_court",
];

// Match token as a whole word within snake_case category names.
// e.g. `bar` matches `bar`, `wine_bar`, `bar_grill`; does NOT match `barber`, `bathroom_remodeling`.
const tokenPattern = `(^|_)(${FOOD_TOKENS.join("|")})($|_)`;
const catFilter = `regexp_matches(categories.primary, '${tokenPattern}')`;

const dbPath = resolve(import.meta.dir, "..", "server", "grubmaps.db");

const query = `
INSTALL httpfs;
LOAD httpfs;
SET s3_region='us-west-2';
COPY (
  SELECT
    id,
    coalesce(names.primary, '') AS name,
    (bbox.xmin + bbox.xmax) / 2 AS lng,
    (bbox.ymin + bbox.ymax) / 2 AS lat,
    coalesce(categories.primary, '') AS category,
    coalesce(addresses[1].freeform, '') AS address
  FROM read_parquet(
    's3://overturemaps-us-west-2/release/${RELEASE}/theme=places/type=place/*'
  )
  WHERE bbox.xmin BETWEEN ${BBOX.xmin} AND ${BBOX.xmax}
    AND bbox.ymin BETWEEN ${BBOX.ymin} AND ${BBOX.ymax}
    AND names.primary IS NOT NULL
    AND (${catFilter})
) TO '/dev/stdout' (FORMAT CSV, HEADER, QUOTE '"', ESCAPE '"');
`;

console.log(`Querying Overture ${RELEASE} for Milwaukee food places…`);

const proc = spawn({
  cmd: ["duckdb", "-c", query],
  stdout: "pipe",
  stderr: "pipe",
});

const [csv, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);

if (exitCode !== 0) {
  console.error("DuckDB failed:", stderr);
  process.exit(1);
}
if (stderr.trim()) console.warn(stderr.trim());

const rows = parseCsv(csv);
console.log(`Parsed ${rows.length} places. Writing to ${dbPath}…`);

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    category TEXT,
    address TEXT
  );
`);

const insert = db.prepare(
  "INSERT OR REPLACE INTO places (id, name, lat, lng, category, address) VALUES (?, ?, ?, ?, ?, ?)",
);
const tx = db.transaction((batch: typeof rows) => {
  for (const r of batch) insert.run(r.id, r.name, r.lat, r.lng, r.category, r.address);
});
tx(rows);

const count = db.query("SELECT COUNT(*) AS n FROM places").get() as { n: number };
console.log(`Done. places rows: ${count.n}`);

function parseCsv(text: string) {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = splitCsvLine(lines[0]);
  const idx = {
    id: header.indexOf("id"),
    name: header.indexOf("name"),
    lat: header.indexOf("lat"),
    lng: header.indexOf("lng"),
    category: header.indexOf("category"),
    address: header.indexOf("address"),
  };
  const out: { id: string; name: string; lat: number; lng: number; category: string; address: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    out.push({
      id: c[idx.id],
      name: c[idx.name],
      lat: Number(c[idx.lat]),
      lng: Number(c[idx.lng]),
      category: c[idx.category],
      address: c[idx.address],
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
