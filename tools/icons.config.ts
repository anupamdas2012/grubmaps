/**
 * Canonical icon set for interest categories. The batch generator
 * (`tools/gen-icons.ts`) reads this to produce one PNG per entry.
 *
 * Keep the `key` in sync with the interest IDs seeded in
 * `server/index.ts` (SEED_INTERESTS). `subject` is the free-text
 * prompt passed to the model — tweak these to reshape the icon.
 *
 * NOTE: `gpt-image-1` does not expose a random seed, so regeneration
 * is deterministic in intent but not pixel-identical. The manifest at
 * `web/public/food-icons/manifest.json` captures the exact prompt +
 * SHAs at generation time so you always know what shipped.
 */

export type IconSpec = {
  key: string;      // interest id (matches server SEED_INTERESTS)
  subject: string;  // prompt handed to the model
};

export const ICON_SIZE_PX = 128;

export const ICON_SET: IconSpec[] = [
  { key: "food",      subject: "a hearty gourmet cheeseburger with lettuce, tomato, and melted cheese on a toasted brioche bun" },
  { key: "coffee",    subject: "a hot latte in a rustic ceramic mug with rich foam art and gentle steam rising" },
  { key: "bars",      subject: "a frothy pint of amber craft beer in a tall pilsner glass" },
  { key: "cocktails", subject: "a classic martini in a stemmed glass with a green olive garnish and a subtle citrus twist" },
  { key: "wine",      subject: "a dark wine bottle beside a stemmed glass of red wine" },
  { key: "cigars",    subject: "a hand-rolled premium cigar with a burning ember tip and a delicate curl of smoke" },
  { key: "sweets",    subject: "a slice of tall layered chocolate cake with glossy ganache and a raspberry on top" },
  { key: "culture",   subject: "an ornate golden theatrical comedy mask with red ribbon accents" },
  { key: "music",     subject: "a vintage silver stage microphone with a small musical note beside it" },
];
