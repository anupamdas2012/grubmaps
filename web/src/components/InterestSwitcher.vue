<script setup lang="ts">
import { ref } from "vue";
import type { Interest } from "../types";

const props = defineProps<{
  interests: Interest[];
  active: string;
}>();

const emit = defineEmits<{
  "update:active": [id: string];
}>();

// If an icon PNG fails to load we fall back to the Unicode emoji.
const imgFailed = ref<Record<string, boolean>>({});
const iconSrc = (id: string) => `/food-icons/${id}.png`;
const onImgError = (id: string) => { imgFailed.value[id] = true; };
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
      <span class="ilink-icon" aria-hidden="true">
        <img
          v-if="!imgFailed[i.id]"
          :src="iconSrc(i.id)"
          :alt="i.name"
          class="ilink-img"
          loading="eager"
          decoding="async"
          @error="onImgError(i.id)"
        />
        <span v-else class="ilink-emoji">{{ i.emoji }}</span>
      </span>
      <span class="ilink-name">{{ i.name }}</span>
    </button>
  </nav>
</template>
