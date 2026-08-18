<script setup lang="ts">
import { computed, ref } from "vue";

type Verdict = 1 | 0 | -1;

const props = defineProps<{ lat: number; lng: number }>();
const emit = defineEmits<{
  cancel: [];
  submit: [payload: { tag: string; verdict: Verdict }];
}>();

const MIN_WORDS = 1;
const MAX_WORDS = 8;
const MAX_CHARS = 60;

const tag = ref("");
const verdict = ref<Verdict | null>(null);
const submitting = ref(false);

const trimmed = computed(() => tag.value.trim());
const words = computed(() =>
  trimmed.value.length === 0 ? 0 : trimmed.value.split(/\s+/).filter(Boolean).length,
);
const wordCountOk = computed(() => words.value >= MIN_WORDS && words.value <= MAX_WORDS);
const charCountOk = computed(() => trimmed.value.length <= MAX_CHARS);
const canSubmit = computed(
  () => wordCountOk.value && charCountOk.value && verdict.value !== null,
);

const counterClass = computed(() => {
  if (words.value === 0) return "neutral";
  if (!wordCountOk.value || !charCountOk.value) return "bad";
  return "good";
});

const onSubmit = () => {
  if (!canSubmit.value || submitting.value || verdict.value === null) return;
  submitting.value = true;
  emit("submit", { tag: trimmed.value, verdict: verdict.value });
};
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('cancel')">
    <div class="modal">
      <h2>What's the verdict?</h2>
      <div class="coords">{{ props.lat.toFixed(4) }}, {{ props.lng.toFixed(4) }}</div>

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
          <span class="verdict-icon">😐</span>
          <span class="verdict-label">Meh</span>
        </button>
        <button
          type="button"
          class="verdict-btn yuck"
          :class="{ active: verdict === -1 }"
          @click="verdict = -1"
        >
          <span class="verdict-icon">🤢</span>
          <span class="verdict-label">Yuck</span>
        </button>
      </div>

      <label for="tag">In {{ MIN_WORDS }}–{{ MAX_WORDS }} words, be brutally specific</label>
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
      />
      <div class="counter" :class="counterClass">
        {{ words }} / {{ MAX_WORDS }} words
        <span v-if="!charCountOk"> · too long</span>
      </div>

      <div class="actions">
        <button class="btn btn-secondary" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary" :disabled="!canSubmit || submitting" @click="onSubmit">
          {{ submitting ? "Posting…" : "Post it" }}
        </button>
      </div>
    </div>
  </div>
</template>
