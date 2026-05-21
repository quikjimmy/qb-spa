<script setup lang="ts">
// Tier-1 celebration: full-screen black takeover with the achievement
// in towering Bebas. Triggered when a goal flips from any non-met
// pace status to 'met' (i.e. it just hit today's target). Parent
// component manages mount/unmount lifetime (~4s hold + fade).

import { onMounted, ref } from 'vue'
import type { ScoreboardGoal } from '@/lib/dailyGoals'

const props = defineProps<{
  goal: ScoreboardGoal
  // Caller sets `leaving` to true ~300ms before unmount so the fade-out
  // CSS can complete cleanly.
  leaving?: boolean
}>()

const mounted = ref(false)

onMounted(() => {
  mounted.value = true
  // Optional: vibrate if on a touch-enabled TV stick. Silent fallback
  // on hardware that doesn't support it (most TVs).
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { navigator.vibrate?.([100, 80, 100]) } catch { /* no-op */ }
  }
})
</script>

<template>
  <div
    v-if="mounted"
    class="scoreboard-celebration"
    :class="{ 'is-leaving': props.leaving }"
    role="alert"
    aria-live="assertive"
  >
    <p class="scoreboard-celebration-eyebrow">{{ goal.department }} · Goal hit</p>
    <p class="scoreboard-celebration-label">{{ goal.label }}</p>
    <p class="scoreboard-celebration-number">{{ goal.current }} / {{ goal.target }}</p>
    <p class="scoreboard-celebration-caption">Today's Target — Cleared</p>
  </div>
</template>
