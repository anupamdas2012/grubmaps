<script setup lang="ts">
import type { Interest } from "../types";

const props = defineProps<{
  interests: Interest[];
  active: string;
  mine: boolean;
  userName: string;
}>();

const emit = defineEmits<{
  "update:active": [id: string];
  "update:mine": [value: boolean];
}>();
</script>

<template>
  <nav class="interest-nav" aria-label="Categories">
    <button
      v-for="i in props.interests"
      :key="i.id"
      type="button"
      class="ilink"
      :class="{ active: props.active === i.id }"
      :style="{ '--chip-color': i.color }"
      @click="emit('update:active', i.id)"
      :aria-pressed="props.active === i.id"
    >
      <span class="ilink-emoji" aria-hidden="true">{{ i.emoji }}</span>
      <span class="ilink-name">{{ i.name }}</span>
    </button>
    <button
      type="button"
      class="ilink ilink--mine"
      :class="{ active: props.mine }"
      @click="emit('update:mine', !props.mine)"
      :title="props.mine ? 'Showing only your pins' : 'Showing everyone\'s pins'"
    >
      <span class="ilink-name">{{ props.mine ? "my tour" : "everyone" }}</span>
    </button>
  </nav>
</template>
