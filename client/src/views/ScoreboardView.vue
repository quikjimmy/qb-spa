<script setup lang="ts">
// Daily Goals Scoreboard — portrait TV display.
//
// Layout (9:16 letterboxed inside the viewport):
//   ┌────────────────────────────────────┐
//   │  KIN · DAILY GOALS                  │
//   │  WEDNESDAY                         │  ← Bebas Neue lockup
//   │  May 20  ·  Day's pace 38%         │
//   ├────────────────────────────────────┤
//   │  On Pace · At Risk · Behind · Crit │  ← Pulse (4 huge counts)
//   ├────────────────────────────────────┤
//   │  Today's Focus  ─ worst 3 goals    │
//   ├────────────────────────────────────┤
//   │  PERMIT                            │  ← Department slide,
//   │  Permits submitted        4 / 6   │     rotates every 12s
//   │  Permit-ready bucket      Clear   │
//   ├────────────────────────────────────┤
//   │  •  •  •  •  •  •  •       3:42 PT │
//   └────────────────────────────────────┘
//
// Polls /api/daily-goals/summary every 60s. Rotates between
// departments every 12s.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import type { ScoreboardSummary } from '@/lib/dailyGoals'
import { formatLongDate, groupByDepartment, paceFor } from '@/lib/dailyGoals'
import ScoreboardPulse from '@/components/scoreboard/ScoreboardPulse.vue'
import ScoreboardGoalCard from '@/components/scoreboard/ScoreboardGoalCard.vue'

import '@/assets/scoreboard.css'

const POLL_MS = 60_000
const ROTATE_MS = 12_000

const auth = useAuthStore()
const summary = ref<ScoreboardSummary | null>(null)
const errorMsg = ref('')
const activeSlide = ref(0)
const clock = ref(new Date())

const slides = computed(() => {
  if (!summary.value) return []
  return groupByDepartment(summary.value.goals)
})

const currentSlide = computed(() => slides.value[activeSlide.value] ?? null)

const dayName = computed(() => summary.value?.dayName ?? 'TODAY')

const dateLabel = computed(() => {
  if (!summary.value) return ''
  return formatLongDate(summary.value.date)
})

const paceLabel = computed(() => {
  if (!summary.value) return ''
  const pct = Math.round(summary.value.dayProgress * 100)
  if (pct <= 0) return 'Workday not started'
  if (pct >= 100) return 'Workday complete'
  return `Day's pace ${pct}%`
})

const clockLabel = computed(() => {
  return clock.value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
})

const ranking = computed(() => {
  // Worst-first across all goals — used to show today's three most-
  // at-risk metrics as a focus callout at the top of the rotation.
  if (!summary.value) return []
  const weight: Record<string, number> = {
    critical: 0, behind: 1, at_risk: 2, on_pace: 3, met: 4,
  }
  const dp = summary.value.dayProgress
  return [...summary.value.goals]
    .map(g => ({ goal: g, pace: paceFor(g, dp) }))
    .sort((a, b) =>
      (weight[a.pace.status] ?? 9) - (weight[b.pace.status] ?? 9)
      || a.pace.fraction - b.pace.fraction,
    )
    .slice(0, 3)
})

async function fetchSummary(): Promise<void> {
  if (!auth.token) {
    errorMsg.value = 'Not signed in'
    return
  }
  try {
    const res = await fetch('/api/daily-goals/summary', {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) {
      errorMsg.value = `Failed to load (${res.status})`
      return
    }
    const data = (await res.json()) as ScoreboardSummary
    summary.value = data
    errorMsg.value = ''
    if (slides.value.length > 0 && activeSlide.value >= slides.value.length) {
      activeSlide.value = 0
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Network error'
  }
}

let pollTimer: number | null = null
let rotateTimer: number | null = null
let clockTimer: number | null = null

onMounted(async () => {
  await fetchSummary()
  pollTimer = window.setInterval(fetchSummary, POLL_MS)
  rotateTimer = window.setInterval(() => {
    if (slides.value.length === 0) return
    activeSlide.value = (activeSlide.value + 1) % slides.value.length
  }, ROTATE_MS)
  clockTimer = window.setInterval(() => { clock.value = new Date() }, 15_000)
})

onBeforeUnmount(() => {
  if (pollTimer != null) window.clearInterval(pollTimer)
  if (rotateTimer != null) window.clearInterval(rotateTimer)
  if (clockTimer != null) window.clearInterval(clockTimer)
})
</script>

<template>
  <div class="scoreboard-root">
    <div class="scoreboard-stage">
      <div class="scoreboard-frame">
        <!-- Header — Bebas day-name lockup -->
        <header class="hdr">
          <p class="scoreboard-eyebrow">Kin · Daily Goals</p>
          <h1 class="scoreboard-display campaign">{{ dayName }}</h1>
          <p class="range">{{ dateLabel }}</p>
          <p class="day">{{ paceLabel }}</p>
        </header>

        <!-- Pulse strip -->
        <ScoreboardPulse
          v-if="summary"
          :goals="summary.goals"
          :day-progress="summary.dayProgress"
        />

        <!-- Today's Focus — worst three goals across all departments -->
        <section v-if="ranking.length > 0" class="focus">
          <p class="scoreboard-eyebrow">Today's Focus</p>
          <ul>
            <li v-for="r in ranking" :key="r.goal.id">
              <span class="focus-dept">{{ r.goal.department }}</span>
              <span class="focus-label">{{ r.goal.label }}</span>
              <span class="scoreboard-pill" :data-pace="r.pace.status">{{ r.pace.label }}</span>
            </li>
          </ul>
        </section>

        <!-- Department slide — rotating -->
        <main class="slide-shell">
          <Transition name="slide" mode="out-in">
            <section v-if="currentSlide" :key="currentSlide.department" class="slide">
              <div class="slide-hdr">
                <h2 class="scoreboard-display dept">{{ currentSlide.department }}</h2>
                <p class="slide-count">{{ currentSlide.goals.length }} goals</p>
              </div>
              <ScoreboardGoalCard
                v-for="g in currentSlide.goals"
                :key="g.id"
                :goal="g"
                :day-progress="summary?.dayProgress ?? 0"
              />
            </section>
            <section v-else class="slide empty">
              <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
              <p v-else class="scoreboard-eyebrow">Loading…</p>
            </section>
          </Transition>
        </main>

        <!-- Footer — slide indicator + clock -->
        <footer class="ftr">
          <div class="dots">
            <span
              v-for="(s, i) in slides"
              :key="s.department"
              class="dot"
              :class="{ active: i === activeSlide }"
            />
          </div>
          <p class="clock">{{ clockLabel }}</p>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hdr {
  padding: 32px 28px 18px;
}

.campaign {
  font-size: 88px;
  margin: 6px 0 0;
}

.range {
  font-family: 'Inter', sans-serif;
  font-size: 22px;
  font-weight: 500;
  color: var(--sb-ink);
  margin: 12px 0 4px;
  letter-spacing: 0;
}

.day {
  font-family: 'Inter', sans-serif;
  font-size: 14px;
  color: var(--sb-mute);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin: 0;
}

.focus {
  padding: 18px 28px 8px;
  border-bottom: 1px solid var(--sb-hairline);
}

.focus ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.focus li {
  display: grid;
  grid-template-columns: 130px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--sb-hairline-soft);
}

.focus li:first-child {
  border-top: 0;
}

.focus-dept {
  font-family: 'Inter', sans-serif;
  font-weight: 700;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sb-mute);
}

.focus-label {
  font-family: 'Inter', sans-serif;
  font-size: 17px;
  font-weight: 500;
  color: var(--sb-ink);
}

.slide-shell {
  flex: 1;
  overflow: hidden;
  padding: 0 28px;
  display: flex;
  flex-direction: column;
}

.slide {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.slide.empty {
  align-items: center;
  justify-content: center;
}

.slide-hdr {
  padding: 24px 0 12px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.dept {
  font-size: 72px;
  margin: 0;
}

.slide-count {
  font-family: 'Inter', sans-serif;
  font-size: 12px;
  font-weight: 500;
  color: var(--sb-mute);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 0;
}

.err {
  font-family: 'Inter', sans-serif;
  color: var(--sb-sale);
}

.ftr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 28px 22px;
  border-top: 1px solid var(--sb-hairline);
}

.dots {
  display: flex;
  gap: 6px;
}

.dot {
  width: 28px;
  height: 3px;
  background: var(--sb-hairline);
  border-radius: var(--sb-rounded-full);
  transition: background 0.3s ease;
}

.dot.active {
  background: var(--sb-ink);
}

.clock {
  font-family: 'Inter', sans-serif;
  font-size: 14px;
  font-weight: 500;
  color: var(--sb-mute);
  letter-spacing: 0.04em;
  margin: 0;
}
</style>
