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

// Sports-style 7-day win/loss strip — one cell per day in the
// history window. State derived from value vs that day's target,
// using the per-day target lock-in (so a target raised yesterday
// doesn't retroactively re-grade Monday).
interface HistoryCell {
  date: string
  dow: string   // single-letter day-of-week
  state: 'hit' | 'miss' | 'weekend' | 'no-target'
}

const DOW_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']  // Sun..Sat

function todayIsoLocal(): string {
  // Office TZ lives server-side; for client-side "is this row today"
  // we just compare to the last entry of the server's history (which
  // is always today). Keeps the client free of TZ logic.
  return props.goal.history[props.goal.history.length - 1]?.date ?? ''
}

const historyCells = computed<HistoryCell[]>(() => {
  const today = todayIsoLocal()
  return props.goal.history.map(h => {
    const d = new Date(`${h.date}T00:00:00`)
    const dow = DOW_LETTERS[d.getDay()] ?? '·'
    const isWeekend = d.getDay() === 0 || d.getDay() === 6
    if (h.date === today) {
      // Today is graded against the pace pill — green if met / on
      // pace / at risk (still within striking distance), red if
      // behind or critical. Matches the pill's color so the row
      // reads consistently.
      const s = pace.value.status
      const state: HistoryCell['state'] = (s === 'met' || s === 'on_pace' || s === 'at_risk')
        ? 'hit'
        : 'miss'
      return { date: h.date, dow, state }
    }
    if (isWeekend)                return { date: h.date, dow, state: 'weekend' }
    if (props.goal.kind === 'empty_bucket') {
      return h.value === 0
        ? { date: h.date, dow, state: 'hit' }
        : { date: h.date, dow, state: 'miss' }
    }
    if (h.target <= 0)            return { date: h.date, dow, state: 'no-target' }
    return h.value >= h.target
      ? { date: h.date, dow, state: 'hit' }
      : { date: h.date, dow, state: 'miss' }
  })
})

// All but the trailing "today" cell — rendered to the left of the
// vertical divider so the eye lands cleanly on today's box.
const priorCells = computed(() => historyCells.value.slice(0, -1))
const todayCell = computed(() => historyCells.value[historyCells.value.length - 1] ?? null)

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

      <!-- 7-day win/loss strip — same row as the title and pace pill.
           Small color-squares with a single day-letter. Hairline
           divider separates the prior 6 days from today (rightmost
           cell). Color carries everything. -->
      <div class="scoreboard-history-strip">
        <div
          v-for="cell in priorCells"
          :key="cell.date"
          class="scoreboard-history-cell"
          :data-state="cell.state"
          :title="cell.date"
        >{{ cell.dow }}</div>
        <div class="scoreboard-history-divider" />
        <div
          v-if="todayCell"
          class="scoreboard-history-cell"
          :data-state="todayCell.state"
          :title="todayCell.date"
        >{{ todayCell.dow }}</div>
      </div>

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
  flex: 1 1 auto;
  min-width: 0;
}

.row .scoreboard-history-strip {
  flex: none;
  /* Override the default top-margin since the strip is inline here,
     not stacked below the sparkline. */
  margin-top: 0;
}

.row .scoreboard-pill {
  flex: none;
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

/* TV mode — scale fixed pixel sizes to vw so the design fills the
   actual TV viewport instead of staying glued to its 600px design
   reference. */
.scoreboard-root.is-tv .label {
  font-size: 2.8vw;
}

.scoreboard-root.is-tv .number-row {
  gap: 2.2vw;
  margin-top: 2.2vw;
  margin-bottom: 1.9vw;
}

.scoreboard-root.is-tv .value {
  font-size: 13vw;
}

.scoreboard-root.is-tv .target {
  font-size: 3.4vw;
}

.scoreboard-root.is-tv .target.empty {
  font-size: 2.2vw;
}

.scoreboard-root.is-tv .dod {
  font-size: 2.5vw;
}

.scoreboard-root.is-tv .glyph {
  font-size: 3vw;
  margin-right: 0.3vw;
}

.scoreboard-root.is-tv .row {
  gap: 2.5vw;
}
</style>
