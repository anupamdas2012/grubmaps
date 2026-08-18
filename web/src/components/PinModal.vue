<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  lat: number;
  lng: number;
  placeName?: string | null;
  placeCategory?: string | null;
  placeAddress?: string | null;
}>();
const emit = defineEmits<{
  cancel: [];
  submit: [payload: { tag: string; rating: number }];
}>();

const tag = ref("");
const rating = ref(0);
const submitting = ref(false);

const canSubmit = () => tag.value.trim().length > 0 && rating.value >= 1;

const onSubmit = () => {
  if (!canSubmit() || submitting.value) return;
  submitting.value = true;
  emit("submit", { tag: tag.value.trim(), rating: rating.value });
};

const prettyCategory = (c?: string | null) =>
  c ? c.replace(/_/g, " ") : "";
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('cancel')">
    <div class="modal">
      <template v-if="props.placeName">
        <h2>{{ props.placeName }}</h2>
        <div class="coords">
          <span v-if="props.placeCategory">{{ prettyCategory(props.placeCategory) }}</span>
          <span v-if="props.placeAddress"> · {{ props.placeAddress }}</span>
        </div>
      </template>
      <template v-else>
        <h2>Rate this spot</h2>
        <div class="coords">{{ props.lat.toFixed(4) }}, {{ props.lng.toFixed(4) }}</div>
      </template>

      <label for="tag">Your take</label>
      <input
        id="tag"
        v-model="tag"
        type="text"
        maxlength="80"
        placeholder="e.g. best tacos, cheap eats, hidden gem"
        autocomplete="off"
        autocapitalize="sentences"
        autofocus
        @keydown.enter.prevent="onSubmit"
      />

      <label>Rating</label>
      <div class="stars">
        <button
          v-for="n in 5"
          :key="n"
          type="button"
          class="star"
          :class="{ active: n <= rating }"
          @click="rating = n"
          :aria-label="`${n} star${n === 1 ? '' : 's'}`"
        >★</button>
      </div>

      <div class="actions">
        <button class="btn btn-secondary" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary" :disabled="!canSubmit() || submitting" @click="onSubmit">
          {{ submitting ? "Saving…" : "Drop pin" }}
        </button>
      </div>
    </div>
  </div>
</template>
