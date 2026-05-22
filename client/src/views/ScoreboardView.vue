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
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import type { ScoreboardGoal, ScoreboardSummary } from '@/lib/dailyGoals'
import { formatLongDate, groupByDepartment, paceFor } from '@/lib/dailyGoals'
import ScoreboardPulse from '@/components/scoreboard/ScoreboardPulse.vue'
import ScoreboardGoalCard from '@/components/scoreboard/ScoreboardGoalCard.vue'
import ScoreboardCelebration from '@/components/scoreboard/ScoreboardCelebration.vue'

import '@/assets/scoreboard.css'

const POLL_MS = 60_000
const ROTATE_MS = 12_000
const CELEBRATION_HOLD_MS = 4_000   // Tier-1 takeover lifetime
const CELEBRATION_FADE_MS = 400     // overlap with fade-out CSS

const auth = useAuthStore()
const route = useRoute()

// OptiSign / TV-stick embed support: if /scoreboard?token=... was
// loaded, treat the URL token as the bearer JWT for API calls. Set
// in-memory only — we don't persist to localStorage so a shared
// browser session can't accidentally carry the read-only token into
// a real user's account.
if (typeof route.query['token'] === 'string' && (route.query['token'] as string).length > 0) {
  auth.token = route.query['token'] as string
}

const summary = ref<ScoreboardSummary | null>(null)
const errorMsg = ref('')
const activeSlide = ref(0)
const clock = ref(new Date())

// Tier-1 celebration plumbing. The server stamps firstHitAt the
// moment it first sees a goal hit 'met' today. We celebrate when
// that timestamp is recent (within 2 min) AND this session hasn't
// already shown the celebration. This survives page refreshes and
// works on a TV that just opened mid-day.
const CELEBRATION_RECENT_WINDOW_MS = 2 * 60 * 1000
const celebratedKeys = ref<Set<string>>(new Set())  // goalId + date
const celebrationQueue = ref<ScoreboardGoal[]>([])
const activeCelebration = ref<ScoreboardGoal | null>(null)
const celebrationLeaving = ref(false)

// Two distinct viewing modes:
//
//   - `/scoreboard/tv` (route name 'scoreboard-tv'): locked TV
//     layout, designed for a 1080×1920 portrait Samsung signage
//     display fed by OptiSign. Always full-fill, auto-rotates,
//     no mobile breakpoint, no orientation-based letterbox.
//
//   - `/scoreboard` (route name 'scoreboard'): responsive. Adapts
//     to desktop (portrait letterbox) and phone (sticky header +
//     stacked scroll). Use this for "preview at my desk".
const isTvMode = computed(() => route.name === 'scoreboard-tv')

const MOBILE_BREAKPOINT_PX = 640
const isMobile = ref(false)

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
    detectGoalHits(data)
    summary.value = data
    errorMsg.value = ''
    if (slides.value.length > 0 && activeSlide.value >= slides.value.length) {
      activeSlide.value = 0
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Network error'
  }
}

// Look at the server's firstHitAt timestamp on each goal. If it's
// recent AND we haven't already celebrated this hit in this session,
// fire. This correctly handles all the "missed the edge" cases:
//   - TV opened after the hit happened earlier today
//   - Page refreshed mid-day
//   - Two TVs both catching the same hit a poll apart
function detectGoalHits(next: ScoreboardSummary): void {
  const now = Date.now()
  for (const g of next.goals) {
    if (!g.firstHitAt) continue
    const hitMs = Date.parse(g.firstHitAt)
    if (!Number.isFinite(hitMs)) continue
    if (now - hitMs > CELEBRATION_RECENT_WINDOW_MS) continue
    const key = `${g.id}-${next.date}`
    if (celebratedKeys.value.has(key)) continue
    celebratedKeys.value.add(key)
    celebrationQueue.value.push(g)
  }
  if (!activeCelebration.value && celebrationQueue.value.length > 0) {
    showNextCelebration()
  }
}

function showNextCelebration(): void {
  const next = celebrationQueue.value.shift()
  if (!next) return
  activeCelebration.value = next
  celebrationLeaving.value = false
  // Start fade-out a beat before unmount so the CSS transition plays.
  window.setTimeout(() => { celebrationLeaving.value = true }, CELEBRATION_HOLD_MS - CELEBRATION_FADE_MS)
  window.setTimeout(() => {
    activeCelebration.value = null
    if (celebrationQueue.value.length > 0) showNextCelebration()
  }, CELEBRATION_HOLD_MS)
}

let pollTimer: number | null = null
let rotateTimer: number | null = null
let clockTimer: number | null = null

function syncIsMobile(): void {
  // TV mode is always full-fill — ignore viewport size entirely so
  // a 1080×1920 portrait TV (or an OptiSign-rotated landscape one
  // reporting < 640px wide in some unusual configs) never falls
  // into the mobile stacked layout.
  if (isTvMode.value) { isMobile.value = false; return }
  isMobile.value = typeof window !== 'undefined'
    && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches
}

onMounted(async () => {
  syncIsMobile()
  window.addEventListener('resize', syncIsMobile)
  await fetchSummary()
  pollTimer = window.setInterval(fetchSummary, POLL_MS)
  // Rotation is TV-mode only; mobile renders all slides stacked and
  // scrollable, so cycling activeSlide would just move state nobody
  // sees. Skip the timer in that case.
  rotateTimer = window.setInterval(() => {
    if (isMobile.value || slides.value.length === 0) return
    activeSlide.value = (activeSlide.value + 1) % slides.value.length
  }, ROTATE_MS)
  clockTimer = window.setInterval(() => { clock.value = new Date() }, 15_000)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncIsMobile)
  if (pollTimer != null) window.clearInterval(pollTimer)
  if (rotateTimer != null) window.clearInterval(rotateTimer)
  if (clockTimer != null) window.clearInterval(clockTimer)
})
</script>

<template>
  <div class="scoreboard-root" :class="{ 'is-mobile': isMobile, 'is-tv': isTvMode }">
    <div class="scoreboard-stage">
      <div class="scoreboard-frame">
        <!-- Header — Kin mark + Bebas day-name lockup. Sticky on
             mobile so it stays anchored while the user scrolls. -->
        <header class="hdr">
          <div class="brand">
            <img src="/img/Kin - Square Profile-blake-white.png" alt="Kin Home" class="brand-mark" />
            <p class="scoreboard-eyebrow brand-tag">Daily Goals</p>
          </div>
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

        <!-- Department slides. TV mode (>640px): one slide visible,
             auto-rotating every 12s. Mobile: all slides stacked +
             scrollable under the sticky header. -->
        <main class="slide-shell">
          <template v-if="isMobile">
            <section v-if="slides.length === 0" class="slide empty">
              <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
              <p v-else class="scoreboard-eyebrow">Loading…</p>
            </section>
            <section
              v-for="s in slides"
              :key="s.department"
              class="slide"
            >
              <div class="slide-hdr">
                <h2 class="scoreboard-display dept">{{ s.department }}</h2>
                <p class="slide-count">{{ s.goals.length }} goals</p>
              </div>
              <ScoreboardGoalCard
                v-for="g in s.goals"
                :key="g.id"
                :goal="g"
                :day-progress="summary?.dayProgress ?? 0"
              />
            </section>
          </template>
          <Transition v-else name="slide" mode="out-in">
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

        <!-- Footer — TV-only. Hidden on mobile since rotation doesn't
             run and dots/clock would just be clutter. -->
        <footer v-if="!isMobile" class="ftr">
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

    <!-- Tier-1 celebration overlay — sits above the entire frame -->
    <ScoreboardCelebration
      v-if="activeCelebration"
      :goal="activeCelebration"
      :leaving="celebrationLeaving"
    />
  </div>
</template>

<style scoped>
.hdr {
  padding: 32px 28px 18px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-mark {
  width: 36px;
  height: 36px;
  object-fit: contain;
  /* Nike-style: image sits flat on canvas, no shadow or border. */
}

.brand-tag {
  margin: 0;
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

/* ─── Mobile mode (phones) ─────────────────────────────────
   Sticky header anchors the brand + day name + date + pace line at
   the top. Everything below scrolls in document flow. Display sizes
   shrink so the layout fits a typical 360-430px phone width.    */
.scoreboard-root.is-mobile .hdr {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--sb-canvas);
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--sb-hairline);
}

.scoreboard-root.is-mobile .campaign {
  font-size: 56px;
}

.scoreboard-root.is-mobile .range {
  font-size: 16px;
  margin-top: 6px;
}

.scoreboard-root.is-mobile .day {
  font-size: 12px;
}

.scoreboard-root.is-mobile .focus {
  padding: 14px 18px 6px;
}

.scoreboard-root.is-mobile .slide-shell {
  padding: 0 18px;
  flex: none;
  overflow: visible;
}

.scoreboard-root.is-mobile .slide {
  flex: none;
}

.scoreboard-root.is-mobile .dept {
  font-size: 48px;
}

/* ─── TV mode sizing (vw-relative) ─────────────────────────
   The base CSS sizes the design against a ~600px-wide portrait
   letterbox (desktop preview). On the actual 1080px+ TV viewport,
   those pixel sizes look proportionally small. Express every
   prominent size in vw so the layout scales naturally to whatever
   the OptiSign / Samsung player reports as its viewport width.
   Multiplier reference: 88px ≈ 14.5% of 600px design width → 14vw. */

.scoreboard-root.is-tv .brand-mark {
  width: 5.5vw;
  height: 5.5vw;
}

.scoreboard-root.is-tv .hdr {
  padding: 4vw 4.5vw 2.5vw;
}

.scoreboard-root.is-tv .campaign {
  font-size: 14vw;
}

.scoreboard-root.is-tv .range {
  font-size: 3.5vw;
  margin: 2vw 0 0.6vw;
}

.scoreboard-root.is-tv .day {
  font-size: 2.2vw;
}

.scoreboard-root.is-tv .focus {
  padding: 2.8vw 4.5vw 1.2vw;
}

.scoreboard-root.is-tv .focus li {
  grid-template-columns: 20vw 1fr auto;
  gap: 2vw;
  padding: 1.6vw 0;
}

.scoreboard-root.is-tv .focus-dept {
  font-size: 1.9vw;
}

.scoreboard-root.is-tv .focus-label {
  font-size: 2.7vw;
}

.scoreboard-root.is-tv .slide-shell {
  padding: 0 4.5vw;
}

.scoreboard-root.is-tv .slide-hdr {
  padding: 3.8vw 0 1.9vw;
}

.scoreboard-root.is-tv .dept {
  font-size: 11.5vw;
}

.scoreboard-root.is-tv .slide-count {
  font-size: 1.9vw;
}

.scoreboard-root.is-tv .ftr {
  padding: 2.2vw 4.5vw 3.5vw;
}

.scoreboard-root.is-tv .dot {
  width: 4.5vw;
  height: 0.5vw;
}

.scoreboard-root.is-tv .clock {
  font-size: 2.2vw;
}
</style>
