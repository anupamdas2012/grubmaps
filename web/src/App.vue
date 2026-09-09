<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from "vue";
import { Map as MLMap, Marker, NavigationControl, AttributionControl, type ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import PinModal from "./components/PinModal.vue";
import LoginModal from "./components/LoginModal.vue";
import Logo from "./components/Logo.vue";
import SearchBar from "./components/SearchBar.vue";
import InterestSwitcher from "./components/InterestSwitcher.vue";
import Fab from "./components/Fab.vue";
import AudienceToggle from "./components/AudienceToggle.vue";
import BusinessPicker from "./components/BusinessPicker.vue";
import DetailSheet from "./components/DetailSheet.vue";
import DisambigModal from "./components/DisambigModal.vue";
import { authFetch, ensureUser, loadUser, registerUser, type User } from "./user";
import { api } from "./api";
import type {
  Business, CityInfo, Interest, Review, SearchResponse, Verdict,
} from "./types";

const VERDICT_META: Record<Verdict, { cls: "yum" | "meh" | "yuck"; icon: string }> = {
  1: { cls: "yum", icon: "😋" },
  0: { cls: "meh", icon: "🫤" },
  [-1]: { cls: "yuck", icon: "💩" },
};

const MILWAUKEE: [number, number] = [-87.9065, 43.0389];

const mapEl = ref<HTMLDivElement | null>(null);

// Auth + interests
const user = ref<User | null>(loadUser());
const needsLogin = computed(() => user.value === null);
const interests = ref<Interest[]>([]);
const activeInterest = ref<string>(localStorage.getItem("grubmaps.activeInterest.v1") ?? "food");
const mineOnly = ref<boolean>(localStorage.getItem("grubmaps.mineOnly.v1") === "1");

// City state (localStorage-cached, GPS-refined on first load)
const city = ref<string | null>(localStorage.getItem("grubmaps.city.v1"));
const cityCenter = ref<[number, number] | null>(null);

// Review + fallback pin state (aggregated by business)
type BusinessPin = {
  business: Business;
  reviews: Review[];      // may be empty for fallback pois
  isFallback: boolean;
};
const businessPins = new Map<string, BusinessPin>();
const businessMarkers = new Map<string, { emoji: Marker; text: Marker }>();

// Modal state
const pickerBusiness = ref<Business | null>(null);   // set → open ReviewModal (was PinModal)
const showPicker = ref(false);                       // set → open BusinessPicker
const pickerPrefill = ref<string>("");
const detailBusinessId = ref<string | null>(null);
const detailFallback = ref<Business | null>(null);   // for fallback POIs not yet in DB
const disambig = ref<{ query: string; named: Business | null; cravingCount: number } | null>(null);

// Search state
const activeSearchQuery = ref<string>("");           // '' → not in search mode
const searching = ref(false);
const searchStatus = ref<string>("");                // hint text under nav

let map: MLMap | null = null;

// ---- rendering ---------------------------------------------------------
const seededUnit = (id: number, salt: number) => {
  const s = Math.sin(id * 9301.7 + salt) * 43758.5453;
  return s - Math.floor(s);
};
const seededRotation = (id: number) => (seededUnit(id, 49297.3) - 0.5) * 12;

const interestColor = (id: string) =>
  interests.value.find((i) => i.id === id)?.color ?? "#333";

// Render one marker per business. For businesses with reviews, use the most
// recent review to source the emoji/tag/color. Fallback POIs render greyed
// with the business name as the tag.
const renderBusinessMarker = (pin: BusinessPin) => {
  if (!map) return;
  const { business, reviews, isFallback } = pin;

  // Remove any existing marker for this business (idempotent re-render).
  const existing = businessMarkers.get(business.id);
  if (existing) {
    existing.emoji.remove();
    existing.text.remove();
    businessMarkers.delete(business.id);
  }

  const seed = business.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  let icon: string;
  let cls: "yum" | "meh" | "yuck" | "fallback";
  let tag: string;
  let accent: string;

  if (isFallback || reviews.length === 0) {
    icon = "❔";
    cls = "fallback";
    tag = business.name;
    accent = "#94a3b8";
  } else {
    const latest = reviews[0]!;
    // Aggregate sentiment across ALL reviews so a mostly-loved spot
    // shows 😋 even if the latest reviewer was grumpy. Average verdict
    // in [-1..1]; ±0.2 threshold gives a slight-majority reading.
    const avgVerdict = reviews.reduce((s, r) => s + r.verdict, 0) / reviews.length;
    const aggVerdict: Verdict = avgVerdict > 0.2 ? 1 : avgVerdict < -0.2 ? -1 : 0;
    const meta = VERDICT_META[aggVerdict];
    icon = meta.icon;
    cls = meta.cls;
    accent = interestColor(latest.interest_id);
    // For a single-review spot, use the tag as-is. For multiple, use
    // the synthesized summary if we've cached it, otherwise show the
    // latest as a placeholder until the async /api/synthesize replies.
    if (reviews.length >= 2) {
      const tags = reviews.map((r) => r.tag);
      const key = [...tags].sort().join("|");
      tag = synthesisCache.get(key) ?? latest.tag;
    } else {
      tag = latest.tag;
    }
  }

  // Hot signal — businesses with lots of reviews and/or Good-calls get
  // larger, more prominent text so the map immediately shows the
  // crowd's favorites. Combines review count (breadth) with legit
  // count on the latest review (depth).
  const legitOnLatest = reviews[0]?.legit ?? 0;
  const hotScore = reviews.length + legitOnLatest / 2;
  const hotTier: "" | " hot" | " superhot" =
    hotScore >= 10 ? " superhot" : hotScore >= 5 ? " hot" : "";

  // Yum wiggle: random per-render phase (negative delay starts mid-cycle)
  // + slightly randomized duration (5–9s) so pins never re-sync into a
  // single group wiggle. Emoji + text of the same business use the same
  // values so they wiggle in lockstep.
  const wiggleDuration = 5 + Math.random() * 4;
  const wigglePhase = Math.random() * wiggleDuration;

  const emojiOuter = document.createElement("div");
  const emojiInner = document.createElement("div");
  emojiInner.className = `pin-emoji ${cls}${hotTier}`;
  emojiInner.textContent = icon;
  if (cls === "yum") {
    emojiInner.style.animationDuration = `${wiggleDuration.toFixed(2)}s`;
    emojiInner.style.animationDelay = `-${wigglePhase.toFixed(2)}s`;
  }
  emojiOuter.appendChild(emojiInner);
  emojiOuter.addEventListener("click", (e) => {
    e.stopPropagation();
    openDetail(business.id, isFallback ? business : null);
  });
  const emojiMarker = new Marker({ element: emojiOuter, anchor: "center" })
    .setLngLat([business.lng, business.lat])
    .addTo(map);

  const textOuter = document.createElement("div");
  const textRot = document.createElement("div");
  textRot.style.transform = `rotate(${seededRotation(seed).toFixed(2)}deg)`;
  const textInner = document.createElement("div");
  textInner.className = `pin-text ${cls}${hotTier}`;
  textInner.textContent = tag;
  textInner.style.setProperty("--pin-accent", accent);
  if (cls === "yum") {
    textInner.style.animationDuration = `${wiggleDuration.toFixed(2)}s`;
    textInner.style.animationDelay = `-${wigglePhase.toFixed(2)}s`;
  }
  textRot.appendChild(textInner);
  textOuter.appendChild(textRot);
  textOuter.addEventListener("click", (e) => {
    e.stopPropagation();
    openDetail(business.id, isFallback ? business : null);
  });
  const textMarker = new Marker({ element: textOuter, anchor: "top", offset: [0, 18] })
    .setLngLat([business.lng, business.lat])
    .addTo(map);

  businessMarkers.set(business.id, { emoji: emojiMarker, text: textMarker });

  // For multi-review businesses, ask the LLM for a "voice of the crowd"
  // summary of all their tags so the pin doesn't cherry-pick the latest.
  // Cached in `synthesisCache` so panning doesn't re-hit the API.
  if (!isFallback && reviews.length >= 2) {
    const tags = reviews.map((r) => r.tag);
    const key = [...tags].sort().join("|");
    if (!synthesisCache.has(key)) {
      void fetch(api("/api/synthesize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { synthesis?: string } | null) => {
          if (data?.synthesis) {
            synthesisCache.set(key, data.synthesis);
            if (textInner.isConnected) textInner.textContent = data.synthesis;
          }
        })
        .catch(() => { /* keep the latest-review placeholder */ });
    }
  }
};

const clearMarkers = () => {
  for (const m of businessMarkers.values()) {
    m.emoji.remove();
    m.text.remove();
  }
  businessMarkers.clear();
  businessPins.clear();
};

const upsertBusinessPin = (business: Business, review: Review | null, isFallback = false) => {
  const existing = businessPins.get(business.id);
  if (existing) {
    if (review && !existing.reviews.find((r) => r.id === review.id)) {
      existing.reviews.unshift(review); // most-recent first
    }
    existing.isFallback = existing.reviews.length === 0 && isFallback;
  } else {
    businessPins.set(business.id, {
      business,
      reviews: review ? [review] : [],
      isFallback: review ? false : isFallback,
    });
  }
  scheduleCluster();
};

// ---- density clustering with LLM-synthesized labels --------------------
// Overlapping pin labels are the map's #1 clutter source. At every zoom
// we project each pin to screen pixels and greedy-group ones within
// CLUSTER_THRESHOLD_PX. Clusters of 1 render as normal pins; clusters
// of 2+ render as a single "voice of the crowd" pin whose text comes
// from /api/synthesize — one short phrase distilled from the member
// tags by gpt-4o-mini. Cached client-side by sorted-tag key so
// re-clustering the same group is instant.
const CLUSTER_THRESHOLD_PX = 90;
const synthesisCache = new Map<string, string>();
let clusterTimer: number | null = null;

const scheduleCluster = () => {
  if (clusterTimer !== null) window.clearTimeout(clusterTimer);
  clusterTimer = window.setTimeout(() => { clusterAndRender(); }, 180);
};

type ClusterMember = { pin: BusinessPin; x: number; y: number };

const clusterAndRender = () => {
  if (!map) return;
  // Drop all existing markers before rebuilding.
  for (const m of businessMarkers.values()) {
    m.emoji.remove();
    m.text.remove();
  }
  businessMarkers.clear();

  const items: ClusterMember[] = Array.from(businessPins.values()).map((pin) => {
    const px = map!.project([pin.business.lng, pin.business.lat]);
    return { pin, x: px.x, y: px.y };
  });

  // Greedy clustering — O(n²), fine for our N ≤ 100 pins.
  const claimed = new Set<string>();
  const clusters: ClusterMember[][] = [];
  for (const item of items) {
    if (claimed.has(item.pin.business.id)) continue;
    const cluster = [item];
    claimed.add(item.pin.business.id);
    for (const other of items) {
      if (claimed.has(other.pin.business.id)) continue;
      const dx = other.x - item.x;
      const dy = other.y - item.y;
      if (dx * dx + dy * dy < CLUSTER_THRESHOLD_PX * CLUSTER_THRESHOLD_PX) {
        cluster.push(other);
        claimed.add(other.pin.business.id);
      }
    }
    clusters.push(cluster);
  }

  for (const cluster of clusters) {
    if (cluster.length === 1) {
      renderBusinessMarker(cluster[0]!.pin);
      continue;
    }
    // Split cluster members by whether they have real reviews.
    const reviewed = cluster.filter((c) => c.pin.reviews.length > 0);
    const fallback = cluster.filter((c) => c.pin.reviews.length === 0);

    if (reviewed.length >= 2) {
      renderClusterMarker(reviewed);
    } else if (reviewed.length === 1) {
      renderBusinessMarker(reviewed[0]!.pin);
    }
    // Fallback (unreviewed) pins in a crowded area collapse to bare dots.
    // Text label returns once you zoom in enough that they aren't
    // overlapping any longer (the next scheduleCluster pass upgrades
    // them back to full pins).
    for (const m of fallback) renderDotOnly(m.pin);
  }
};

const renderDotOnly = (pin: BusinessPin) => {
  if (!map) return;
  const el = document.createElement("div");
  const dot = document.createElement("div");
  dot.className = "pin-dot";
  dot.title = pin.business.name;
  el.appendChild(dot);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    openDetail(pin.business.id, pin.business);
  });
  const marker = new Marker({ element: el, anchor: "center" })
    .setLngLat([pin.business.lng, pin.business.lat])
    .addTo(map);
  // Store as both emoji + text so clearMarkers cleans it up uniformly.
  businessMarkers.set(pin.business.id, { emoji: marker, text: marker });
};

const renderClusterMarker = (cluster: ClusterMember[]) => {
  if (!map) return;

  const centroid: [number, number] = [
    cluster.reduce((s, c) => s + c.pin.business.lng, 0) / cluster.length,
    cluster.reduce((s, c) => s + c.pin.business.lat, 0) / cluster.length,
  ];

  // Collect real-review tags (skip fallback POIs which have no tag yet).
  const tags = cluster
    .map((c) => c.pin.reviews[0]?.tag)
    .filter((t): t is string => typeof t === "string");

  // Hottest member drives color/accent, but the emoji reflects the
  // aggregate sentiment across every review in the cluster so the
  // face matches the crowd's overall vibe, not a single reviewer's.
  const scored = cluster
    .map((c) => c.pin)
    .filter((p) => p.reviews.length > 0)
    .map((p) => ({
      pin: p,
      score: p.reviews.length + (p.reviews[0]?.legit ?? 0) / 2,
    }))
    .sort((a, b) => b.score - a.score);
  const hottest = scored[0]?.pin ?? cluster[0]!.pin;
  const hottestReview = hottest.reviews[0];
  const allReviews = cluster.flatMap((c) => c.pin.reviews);
  let cls: "yum" | "meh" | "yuck" | "fallback" = "fallback";
  let icon = "❔";
  if (allReviews.length > 0) {
    const avg = allReviews.reduce((s, r) => s + r.verdict, 0) / allReviews.length;
    const agg: Verdict = avg > 0.2 ? 1 : avg < -0.2 ? -1 : 0;
    cls = VERDICT_META[agg].cls;
    icon = VERDICT_META[agg].icon;
  }
  const accent = hottestReview ? interestColor(hottestReview.interest_id) : "#94a3b8";

  const cacheKey = tags.length > 0 ? [...tags].sort().join("|") : `fallback:${cluster.length}`;
  const cachedSynth = synthesisCache.get(cacheKey);
  const placeholder =
    tags.length === 0
      ? `${cluster.length} spots · be first`
      : tags[0] ?? `${cluster.length} spots`;
  const initialText = cachedSynth ?? placeholder;

  const openCluster = () => {
    if (!map) return;
    map.easeTo({
      center: centroid,
      zoom: Math.min((map.getZoom() ?? 12) + 2, 18),
      duration: 500,
    });
  };

  const emojiOuter = document.createElement("div");
  const emojiInner = document.createElement("div");
  emojiInner.className = `pin-emoji ${cls} superhot cluster`;
  emojiInner.textContent = icon;
  const badge = document.createElement("span");
  badge.className = "pin-cluster-badge";
  badge.textContent = `+${cluster.length - 1}`;
  emojiInner.appendChild(badge);
  emojiOuter.appendChild(emojiInner);
  emojiOuter.addEventListener("click", (e) => { e.stopPropagation(); openCluster(); });
  const emojiMarker = new Marker({ element: emojiOuter, anchor: "center" })
    .setLngLat(centroid)
    .addTo(map);

  const textOuter = document.createElement("div");
  const textInner = document.createElement("div");
  textInner.className = `pin-text ${cls} superhot cluster`;
  textInner.textContent = initialText;
  textInner.style.setProperty("--pin-accent", accent);
  textOuter.appendChild(textInner);
  textOuter.addEventListener("click", (e) => { e.stopPropagation(); openCluster(); });
  const textMarker = new Marker({ element: textOuter, anchor: "top", offset: [0, 22] })
    .setLngLat(centroid)
    .addTo(map);

  // Store under a synthetic id so the next clusterAndRender can clean it up.
  const clusterId = `cluster:${cacheKey.slice(0, 24)}:${cluster.length}`;
  businessMarkers.set(clusterId, { emoji: emojiMarker, text: textMarker });

  // Fetch a synthesized label if we don't have one cached yet.
  if (!cachedSynth && tags.length >= 2) {
    void fetch(api("/api/synthesize"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { synthesis?: string } | null) => {
        if (data?.synthesis) {
          synthesisCache.set(cacheKey, data.synthesis);
          if (textInner.isConnected) textInner.textContent = data.synthesis;
        }
      })
      .catch(() => { /* keep placeholder */ });
  }
};

// ---- data loaders ------------------------------------------------------
const loadInterests = async () => {
  const res = await fetch(api("/api/interests"));
  if (!res.ok) return;
  interests.value = await res.json();
};

const loadReviews = async () => {
  clearMarkers();
  activeSearchQuery.value = "";
  searchStatus.value = "";
  const q = new URLSearchParams();
  q.set("interest", activeInterest.value);
  if (mineOnly.value && user.value) q.set("user", user.value.id);
  if (city.value) q.set("city", city.value);
  try {
    const res = await fetch(api(`/api/reviews?${q.toString()}`));
    if (!res.ok) return;
    const reviews = (await res.json()) as Review[];
    for (const r of reviews) {
      const business: Business = {
        id: r.business_id, source: "osm", source_id: "",
        name: r.business_name, address: r.business_address,
        city: r.business_city, lat: r.lat, lng: r.lng, category: null,
      };
      upsertBusinessPin(business, r, false);
    }
  } catch (err) {
    console.error("failed to load reviews", err);
  }
};

// ---- search + intent routing ------------------------------------------
const runSearch = async (q: string) => {
  if (!q.trim()) return;
  searching.value = true;
  try {
    const res = await fetch(api("/api/search"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, city: city.value }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as SearchResponse;
    activeSearchQuery.value = q;

    if (data.intent === "named") {
      const list = data.named_list ?? (data.named ? [data.named] : []);
      if (list.length === 0) {
        searchStatus.value = `No match for "${q}"${city.value ? ` in ${city.value}` : ""}`;
        return;
      }
      if (list.length === 1) {
        // Single result → fly-to + auto-open the detail sheet.
        await upsertBusinessAndOpenDetail(list[0]!);
        searchStatus.value = `→ ${list[0]!.name}`;
        return;
      }
      // Multiple locations of the same name (chains like "Cousins Subs").
      // Render every pin, then auto-open the detail sheet for the "best"
      // one — the most-reviewed location, or the top hit if none have
      // reviews. Preserves the single-hit "sheet opens automatically"
      // feel while still showing all pins for chains.
      clearMarkers();
      await Promise.all(
        list.map((b) =>
          fetch(api("/api/businesses"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(b),
          }).catch(() => null),
        ),
      );
      let reviewedCount = 0;
      for (const b of list) {
        if (b.latest_review) {
          reviewedCount++;
          const synth: Review = {
            id: b.latest_review.id,
            user_id: "", business_id: b.id, interest_id: b.latest_review.interest_id,
            tag: b.latest_review.tag, verdict: b.latest_review.verdict,
            created_at: b.latest_review.created_at,
            lat: b.lat, lng: b.lng,
            business_name: b.name, business_address: b.address, business_city: b.city,
            display_name: b.latest_review.display_name ?? "",
            legit: 0, dispute: 0, protip: 0,
          };
          upsertBusinessPin(b, synth, false);
        } else {
          upsertBusinessPin(b, null, true);
        }
      }
      fitBoundsToBusinesses(list);

      // Pick the "best" one to auto-open: prefer any with reviews (highest
      // review_count wins), else fall back to the top Nominatim hit.
      const best = [...list].sort((a, b) => (b.review_count ?? 0) - (a.review_count ?? 0))[0]!;
      openDetail(best.id, best);

      const cityStr = city.value ? ` in ${city.value}` : "";
      const nameLabel = list[0]!.name;
      searchStatus.value = reviewedCount === 0
        ? `${list.length} ${nameLabel} locations${cityStr} · showing best match · close to browse others`
        : `${list.length} ${nameLabel} locations${cityStr} · ${reviewedCount} reviewed · close to browse others`;
      return;
    }

    if (data.intent === "craving") {
      const businesses = data.craving?.businesses ?? [];
      clearMarkers();
      let reviewedCount = 0;
      for (const b of businesses) {
        // Reviewed spots render in full color with the latest review tag;
        // unreviewed ones render greyed with a "be the first" style.
        if (b.latest_review) {
          reviewedCount++;
          const synth: Review = {
            id: b.latest_review.id,
            user_id: "", business_id: b.id, interest_id: b.latest_review.interest_id,
            tag: b.latest_review.tag, verdict: b.latest_review.verdict,
            created_at: b.latest_review.created_at,
            lat: b.lat, lng: b.lng,
            business_name: b.name, business_address: b.address, business_city: b.city,
            display_name: b.latest_review.display_name ?? "",
            legit: 0, dispute: 0, protip: 0,
          };
          upsertBusinessPin(b, synth, false);
        } else {
          upsertBusinessPin(b, null, true);
        }
      }
      if (businesses.length > 0) {
        fitBoundsToBusinesses(businesses);
        const cityStr = city.value ? ` in ${city.value}` : "";
        const n = businesses.length;
        searchStatus.value = reviewedCount === 0
          ? `${n} spot${n === 1 ? "" : "s"} for "${q}"${cityStr} · tap one to be the first`
          : `${n} spot${n === 1 ? "" : "s"} for "${q}"${cityStr} · ${reviewedCount} reviewed · tap any to view or add`;
      } else {
        searchStatus.value = `No results for "${q}"${city.value ? ` in ${city.value}` : ""}`;
      }
      return;
    }

    if (data.intent === "ambiguous") {
      disambig.value = {
        query: q,
        named: data.named ?? null,
        cravingCount: data.craving?.businesses?.length ?? 0,
      };
    }
  } catch (err) {
    console.error("search failed", err);
    searchStatus.value = "Search failed.";
  } finally {
    searching.value = false;
  }
};

const chooseDisambig = async (choice: "named" | "craving") => {
  if (!disambig.value) return;
  const d = disambig.value;
  disambig.value = null;
  if (choice === "named" && d.named) {
    await upsertBusinessAndOpenDetail(d.named);
    searchStatus.value = `→ ${d.named.name}`;
    activeSearchQuery.value = d.query;
    return;
  }
  // Fall back to craving: rerun with a hint by wrapping the search as craving.
  // Simplest: rerun the query — server will still route based on classifier.
  // For a stronger UX, we could add a `force_intent` parameter.
  await runSearch(d.query);
};

const fitBoundsToBusinesses = (list: { lat: number; lng: number }[]) => {
  if (!map || list.length === 0) return;
  if (list.length === 1) {
    map.easeTo({ center: [list[0]!.lng, list[0]!.lat], zoom: 16, duration: 800 });
    return;
  }
  // Some search paths may include a stray result outside the current city.
  // If the raw bounds span more than a metro-area distance, use the tight
  // subset around the densest cluster (median-based) so we don't fly out
  // to the whole USA.
  const METRO_DEGREE_SPAN = 1.2; // ≈130km — generous metro cutoff
  let lats = list.map((b) => b.lat).sort((a, z) => a - z);
  let lngs = list.map((b) => b.lng).sort((a, z) => a - z);
  const rawSpan = Math.max(lats.at(-1)! - lats[0]!, lngs.at(-1)! - lngs[0]!);
  if (rawSpan > METRO_DEGREE_SPAN) {
    // Trim outliers: use the middle 90% of points on each axis.
    const drop = Math.floor(list.length * 0.05);
    lats = lats.slice(drop, list.length - drop);
    lngs = lngs.slice(drop, list.length - drop);
  }
  const minLat = lats[0]!, maxLat = lats.at(-1)!;
  const minLng = lngs[0]!, maxLng = lngs.at(-1)!;
  map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 80, duration: 800, maxZoom: 15 });
};

const upsertBusinessAndOpenDetail = async (b: Business) => {
  // Ensure the business is in our DB so DetailSheet can load /api/businesses/:id.
  try {
    await fetch(api("/api/businesses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });
  } catch { /* upsert is idempotent on the server; ignore failures */ }
  upsertBusinessPin(b, null, false);
  if (map) map.easeTo({ center: [b.lng, b.lat], zoom: 17, duration: 800 });
  openDetail(b.id, b);
};

// ---- FAB flow ----------------------------------------------------------
const onFab = () => {
  if (!user.value) return;
  pickerPrefill.value = "";
  showPicker.value = true;
};

const onPickerCancel = () => { showPicker.value = false; };

const onPickerPick = async (b: Business) => {
  showPicker.value = false;
  // Save to DB first so review submit can reference it.
  try {
    await fetch(api("/api/businesses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });
  } catch (err) { console.error("business upsert failed", err); }
  pickerBusiness.value = b;
};

// ---- detail sheet flow -------------------------------------------------
// The sheet needs a full Business object so it can render headers even
// for spots not yet in our DB (fallback POIs). We look one up from the
// pin cache, fall back to the passed-in business, and set both refs.
const openDetail = (businessId: string, fallbackBusiness: Business | null) => {
  const cached = businessPins.get(businessId)?.business;
  detailFallback.value = cached ?? fallbackBusiness ?? null;
  detailBusinessId.value = businessId;
};
const closeDetail = () => {
  detailBusinessId.value = null;
  detailFallback.value = null;
};

const onDetailWriteReview = (b: Business) => {
  detailBusinessId.value = null;
  pickerBusiness.value = b;
};

// ---- review submit -----------------------------------------------------
const submitReview = async ({
  tag, verdict, interest_id,
}: { tag: string; verdict: Verdict; interest_id: string }) => {
  if (!pickerBusiness.value || !user.value) return;
  const business = pickerBusiness.value;
  try {
    // Upsert the business first — it may be a fallback pin from Overpass
    // or Nominatim that was never saved. POST /api/businesses is idempotent
    // (409-safe), so this is always cheap and never hurts.
    await fetch(api("/api/businesses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(business),
    }).catch((err) => console.warn("business upsert failed (non-fatal)", err));
    const res = await authFetch(user.value, "/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ business_id: business.id, tag, verdict, interest_id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      alert(`Could not post: ${err.error ?? res.statusText}`);
      return;
    }
    const review: Review = await res.json();
    // Always render the pin immediately so the user sees their post land,
    // even if we're in search mode or the interest filter is about to change.
    upsertBusinessPin(business, review, false);
    if (review.interest_id !== activeInterest.value) {
      activeInterest.value = review.interest_id; // watcher will reload; pin re-materializes with fresh data
    }
    // Recenter the map on the business so the pin lands in view.
    if (map) map.easeTo({ center: [business.lng, business.lat], zoom: 15, duration: 700 });
  } catch (err) {
    console.error(err);
    alert("Network error.");
  } finally {
    pickerBusiness.value = null;
  }
};

// ---- login -------------------------------------------------------------
const onLoginSubmit = async (name: string) => {
  try {
    user.value = await registerUser(name);
  } catch (err) {
    console.error(err);
    alert("Could not register — is the server up?");
  }
};

// ---- city --------------------------------------------------------------
const setCity = (c: string) => {
  city.value = c;
  localStorage.setItem("grubmaps.city.v1", c);
  if (activeSearchQuery.value) {
    void runSearch(activeSearchQuery.value);
  } else {
    void loadReviews();
  }
};

const detectCity = async () => {
  if (city.value) return; // already set (localStorage)
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const res = await fetch(
          `/api/city/reverse?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`,
        );
        if (!res.ok) return;
        const info = (await res.json()) as CityInfo;
        if (info.city) {
          city.value = info.city;
          localStorage.setItem("grubmaps.city.v1", info.city);
          cityCenter.value = [info.lng, info.lat];
          if (map) map.easeTo({ center: [info.lng, info.lat], zoom: 12, duration: 600 });
          void loadReviews();
        }
      } catch (err) { console.error("city reverse-geocode failed", err); }
    },
    (err) => { console.log("geolocation denied/unavailable:", err.message); },
    { timeout: 8000, maximumAge: 24 * 60 * 60 * 1000 },
  );
};

// ---- interest / mine changes ------------------------------------------
watch(activeInterest, (id) => {
  localStorage.setItem("grubmaps.activeInterest.v1", id);
  if (!activeSearchQuery.value) void loadReviews();
});
watch(mineOnly, (v) => {
  localStorage.setItem("grubmaps.mineOnly.v1", v ? "1" : "0");
  if (!activeSearchQuery.value) void loadReviews();
});

// ---- map cleanup pass --------------------------------------------------
const MAJOR_ROAD_RE = /motorway|trunk|primary|secondary/i;
const MINOR_ROAD_OPACITY: ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"],
  14, 0, 15, 0.15, 17, 0.55, 19, 1.0,
];

const applyStyleCleanup = () => {
  if (!map) return;
  const style = map.getStyle();
  for (const layer of style.layers) {
    const src = (layer as { "source-layer"?: string })["source-layer"];
    const id = layer.id.toLowerCase();
    if (layer.type === "symbol") {
      const isRoadLabel =
        src === "transportation_name" ||
        id.includes("road") || id.includes("street") || id.includes("highway");
      if (isRoadLabel) {
        map.setFilter(layer.id, [
          "in", ["get", "class"],
          ["literal", ["motorway", "trunk", "primary", "secondary"]],
        ]);
      } else {
        map.removeLayer(layer.id);
      }
      continue;
    }
    if (layer.type !== "line") continue;
    const isRoadLine =
      src === "transportation" || id.includes("road") || id.includes("bridge") || id.includes("tunnel");
    if (!isRoadLine) continue;
    if (MAJOR_ROAD_RE.test(id)) continue;
    map.setPaintProperty(layer.id, "line-opacity", MINOR_ROAD_OPACITY);
  }
};

// ---- map init ----------------------------------------------------------
onMounted(async () => {
  await loadInterests();
  // If we already have a stored user, verify the server still knows them
  // (guards against DB resets that stranded the localStorage id).
  if (user.value) {
    try { user.value = await ensureUser(user.value); } catch (err) { console.warn("ensureUser failed", err); }
  }
  if (!mapEl.value) return;
  map = new MLMap({
    container: mapEl.value,
    style: "https://tiles.openfreemap.org/styles/positron",
    center: MILWAUKEE,
    zoom: 12,
    attributionControl: false,               // we add our own below, positioned bottom-left
  });
  map.addControl(new AttributionControl({ compact: true }), "bottom-left");
  // Re-cluster whenever the visible pixel projection changes.
  map.on("zoomend", scheduleCluster);
  map.on("moveend", scheduleCluster);
  map.on("load", () => {
    if (!map) return;
    applyStyleCleanup();
    void loadReviews();
    void detectCity();
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  const canvas = map.getCanvas();
  canvas.style.cursor = "grab";
  // Map is browse-only. No click handler on the canvas.
});

const onKeydown = (e: KeyboardEvent) => {
  if (e.key !== "Escape") return;
  if (pickerBusiness.value) pickerBusiness.value = null;
  else if (showPicker.value) showPicker.value = false;
  else if (detailBusinessId.value) closeDetail();
  else if (disambig.value) disambig.value = null;
};
onMounted(() => window.addEventListener("keydown", onKeydown));

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  clearMarkers();
  map?.remove();
  map = null;
});
</script>

<template>
  <header class="topbar">
    <Logo class="logo--topbar" />
    <SearchBar
      :city="city"
      :loading="searching"
      @submit="runSearch"
      @city-change="setCity"
      @clear="loadReviews"
    />
  </header>
  <InterestSwitcher
    v-if="interests.length > 0 && user"
    :interests="interests"
    :active="activeInterest"
    @update:active="activeInterest = $event"
  />
  <div v-if="searchStatus" class="hint">
    {{ searchStatus }}
  </div>
  <div class="map-frame">
    <div ref="mapEl" class="map"></div>
    <Logo class="logo--map-overlay" />
    <AudienceToggle v-if="user" :mine="mineOnly" @update:mine="mineOnly = $event" />
    <Fab v-if="user" @click="onFab" />
  </div>

  <LoginModal v-if="needsLogin" @submit="onLoginSubmit" />

  <BusinessPicker
    v-if="showPicker"
    :city="city"
    :prefill-query="pickerPrefill"
    @cancel="onPickerCancel"
    @pick="onPickerPick"
  />

  <PinModal
    v-if="pickerBusiness && user"
    :business="pickerBusiness"
    :interests="interests"
    :default-interest="activeInterest"
    @cancel="pickerBusiness = null"
    @submit="submitReview"
  />

  <DetailSheet
    v-if="detailBusinessId && detailFallback"
    :business="detailFallback"
    @close="closeDetail"
    @write-review="onDetailWriteReview"
  />

  <DisambigModal
    v-if="disambig"
    :query="disambig.query"
    :named-candidate="disambig.named"
    :craving-count="disambig.cravingCount"
    @choose="chooseDisambig"
    @cancel="disambig = null"
  />
</template>
