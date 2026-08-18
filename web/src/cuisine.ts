export type Cuisine =
  | "pizza"
  | "mexican"
  | "american"
  | "asian"
  | "european"
  | "cafe"
  | "sweet"
  | "bar"
  | "other";

export type CuisineMeta = { cuisine: Cuisine; label: string; emoji: string; color: string };

export const CUISINES: readonly CuisineMeta[] = [
  { cuisine: "pizza", label: "Pizza", emoji: "🍕", color: "#e63946" },
  { cuisine: "mexican", label: "Mexican & Latin", emoji: "🌮", color: "#f4a261" },
  { cuisine: "american", label: "American & Burger", emoji: "🍔", color: "#b5651d" },
  { cuisine: "asian", label: "Asian", emoji: "🥢", color: "#c1121f" },
  { cuisine: "european", label: "European", emoji: "🍝", color: "#7f5539" },
  { cuisine: "cafe", label: "Cafe & Coffee", emoji: "☕", color: "#6f4e37" },
  { cuisine: "sweet", label: "Bakery & Sweets", emoji: "🥐", color: "#e5989b" },
  { cuisine: "bar", label: "Bar & Brewery", emoji: "🍺", color: "#f4b400" },
  { cuisine: "other", label: "Other", emoji: "🍽️", color: "#9ca3af" },
] as const;

const META: Record<Cuisine, CuisineMeta> = Object.fromEntries(
  CUISINES.map((c) => [c.cuisine, c]),
) as Record<Cuisine, CuisineMeta>;

export const cuisineMeta = (c: Cuisine): CuisineMeta => META[c];

// Categories that should NOT be shown even though our seed regex caught them.
const EXCLUDE_SUBSTRINGS = ["equipment", "supply", "store", "wholesale", "distributor"];

export const categoryToCuisine = (category: string | null | undefined): Cuisine | null => {
  if (!category) return "other";
  const c = category.toLowerCase();
  if (EXCLUDE_SUBSTRINGS.some((s) => c.includes(s))) return null;

  // Order matters: more specific matches first.
  if (c.includes("pizza")) return "pizza";
  if (
    c.includes("mexican") ||
    c.includes("taco") ||
    c.includes("burrito") ||
    c.includes("latin") ||
    c.includes("cuban") ||
    c.includes("caribbean") ||
    c.includes("jamaican") ||
    c.includes("puerto_rican") ||
    c.includes("peruvian") ||
    c.includes("venezuelan") ||
    c.includes("texmex")
  )
    return "mexican";

  if (
    c.includes("burger") ||
    c.includes("hot_dog") ||
    c.includes("chicken_wings") ||
    c.includes("bar_and_grill") ||
    c.includes("american") ||
    c.includes("diner") ||
    c.includes("barbecue") ||
    c.includes("fast_food") ||
    c.includes("chicken_restaurant") ||
    c.includes("southern") ||
    c.includes("cajun") ||
    c.includes("comfort_food")
  )
    return "american";

  if (
    c.includes("chinese") ||
    c.includes("japanese") ||
    c.includes("sushi") ||
    c.includes("thai") ||
    c.includes("korean") ||
    c.includes("vietnamese") ||
    c.includes("asian") ||
    c.includes("ramen") ||
    c.includes("noodles") ||
    c.includes("indian") ||
    c.includes("pakistani") ||
    c.includes("filipino") ||
    c.includes("poke") ||
    c.includes("halal") ||
    c.includes("middle_eastern")
  )
    return "asian";

  if (
    c.includes("italian") ||
    c.includes("mediterranean") ||
    c.includes("greek") ||
    c.includes("french") ||
    c.includes("spanish") ||
    c.includes("german") ||
    c.includes("tapas")
  )
    return "european";

  if (c.includes("coffee") || c === "cafe" || c.includes("tea_room")) return "cafe";

  if (
    c.includes("bakery") ||
    c.includes("ice_cream") ||
    c.includes("frozen_yog") ||
    c.includes("donut") ||
    c.includes("dessert") ||
    c.includes("smoothie") ||
    c.includes("juice_bar")
  )
    return "sweet";

  if (
    c === "bar" ||
    c.includes("pub") ||
    c.includes("brewery") ||
    c.includes("winery") ||
    c.includes("distillery") ||
    c.includes("cocktail_bar") ||
    c.includes("sports_bar") ||
    c.includes("dive_bar") ||
    c.includes("wine_bar") ||
    c.includes("beer_bar") ||
    c.includes("gay_bar") ||
    c.includes("hookah_bar") ||
    c.includes("tiki_bar") ||
    c.includes("tapas_bar")
  )
    return "bar";

  // salad_bar, food_court, seafood, etc. → generic
  return "other";
};
