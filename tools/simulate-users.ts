#!/usr/bin/env bun
/**
 * Seed the DB with a plausible community of users so we can eyeball
 * how the credibility mechanic feels at scale.
 *
 *   bun run tools/simulate-users.ts             # default city=Milwaukee, 15 users
 *   bun run tools/simulate-users.ts --city "San Diego" --users 20
 *   bun run tools/simulate-users.ts --dry-run   # print plan, don't POST
 *
 * Hits the running API at http://localhost:3001. Each simulated user
 * spoofs a distinct X-Forwarded-For so review-per-IP rate limits and
 * per-IP reaction dedup keep behaving as if it's a crowd. Uses our
 * own /api/search endpoint to pull real businesses in the city.
 */

const API = process.env.API_URL ?? "http://localhost:3001";

// ---- args --------------------------------------------------------------
const args = process.argv.slice(2);
let city = "Milwaukee";
let userCount = 15;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--city" && i + 1 < args.length) city = args[++i]!;
  else if (a === "--users" && i + 1 < args.length) userCount = Math.max(3, Math.min(50, parseInt(args[++i]!, 10) || 15));
  else if (a === "--dry-run") dryRun = true;
}

// ---- taste tribes ------------------------------------------------------
type Tribe = "foodie" | "casual" | "nightlife";
const TRIBES: Tribe[] = ["foodie", "casual", "nightlife"];

// Each tribe has preferred cuisine search queries — used to fetch a
// pool of candidate businesses tuned to what that tribe would review.
const TRIBE_CRAVINGS: Record<Tribe, string[]> = {
  foodie:    ["italian", "sushi", "thai", "seafood", "ramen", "french", "korean"],
  casual:    ["pizza", "burgers", "tacos", "sandwich", "chinese", "brunch"],
  nightlife: ["cocktails", "wine", "bars", "coffee", "late night"],
};

// Interest-id used on the review payload, mapped per craving keyword.
const CRAVING_TO_INTEREST: Record<string, string> = {
  italian: "food", sushi: "food", thai: "food", seafood: "food", ramen: "food",
  french: "food", korean: "food", pizza: "food", burgers: "food", tacos: "food",
  sandwich: "food", chinese: "food", brunch: "food",
  cocktails: "cocktails", wine: "wine", bars: "bars", coffee: "coffee",
  "late night": "food",
};

// Hand-crafted short tags (1–8 words) per craving + verdict. Sim-only
// grade-B copy — good enough to visually populate a map, not gold.
type Verdict = 1 | 0 | -1;
const TAGS: Record<string, Record<Verdict, string[]>> = {
  italian: {
    1: ["best carbonara in town", "wood-fired pizza magic", "old-school italian gem", "handmade pasta perfection", "sunday sauce vibes"],
    0: ["decent pasta forgettable sauce", "average for the price", "fine but nothing special"],
    [-1]: ["pasta was gluey", "overpriced tourist trap", "microwaved lasagna energy"],
  },
  sushi: {
    1: ["freshest omakase downtown", "excellent uni", "chef's choice is worth it", "spicy tuna on point"],
    0: ["decent rolls skip the sashimi", "solid but not memorable"],
    [-1]: ["fish tasted old", "ambiance beats the food"],
  },
  thai: {
    1: ["real thai heat here", "green curry is fire", "best pad see ew", "amazing khao soi"],
    0: ["mild for my taste", "pad thai was fine"],
    [-1]: ["too americanized", "sauce was watery"],
  },
  seafood: {
    1: ["best oysters in town", "clam chowder heaven", "lobster roll dreams", "get the whole fish"],
    0: ["fresh but overpriced", "sides let it down"],
    [-1]: ["fish was overcooked", "chowder tasted canned"],
  },
  ramen: {
    1: ["broth is transcendent", "best tonkotsu in the city", "worth the wait"],
    0: ["good noodles weak broth", "solid backup ramen spot"],
    [-1]: ["broth was thin", "noodles overcooked"],
  },
  french: {
    1: ["duck confit perfection", "best steak frites", "classic bistro done right"],
    0: ["service saved the meal", "fine for a splurge"],
    [-1]: ["overpriced for the portion"],
  },
  korean: {
    1: ["banchan is amazing", "best bulgogi", "kimchi jjigae is comfort", "korean fried chicken done right"],
    0: ["decent bibimbap", "solid lunch spot"],
    [-1]: ["portions were small"],
  },
  pizza: {
    1: ["best neapolitan in town", "wood-fired crust magic", "detroit style done right", "worth the drive"],
    0: ["solid slice not destination", "average pepperoni"],
    [-1]: ["soggy crust", "sauce tasted canned"],
  },
  burgers: {
    1: ["best smash burger", "juicy patty butter bun", "underrated burger spot", "get the double"],
    0: ["fine burger nothing special", "fries stole the show"],
    [-1]: ["dry patty stale bun", "over-hyped"],
  },
  tacos: {
    1: ["carne asada is life", "best al pastor east side", "birria dreams", "authentic taqueria vibes", "salsa bar is chef's kiss"],
    0: ["decent tacos small portions", "fine for late night"],
    [-1]: ["overpriced for the size", "tortillas were stale"],
  },
  sandwich: {
    1: ["best italian sub", "amazing meatball hero", "worth skipping subway", "crunchy fresh bread"],
    0: ["decent sub for lunch", "fine but forgettable"],
    [-1]: ["bread was stale"],
  },
  chinese: {
    1: ["best dan dan noodles", "authentic sichuan heat", "dumplings are amazing"],
    0: ["decent lunch special"],
    [-1]: ["greasy takeout vibes"],
  },
  brunch: {
    1: ["best eggs benedict", "amazing pancakes", "hash browns done right"],
    0: ["long wait mediocre food"],
    [-1]: ["overpriced mimosas"],
  },
  cocktails: {
    1: ["best old fashioned in town", "excellent negroni", "bartender knows their craft", "worth the price"],
    0: ["decent drinks slow service"],
    [-1]: ["watered down for the price"],
  },
  wine: {
    1: ["great by-the-glass list", "sommelier is thoughtful", "underrated wine bar", "excellent natural wine"],
    0: ["fine list overpriced"],
    [-1]: ["corked bottle no offer to replace"],
  },
  bars: {
    1: ["perfect neighborhood dive", "cold beer great vibes", "best jukebox in town"],
    0: ["decent bar nothing special"],
    [-1]: ["overpriced watered drinks"],
  },
  coffee: {
    1: ["best espresso in town", "excellent cortado", "third wave done right", "beans roasted in-house"],
    0: ["decent latte slow service"],
    [-1]: ["burnt beans watery espresso"],
  },
  "late night": {
    1: ["best late night eats", "open when nothing else is"],
    0: ["fine after midnight"],
    [-1]: ["worth it only when desperate"],
  },
};

// Verdict distribution per tribe. Foodies are picky, casuals are
// generous, nightlife people are variable.
const VERDICT_DIST: Record<Tribe, [number, number, number]> = {
  //           yum  meh  yuck
  foodie:    [0.55, 0.30, 0.15],
  casual:    [0.75, 0.20, 0.05],
  nightlife: [0.60, 0.30, 0.10],
};

// ---- user pool ---------------------------------------------------------
const FIRST_NAMES = [
  "Alex", "Sam", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Dakota",
  "Avery", "Quinn", "Reese", "Sydney", "Peyton", "Rowan", "Kai",
  "Elena", "Marcus", "Priya", "Kenji", "Zara", "Diego", "Nadia", "Theo",
];

function pickTribe(idx: number): Tribe {
  return TRIBES[idx % TRIBES.length]!;
}

function rnd<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function weightedVerdict(dist: [number, number, number]): Verdict {
  const r = Math.random();
  if (r < dist[0]) return 1;
  if (r < dist[0] + dist[1]) return 0;
  return -1;
}

// ---- HTTP helpers ------------------------------------------------------
type Business = {
  id: string; source: string; source_id: string;
  name: string; address: string | null; city: string | null;
  lat: number; lng: number; category: string | null;
};

const spoofIp = (i: number) => `10.42.${Math.floor(i / 254)}.${(i % 254) + 1}`;

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function ensureBusinesses(craving: string, cityName: string): Promise<Business[]> {
  // Use our own /api/search to fetch candidate businesses — same path
  // real users hit, so the sim exercises the same code paths.
  const res = await post("/api/search", { q: craving, city: cityName });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    intent: string;
    craving?: { businesses: Business[] };
    named_list?: Business[];
  };
  return data.craving?.businesses ?? data.named_list ?? [];
}

// ---- main --------------------------------------------------------------
console.log(`Simulating ${userCount} users in ${city} against ${API}`);
if (dryRun) console.log("(dry-run — no API writes)\n");

// 1. Fetch a candidate pool of businesses per tribe cravings.
console.log("Fetching candidate businesses per tribe…");
const businessPool: Record<Tribe, { craving: string; businesses: Business[] }[]> = {
  foodie: [], casual: [], nightlife: [],
};
for (const tribe of TRIBES) {
  for (const craving of TRIBE_CRAVINGS[tribe]) {
    const bizs = await ensureBusinesses(craving, city);
    businessPool[tribe].push({ craving, businesses: bizs });
    console.log(`  [${tribe.padEnd(9)}] "${craving.padEnd(11)}" → ${bizs.length} candidates`);
    await new Promise((r) => setTimeout(r, 250)); // gentle
  }
}

// 2. Create users.
type SimUser = { id: string; name: string; tribe: Tribe; ip: string };
const users: SimUser[] = [];
for (let i = 0; i < userCount; i++) {
  const name = `${rnd(FIRST_NAMES)} ${String.fromCharCode(65 + (i % 26))}.`;
  const tribe = pickTribe(i);
  const ip = spoofIp(i);
  if (dryRun) {
    users.push({ id: `dry-${i}`, name, tribe, ip });
    continue;
  }
  const res = await post("/api/users", { display_name: name }, { "x-forwarded-for": ip });
  const data = (await res.json()) as { id: string; display_name: string };
  users.push({ id: data.id, name: data.display_name, tribe, ip });
}
console.log(`\nCreated ${users.length} users across tribes:`);
for (const t of TRIBES) {
  const n = users.filter((u) => u.tribe === t).length;
  console.log(`  ${t.padEnd(9)}: ${n}`);
}

// 3. Each user posts 4-8 reviews at businesses matching their tribe.
type PostedReview = { id: number; user: SimUser; businessId: string; tag: string; interest: string };
const postedReviews: PostedReview[] = [];
console.log(`\nPosting reviews…`);
for (const u of users) {
  const nReviews = 4 + Math.floor(Math.random() * 5); // 4-8
  const pool = businessPool[u.tribe];
  const targets: { craving: string; business: Business }[] = [];
  for (let i = 0; i < nReviews && targets.length < nReviews; i++) {
    const bucket = rnd(pool);
    if (bucket.businesses.length === 0) continue;
    const business = rnd(bucket.businesses);
    if (targets.find((t) => t.business.id === business.id)) continue; // no dup per user
    targets.push({ craving: bucket.craving, business });
  }
  for (const { craving, business } of targets) {
    const verdict = weightedVerdict(VERDICT_DIST[u.tribe]);
    const bank = TAGS[craving]?.[verdict] ?? [`something about ${craving}`];
    const tag = rnd(bank);
    const interest = CRAVING_TO_INTEREST[craving] ?? "food";
    if (dryRun) {
      postedReviews.push({ id: -1, user: u, businessId: business.id, tag, interest });
      continue;
    }
    // Upsert business first (Overpass results aren't yet in our DB).
    await post("/api/businesses", business, { "x-forwarded-for": u.ip });
    const res = await post(
      "/api/reviews",
      { business_id: business.id, interest_id: interest, verdict, tag },
      { "x-user-id": u.id, "x-forwarded-for": u.ip },
    );
    if (!res.ok) {
      console.log(`  ${u.name} → ${business.name}: FAIL ${res.status} ${await res.text().catch(() => "")}`);
      continue;
    }
    const data = (await res.json()) as { id: number };
    postedReviews.push({ id: data.id, user: u, businessId: business.id, tag, interest });
  }
  process.stdout.write(`  ${u.name} (${u.tribe}) → ${targets.length} reviews\n`);
  await new Promise((r) => setTimeout(r, 60));
}
console.log(`\nTotal reviews posted: ${postedReviews.length}`);

// 4. Cross-Good-call other users' reviews with tribe affinity.
console.log(`\nGood-calling reviews…`);
const CROSS_TRIBE_P = 0.15;
const SAME_TRIBE_P  = 0.65;
let goodCallCount = 0;
for (const u of users) {
  for (const r of postedReviews) {
    if (r.user.id === u.id) continue; // don't self-good-call
    const p = r.user.tribe === u.tribe ? SAME_TRIBE_P : CROSS_TRIBE_P;
    if (Math.random() > p) continue;
    if (dryRun) { goodCallCount++; continue; }
    const res = await post(
      `/api/reviews/${r.id}/reactions`,
      { kind: "legit" },
      { "x-user-id": u.id, "x-forwarded-for": u.ip },
    );
    if (res.ok) goodCallCount++;
  }
}
console.log(`Total good-calls: ${goodCallCount}`);

console.log(`\nDone. Try: open ${API.replace(":3001", ":5173")} and search "italian", "tacos", "cocktails"`);
