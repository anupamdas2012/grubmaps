<script setup lang="ts">
defineProps<{
  mine: boolean;
}>();

defineEmits<{
  "update:mine": [value: boolean];
}>();
</script>

<template>
  <div class="audience-toggle" role="radiogroup" aria-label="Whose reviews to show">
    <button
      type="button"
      class="audience-opt"
      :class="{ active: !mine }"
      :aria-pressed="!mine"
      @click="$emit('update:mine', false)"
    >
      everyone
    </button>
    <button
      type="button"
      class="audience-opt"
      :class="{ active: mine }"
      :aria-pressed="mine"
      @click="$emit('update:mine', true)"
    >
      just me
    </button>
    <span class="audience-thumb" :class="{ 'thumb-right': mine }" aria-hidden="true"></span>
  </div>
</template>
