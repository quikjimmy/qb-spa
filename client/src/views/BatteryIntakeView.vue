<script setup lang="ts">
// Battery Intake Monitoring — a mobile-first queue over the QB "HVC Raw JSON"
// staging table (bvmute72r). Shows every battery deal from the Sunobi Battery
// Sizer, buckets them into Stuck / Queued / Tests / All, and lets the intake
// team Re-push a stuck deal (set Send to Zap = Yes) with one tap — the whole
// loop works one-handed on a phone. See docs/BATTERY_INTAKE_MONITORING_GUIDE.md.

import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { useAuthStore } from '@/stores/auth'
import MilestoneShell from '@/components/milestone/MilestoneShell.vue'
import { Sheet, SheetContent } from '@/components/ui/sheet'

const auth = useAuthStore()
const route = useRoute()
function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

interface Row {
  record_id: number
  proposal_id: string
  date_created: string
  intake_status: string
  intake_error: string
  intake_step: string
  intake_missing: string
  project_record_id: number | null
  last_attempt: string
  attempt_count: number
  send_to_zap: boolean
  sent_to_zap_at: string
  likely_test: boolean
  test_signals: string
  customer_name: string
  customer_address: string
  battery: string
  price: number | null
  rep: string
  source: string
  qb_url: string
  project_url: string
}

const rows = ref<Row[]>([])
const asOf = ref('')
const loading = ref(true)
const refreshing = ref(false)
const errorMsg = ref('')

async function loadData(force = false, silent = false) {
  if (!silent) { if (force) refreshing.value = true; else loading.value = true }
  try {
    const res = await fetch(`/api/battery-intake${force ? '?fresh=1' : ''}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { items: Row[]; as_of: string }
    rows.value = data.items ?? []
    asOf.value = data.as_of ?? ''
    errorMsg.value = ''
  } catch (e) {
    if (!silent) errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

// ── Buckets ──
const STUCK = new Set(['error', 'incomplete', 'manual_review', 'bad_payload'])
function isStuck(r: Row) { return STUCK.has(r.intake_status) }
// A cleanly landed deal — already created its Project. Re-pushing one just
// re-runs intake and can overwrite manual QB edits, so we don't offer it here
// (QuickBase's own "Resend to Zap" remains the escape hatch for rare cases).
function isLanded(r: Row) { return r.intake_status === 'success' && r.project_record_id != null }

type TabKey = 'stuck' | 'queued' | 'tests' | 'all'
const activeTab = ref<TabKey>('stuck')

const counts = computed(() => ({
  stuck: rows.value.filter(isStuck).length,
  queued: rows.value.filter(r => r.send_to_zap).length,
  tests: rows.value.filter(r => r.likely_test).length,
  all: rows.value.length,
}))

const tabs: { key: TabKey; label: string }[] = [
  { key: 'stuck', label: 'Stuck' },
  { key: 'queued', label: 'Queued' },
  { key: 'tests', label: 'Tests' },
  { key: 'all', label: 'All' },
]

const visibleRows = computed(() => {
  switch (activeTab.value) {
    case 'stuck': return rows.value.filter(isStuck)
    case 'queued': return rows.value.filter(r => r.send_to_zap)
    case 'tests': return rows.value.filter(r => r.likely_test)
    default: return rows.value
  }
})

// ── Status pill styling (calm palette — red reserved for actionable failures) ──
const statusMeta: Record<string, { label: string; pill: string }> = {
  success:       { label: 'Success',       pill: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400' },
  incomplete:    { label: 'Incomplete',    pill: 'bg-amber-50 text-amber-700 dark:bg-amber-950/25 dark:text-amber-400' },
  error:         { label: 'Error',         pill: 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400' },
  manual_review: { label: 'Manual Review', pill: 'bg-violet-50 text-violet-700 dark:bg-violet-950/25 dark:text-violet-400' },
  bad_payload:   { label: 'Bad Payload',   pill: 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400' },
}
function statusFor(r: Row) {
  return statusMeta[r.intake_status] ?? { label: 'Pending', pill: 'bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400' }
}

// ── Formatting ──
function fmtDate(v: string) {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function fmtDateTime(v: string) {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function fmtPrice(n: number | null) {
  if (n == null) return ''
  return `$${n.toLocaleString('en-US')}`
}
function relOf(iso: string): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}
function missingItems(r: Row): string[] {
  if (!r.intake_missing) return []
  return r.intake_missing.split(/[;\n|]/).map(s => s.trim()).filter(Boolean)
}

// ── Detail sheet ──
const isDesktop = useMediaQuery('(min-width: 640px)')
const sheetSide = computed<'right' | 'bottom'>(() => (isDesktop.value ? 'right' : 'bottom'))
const detailOpen = ref(false)
const detailRow = ref<Row | null>(null)
function openDetail(r: Row) { detailRow.value = r; detailOpen.value = true }

// ── Re-push ──
const busyId = ref<number | null>(null)
const justPushed = ref<number | null>(null)
async function rePush(r: Row) {
  if (busyId.value != null) return
  busyId.value = r.record_id
  try {
    const res = await fetch(`/api/battery-intake/${r.record_id}/repush`, { method: 'POST', headers: hdrs() })
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(j.error || `HTTP ${res.status}`)
    }
    justPushed.value = r.record_id
    setTimeout(() => { if (justPushed.value === r.record_id) justPushed.value = null }, 4000)
    await loadData(true)
    if (detailRow.value) detailRow.value = rows.value.find(x => x.record_id === detailRow.value!.record_id) ?? detailRow.value
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyId.value = null
  }
}

// ── Polling (only while the tab is visible) ──
let pollHandle: ReturnType<typeof setInterval> | null = null
function startPoll() {
  pollHandle = setInterval(() => {
    if (document.visibilityState === 'visible') loadData(false, true)
  }, 30_000)
}
onMounted(async () => {
  await loadData()
  startPoll()
  // Deep-linked from a stuck-deal notification (?deal=<record_id>) — open it.
  const dealId = Number(route.query['deal'])
  if (Number.isFinite(dealId) && dealId > 0) {
    const r = rows.value.find(x => x.record_id === dealId)
    if (r) openDetail(r)
  }
})
onBeforeUnmount(() => { if (pollHandle) clearInterval(pollHandle) })
</script>

<template>
  <MilestoneShell
    title="Battery Intake"
    description="Monitor & re-push battery deals from the Sunobi Battery Sizer."
    back-to="/projects"
    :show-freshness="false"
  >
    <template #header-actions>
      <div class="flex items-center gap-2">
        <span v-if="asOf" class="hidden sm:inline text-[10px] text-muted-foreground tabular-nums">
          Updated {{ relOf(asOf) }}
        </span>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium hover:bg-muted/70 active:scale-95 transition disabled:opacity-50"
          :disabled="refreshing"
          @click="loadData(true)"
        >
          <span :class="refreshing ? 'animate-spin' : ''">↻</span>
          <span class="hidden sm:inline">Refresh</span>
        </button>
      </div>
    </template>

    <!-- Tabs + counts in one compact control (mobile-first: selects and
         informs, no wasted vertical space). -->
    <div class="flex gap-1 p-0.5 bg-muted rounded-xl overflow-x-auto no-scrollbar">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="flex-1 min-w-[72px] rounded-lg px-2.5 py-2 text-sm font-medium transition flex items-center justify-center gap-1.5"
        :class="activeTab === t.key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'"
        @click="activeTab = t.key"
      >
        <span>{{ t.label }}</span>
        <span
          class="text-[11px] tabular-nums rounded-full px-1.5 min-w-[20px] text-center"
          :class="[
            t.key === 'stuck' && counts.stuck > 0 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' : 'bg-foreground/10 text-muted-foreground',
          ]"
        >{{ counts[t.key] }}</span>
      </button>
    </div>

    <!-- Error banner -->
    <p v-if="errorMsg" class="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/30 rounded-lg px-3 py-2">
      {{ errorMsg }}
    </p>

    <!-- Loading skeleton -->
    <div v-if="loading" class="grid gap-2">
      <div v-for="i in 4" :key="i" class="h-20 rounded-xl bg-muted animate-pulse" />
    </div>

    <!-- Empty state -->
    <div v-else-if="visibleRows.length === 0" class="text-center py-12 text-sm text-muted-foreground">
      <p class="text-2xl mb-2">✓</p>
      <p v-if="activeTab === 'stuck'">Nothing stuck — every deal landed.</p>
      <p v-else-if="activeTab === 'queued'">Nothing queued right now.</p>
      <p v-else-if="activeTab === 'tests'">No test submissions.</p>
      <p v-else>No battery deals yet.</p>
    </div>

    <template v-else>
      <!-- Mobile: cards -->
      <div class="lg:hidden grid gap-2">
        <div
          v-for="r in visibleRows"
          :key="r.record_id"
          class="rounded-xl bg-card p-3 border-l-[3px]"
          :class="isStuck(r) ? 'border-l-amber-400' : r.send_to_zap ? 'border-l-blue-400' : 'border-l-transparent'"
        >
          <button type="button" class="w-full text-left" @click="openDetail(r)">
            <div class="flex items-start justify-between gap-2">
              <span class="font-semibold truncate">{{ r.customer_name || 'Unknown customer' }}</span>
              <span class="shrink-0 text-[11px] font-medium rounded-full px-2 py-0.5" :class="statusFor(r).pill">
                {{ statusFor(r).label }}
              </span>
            </div>
            <p v-if="r.customer_address" class="text-xs text-muted-foreground truncate mt-0.5">{{ r.customer_address }}</p>
            <p class="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
              <span v-if="r.battery">{{ r.battery }}</span>
              <span v-if="r.price != null">{{ fmtPrice(r.price) }}</span>
              <span>{{ fmtDate(r.date_created) }}</span>
              <span v-if="r.attempt_count > 0">· {{ r.attempt_count }} attempt{{ r.attempt_count === 1 ? '' : 's' }}</span>
            </p>
          </button>
          <div v-if="isStuck(r) || r.send_to_zap" class="mt-2.5 flex items-center gap-2">
            <button
              v-if="!r.send_to_zap"
              type="button"
              class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-foreground text-background px-3 py-2 text-sm font-semibold active:scale-95 transition disabled:opacity-50"
              :disabled="busyId === r.record_id"
              @click="rePush(r)"
            >
              <span v-if="busyId === r.record_id">Re-pushing…</span>
              <span v-else-if="justPushed === r.record_id">✓ Re-pushed</span>
              <span v-else>↻ Re-push</span>
            </button>
            <span v-else class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 px-3 py-2 text-sm font-medium">
              Queued…
            </span>
          </div>
        </div>
      </div>

      <!-- Desktop: table -->
      <div class="hidden lg:block rounded-xl bg-card overflow-hidden">
        <table class="w-full text-sm">
          <thead class="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b">
            <tr>
              <th class="px-4 py-2.5 font-semibold">Customer</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
              <th class="px-4 py-2.5 font-semibold">Battery</th>
              <th class="px-4 py-2.5 font-semibold">Created</th>
              <th class="px-4 py-2.5 font-semibold text-center">Attempts</th>
              <th class="px-4 py-2.5 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="r in visibleRows" :key="r.record_id" class="hover:bg-muted/40 transition">
              <td class="px-4 py-2.5">
                <button type="button" class="text-left hover:underline" @click="openDetail(r)">
                  <span class="font-medium">{{ r.customer_name || 'Unknown customer' }}</span>
                  <span v-if="r.customer_address" class="block text-xs text-muted-foreground truncate max-w-[280px]">{{ r.customer_address }}</span>
                </button>
              </td>
              <td class="px-4 py-2.5">
                <span class="text-[11px] font-medium rounded-full px-2 py-0.5" :class="statusFor(r).pill">{{ statusFor(r).label }}</span>
              </td>
              <td class="px-4 py-2.5 text-muted-foreground">{{ r.battery || '—' }}</td>
              <td class="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{{ fmtDate(r.date_created) }}</td>
              <td class="px-4 py-2.5 text-center tabular-nums text-muted-foreground">{{ r.attempt_count }}</td>
              <td class="px-4 py-2.5 text-right">
                <button
                  v-if="!r.send_to_zap"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg bg-foreground text-background px-2.5 py-1.5 text-xs font-semibold active:scale-95 transition disabled:opacity-50"
                  :disabled="busyId === r.record_id"
                  @click="rePush(r)"
                >
                  <span v-if="busyId === r.record_id">Re-pushing…</span>
                  <span v-else-if="justPushed === r.record_id">✓ Done</span>
                  <span v-else>↻ Re-push</span>
                </button>
                <span v-else class="text-xs text-blue-600 dark:text-blue-400 font-medium">Queued…</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Detail: bottom-sheet on mobile, right drawer on desktop -->
    <Sheet v-model:open="detailOpen">
      <SheetContent
        :side="sheetSide"
        class="overflow-y-auto p-0"
        :class="sheetSide === 'bottom' ? 'max-h-[85vh] rounded-t-2xl' : 'w-full sm:max-w-md'"
      >
        <div v-if="detailRow" class="p-4 grid gap-4">
          <!-- Header -->
          <div>
            <div class="flex items-start justify-between gap-2 pr-8">
              <h2 class="text-lg font-semibold">{{ detailRow.customer_name || 'Unknown customer' }}</h2>
              <span class="shrink-0 text-[11px] font-medium rounded-full px-2 py-0.5" :class="statusFor(detailRow).pill">
                {{ statusFor(detailRow).label }}
              </span>
            </div>
            <p v-if="detailRow.customer_address" class="text-sm text-muted-foreground mt-0.5">{{ detailRow.customer_address }}</p>
          </div>

          <!-- Primary action zone. Landed deals are done — no Re-push (it would
               re-run intake and could overwrite manual QB edits). -->
          <div v-if="isLanded(detailRow)" class="w-full text-center rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 px-4 py-3 text-sm font-medium">
            ✓ Landed · Project #{{ detailRow.project_record_id }}
          </div>
          <button
            v-else-if="!detailRow.send_to_zap"
            type="button"
            class="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-foreground text-background px-4 py-3 text-sm font-semibold active:scale-[0.98] transition disabled:opacity-50"
            :disabled="busyId === detailRow.record_id"
            @click="rePush(detailRow)"
          >
            <span v-if="busyId === detailRow.record_id">Re-pushing…</span>
            <span v-else-if="justPushed === detailRow.record_id">✓ Re-pushed — updating…</span>
            <span v-else>↻ Re-push this deal</span>
          </button>
          <div v-else class="w-full text-center rounded-xl bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 px-4 py-3 text-sm font-medium">
            Queued — re-processing shortly
          </div>

          <!-- Error / missing (when stuck) -->
          <div v-if="detailRow.intake_error" class="rounded-lg bg-rose-50 dark:bg-rose-950/30 p-3">
            <p class="text-[11px] font-semibold uppercase tracking-wider text-rose-600 mb-1">Error</p>
            <p class="text-sm text-rose-700 dark:text-rose-400 break-words">{{ detailRow.intake_error }}</p>
            <p v-if="detailRow.intake_step" class="text-xs text-rose-600/80 mt-1">Stopped at: {{ detailRow.intake_step }}</p>
          </div>
          <div v-if="missingItems(detailRow).length" class="rounded-lg bg-amber-50 dark:bg-amber-950/25 p-3">
            <p class="text-[11px] font-semibold uppercase tracking-wider text-amber-700 mb-1">Missing data</p>
            <ul class="text-sm text-amber-800 dark:text-amber-300 list-disc pl-4 space-y-0.5">
              <li v-for="(m, i) in missingItems(detailRow)" :key="i">{{ m }}</li>
            </ul>
          </div>

          <!-- Facts grid -->
          <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div v-if="detailRow.battery">
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Battery</dt>
              <dd>{{ detailRow.battery }}</dd>
            </div>
            <div v-if="detailRow.price != null">
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Price</dt>
              <dd>{{ fmtPrice(detailRow.price) }}</dd>
            </div>
            <div v-if="detailRow.rep">
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Rep</dt>
              <dd>{{ detailRow.rep }}</dd>
            </div>
            <div v-if="detailRow.source">
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Source</dt>
              <dd>{{ detailRow.source }}</dd>
            </div>
            <div>
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Created</dt>
              <dd>{{ fmtDateTime(detailRow.date_created) }}</dd>
            </div>
            <div>
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Attempts</dt>
              <dd>{{ detailRow.attempt_count }}<span v-if="detailRow.last_attempt" class="text-muted-foreground"> · last {{ relOf(detailRow.last_attempt) }}</span></dd>
            </div>
            <div v-if="detailRow.proposal_id" class="col-span-2">
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Proposal ID</dt>
              <dd class="font-mono text-xs break-all">{{ detailRow.proposal_id }}</dd>
            </div>
            <div v-if="detailRow.test_signals" class="col-span-2">
              <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Test signals</dt>
              <dd class="text-xs">{{ detailRow.test_signals }}</dd>
            </div>
          </dl>

          <!-- Deep links -->
          <div class="grid gap-2 pt-1">
            <a
              v-if="detailRow.project_url"
              :href="detailRow.project_url" target="_blank" rel="noopener"
              class="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-medium hover:bg-muted/70 transition"
            >Open Project #{{ detailRow.project_record_id }} ↗</a>
            <a
              :href="detailRow.qb_url" target="_blank" rel="noopener"
              class="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-medium hover:bg-muted/70 transition"
            >View raw payload in QuickBase ↗</a>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  </MilestoneShell>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
