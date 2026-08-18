<script setup lang="ts">
import { ref, computed } from "vue";
import { CUISINES, type Cuisine } from "../cuisine";

const props = defineProps<{ active: Set<Cuisine> }>();
const emit = defineEmits<{ "update:active": [value: Set<Cuisine>] }>();

const collapsed = ref(false);

const isActive = (c: Cuisine) => props.active.has(c);
const anyActive = computed(() => props.active.size > 0);
const allActive = computed(() => props.active.size === CUISINES.length);

const toggle = (c: Cuisine) => {
  const next = new Set(props.active);
  if (next.has(c)) next.delete(c);
  else next.add(c);
  emit("update:active", next);
};
const selectAll = () => emit("update:active", new Set(CUISINES.map((c) => c.cuisine)));
const selectNone = () => emit("update:active", new Set());
</script>

<template>
  <div class="legend" :class="{ collapsed }">
    <button class="legend-toggle" @click="collapsed = !collapsed" :aria-expanded="!collapsed">
      <span class="legend-title">Cuisine</span>
      <span class="legend-caret">{{ collapsed ? "▸" : "▾" }}</span>
    </button>
    <div v-if="!collapsed">
      <ul class="legend-list">
        <li
          v-for="c in CUISINES"
          :key="c.cuisine"
          class="legend-row"
          :class="{ inactive: !isActive(c.cuisine) }"
          role="checkbox"
          :aria-checked="isActive(c.cuisine)"
          tabindex="0"
          @click="toggle(c.cuisine)"
          @keydown.enter.prevent="toggle(c.cuisine)"
          @keydown.space.prevent="toggle(c.cuisine)"
        >
          <span class="legend-dot" :style="{ background: c.color }"></span>
          <span class="legend-emoji">{{ c.emoji }}</span>
          <span class="legend-label">{{ c.label }}</span>
          <span class="legend-check">{{ isActive(c.cuisine) ? "✓" : "" }}</span>
        </li>
      </ul>
      <div class="legend-quick">
        <button type="button" @click="selectAll" :disabled="allActive">All</button>
        <span class="dot-sep">·</span>
        <button type="button" @click="selectNone" :disabled="!anyActive">None</button>
      </div>
    </div>
  </div>
</template>
