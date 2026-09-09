<script setup lang="ts">
import { ref } from "vue";
import CityChip from "./CityChip.vue";

const props = defineProps<{
  city: string | null;
  loading?: boolean;
}>();

const emit = defineEmits<{
  submit: [q: string];
  "city-change": [city: string];
  clear: [];
}>();

const query = ref("");

const submit = () => {
  const q = query.value.trim();
  if (q.length === 0) return;
  emit("submit", q);
};

const clear = () => {
  query.value = "";
  emit("clear");
};
</script>

<template>
  <div class="search">
    <div class="search-input-wrap">
      <CityChip :city="props.city" @change="(c) => emit('city-change', c)" />
      <span class="search-divider" aria-hidden="true"></span>
      <input
        type="text"
        class="search-input"
        placeholder="craving something?"
        v-model="query"
        @keydown.enter.prevent="submit"
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
      <button
        v-if="query"
        class="search-submit"
        type="button"
        :disabled="props.loading"
        @click="submit"
      >
        {{ props.loading ? "…" : "→" }}
      </button>
    </div>
  </div>
</template>
