export type Verdict = 1 | 0 | -1;
export type ReactionKind = "legit" | "dispute" | "protip";

export type Interest = {
  id: string;
  name: string;
  emoji: string;
  color: string;
};

export type Business = {
  id: string;
  source: string;
  source_id: string;
  name: string;
  address: string | null;
  city: string | null;
  lat: number;
  lng: number;
  category: string | null;
  display_name?: string; // present on Nominatim autocomplete results
};

export type Review = {
  id: number;
  user_id: string;
  business_id: string;
  interest_id: string;
  tag: string;
  verdict: Verdict;
  created_at: number;
  lat: number;              // denormalized from business for map rendering
  lng: number;
  business_name: string;
  business_address: string | null;
  business_city: string | null;
  display_name: string;
  legit: number;
  dispute: number;
  protip: number;
};

export type SearchIntent = "named" | "craving" | "ambiguous";

export type LatestReviewLite = {
  id: number;
  verdict: Verdict;
  tag: string;
  interest_id: string;
  created_at: number;
  display_name: string | null;
};

export type CravingBusiness = Business & {
  review_count: number;
  latest_review: LatestReviewLite | null;
};

export type SearchResponse = {
  intent: SearchIntent;
  classifier?: {
    intent: SearchIntent;
    named_query?: string;
    craving_query?: string;
    reason?: string;
  };
  named?: Business | null;
  craving?: { businesses: CravingBusiness[] };
  fallback?: { pois: Business[] };
};

export type CityInfo = {
  city: string | null;
  state: string | null;
  country: string | null;
  display: string;
  lat: number;
  lng: number;
};
