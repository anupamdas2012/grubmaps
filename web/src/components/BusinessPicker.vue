<script setup lang="ts">
import { ref, onBeforeUnmount, onMounted, watch } from "vue";
import type { Business } from "../types";

const props = defineProps<{
  city: string | null;
  prefillQuery?: string;
}>();

const emit = defineEmits<{
  cancel: [];
  pick: [business: Business];
}>();

const query = ref(props.prefillQuery ?? "");
const results = ref<Business[]>([]);
const loading = ref(false);
const noMatches = ref(false);

let debounce: number | null = null;
let abort: AbortController | null = null;
const inputRef = ref<HTMLInputElement | null>(null);

const doSearch = async (q: string) => {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    results.value = [];
    noMatches.value = false;
    return;
  }
  abort?.abort();
  abort = new AbortController();
  loading.value = true;
  try {
    const url = new URL("/api/places/search", location.origin);
    url.searchParams.set("q", trimmed);
    if (props.city) url.searchParams.set("city", props.city);
    url.searchParams.set("limit", "8");
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as Business[];
    results.value = data;
    noMatches.value = data.length === 0;
  } catch (err) {
    if ((err as Error).name !== "AbortError") console.error("place search failed", err);
  } finally {
    loading.value = false;
  }
};

const onInput = () => {
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = window.setTimeout(() => doSearch(query.value), 300);
};

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("cancel");
};

onMounted(() => {
  inputRef.value?.focus();
  if (query.value.trim().length >= 2) void doSearch(query.value);
});
onBeforeUnmount(() => {
  abort?.abort();
  if (debounce !== null) window.clearTimeout(debounce);
});
watch(() => props.prefillQuery, (v) => {
  if (v && v.length >= 2 && v !== query.value) {
    query.value = v;
    void doSearch(v);
  }
});
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('cancel')" @keydown="onKey">
    <div class="menu-card menu-card--modal picker-card">
      <h2 class="menu-card-title">Pick your spot</h2>
      <div class="menu-card-rule"></div>

      <div class="picker-search-wrap">
        <input
          ref="inputRef"
          v-model="query"
          @input="onInput"
          @keydown.esc="emit('cancel')"
          type="text"
          class="menu-input"
          :placeholder="props.city ? `search in ${props.city}…` : 'restaurant, cafe, bar…'"
          autocomplete="off"
          spellcheck="false"
        />
        <span v-if="loading" class="picker-loading" aria-hidden="true">…</span>
      </div>

      <ul v-if="results.length > 0" class="picker-results">
        <li
          v-for="b in results"
          :key="b.id"
          class="picker-result"
          @click="emit('pick', b)"
        >
          <span class="picker-result-name">{{ b.name }}</span>
          <span class="picker-result-address">{{ b.address ?? b.display_name }}</span>
        </li>
      </ul>
      <div v-else-if="noMatches && !loading" class="picker-empty">
        No matches{{ props.city ? ` in ${props.city}` : "" }} — try a different name.
      </div>

      <div class="actions">
        <button class="menu-btn menu-btn--secondary" @click="emit('cancel')">Cancel</button>
      </div>
    </div>
  </div>
</template>
