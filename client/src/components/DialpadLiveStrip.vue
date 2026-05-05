<script setup lang="ts">
// Single-line live indicator for /comms. Replaces the inline 220 px tall
// DialpadLivePanel mount on the page so RecentThreads + the first inbox
// rows survive above the fold on a 390 px iPhone landscape.
//
// The full panel is still reachable: click opens the Live Hub rail on
// desktop (sm+); on mobile (<sm), click expands an inline DialpadLivePanel
// in place. Expansion state is component-local — no localStorage, the
// strip is meant to be a quick glance, not a persistent surface.
//
// Spec: docs/comms-landing-c1-spec.md §4.

import { computed, ref } from 'vue'
import { useDialpadLive } from '@/lib/dialpadLive'
import { useCommsRail } from '@/composables/useCommsRail'
import DialpadLivePanel from '@/components/DialpadLivePanel.vue'

const { events, connected, reconnectAttempt } = useDialpadLive()
const { setOpen: setRailOpen } = useCommsRail()

// Mobile breakpoint matches the rest of the app (Tailwind sm = 640).
// We only use this to decide click target — desktop opens the rail,
// mobile inlines the full panel under the strip.
const isMobile = ref(false)
function syncBreakpoint() {
  if (typeof window === 'undefined') return
  isMobile.value = window.matchMedia('(max-width: 639px)').matches
}
syncBreakpoint()
if (typeof window !== 'undefined') {
  window.matchMedia('(max-width: 639px)').addEventListener('change', syncBreakpoint)
}

// Local expand state for the mobile inline path. Reset implicitly on
// component unmount (route change).
const inlineOpen = ref(false)

// Last-hour event count, computed off the in-memory ring buffer. No
// network call, recomputes whenever events.value or "now" updates.
// Tick a "now" every 30s so the count fades out without a refresh.
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
import { onMounted, onBeforeUnmount } from 'vue'
onMounted(() => {
  tick = setInterval(() => { now.value = Date.now() }, 30_000)
})
onBeforeUnmount(() => { if (tick) clearInterval(tick) })

const lastHourCount = computed(() => {
  const cutoff = now.value - 60 * 60 * 1000
  return events.value.filter(e => {
    const t = new Date(e.received_at.includes('T') ? e.received_at : e.received_at.replace(' ', 'T') + 'Z').getTime()
    return Number.isFinite(t) && t >= cutoff
  }).length
})

// Three states drive label + dot. ui-ux-pro-max Navigation/Active State
// — single visual cue (the dot) carries connection vs activity vs idle.
type StripState = 'active' | 'empty' | 'disconnected'
const state = computed<StripState>(() => {
  if (!connected.value) return 'disconnected'
  return lastHourCount.value > 0 ? 'active' : 'empty'
})

const label = computed(() => {
  if (state.value === 'disconnected') {
    return reconnectAttempt.value > 0
      ? 'Reconnecting to live feed…'
      : 'Live feed offline — reconnecting…'
  }
  if (state.value === 'active') {
    const n = lastHourCount.value
    return `${n} event${n === 1 ? '' : 's'} in the last hour — tap to open Live Hub`
  }
  return 'No live activity — tap to open Live Hub'
})

// Tone for the dot. Green = active, slate = idle, amber = retrying.
const dotClass = computed(() => {
  if (state.value === 'disconnected') return 'bg-amber-500'
  if (state.value === 'active') return 'bg-emerald-500 animate-pulse'
  return 'bg-slate-400'
})

const clickable = computed(() => state.value !== 'disconnected')

function onStripClick() {
  if (!clickable.value) return
  if (isMobile.value) {
    inlineOpen.value = !inlineOpen.value
  } else {
    setRailOpen(true)
  }
}
</script>

<template>
  <div class="comms-live-strip">
    <button
      type="button"
      class="
        w-full flex items-center gap-2 h-7 px-3 rounded-md
        bg-muted/30 border text-[11px] tabular-nums
        transition-colors
      "
      :class="clickable ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-default opacity-90'"
      :aria-expanded="inlineOpen"
      :aria-disabled="!clickable"
      @click="onStripClick"
    >
      <span
        class="size-1.5 rounded-full shrink-0"
        :class="dotClass"
        aria-hidden="true"
      />
      <span class="truncate text-foreground/80">{{ label }}</span>
    </button>

    <!-- Mobile-only inline expansion. Desktop click goes to the rail
         instead so the full panel doesn't push the rest of the page
         around. -->
    <div v-if="inlineOpen && isMobile" class="mt-2">
      <DialpadLivePanel />
    </div>
  </div>
</template>
