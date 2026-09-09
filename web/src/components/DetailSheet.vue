<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from "vue";
import type { Business, Review, Verdict } from "../types";

const props = defineProps<{
  // Passed by App.vue whenever a pin is tapped — contains everything we
  // need to render the sheet header immediately, even for spots not yet
  // saved in our DB (Overpass/Nominatim fallback POIs).
  business: Business;
}>();

const emit = defineEmits<{
  close: [];
  "write-review": [business: Business];
}>();

const VERDICT_META: Record<Verdict, { cls: "yum" | "meh" | "yuck"; icon: string; label: string }> = {
  1: { cls: "yum", icon: "😋", label: "Yum" },
  0: { cls: "meh", icon: "🫤", label: "Meh" },
  [-1]: { cls: "yuck", icon: "💩", label: "Yuck" },
};

const reviews = ref<Review[]>([]);
const loading = ref(false);
const notInDb = ref(false);
const error = ref<string | null>(null);
let abort: AbortController | null = null;

// Local record of which reviews the current browser has "Good called".
// Same pattern the old reaction fan used — server tracks by ip_hash, we
// remember the click locally so the button stays filled on reload.
const MY_KEY = "crave.myGoodCalls.v1";
const myGoodCalls = ref<Set<number>>(new Set());
const loadMyGoodCalls = () => {
  try {
    const raw = localStorage.getItem(MY_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) myGoodCalls.value = new Set(arr.filter((n) => typeof n === "number"));
  } catch { /* ignore */ }
};
const saveMyGoodCalls = () => {
  try { localStorage.setItem(MY_KEY, JSON.stringify([...myGoodCalls.value])); } catch { /* ignore */ }
};
loadMyGoodCalls();

// Sheet header renders from props.business immediately; the fetch below
// only fills in the reviews list. A 404 just means "no reviews yet" —
// still show the header + "Be the first to review" CTA.
const load = async () => {
  loading.value = true;
  error.value = null;
  notInDb.value = false;
  reviews.value = [];
  abort?.abort();
  abort = new AbortController();
  try {
    const res = await fetch(
      `/api/businesses/${encodeURIComponent(props.business.id)}`,
      { signal: abort.signal },
    );
    if (res.status === 404) {
      notInDb.value = true;
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      const data = (await res.json()) as { business: Business; reviews: Review[] };
      reviews.value = data.reviews;
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") error.value = String(err);
  } finally {
    loading.value = false;
  }
};

watch(() => props.business.id, () => void load(), { immediate: true });
onBeforeUnmount(() => abort?.abort());

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};

const writeReview = () => emit("write-review", props.business);

// Optimistic toggle of the "Good call" (legit) reaction on a review.
// Server is the source of truth for the count; we snap-back on failure.
const toggleGoodCall = async (review: Review) => {
  const marked = myGoodCalls.value.has(review.id);
  const snapshot = review.legit;
  if (marked) {
    myGoodCalls.value.delete(review.id);
    review.legit = Math.max(0, review.legit - 1);
  } else {
    myGoodCalls.value.add(review.id);
    review.legit++;
  }
  saveMyGoodCalls();
  try {
    const res = await fetch(`/api/reviews/${review.id}/reactions`, {
      method: marked ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "legit" }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { reactions: { legit: number; dispute: number; protip: number } };
    review.legit = data.reactions.legit;
    review.dispute = data.reactions.dispute;
    review.protip = data.reactions.protip;
  } catch (err) {
    // Snap back on failure.
    if (marked) myGoodCalls.value.add(review.id);
    else myGoodCalls.value.delete(review.id);
    review.legit = snapshot;
    saveMyGoodCalls();
    console.error("Good-call toggle failed", err);
  }
};

const ctaLabel = computed(() =>
  reviews.value.length === 0 ? "Be the first to review" : "Write another review",
);
const reviewsHeading = computed(() =>
  reviews.value.length === 0
    ? "No reviews yet"
    : `${reviews.value.length} review${reviews.value.length === 1 ? "" : "s"}`,
);
</script>

<template>
  <div class="sheet-backdrop" @click.self="emit('close')" @keydown="onKey" tabindex="-1">
    <aside class="sheet" role="dialog" aria-modal="true">
      <button class="sheet-close" @click="emit('close')" aria-label="Close">✕</button>

      <div class="sheet-header">
        <h2 class="sheet-title">{{ props.business.name }}</h2>
        <div class="sheet-address" v-if="props.business.address">{{ props.business.address }}</div>
      </div>

      <div class="sheet-actions">
        <button class="menu-btn menu-btn--primary" @click="writeReview">
          {{ ctaLabel }}
        </button>
      </div>

      <div class="sheet-body">
        <template v-if="error">
          <div class="sheet-body--empty">Couldn't load reviews — {{ error }}</div>
        </template>
        <template v-else>
          <h3 class="sheet-section-title">
            {{ loading && reviews.length === 0 ? "Loading…" : reviewsHeading }}
          </h3>
          <ul v-if="reviews.length > 0" class="sheet-reviews">
            <li v-for="r in reviews" :key="r.id" class="sheet-review">
              <div class="sheet-review-head">
                <span class="sheet-review-verdict" :class="VERDICT_META[r.verdict].cls">
                  {{ VERDICT_META[r.verdict].icon }} {{ VERDICT_META[r.verdict].label }}
                </span>
                <span class="sheet-review-author">{{ r.display_name }}</span>
              </div>
              <div class="sheet-review-tag">"{{ r.tag }}"</div>
              <div class="sheet-review-actions">
                <button
                  type="button"
                  class="good-call"
                  :class="{ marked: myGoodCalls.has(r.id) }"
                  :aria-pressed="myGoodCalls.has(r.id)"
                  @click="toggleGoodCall(r)"
                >
                  <span class="good-call-icon" aria-hidden="true">👍</span>
                  <span class="good-call-label">
                    {{ myGoodCalls.has(r.id) ? "Good call" : "Good call?" }}
                  </span>
                  <span v-if="r.legit > 0" class="good-call-count">{{ r.legit }}</span>
                </button>
              </div>
            </li>
          </ul>
          <p v-else-if="!loading" class="sheet-empty-hint">
            {{ notInDb ? "Nobody's weighed in here yet. Be the pioneer." : "Been here? Drop the first take." }}
          </p>
        </template>
      </div>
    </aside>
  </div>
</template>
