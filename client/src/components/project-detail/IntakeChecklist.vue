<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Multi-attempt intake checklist — one column per intake event, one row per
// checklist item. Mirrors the install-tracker pattern: ✓ when the item
// passed on that attempt, ✗ when it failed, blank when missing.
//
// Backed by /api/intake?project_id=N (QB table bt4a8ypkq). Shown inside the
// MilestoneDetail panel when the Intake step is selected.

interface Props {
  projectRid: number
  /** Compact mode trims auditor/date detail above the grid — used when the
   *  component is embedded in a tight rail. Defaults to full. */
  compact?: boolean
}
const props = defineProps<Props>()

interface IntakeEvent {
  record_id: number
  project_rid: number
  date_created: string | null
  date_modified: string | null
  last_modified_by: string | null
  status: string | null
  install_agreement: string | null
  finance: string | null
  finance_missing_items: string | null
  utility_bill: string | null
  consumption_audit: string | null
  site_survey: string | null
  welcome_call: string | null
  adders: string | null
}

const auth = useAuthStore()
const items = ref<IntakeEvent[]>([])
const loading = ref(true)
const errorMsg = ref('')
const expanded = ref(true)

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/intake?project_id=${props.projectRid}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    items.value = (data.items as IntakeEvent[]) ?? []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.projectRid, load)

// Order matches the install-tracker reference exactly.
type ItemKey = 'install_agreement' | 'finance' | 'utility_bill' | 'consumption_audit' | 'site_survey' | 'welcome_call' | 'adders'
const CHECKLIST: Array<{ key: ItemKey; label: string }> = [
  { key: 'install_agreement', label: 'Install Agmt' },
  { key: 'finance',            label: 'Finance' },
  { key: 'utility_bill',       label: 'Utility Bill' },
  { key: 'consumption_audit',  label: 'Consumption' },
  { key: 'site_survey',        label: 'Survey Sched' },
  { key: 'welcome_call',       label: 'Welcome Call' },
  { key: 'adders',             label: 'Adders' },
]

// Each cell holds either a pass / fail / missing result. The QB fields are
// multi-select text — we treat any non-empty truthy-looking value as a pass
// signal except known reject keywords. This is intentionally permissive so
// the grid stays useful before we lock down the exact value taxonomy.
type Cell = 'pass' | 'fail' | 'missing'
const REJECT_PATTERNS = /reject|fail|missing|incorrect|invalid|incomplete/i
const PASS_PATTERNS = /pass|good|approve|complete|verified|valid|ok\b|yes/i

function cellState(rawValue: string | null | undefined): Cell {
  const v = (rawValue ?? '').trim()
  if (!v) return 'missing'
  if (REJECT_PATTERNS.test(v)) return 'fail'
  if (PASS_PATTERNS.test(v)) return 'pass'
  // Default to pass for any non-empty, non-reject value (QB checkbox 'true',
  // free-form notes, etc.). Adjust once we know the exact value vocabulary.
  return v === 'false' || v === '0' ? 'missing' : 'pass'
}

function fmtDayHeader(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return '—'
  return `${d.getMonth() + 1}/${d.getDate()}`
}
function fmtFullDate(s: string | null): string {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Latest event status (drives the green "Approved" pill in the header)
const latestEvent = computed<IntakeEvent | null>(() => items.value[items.value.length - 1] ?? null)
const latestStatus = computed<string>(() => latestEvent.value?.status ?? '')
const isApproved = computed(() => /approve|pass|complete/i.test(latestStatus.value))
const isRejected = computed(() => /reject|fail/i.test(latestStatus.value))

// Pass count on the latest attempt — drives the "7/7" header label.
const latestPassCount = computed(() => {
  const ev = latestEvent.value
  if (!ev) return 0
  let n = 0
  for (const c of CHECKLIST) if (cellState(ev[c.key]) === 'pass') n++
  return n
})
</script>

<template>
  <div
    class="rounded-lg bg-white ring-1 ring-slate-100 overflow-hidden"
  >
    <!-- Header: title (collapsible) + summary on right -->
    <button
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition-colors cursor-pointer text-left"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="text-slate-400 text-xs">{{ expanded ? '▾' : '▸' }}</span>
      <span class="text-[11px] font-semibold tracking-[0.08em] uppercase text-blue-700">KCA Checklist</span>
      <div class="flex-1" />
      <span v-if="!loading && items.length" class="text-[11px] text-slate-500 tabular-nums">
        {{ latestPassCount }}/{{ CHECKLIST.length }} · {{ items.length }} intake event{{ items.length === 1 ? '' : 's' }}
      </span>
      <span
        v-if="!loading && latestStatus"
        class="inline-flex items-center px-2 py-[2px] rounded-full text-[10px] font-medium"
        :class="[
          isApproved ? 'bg-emerald-50 text-emerald-700' : '',
          isRejected ? 'bg-rose-50 text-rose-700' : '',
          !isApproved && !isRejected ? 'bg-slate-100 text-slate-600' : '',
        ]"
      >{{ latestStatus }}</span>
    </button>

    <!-- States -->
    <div v-if="loading && expanded" class="px-3 pb-3 text-[12px] text-slate-400">Loading intake events…</div>
    <div v-else-if="errorMsg && expanded" class="px-3 pb-3 text-[12px] text-rose-600">{{ errorMsg }}</div>
    <div v-else-if="!items.length && expanded" class="px-3 pb-3 text-[12px] text-slate-400">No intake events on this project.</div>

    <!-- Grid -->
    <div v-else-if="expanded" class="px-3 pb-3">
      <!-- Latest auditor + date one-liner (skipped in compact mode) -->
      <div v-if="!compact && latestEvent" class="flex items-center gap-1.5 text-[11px] text-slate-500 mb-2">
        <span>{{ fmtFullDate(latestEvent.date_created) }}</span>
        <span v-if="latestEvent.last_modified_by" class="text-slate-300">·</span>
        <span v-if="latestEvent.last_modified_by">{{ latestEvent.last_modified_by }}</span>
      </div>

      <!-- Date column headers -->
      <div
        class="grid items-end gap-x-1.5 pb-1 border-b border-slate-100"
        :style="{ gridTemplateColumns: `minmax(78px, 1fr) repeat(${items.length}, 28px)` }"
      >
        <div />
        <div
          v-for="(ev, i) in items"
          :key="ev.record_id"
          class="text-center text-[10.5px] text-slate-500 tabular-nums"
          :title="fmtFullDate(ev.date_created) + (ev.last_modified_by ? ` · ${ev.last_modified_by}` : '')"
        >{{ fmtDayHeader(ev.date_created) }}<span v-if="false" class="hidden">{{ i }}</span></div>
      </div>

      <!-- Rows -->
      <div
        v-for="row in CHECKLIST"
        :key="row.key"
        class="grid items-center gap-x-1.5 py-1 border-b border-slate-50 last:border-b-0"
        :style="{ gridTemplateColumns: `minmax(78px, 1fr) repeat(${items.length}, 28px)` }"
      >
        <span class="text-[12.5px] text-slate-700 truncate" :title="row.label">{{ row.label }}</span>
        <span
          v-for="ev in items"
          :key="ev.record_id + ':' + row.key"
          class="size-5 mx-auto rounded-full flex items-center justify-center"
          :class="[
            cellState(ev[row.key]) === 'pass'    ? 'bg-emerald-50 text-emerald-700' : '',
            cellState(ev[row.key]) === 'fail'    ? 'bg-rose-50 text-rose-600 ring-1 ring-rose-200' : '',
            cellState(ev[row.key]) === 'missing' ? 'bg-slate-50 text-slate-300' : '',
          ]"
          :title="(ev[row.key] || '').toString()"
        >
          <svg
            v-if="cellState(ev[row.key]) === 'pass'"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
            class="size-3" aria-hidden="true"
          ><path d="M5 12l5 5L20 7" /></svg>
          <svg
            v-else-if="cellState(ev[row.key]) === 'fail'"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
            class="size-3" aria-hidden="true"
          ><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
          <span v-else class="text-[10px]">·</span>
        </span>
      </div>

      <!-- Latest finance-missing-items detail (only when present and the
           latest finance cell is failing) -->
      <div
        v-if="latestEvent && cellState(latestEvent.finance) === 'fail' && latestEvent.finance_missing_items"
        class="mt-2 rounded-md bg-rose-50 ring-1 ring-rose-100 px-2.5 py-1.5"
      >
        <div class="text-[10px] font-semibold text-rose-700 uppercase tracking-wider">Finance gaps</div>
        <div class="text-[12px] text-slate-700 mt-0.5 leading-snug">{{ latestEvent.finance_missing_items }}</div>
      </div>
    </div>
  </div>
</template>
