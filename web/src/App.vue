<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from "vue";
import { Map as MLMap, Marker, NavigationControl, type ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import PinModal from "./components/PinModal.vue";
import LoginModal from "./components/LoginModal.vue";
import Logo from "./components/Logo.vue";
import SearchBar from "./components/SearchBar.vue";
import InterestSwitcher from "./components/InterestSwitcher.vue";
import Fab from "./components/Fab.vue";
import BusinessPicker from "./components/BusinessPicker.vue";
import DetailSheet from "./components/DetailSheet.vue";
import DisambigModal from "./components/DisambigModal.vue";
import { authFetch, loadUser, registerUser, type User } from "./user";
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

const activeInterestMeta = computed(
  () => interests.value.find((i) => i.id === activeInterest.value) ?? null,
);

// ---- rendering ---------------------------------------------------------
const seededUnit = (id: number, salt: number) => {
  const s = Math.sin(id * 9301.7 + salt) * 43758.5453;
  return s - Math.floor(s);
};
const seededRotation = (id: number) => (seededUnit(id, 49297.3) - 0.5) * 12;
const seededYumDelay = (id: number) => seededUnit(id, 71723.5) * 7;

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
    const meta = VERDICT_META[latest.verdict];
    icon = meta.icon;
    cls = meta.cls;
    tag = latest.tag;
    accent = interestColor(latest.interest_id);
  }

  const emojiOuter = document.createElement("div");
  const emojiInner = document.createElement("div");
  emojiInner.className = `pin-emoji ${cls}`;
  emojiInner.textContent = icon;
  if (cls === "yum") emojiInner.style.animationDelay = `${seededYumDelay(seed).toFixed(2)}s`;
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
  textInner.className = `pin-text ${cls}`;
  textInner.textContent = tag;
  textInner.style.setProperty("--pin-accent", accent);
  if (cls === "yum") textInner.style.animationDelay = `${seededYumDelay(seed).toFixed(2)}s`;
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
  const pin = businessPins.get(business.id)!;
  renderBusinessMarker(pin);
};

// ---- data loaders ------------------------------------------------------
const loadInterests = async () => {
  const res = await fetch("/api/interests");
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
    const res = await fetch(`/api/reviews?${q.toString()}`);
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
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, city: city.value }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as SearchResponse;
    activeSearchQuery.value = q;

    if (data.intent === "named" && data.named) {
      // Fly to and open detail. Ensure the business exists in our DB.
      await upsertBusinessAndOpenDetail(data.named);
      searchStatus.value = `→ ${data.named.name}`;
      return;
    }

    if (data.intent === "craving") {
      const businesses = data.craving?.businesses ?? [];
      clearMarkers();
      for (const b of businesses) {
        // Hydrate the pin with the business's latest review so it renders
        // with the real verdict/tag/color instead of the fallback "❔" style.
        const synthReview = b.latest_review
          ? {
              id: b.latest_review.id,
              user_id: "", business_id: b.id, interest_id: b.latest_review.interest_id,
              tag: b.latest_review.tag, verdict: b.latest_review.verdict,
              created_at: b.latest_review.created_at,
              lat: b.lat, lng: b.lng,
              business_name: b.name, business_address: b.address, business_city: b.city,
              display_name: b.latest_review.display_name ?? "",
              legit: 0, dispute: 0, protip: 0,
            } as Review
          : null;
        upsertBusinessPin(b, synthReview, false);
      }
      if (businesses.length > 0) {
        fitBoundsToBusinesses(businesses);
        searchStatus.value = `${businesses.length} spot${businesses.length === 1 ? "" : "s"} for "${q}"${city.value ? ` in ${city.value}` : ""}`;
      } else if (data.fallback?.pois && data.fallback.pois.length > 0) {
        for (const p of data.fallback.pois) upsertBusinessPin(p, null, true);
        fitBoundsToBusinesses(data.fallback.pois);
        searchStatus.value = `No reviews yet for "${q}" — ${data.fallback.pois.length} candidate${data.fallback.pois.length === 1 ? "" : "s"} · be the first`;
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
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const b of list) {
    if (b.lat < minLat) minLat = b.lat;
    if (b.lat > maxLat) maxLat = b.lat;
    if (b.lng < minLng) minLng = b.lng;
    if (b.lng > maxLng) maxLng = b.lng;
  }
  map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 80, duration: 800, maxZoom: 15 });
};

const upsertBusinessAndOpenDetail = async (b: Business) => {
  // Ensure the business is in our DB so DetailSheet can load /api/businesses/:id.
  try {
    await fetch("/api/businesses", {
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
    await fetch("/api/businesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });
  } catch (err) { console.error("business upsert failed", err); }
  pickerBusiness.value = b;
};

// ---- detail sheet flow -------------------------------------------------
const openDetail = (businessId: string, fallbackBusiness: Business | null) => {
  detailFallback.value = fallbackBusiness;
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
    if (review.interest_id !== activeInterest.value) {
      activeInterest.value = review.interest_id; // watcher will reload
    } else {
      upsertBusinessPin(business, review, false);
    }
    // Recenter the map on the business so the user sees their new pin.
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
  if (!mapEl.value) return;
  map = new MLMap({
    container: mapEl.value,
    style: "https://tiles.openfreemap.org/styles/positron",
    center: MILWAUKEE,
    zoom: 12,
  });
  map.on("load", () => {
    if (!map) return;
    applyStyleCleanup();
    void loadReviews();
    void detectCity();
  });
  map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
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
    <Logo />
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
    :mine="mineOnly"
    :user-name="user.displayName"
    @update:active="activeInterest = $event"
    @update:mine="mineOnly = $event"
  />
  <div class="hint">
    <template v-if="searchStatus">{{ searchStatus }}</template>
    <template v-else-if="user && activeInterestMeta">
      {{ mineOnly ? "your tour ·" : "everyone's" }}
      {{ activeInterestMeta.emoji }} {{ activeInterestMeta.name.toLowerCase() }}
      · tap "+" to review a spot
    </template>
    <template v-else>Sign in to review · tap a pin to see what people think</template>
  </div>
  <div class="map-frame">
    <div ref="mapEl" class="map"></div>
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
    v-if="detailBusinessId"
    :business-id="detailBusinessId"
    :is-fallback="!!detailFallback"
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
