<script setup lang="ts">
// Four-count pulse at the top of the scoreboard: how many goals are
// On Pace / At Risk / Behind / Met across the whole company this week.
// One short row, big editorial numbers, no chrome.

import { computed } from 'vue'
import type { ScoreboardGoal } from '@/lib/dailyGoals'
import { paceFor } from '@/lib/dailyGoals'

const props = defineProps<{
  goals: ScoreboardGoal[]
  dayProgress: number
}>()

const counts = computed(() => {
  const out = { met: 0, on_pace: 0, at_risk: 0, behind: 0, critical: 0 }
  for (const g of props.goals) {
    const s = paceFor(g, props.dayProgress).status
    out[s] = (out[s] ?? 0) + 1
  }
  return out
})

const cells = computed(() => [
  { key: 'on_pace', label: 'On Pace', value: counts.value.met + counts.value.on_pace, pace: 'on_pace' as const },
  { key: 'at_risk', label: 'At Risk', value: counts.value.at_risk, pace: 'at_risk' as const },
  { key: 'behind',  label: 'Behind',  value: counts.value.behind,  pace: 'behind' as const },
  { key: 'critical', label: 'Critical', value: counts.value.critical, pace: 'critical' as const },
])
</script>

<template>
  <div class="pulse">
    <div v-for="c in cells" :key="c.key" class="cell">
      <span class="scoreboard-number value" :data-pace="c.pace">{{ c.value }}</span>
      <span class="scoreboard-eyebrow label">{{ c.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.pulse {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid var(--sb-hairline);
  border-bottom: 1px solid var(--sb-hairline);
}

.cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px 16px;
  text-align: left;
  border-left: 1px solid var(--sb-hairline);
}

.cell:first-child {
  border-left: 0;
}

.value {
  font-size: 64px;
  line-height: 0.9;
}

.label {
  font-size: 12px;
}
</style>
