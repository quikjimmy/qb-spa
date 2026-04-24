<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { bucketMeta, formatPhone, fmtTalkSec, splitStartedAt } from '@/lib/callBuckets'

// Per-call activity feed — renders one row per call with a dialtone icon
// indicating the leaf bucket (missed, connected, voicemail, etc.). Responsive
// down to 390px: no horizontal scroll, duration and state collapse to a
// compact right column.

interface Props {
  coordinator?: string
  from?: string
  to?: string
  limit?: number
  bucket?: string   // optional — filter to one leaf (e.g., only 'in_missed')
}
const props = withDefaults(defineProps<Props>(), { limit: 100 })

interface CallRow {
  call_id: string
  user_email: string
  user_name: string | null
  coordinator: string
  direction: string
  bucket: string
  external_number: string | null
  started_at: string
  connected_at: string | null
  ended_at: string | null
  talk_time_sec: number
  ring_time_sec: number
  was_voicemail: number
  was_transfer: number
  entry_point_target_kind: string | null
}

const auth = useAuthStore()
const rows = ref<CallRow[]>([])
const loading = ref(false)
const error = ref('')
const bucketFilter = ref<string>(props.bucket || '')

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function load() {
  loading.value = true
  error.value = ''
  const p = new URLSearchParams()
  p.set('limit', String(props.limit))
  if (props.coordinator) p.set('coordinator', props.coordinator)
  if (props.from) p.set('from', props.from)
  if (props.to) p.set('to', props.to)
  if (bucketFilter.value) p.set('bucket', bucketFilter.value)
  try {
    const res = await fetch(`/api/dialpad/call-records?${p}`, { headers: hdrs() })
    if (!res.ok) { error.value = `HTTP ${res.status}`; return }
    const data = await res.json()
    rows.value = data.rows || []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally { loading.value = false }
}

onMounted(load)
watch(() => [props.coordinator, props.from, props.to, props.bucket], () => { bucketFilter.value = props.bucket || ''; load() })
watch(bucketFilter, load)

// Quick filter chips — bucket counts derived from current rows
interface ChipEntry { key: string; label: string; count: number }
const bucketChips = computed<ChipEntry[]>(() => {
  const counts: Record<string, number> = {}
  for (const r of rows.value) counts[r.bucket] = (counts[r.bucket] || 0) + 1
  const order = ['in_answered', 'in_missed', 'in_voicemail', 'in_abandoned', 'in_transfer_unanswered', 'in_callback_requested', 'out_connected', 'out_cancelled', 'out_callback_attempt']
  return order.filter(k => counts[k]).map(k => ({ key: k, label: bucketMeta(k).short, count: counts[k]! }))
})

function toggleBucket(k: string) {
  bucketFilter.value = bucketFilter.value === k ? '' : k
}
</script>

<template>
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="px-3 sm:px-4 py-2.5 border-b flex items-center justify-between gap-2">
      <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        Activity <span v-if="coordinator" class="normal-case tracking-normal font-medium text-foreground">· {{ coordinator }}</span>
      </p>
      <p class="text-[10px] text-muted-foreground">{{ rows.length }} {{ rows.length === 1 ? 'call' : 'calls' }}</p>
    </div>

    <!-- Bucket filter chips — wrap on narrow, no h-scroll -->
    <div v-if="bucketChips.length > 1" class="px-3 sm:px-4 py-2 border-b flex flex-wrap gap-1.5">
      <button
        class="px-2 h-6 rounded-full border text-[10px] font-medium transition-colors"
        :class="bucketFilter === '' ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
        @click="bucketFilter = ''"
      >All</button>
      <button v-for="c in bucketChips" :key="c.key"
        class="px-2 h-6 rounded-full border text-[10px] font-medium transition-colors inline-flex items-center gap-1"
        :class="bucketFilter === c.key ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
        @click="toggleBucket(c.key)"
      >
        {{ c.label }}
        <span class="tabular-nums opacity-70">{{ c.count }}</span>
      </button>
    </div>

    <div v-if="loading && rows.length === 0" class="px-4 py-8 text-center text-[11px] text-muted-foreground">Loading activity…</div>
    <div v-else-if="error" class="px-4 py-8 text-center text-[11px] text-red-600">{{ error }}</div>
    <div v-else-if="rows.length === 0" class="px-4 py-8 text-center text-[11px] text-muted-foreground">No calls in this window.</div>

    <div v-else class="divide-y max-h-[560px] overflow-y-auto">
      <div v-for="r in rows" :key="r.call_id" class="flex items-center gap-2.5 sm:gap-3 px-3 sm:px-4 py-2">
        <!-- Icon chip -->
        <div class="shrink-0 size-8 rounded-full flex items-center justify-center" :class="bucketMeta(r.bucket).bgClass">
          <component :is="bucketMeta(r.bucket).icon" class="w-4 h-4" :class="bucketMeta(r.bucket).colorClass" />
        </div>

        <!-- Middle — who + when -->
        <div class="flex-1 min-w-0">
          <p class="font-mono text-[12px] truncate">{{ formatPhone(r.external_number) || 'Unknown' }}</p>
          <p class="text-[10px] text-muted-foreground truncate">
            <span>{{ bucketMeta(r.bucket).short }}</span>
            <template v-if="r.was_transfer"> · transfer</template>
            <template v-if="r.entry_point_target_kind && r.entry_point_target_kind !== 'UserProfile'"> · via {{ r.entry_point_target_kind }}</template>
          </p>
        </div>

        <!-- Right — time + duration -->
        <div class="shrink-0 text-right">
          <p class="text-[11px] tabular-nums">{{ splitStartedAt(r.started_at).time }}</p>
          <p class="text-[10px] text-muted-foreground tabular-nums">
            <template v-if="r.talk_time_sec > 0">{{ fmtTalkSec(r.talk_time_sec) }}</template>
            <template v-else>{{ splitStartedAt(r.started_at).date }}</template>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
