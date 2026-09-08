<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import type { Business, Review, Verdict } from "../types";

const props = defineProps<{
  businessId: string;
  isFallback?: boolean; // true when opened from a greyed place-provider pin
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

const business = ref<Business | null>(null);
const reviews = ref<Review[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

let abort: AbortController | null = null;

const load = async () => {
  loading.value = true;
  error.value = null;
  abort?.abort();
  abort = new AbortController();
  try {
    const res = await fetch(`/api/businesses/${encodeURIComponent(props.businessId)}`, { signal: abort.signal });
    if (res.status === 404) {
      // Fallback pin — not yet in our DB. We'll show the "be the first" state
      // with data passed via a different mechanism; for now render an empty state.
      business.value = null;
      reviews.value = [];
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      const data = (await res.json()) as { business: Business; reviews: Review[] };
      business.value = data.business;
      reviews.value = data.reviews;
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      error.value = String(err);
    }
  } finally {
    loading.value = false;
  }
};

watch(() => props.businessId, () => void load(), { immediate: true });
onBeforeUnmount(() => abort?.abort());

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};

const writeReview = () => {
  if (business.value) emit("write-review", business.value);
};
</script>

<template>
  <div class="sheet-backdrop" @click.self="emit('close')" @keydown="onKey" tabindex="-1">
    <aside class="sheet" role="dialog" aria-modal="true">
      <button class="sheet-close" @click="emit('close')" aria-label="Close">✕</button>

      <template v-if="loading && !business">
        <div class="sheet-body sheet-body--empty">Loading…</div>
      </template>
      <template v-else-if="error">
        <div class="sheet-body sheet-body--empty">Couldn't load — {{ error }}</div>
      </template>
      <template v-else-if="business">
        <div class="sheet-header">
          <h2 class="sheet-title">{{ business.name }}</h2>
          <div class="sheet-address" v-if="business.address">{{ business.address }}</div>
        </div>

        <div class="sheet-actions">
          <button class="menu-btn menu-btn--primary" @click="writeReview">
            {{ reviews.length === 0 ? "Be the first to review" : "Write another review" }}
          </button>
        </div>

        <div class="sheet-body">
          <h3 class="sheet-section-title">
            {{ reviews.length === 0 ? "No reviews yet" : `${reviews.length} review${reviews.length === 1 ? "" : "s"}` }}
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
            </li>
          </ul>
          <p v-else class="sheet-empty-hint">
            Been here? Drop the first take.
          </p>
        </div>
      </template>
      <template v-else>
        <!-- 404 → business not saved yet; caller should have called write-review instead -->
        <div class="sheet-body sheet-body--empty">
          Not yet in our list. Tap "Be the first to review" to add it.
        </div>
      </template>
    </aside>
  </div>
</template>
