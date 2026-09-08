<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  city: string | null;
}>();

const emit = defineEmits<{
  change: [city: string];
}>();

const editing = ref(false);
const draft = ref("");

const openEdit = () => {
  draft.value = props.city ?? "";
  editing.value = true;
};

const commit = () => {
  const c = draft.value.trim();
  if (c.length > 0) emit("change", c);
  editing.value = false;
};
</script>

<template>
  <button
    v-if="!editing"
    type="button"
    class="city-chip"
    :title="props.city ?? 'Set your city'"
    @click="openEdit"
  >
    <span class="city-chip-pin" aria-hidden="true">📍</span>
    <span class="city-chip-name">{{ props.city ?? "set city" }}</span>
    <span class="city-chip-caret" aria-hidden="true">▾</span>
  </button>
  <div v-else class="city-chip-edit">
    <input
      v-model="draft"
      class="city-chip-input"
      placeholder="City name"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter="commit"
      @keydown.escape="editing = false"
      @blur="commit"
      autofocus
    />
  </div>
</template>
