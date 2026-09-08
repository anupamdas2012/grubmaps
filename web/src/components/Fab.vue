<script setup lang="ts">
defineEmits<{ click: [] }>();
</script>

<template>
  <button
    type="button"
    class="fab"
    aria-label="Write a review"
    title="Write a review"
    @click="$emit('click')"
  >
    <span class="fab-plus" aria-hidden="true">+</span>
    <span class="fab-label">review</span>
  </button>
</template>
