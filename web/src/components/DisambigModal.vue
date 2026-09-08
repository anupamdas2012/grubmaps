<script setup lang="ts">
import type { Business } from "../types";

defineProps<{
  query: string;
  namedCandidate: Business | null;
  cravingCount: number;
}>();

defineEmits<{
  choose: [choice: "named" | "craving"];
  cancel: [];
}>();
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('cancel')">
    <div class="menu-card menu-card--modal disambig-card">
      <div class="menu-card-eyebrow">"{{ query }}"</div>
      <h2 class="menu-card-title">Did you mean…</h2>
      <div class="menu-card-rule"></div>

      <div class="disambig-choices">
        <button
          v-if="namedCandidate"
          class="disambig-choice"
          @click="$emit('choose', 'named')"
        >
          <span class="disambig-choice-icon">📍</span>
          <div class="disambig-choice-body">
            <span class="disambig-choice-title">{{ namedCandidate.name }}</span>
            <span class="disambig-choice-sub">{{ namedCandidate.address ?? "a specific place" }}</span>
          </div>
        </button>
        <button
          class="disambig-choice"
          @click="$emit('choose', 'craving')"
        >
          <span class="disambig-choice-icon">🍽</span>
          <div class="disambig-choice-body">
            <span class="disambig-choice-title">Something else matching "{{ query }}"</span>
            <span class="disambig-choice-sub">
              {{ cravingCount > 0 ? `${cravingCount} spot${cravingCount === 1 ? "" : "s"} reviewed` : "search nearby options" }}
            </span>
          </div>
        </button>
      </div>

      <div class="actions">
        <button class="menu-btn menu-btn--secondary" @click="$emit('cancel')">Cancel</button>
      </div>
    </div>
  </div>
</template>
