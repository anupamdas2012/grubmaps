#!/usr/bin/env bun
/**
 * Generate a food-icon PNG in the style of `.context/style-refs/food-icon.png`
 * but with an arbitrary subject. The reference is a style anchor only —
 * its subject is replaced.
 *
 * Defaults to an isolated subject on a transparent background so the
 * frame/gradient can be composed at runtime as SVG/CSS. Pass --framed
 * to instead bake the reference's rounded-rect frame into the PNG.
 *
 *   bun run icon "wine"                 # alpha, 512px + 1024 source
 *   bun run icon "wine" --size 128      # alpha, 128px + 1024 source
 *   bun run icon "wine" --framed        # framed variant (full icon)
 *   bun run icon "wine" --slug wine_red # custom output filename
 *
 * Outputs:
 *   web/public/food-icons/{slug}.png        (downscaled to --size, default 512)
 *   web/public/food-icons/{slug}@1024.png   (source)
 *
 * Requires OPENAI_API_KEY. ~$0.02/icon at gpt-image-1 low quality.
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = resolve(import.meta.dir, "..");
const STYLE_REF = resolve(ROOT, ".context/style-refs/food-icon.png");
const OUT_DIR = resolve(ROOT, "web/public/food-icons");
const MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";

export type IconOptions = {
  subject: string;
  size?: number;   // downscaled output size in px; default 512
  slug?: string;   // filename slug; default = slugified(subject)
  alpha?: boolean; // default true (transparent bg, no frame)
};

export type IconResult = {
  slug: string;
  subject: string;
  alpha: boolean;
  size: number;
  model: string;
  prompt: string;
  sourcePath: string;
  outPath: string;
  sourceSha256: string;
  outSha256: string;
  bytes: number;
  styleRefSha256: string;
};

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const sha256 = (buf: Buffer | Uint8Array) =>
  createHash("sha256").update(buf).digest("hex");

const framedPromptFor = (subject: string) =>
  `Generate a new app icon whose SUBJECT is "${subject}".

Match the visual STYLE of the reference image exactly — but do NOT
copy its subject. Preserve from the reference: the warm gradient
background, the rounded-rectangle icon frame, the cinematic 3D-render
+ painterly-illustration hybrid, the soft studio lighting and warm
shadows, the wooden-surface framing when appropriate, the color
palette, and the "premium App Store icon" composition. Subject is
centered and fills ~65% of the canvas.

No text, no logos, no watermarks. The reference's sushi/nori/board
must NOT appear unless the requested subject happens to be sushi.`;

const alphaPromptFor = (subject: string) =>
  `Generate an isolated 3D-rendered illustration of "${subject}" on a fully transparent background.

Match the SUBJECT rendering style of the reference image: cinematic
3D-render + painterly-illustration hybrid, glossy studio lighting,
warm color palette, premium material detail.

CRITICAL: do NOT include any background, gradient, frame, rounded
rectangle, wooden board, cutting board, plate, or surface. The
subject floats on transparent alpha. Include ONLY a soft partial-alpha
ground shadow directly beneath the subject to imply grounding —
nothing else opaque. Subject centered, fills ~70% of the canvas.

No text, no logos, no watermarks.`;

export async function generateIcon(opts: IconOptions): Promise<IconResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  if (!existsSync(STYLE_REF)) throw new Error(`Style reference missing: ${STYLE_REF}`);

  const subject = opts.subject.trim();
  if (!subject) throw new Error("Subject is empty.");

  const alpha = opts.alpha ?? true;
  const size = Math.max(16, Math.min(1024, opts.size ?? 512));
  const slug = slugify(opts.slug ?? subject);
  const sourcePath = resolve(OUT_DIR, `${slug}@1024.png`);
  const outPath = resolve(OUT_DIR, `${slug}.png`);
  const prompt = alpha ? alphaPromptFor(subject) : framedPromptFor(subject);
  const styleRefBuf = readFileSync(STYLE_REF);
  const styleRefSha256 = sha256(styleRefBuf);

  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("size", "1024x1024");
  form.append("n", "1");
  if (alpha) form.append("background", "transparent");
  form.append("image", new Blob([styleRefBuf], { type: "image/png" }), basename(STYLE_REF));

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const first = data.data?.[0];
  if (!first) throw new Error("Empty response from OpenAI");

  const png: Buffer = first.b64_json
    ? Buffer.from(first.b64_json, "base64")
    : first.url
      ? Buffer.from(await (await fetch(first.url)).arrayBuffer())
      : (() => { throw new Error("No image data in response"); })();

  writeFileSync(sourcePath, png);
  const sourceSha256 = sha256(png);

  let outSha256 = sourceSha256;
  if (size !== 1024) {
    const r = spawnSync("sips", ["-Z", String(size), "--out", outPath, sourcePath], { stdio: "pipe" });
    if (r.status !== 0) throw new Error(`sips failed: ${r.stderr?.toString() ?? "unknown"}`);
    outSha256 = sha256(readFileSync(outPath));
  } else {
    writeFileSync(outPath, png);
  }

  return {
    slug, subject, alpha, size,
    model: MODEL, prompt,
    sourcePath, outPath,
    sourceSha256, outSha256,
    bytes: png.length,
    styleRefSha256,
  };
}

// -------- CLI --------
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: bun run icon "<subject>" [--size <px>] [--slug <name>] [--framed]');
    process.exit(1);
  }

  let size = 512;
  let slugOverride: string | null = null;
  let alpha = true;
  const subjectParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--size" && i + 1 < args.length) {
      size = Math.max(16, Math.min(1024, parseInt(args[++i]!, 10) || 512));
    } else if (a === "--slug" && i + 1 < args.length) {
      slugOverride = args[++i]!;
    } else if (a === "--framed") {
      alpha = false;
    } else if (a === "--alpha") {
      alpha = true;
    } else {
      subjectParts.push(a);
    }
  }
  const subject = subjectParts.join(" ").trim();
  if (!subject) {
    console.error("Subject is empty.");
    process.exit(1);
  }

  console.log(`→ subject: ${subject}`);
  console.log(`  model:   ${MODEL}`);
  console.log(`  alpha:   ${alpha}`);
  console.log(`  size:    ${size}px (source at 1024px)`);

  try {
    const r = await generateIcon({ subject, size, slug: slugOverride ?? undefined, alpha });
    console.log(`  ✓ source: ${r.sourcePath} (${(r.bytes / 1024).toFixed(1)} KB)`);
    if (r.size !== 1024) {
      console.log(`  ✓ downscaled to ${r.size}px: ${r.outPath}`);
    } else {
      console.log(`  ✓ ${r.outPath} (same as source)`);
    }
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}
