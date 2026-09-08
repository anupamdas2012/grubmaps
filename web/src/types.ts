export type Verdict = 1 | 0 | -1;
export type ReactionKind = "legit" | "dispute" | "protip";

export type Interest = {
  id: string;
  name: string;
  emoji: string;
  color: string;
};

export type Pin = {
  id: number;
  user_id: string;
  interest_id: string;
  lat: number;
  lng: number;
  tag: string;
  verdict: Verdict;
  created_at: number;
  display_name: string;
  legit: number;
  dispute: number;
  protip: number;
};
