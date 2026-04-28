<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Visible freshness badge for any view that reads from project_cache.
// Pulls /api/projects/freshness once on mount + refreshes every 30s
// (cheap; just reads SQLite). Surfaces a relative-time stamp tied to
// the most relevant tier for this view, plus a manual "Refresh now"
// for admins that triggers an immediate tier refresh.
//
// Usage:
//   <DataFreshness />                       — overall (defaults to overall_latest)
//   <DataFreshness tier="hot" />            — pin to a specific tier
//   <DataFreshness label="Inbox" />         — custom label prefix

interface Props {
  /** Tier to track: 'hot' | 'warm' | 'cool' | 'cold'. Default = overall. */
  tier?: 'hot' | 'warm' | 'cool' | 'cold'
  /** Optional label prefix (e.g. "Projects"). */
  label?: string
  /** Hide the manual refresh button (some views can't trigger refresh). */
  hideRefresh?: boolean
  /** Compact layout for use inside table headers. */
  compact?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  tier: undefined,
  label: '',
  hideRefresh: false,
  compact: false,
})

interface TierRun {
  tier: string
  last_started_at: string | null
  last_finished_at: string | null
  last_status: string | null
  last_rows_changed: number | null
  last_error: string | null
}
interface TierCount { refresh_tier: string | null; latest: string; n: number }
interface FreshResp {
  overall_latest: string | null
  overall_total: number
  tier_runs: TierRun[]
  tier_counts: TierCount[]
  server_time: string
  cadence: { hot: string; warm: string; cool: string; cold: string }
}

const auth = useAuthStore()
const data = ref<FreshResp | null>(null)
const refreshing = ref(false)
const error = ref('')

async function load() {
  try {
    const res = await fetch('/api/projects/freshness', {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) { error.value = `HTTP ${res.status}`; return }
    data.value = await res.json() as FreshResp
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function refreshNow() {
  if (!auth.isAdmin || refreshing.value) return
  refreshing.value = true
  try {
    const tier = props.tier || 'hot'
    await fetch(`/api/projects/refresh-tier/${tier}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    await load()
  } finally {
    refreshing.value = false
  }
}

let pollHandle: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  load()
  pollHandle = setInterval(load, 30_000)
})
onBeforeUnmount(() => { if (pollHandle) clearInterval(pollHandle) })

// ── Selected timestamp + freshness state ──
const selected = computed<{ ts: string | null; rows: number; status: string | null }>(() => {
  if (!data.value) return { ts: null, rows: 0, status: null }
  if (props.tier) {
    const run = data.value.tier_runs.find(r => r.tier === props.tier)
    const count = data.value.tier_counts.find(c => c.refresh_tier === props.tier)
    return {
      ts: run?.last_finished_at || count?.latest || null,
      rows: count?.n ?? 0,
      status: run?.last_status ?? null,
    }
  }
  return { ts: data.value.overall_latest, rows: data.value.overall_total, status: null }
})

// Now ticks every 15s so "X min ago" updates without a refetch.
const now = ref(Date.now())
let nowHandle: ReturnType<typeof setInterval> | null = null
onMounted(() => { nowHandle = setInterval(() => { now.value = Date.now() }, 15_000) })
onBeforeUnmount(() => { if (nowHandle) clearInterval(nowHandle) })

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = new Date(iso.replace(' ', 'T') + 'Z').getTime()
  if (!Number.isFinite(ms)) return iso
  const diff = Math.max(0, now.value - ms)
  const sec = Math.round(diff / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

// Stale logic: each tier has a "freshness budget." If last_finished_at
// is older than 2× the cadence, the badge goes amber. Errors go rose.
const staleness = computed<'fresh' | 'stale' | 'error'>(() => {
  if (!data.value) return 'fresh'
  if (selected.value.status === 'failed') return 'error'
  const ts = selected.value.ts
  if (!ts) return 'fresh'
  const ageMs = now.value - new Date(ts.replace(' ', 'T') + 'Z').getTime()
  const tier = props.tier
  const budgetMs: Record<string, number> = {
    hot: 5 * 60_000 * 2,
    warm: 30 * 60_000 * 2,
    cool: 6 * 3_600_000 * 2,
    cold: 24 * 3_600_000 * 2,
  }
  const budget = tier ? budgetMs[tier] : 12 * 3_600_000  // overall: 12h
  return ageMs > (budget ?? Number.POSITIVE_INFINITY) ? 'stale' : 'fresh'
})

const dotClass = computed(() => {
  if (staleness.value === 'error') return 'bg-rose-500'
  if (staleness.value === 'stale') return 'bg-amber-500'
  return 'bg-emerald-500'
})
const labelText = computed(() => {
  const parts: string[] = []
  if (props.label) parts.push(props.label)
  if (props.tier) parts.push(`${props.tier} tier`)
  parts.push(`updated ${relTime(selected.value.ts)}`)
  return parts.join(' · ')
})
</script>

<template>
  <div
    class="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
    :class="compact ? '' : 'tabular-nums'"
  >
    <span class="size-1.5 rounded-full" :class="dotClass" :title="staleness === 'error' ? 'Last refresh failed' : staleness === 'stale' ? 'Older than expected — refresh recommended' : 'Up to date'" />
    <span class="truncate">{{ labelText }}</span>
    <button
      v-if="auth.isAdmin && !hideRefresh"
      type="button"
      class="ml-1 hover:text-foreground transition-colors disabled:opacity-50"
      :disabled="refreshing"
      :title="refreshing ? 'Refreshing…' : 'Refresh now'"
      @click="refreshNow"
    >
      <span v-if="refreshing">…</span>
      <span v-else>↻</span>
    </button>
  </div>
</template>
