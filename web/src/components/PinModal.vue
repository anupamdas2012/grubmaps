<script setup lang="ts">
import { computed, ref } from "vue";
import type { Business, Interest, Verdict } from "../types";

const props = defineProps<{
  business: Business;
  interests: Interest[];
  defaultInterest: string;
}>();

const emit = defineEmits<{
  cancel: [];
  submit: [payload: { tag: string; verdict: Verdict; interest_id: string }];
}>();

const MIN_WORDS = 1;
const MAX_WORDS = 8;
const MAX_CHARS = 60;

const tag = ref("");
const verdict = ref<Verdict | null>(null);
const interestId = ref<string>(props.defaultInterest);
const submitting = ref(false);

const trimmed = computed(() => tag.value.trim());
const words = computed(() =>
  trimmed.value.length === 0 ? 0 : trimmed.value.split(/\s+/).filter(Boolean).length,
);
const wordCountOk = computed(() => words.value >= MIN_WORDS && words.value <= MAX_WORDS);
const charCountOk = computed(() => trimmed.value.length <= MAX_CHARS);
const canSubmit = computed(
  () =>
    wordCountOk.value &&
    charCountOk.value &&
    verdict.value !== null &&
    interestId.value.length > 0,
);

const counterClass = computed(() => {
  if (words.value === 0) return "neutral";
  if (!wordCountOk.value || !charCountOk.value) return "bad";
  return "good";
});

const onSubmit = () => {
  if (!canSubmit.value || submitting.value || verdict.value === null) return;
  submitting.value = true;
  emit("submit", {
    tag: trimmed.value,
    verdict: verdict.value,
    interest_id: interestId.value,
  });
};
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('cancel')">
    <div class="menu-card menu-card--modal">
      <div class="menu-card-eyebrow">a review for</div>
      <h2 class="menu-card-title">{{ props.business.name }}</h2>
      <div v-if="props.business.address" class="menu-card-sub">{{ props.business.address }}</div>
      <div class="menu-card-rule"></div>

      <label class="menu-card-label">Category</label>
      <div class="interest-picker">
        <button
          v-for="i in props.interests"
          :key="i.id"
          type="button"
          class="interest-pick"
          :class="{ active: interestId === i.id }"
          :style="{ '--chip-accent': i.color }"
          @click="interestId = i.id"
        >
          <span class="interest-chip-emoji">{{ i.emoji }}</span>
          <span class="interest-chip-name">{{ i.name }}</span>
        </button>
      </div>

      <label class="menu-card-label">Verdict</label>
      <div class="verdict-picker">
        <button
          type="button"
          class="verdict-btn yum"
          :class="{ active: verdict === 1 }"
          @click="verdict = 1"
        >
          <span class="verdict-icon">😋</span>
          <span class="verdict-label">Yum</span>
        </button>
        <button
          type="button"
          class="verdict-btn meh"
          :class="{ active: verdict === 0 }"
          @click="verdict = 0"
        >
          <span class="verdict-icon">🫤</span>
          <span class="verdict-label">Meh</span>
        </button>
        <button
          type="button"
          class="verdict-btn yuck"
          :class="{ active: verdict === -1 }"
          @click="verdict = -1"
        >
          <span class="verdict-icon">💩</span>
          <span class="verdict-label">Yuck</span>
        </button>
      </div>

      <label for="tag" class="menu-card-label">
        Your take · {{ MIN_WORDS }}–{{ MAX_WORDS }} words
      </label>
      <input
        id="tag"
        v-model="tag"
        type="text"
        :maxlength="MAX_CHARS + 20"
        placeholder="e.g. best carne asada tacos"
        autocomplete="off"
        autocapitalize="sentences"
        autofocus
        @keydown.enter.prevent="onSubmit"
        class="menu-input"
      />
      <div class="counter" :class="counterClass">
        {{ words }} / {{ MAX_WORDS }} words
        <span v-if="!charCountOk"> · too long</span>
      </div>

      <div class="actions">
        <button class="menu-btn menu-btn--secondary" @click="emit('cancel')">Cancel</button>
        <button
          class="menu-btn menu-btn--primary"
          :disabled="!canSubmit || submitting"
          @click="onSubmit"
        >
          {{ submitting ? "…" : "Post it" }}
        </button>
      </div>
    </div>
  </div>
</template>
