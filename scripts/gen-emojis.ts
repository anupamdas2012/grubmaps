#!/usr/bin/env bun
/**
 * One-time backend script: for each food type below, ask an LLM to
 * produce a small vector-emoji SVG. Writes everything to
 * `web/src/foodEmojis.ts`. Rerun any time to regenerate.
 *
 * Requires OPENAI_API_KEY. Uses gpt-4o-mini (~$0.0003 per item;
 * whole batch is a few pennies).
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

type FoodType = {
  key: string; // stable id, used in code
  name: string; // sent to the LLM
  keywords: string[]; // lowercase substrings matched against user tags
};

// Curated food list. Add / remove freely and rerun `bun run gen:emojis`.
// Milwaukee-heavy on the local specialties; broad on the global classics.
const FOOD_TYPES: FoodType[] = [
  { key: "taco", name: "a taco with fillings", keywords: ["taco", "tacos", "carne asada", "al pastor", "birria", "carnitas"] },
  { key: "burrito", name: "a burrito", keywords: ["burrito", "burritos", "chimichanga"] },
  { key: "pizza", name: "a slice of pizza", keywords: ["pizza", "slice", "pepperoni", "margherita", "detroit style"] },
  { key: "burger", name: "a cheeseburger", keywords: ["burger", "cheeseburger", "smashburger", "smash burger"] },
  { key: "sandwich", name: "a stacked deli sandwich", keywords: ["sandwich", "sub", "hoagie", "grinder", "melt", "reuben", "banh mi"] },
  { key: "hot_dog", name: "a hot dog in a bun", keywords: ["hot dog", "hotdog", "chicago dog", "corn dog"] },
  { key: "bratwurst", name: "a grilled bratwurst sausage in a bun", keywords: ["brat", "bratwurst", "sausage", "kielbasa"] },
  { key: "fried_chicken", name: "a piece of crispy fried chicken", keywords: ["fried chicken", "chicken tender", "chicken sandwich", "nashville hot"] },
  { key: "chicken_wings", name: "chicken wings with sauce", keywords: ["wing", "wings", "buffalo wing"] },
  { key: "steak", name: "a grilled steak on a plate", keywords: ["steak", "ribeye", "filet", "porterhouse", "steakhouse", "prime rib"] },
  { key: "bbq", name: "smoked bbq brisket or ribs", keywords: ["bbq", "barbecue", "brisket", "ribs", "pulled pork", "smoked"] },
  { key: "seafood", name: "a plate of shrimp or lobster", keywords: ["shrimp", "lobster", "crab", "seafood", "scallop"] },
  { key: "oyster", name: "fresh oysters on the half shell", keywords: ["oyster", "oysters", "raw bar"] },
  { key: "fish_fry", name: "a Wisconsin friday fish fry plate with breaded cod and fries", keywords: ["fish fry", "friday fish", "beer battered", "cod", "walleye", "perch"] },
  { key: "sushi", name: "sushi rolls on a plate", keywords: ["sushi", "sashimi", "nigiri", "maki", "poke"] },
  { key: "ramen", name: "a bowl of ramen with noodles and toppings", keywords: ["ramen", "tonkotsu", "shoyu", "miso ramen"] },
  { key: "pho", name: "a bowl of pho with noodles and herbs", keywords: ["pho", "vietnamese noodle"] },
  { key: "noodles", name: "a bowl of asian noodles with chopsticks", keywords: ["noodle", "noodles", "lo mein", "chow mein", "udon", "soba", "pad thai", "pad see ew", "drunken noodle"] },
  { key: "dumpling", name: "steamed dumplings in a bamboo basket", keywords: ["dumpling", "dumplings", "dim sum", "bao", "gyoza", "potsticker", "xiao long bao", "soup dumpling"] },
  { key: "curry", name: "a bowl of curry with rice", keywords: ["curry", "tikka masala", "vindaloo", "korma", "green curry", "red curry", "massaman"] },
  { key: "pasta", name: "a bowl of pasta with sauce", keywords: ["pasta", "spaghetti", "lasagna", "ravioli", "carbonara", "bolognese", "linguine", "fettuccine"] },
  { key: "kebab", name: "grilled meat skewers", keywords: ["kebab", "kabob", "shawarma", "gyro", "souvlaki"] },
  { key: "salad", name: "a fresh mixed salad in a bowl", keywords: ["salad", "caesar", "cobb", "greens"] },
  { key: "soup", name: "a bowl of soup", keywords: ["soup", "chowder", "bisque", "chili", "stew"] },
  { key: "cheese_curds", name: "a basket of fried Wisconsin cheese curds", keywords: ["cheese curd", "curds", "fried curds"] },
  { key: "pretzel", name: "a soft pretzel with mustard", keywords: ["pretzel", "soft pretzel"] },
  { key: "bagel", name: "a bagel with cream cheese", keywords: ["bagel", "lox", "schmear"] },
  { key: "pancake", name: "a stack of pancakes with syrup", keywords: ["pancake", "flapjack"] },
  { key: "waffle", name: "a golden waffle with syrup", keywords: ["waffle", "belgian waffle", "chicken and waffle"] },
  { key: "brunch", name: "eggs benedict on a plate", keywords: ["brunch", "eggs benedict", "omelet", "omelette", "breakfast burrito", "breakfast"] },
  { key: "ice_cream", name: "an ice cream cone with a scoop", keywords: ["ice cream", "gelato", "sorbet", "sundae", "scoop"] },
  { key: "frozen_custard", name: "a cup of Wisconsin frozen custard with sprinkles", keywords: ["custard", "frozen custard", "kopps"] },
  { key: "donut", name: "a glazed donut with sprinkles", keywords: ["donut", "doughnut", "cruller"] },
  { key: "cookie", name: "a chocolate chip cookie", keywords: ["cookie", "cookies", "biscotti"] },
  { key: "cake", name: "a slice of layered birthday cake", keywords: ["cake", "cheesecake", "cupcake", "tres leches", "carrot cake"] },
  { key: "pie", name: "a slice of pie", keywords: ["pie", "apple pie", "pecan pie", "key lime"] },
  { key: "cream_puff", name: "a Wisconsin state fair cream puff", keywords: ["cream puff", "eclair", "profiterole"] },
  { key: "croissant", name: "a flaky butter croissant", keywords: ["croissant", "pastry", "danish", "pain au chocolat", "kouign amann"] },
  { key: "bakery", name: "an assortment of breads and pastries", keywords: ["bakery", "bread", "loaf", "sourdough", "focaccia", "kringle"] },
  { key: "coffee", name: "a latte with foam art in a mug", keywords: ["coffee", "latte", "espresso", "cappuccino", "cortado", "cold brew", "mocha", "flat white", "americano", "cafe"] },
  { key: "tea", name: "a cup of tea with steam", keywords: ["tea", "matcha", "chai", "boba", "bubble tea"] },
  { key: "beer", name: "a pint glass of golden beer with foam", keywords: ["beer", "ipa", "lager", "pilsner", "stout", "pint", "brewery", "brewpub"] },
  { key: "cocktail", name: "a fancy cocktail with a garnish", keywords: ["cocktail", "martini", "margarita", "mojito", "negroni", "manhattan", "mule"] },
  { key: "old_fashioned", name: "a brandy old fashioned Wisconsin cocktail with an orange slice", keywords: ["old fashioned", "brandy old fashioned"] },
  { key: "wine", name: "a glass of red wine", keywords: ["wine", "vino", "chardonnay", "cabernet", "pinot", "sommelier"] },
  { key: "smoothie", name: "a fruit smoothie in a glass with a straw", keywords: ["smoothie", "juice", "shake", "milkshake", "frappe"] },
];

const SYSTEM_PROMPT =
  "You are an SVG illustrator. You produce compact, valid SVG code representing a single object as a cute vector-style emoji.";

const buildPrompt = (name: string) => `Generate a clean vector emoji-style SVG icon of ${name}.

Requirements:
- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
- Flat colors, bold contour outlines (typically dark or white strokes), simple shapes.
- Transparent background — do NOT include a background <rect> that fills the canvas.
- Composition centered in the 100x100 viewBox with a small margin.
- No text elements, no gradients if avoidable, no filters, no external references.
- Absolutely no <script>, <foreignObject>, <use xlink:href>, <image>, or <style> tags.
- Output ONLY the SVG code starting with "<svg" and ending with "</svg>". No markdown fences, no commentary.`;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Set OPENAI_API_KEY to run this script.");
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

async function generateSvg(name: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(name) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  return sanitizeSvg(raw);
}

// Strip markdown fences and validate the SVG is safe to embed inline.
function sanitizeSvg(raw: string): string {
  let s = raw.trim();
  // Remove ```svg / ``` fences if the model wrapped them.
  s = s.replace(/^```(?:svg|xml|html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!s.startsWith("<svg") || !s.endsWith("</svg>")) {
    throw new Error(`Not a well-formed SVG: ${s.slice(0, 120)}`);
  }
  if (/<script|<foreignObject|<image[\s>]|xlink:href|<style/i.test(s)) {
    throw new Error("SVG contains disallowed elements/attributes");
  }
  return s;
}

// Escape only what breaks a template literal: backtick and ${.
function escapeForTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

async function main() {
  console.log(`Generating ${FOOD_TYPES.length} food emojis via ${MODEL}…\n`);
  const results: Record<string, { keywords: string[]; svg: string }> = {};
  const failures: string[] = [];

  for (const food of FOOD_TYPES) {
    process.stdout.write(`  ${food.key.padEnd(18)}`);
    try {
      const svg = await generateSvg(food.name);
      results[food.key] = { keywords: food.keywords, svg };
      console.log(`ok (${svg.length} chars)`);
    } catch (err) {
      failures.push(food.key);
      console.log(`FAILED — ${(err as Error).message.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 120)); // gentle rate limit
  }

  const keys = Object.keys(results).sort();
  const outPath = resolve(import.meta.dir, "..", "web", "src", "foodEmojis.ts");
  const body = renderOutput(keys, results);
  writeFileSync(outPath, body);

  console.log(`\nWrote ${keys.length}/${FOOD_TYPES.length} emojis to ${outPath}`);
  if (failures.length) {
    console.log(`Failed: ${failures.join(", ")}`);
    console.log("Rerun to retry the failures (successful ones are unaffected).");
  }
}

function renderOutput(
  keys: string[],
  results: Record<string, { keywords: string[]; svg: string }>,
): string {
  const union = keys.map((k) => `  | "${k}"`).join("\n");
  const entries = keys
    .map((k) => {
      const r = results[k]!;
      return `  ${k}: {
    keywords: ${JSON.stringify(r.keywords)},
    svg: \`${escapeForTemplate(r.svg)}\`,
  },`;
    })
    .join("\n");

  return `// AUTO-GENERATED by scripts/gen-emojis.ts — do not edit.
// Regenerate with: bun run gen:emojis

export type FoodEmojiKey =
${union};

export type FoodEmoji = {
  keywords: string[];
  svg: string;
};

export const FOOD_EMOJIS: Record<FoodEmojiKey, FoodEmoji> = {
${entries}
};

/**
 * Match a user's freeform tag against the pre-generated emoji set.
 * Returns the first key whose keyword substring appears in the tag,
 * or null if nothing matches (caller falls back to the verdict emoji).
 */
export const matchFoodEmoji = (tag: string): FoodEmojiKey | null => {
  const lower = tag.toLowerCase();
  for (const [key, { keywords }] of Object.entries(FOOD_EMOJIS)) {
    if (keywords.some((k) => lower.includes(k))) return key as FoodEmojiKey;
  }
  return null;
};
`;
}

await main();
