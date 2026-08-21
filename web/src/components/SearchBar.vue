<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";

type NominatimResult = {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
};

const emit = defineEmits<{
  select: [{ lat: number; lng: number; name: string }];
}>();

// Milwaukee metro viewbox (Nominatim wants minLon,minLat,maxLon,maxLat).
const MILWAUKEE_VIEWBOX = "-88.1,42.9,-87.85,43.2";

const query = ref("");
const results = ref<NominatimResult[]>([]);
const open = ref(false);
const loading = ref(false);
const noMatches = ref(false);

let debounceTimer: number | null = null;
let abortCtrl: AbortController | null = null;

const primaryName = (displayName: string) => displayName.split(",")[0]!.trim();
const restAddress = (displayName: string) =>
  displayName.split(",").slice(1).join(",").trim();

const doSearch = async (q: string) => {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    results.value = [];
    noMatches.value = false;
    open.value = false;
    return;
  }
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  loading.value = true;
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", trimmed);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "6");
    url.searchParams.set("viewbox", MILWAUKEE_VIEWBOX);
    url.searchParams.set("bounded", "1");
    url.searchParams.set("addressdetails", "1");
    const res = await fetch(url, {
      signal: abortCtrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as NominatimResult[];
    results.value = data;
    noMatches.value = data.length === 0;
    open.value = true;
  } catch (err) {
    if ((err as Error).name !== "AbortError") console.error("search failed", err);
  } finally {
    loading.value = false;
  }
};

const onInput = () => {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => doSearch(query.value), 300);
};

const pick = (r: NominatimResult) => {
  emit("select", {
    lat: Number(r.lat),
    lng: Number(r.lon),
    name: primaryName(r.display_name),
  });
  clear();
};

const clear = () => {
  query.value = "";
  results.value = [];
  noMatches.value = false;
  open.value = false;
};

const onFocus = () => {
  if (results.value.length > 0) open.value = true;
};
const onBlur = () => {
  // Delay so click on result fires before dropdown closes.
  window.setTimeout(() => (open.value = false), 150);
};

onBeforeUnmount(() => {
  abortCtrl?.abort();
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="search">
    <div class="search-input-wrap">
      <span class="search-icon" aria-hidden="true">🔍</span>
      <input
        type="text"
        class="search-input"
        placeholder="find a spot — e.g. discourse coffee"
        v-model="query"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        autocomplete="off"
        spellcheck="false"
      />
      <button
        v-if="query"
        class="search-clear"
        type="button"
        aria-label="Clear"
        @click="clear"
      >
        ✕
      </button>
    </div>
    <ul v-if="open && results.length > 0" class="search-results">
      <li
        v-for="r in results"
        :key="r.place_id"
        class="search-result"
        @mousedown.prevent="pick(r)"
      >
        <span class="result-name">{{ primaryName(r.display_name) }}</span>
        <span class="result-address">{{ restAddress(r.display_name) }}</span>
      </li>
    </ul>
    <div v-else-if="open && noMatches && !loading" class="search-empty">
      No matches in Milwaukee
    </div>
  </div>
</template>
