<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  submit: [name: string];
}>();

const name = ref("");
const submitting = ref(false);

const canSubmit = () => name.value.trim().length > 0 && name.value.trim().length <= 32;

const onSubmit = () => {
  if (!canSubmit() || submitting.value) return;
  submitting.value = true;
  emit("submit", name.value.trim());
};
</script>

<template>
  <div class="modal-backdrop">
    <div class="menu-card menu-card--modal">
      <div class="menu-card-eyebrow">welcome to</div>
      <h1 class="menu-card-title"><i>Crave</i></h1>
      <div class="menu-card-rule"></div>
      <p class="menu-card-lead">
        Your personal tour of the good stuff. Pin what you love.
        Share your take. Discover what other people swear by.
      </p>
      <label for="login-name" class="menu-card-label">What should we call you?</label>
      <input
        id="login-name"
        v-model="name"
        type="text"
        maxlength="40"
        placeholder="e.g. Sam, DorkusMaximus, Chef Anna"
        autocomplete="off"
        autocapitalize="words"
        autofocus
        @keydown.enter.prevent="onSubmit"
        class="menu-input"
      />
      <button
        class="menu-btn menu-btn--primary"
        :disabled="!canSubmit() || submitting"
        @click="onSubmit"
      >
        {{ submitting ? "…" : "Start pinning" }}
      </button>
    </div>
  </div>
</template>
