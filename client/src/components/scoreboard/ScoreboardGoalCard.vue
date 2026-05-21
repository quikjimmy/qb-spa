<script setup lang="ts">
// Single goal row inside a department slide. Layout (per Nike's
// editorial billboard pattern):
//
//  LABEL ······························· [PACE PILL]
//   ┌──────────────────┐
//   │  42              │  / 50   ↑ 12%
//   └──────────────────┘
//   ▁▂▃▅▄▇  ── 6-day trend ──
//
// One huge editorial number per card, everything else quiet.

import { computed, ref, watch } from 'vue'
import type { ScoreboardGoal } from '@/lib/dailyGoals'
import { paceFor } from '@/lib/dailyGoals'
import ScoreboardSparkline from './ScoreboardSparkline.vue'

const props = defineProps<{
  goal: ScoreboardGoal
  dayProgress: number
}>()

// Tier-2 celebration: when the current value goes up between polls,
// briefly pulse the number and float a "+N" tag up off the top of it.
// Skipped for empty-bucket goals (where down is good, up is bad).
const bumped = ref(false)
const bumpDelta = ref(0)

watch(
  () => props.goal.current,
  (newV, oldV) => {
    if (props.goal.kind === 'empty_bucket') return
    if (typeof oldV !== 'number') return
    const delta = newV - oldV
    if (delta > 0) {
      bumpDelta.value = delta
      bumped.value = true
      window.setTimeout(() => { bumped.value = false }, 1400)
    }
  },
)

const pace = computed(() => paceFor(props.goal, props.dayProgress))

const values = computed(() => props.goal.history.map(h => h.value))

const dodGlyph = computed(() => {
  const d = props.goal.dayOverDayDelta
  if (d == null) return ''
  if (d > 0) return '↑'
  if (d < 0) return '↓'
  return '→'
})

const dodLabel = computed(() => {
  const d = props.goal.dayOverDayDelta
  if (d == null) return 'New'
  return `${Math.abs(d)}% DoD`
})

const dodColor = computed(() => {
  const d = props.goal.dayOverDayDelta
  if (d == null) return 'var(--sb-mute)'
  if (props.goal.kind === 'empty_bucket') {
    // For empty-bucket goals, lower is better.
    return d <= 0 ? 'var(--sb-success)' : 'var(--sb-sale)'
  }
  return d >= 0 ? 'var(--sb-success)' : 'var(--sb-sale)'
})
</script>

<template>
  <div class="scoreboard-card">
    <div class="row">
      <p class="label">{{ goal.label }}</p>
      <span class="scoreboard-pill" :data-pace="pace.status">{{ pace.label }}</span>
    </div>

    <div class="number-row">
      <span
        class="scoreboard-number value"
        :class="{ 'is-bumped': bumped }"
        :data-pace="pace.status"
      >
        {{ goal.current }}
        <span v-if="bumped" class="scoreboard-bump-tag">+{{ bumpDelta }}</span>
      </span>
      <span v-if="goal.kind === 'count'" class="target">/ {{ goal.target }}</span>
      <span v-else class="target empty">target&nbsp;0</span>
      <span class="dod" :style="{ color: dodColor }">
        <span class="glyph">{{ dodGlyph }}</span>
        {{ dodLabel }}
      </span>
    </div>

    <ScoreboardSparkline
      class="spark"
      :values="values"
      :target="goal.target"
      :kind="goal.kind"
      :width="640"
      :height="48"
    />
  </div>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.label {
  font-family: 'Inter', sans-serif;
  font-size: 18px;
  font-weight: 500;
  color: var(--sb-ink);
  margin: 0;
  letter-spacing: 0;
}

.number-row {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-top: 14px;
  margin-bottom: 12px;
}

.value {
  font-size: 88px;
  line-height: 0.9;
  position: relative;  /* anchor for the absolute "+N" tag */
}

.target {
  font-family: 'Inter', sans-serif;
  font-size: 22px;
  font-weight: 500;
  color: var(--sb-mute);
}

.target.empty {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 14px;
}

.dod {
  margin-left: auto;
  font-family: 'Inter', sans-serif;
  font-weight: 500;
  font-size: 16px;
  letter-spacing: 0;
}

.glyph {
  font-size: 20px;
  margin-right: 2px;
}

.spark {
  display: block;
  width: 100%;
  height: auto;
}
</style>
