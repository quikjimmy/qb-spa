<script setup lang="ts">
import { computed } from 'vue'

interface RateSnapshot {
  tokens_remaining: number | null
  tokens_limit: number | null
  requests_remaining: number | null
  requests_limit: number | null
  reset_at: string | null
  used_own_key: boolean
  updated_at: string
}

interface Quota {
  cap_cents: number | null
  spent_cents: number
  cap_pct_used: number | null
  byok_bypasses_cap: boolean
  providers: Record<string, RateSnapshot>
}

const props = defineProps<{
  // The thread's set preference (when /model was used).
  preferredProvider?: string | null
  preferredModel?: string | null
  // Whole-user quota snapshot. Optional — component renders gracefully without it.
  quota?: Quota | null
  // Compact mode trims the model name on small screens.
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-picker'): void
}>()

// Friendly model label — strip noise like the date suffix on Claude IDs.
const modelLabel = computed(() => {
  if (!props.preferredModel) return 'Auto'
  return props.preferredModel
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
})

// Snapshot for the active provider (if known) — used to compute the ring.
const activeSnap = computed<RateSnapshot | null>(() => {
  if (!props.quota || !props.preferredProvider) return null
  return props.quota.providers[props.preferredProvider] ?? null
})

// Lower of (rate-limit % used) and (cap % used). Returns null if neither is known.
const ringPct = computed<number | null>(() => {
  const capPct = props.quota?.cap_pct_used ?? null
  const snap = activeSnap.value
  let ratePct: number | null = null
  if (snap && snap.tokens_limit && snap.tokens_remaining != null) {
    ratePct = Math.round(((snap.tokens_limit - snap.tokens_remaining) / snap.tokens_limit) * 100)
  }
  const candidates = [capPct, ratePct].filter((v): v is number => v != null)
  if (candidates.length === 0) return null
  return Math.max(...candidates)
})

const ringColor = computed(() => {
  const p = ringPct.value
  if (p == null) return 'stroke-muted-foreground/40'
  if (p >= 90) return 'stroke-amber-500'
  if (p >= 70) return 'stroke-amber-400'
  return 'stroke-emerald-500'
})

const tooltip = computed(() => {
  const lines: string[] = []
  if (props.quota?.cap_cents != null) {
    lines.push(`Monthly cap: $${(props.quota.spent_cents / 100).toFixed(2)} / $${(props.quota.cap_cents / 100).toFixed(2)}`)
  }
  const snap = activeSnap.value
  if (snap?.tokens_remaining != null && snap.tokens_limit) {
    lines.push(`${snap.tokens_remaining.toLocaleString()} / ${snap.tokens_limit.toLocaleString()} tokens left in window`)
  }
  if (snap?.reset_at) {
    const d = new Date(snap.reset_at)
    if (!isNaN(d.getTime())) {
      const mins = Math.max(0, Math.round((d.getTime() - Date.now()) / 60_000))
      lines.push(`Resets in ${mins}m`)
    }
  }
  if (lines.length === 0) lines.push('No quota data yet — send a message to populate.')
  lines.push('Click to change model')
  return lines.join('\n')
})

// SVG ring math
const RADIUS = 8
const CIRC = 2 * Math.PI * RADIUS
const dashOffset = computed(() => {
  const p = ringPct.value ?? 0
  return CIRC * (1 - p / 100)
})
</script>

<template>
  <button
    @click="emit('open-picker')"
    :title="tooltip"
    class="inline-flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-foreground/[0.04] transition-colors text-left group"
  >
    <!-- Quota ring -->
    <svg width="22" height="22" viewBox="0 0 22 22" class="shrink-0 -rotate-90">
      <circle cx="11" cy="11" :r="RADIUS" fill="none" class="stroke-foreground/[0.08]" stroke-width="2" />
      <circle
        v-if="ringPct != null"
        cx="11" cy="11" :r="RADIUS" fill="none" stroke-width="2" stroke-linecap="round"
        :class="ringColor"
        :stroke-dasharray="CIRC"
        :stroke-dashoffset="dashOffset"
        style="transition: stroke-dashoffset 300ms ease-out;"
      />
    </svg>

    <!-- Model name -->
    <div class="min-w-0">
      <div class="text-[9px] uppercase tracking-widest text-muted-foreground/70 font-semibold leading-tight">Model</div>
      <div class="text-[11px] font-medium font-mono truncate group-hover:text-foreground transition-colors" :class="compact ? 'max-w-[90px]' : 'max-w-[140px]'">
        {{ modelLabel }}
      </div>
    </div>
  </button>
</template>
