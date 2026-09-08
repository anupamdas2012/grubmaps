#!/usr/bin/env bun
/**
 * Batch-generate every icon in `tools/icons.config.ts`. Writes each
 * PNG (+ its 1024 source) to `web/public/food-icons/` and drops a
 * `manifest.json` alongside them with every input + output SHA so a
 * future generation can be verified or diffed.
 *
 *   bun run icons:gen              # generate all icons in the set
 *   bun run icons:gen --only wine  # regenerate a subset (comma-sep keys)
 *   bun run icons:gen --force      # overwrite even if manifest matches
 *
 * Requires OPENAI_API_KEY. ~$0.02/icon → whole set is ~$0.18.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { generateIcon, type IconResult } from "./make-icon.ts";
import { ICON_SET, ICON_SIZE_PX, type IconSpec } from "./icons.config.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = resolve(ROOT, "web/public/food-icons");
const MANIFEST_PATH = resolve(OUT_DIR, "manifest.json");
const STYLE_REF = resolve(ROOT, ".context/style-refs/food-icon.png");

type Manifest = {
  generatedAt: string;
  styleRefSha256: string;
  model: string;
  size: number;
  icons: Record<string, {
    key: string;
    subject: string;
    alpha: boolean;
    size: number;
    model: string;
    prompt: string;
    generatedAt: string;
    sourceSha256: string;
    outSha256: string;
    styleRefSha256: string;
    bytes: number;
    outFile: string;
    sourceFile: string;
  }>;
};

const args = process.argv.slice(2);
let onlyKeys: Set<string> | null = null;
let force = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--only" && i + 1 < args.length) {
    onlyKeys = new Set(args[++i]!.split(",").map((s) => s.trim()).filter(Boolean));
  } else if (a === "--force") {
    force = true;
  }
}

mkdirSync(OUT_DIR, { recursive: true });

const existingManifest: Manifest | null = existsSync(MANIFEST_PATH)
  ? (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest)
  : null;

const styleRefSha256 = createHash("sha256")
  .update(readFileSync(STYLE_REF))
  .digest("hex");

const targets: IconSpec[] = ICON_SET.filter(
  (s) => onlyKeys === null || onlyKeys.has(s.key),
);

if (targets.length === 0) {
  console.error("No icons matched. Available keys:", ICON_SET.map((i) => i.key).join(", "));
  process.exit(1);
}

console.log(`Generating ${targets.length} icon${targets.length === 1 ? "" : "s"} @ ${ICON_SIZE_PX}px (source 1024)…`);
console.log(`Style ref SHA: ${styleRefSha256.slice(0, 12)}…\n`);

const nowIso = new Date().toISOString();
const nextManifest: Manifest = existingManifest
  ? { ...existingManifest, generatedAt: nowIso, styleRefSha256, size: ICON_SIZE_PX }
  : {
      generatedAt: nowIso,
      styleRefSha256,
      model: "gpt-image-1",
      size: ICON_SIZE_PX,
      icons: {},
    };

const failures: { key: string; error: string }[] = [];

for (const spec of targets) {
  const prev = existingManifest?.icons[spec.key];
  const specMatches =
    prev &&
    prev.subject === spec.subject &&
    prev.size === ICON_SIZE_PX &&
    prev.alpha === true &&
    prev.styleRefSha256 === styleRefSha256;
  if (specMatches && !force) {
    console.log(`  ${spec.key.padEnd(12)} · unchanged — skip (--force to override)`);
    continue;
  }

  process.stdout.write(`  ${spec.key.padEnd(12)} · generating…`);
  try {
    const r: IconResult = await generateIcon({
      subject: spec.subject,
      size: ICON_SIZE_PX,
      slug: spec.key,
      alpha: true,
    });
    nextManifest.icons[spec.key] = {
      key: spec.key,
      subject: spec.subject,
      alpha: r.alpha,
      size: r.size,
      model: r.model,
      prompt: r.prompt,
      generatedAt: new Date().toISOString(),
      sourceSha256: r.sourceSha256,
      outSha256: r.outSha256,
      styleRefSha256: r.styleRefSha256,
      bytes: r.bytes,
      outFile: `${spec.key}.png`,
      sourceFile: `${spec.key}@1024.png`,
    };
    console.log(` ok (${(r.bytes / 1024).toFixed(0)} KB source)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(` FAILED — ${msg.slice(0, 100)}`);
    failures.push({ key: spec.key, error: msg });
  }
  await new Promise((r) => setTimeout(r, 300)); // gentle rate limit
}

writeFileSync(MANIFEST_PATH, JSON.stringify(nextManifest, null, 2) + "\n");
console.log(`\nManifest → ${MANIFEST_PATH}`);

if (failures.length > 0) {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(`  ${f.key}: ${f.error.slice(0, 120)}`);
  process.exit(1);
}
