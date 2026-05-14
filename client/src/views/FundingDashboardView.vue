<script setup lang="ts">
// Funding department dashboard — milestone toggle (M1 / M2 / M3 / DCA),
// canonical KPI tiles per milestone, click-to-drill audit dropdowns
// (B&B pattern), and a per-lender pivot for the selected milestone.
// Follows docs/ui-component-specs.md for sizing, color tokens, and
// table shapes.
import { computed, ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import DataFreshness from '@/components/DataFreshness.vue'
import { openProjectWithEvent } from '@/lib/openProject'
import { localTodayIso } from '@/lib/dates'

type Milestone = 'M1' | 'M2' | 'M3' | 'DCA'
type MilestoneMode = Milestone | 'ALL'
const NUMERIC_MILESTONES: Milestone[] = ['M1', 'M2', 'M3', 'DCA']

interface Bucket { count: number; expectedAmount: number; label: string }
interface MilestoneSummary {
  buckets: Record<string, Bucket>
  followUp?: { count: number; expectedAmount: number }
}
interface Overview {
  asOf: string
  activeMilestone: Milestone
  milestones: Record<Milestone, MilestoneSummary>
  byLender: Array<{ lender: string; status: string; count: number; expectedAmount: number }>
}
interface AuditRow {
  recordId: number
  customerName: string
  state: string; status: string; lender: string
  salesDate: string; installScheduled: string; installCompleted: string
  milestoneStatus: string
  milestoneRequestedDate: string; milestoneApprovedDate: string
  milestoneRejectedDate: string;  milestoneDepositDate: string
  milestoneExpectedAmount: number; milestoneNetReceived: number
  systemPrice: number; systemSizeKw: number
}

const auth = useAuthStore()
const router = useRouter()
const overview = ref<Overview | null>(null)
const loading = ref(true)
const err = ref('')

// Selected milestone — persists in localStorage so a coordinator
// returning to the page stays on the milestone they were last on.
const STORAGE_KEY = 'funding.milestone.v1'
function readStored(): MilestoneMode {
  if (typeof localStorage === 'undefined') return 'M2'
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'M1' || v === 'M2' || v === 'M3' || v === 'DCA' || v === 'ALL' ? v : 'M2'
}
const milestone = ref<MilestoneMode>(readStored())

// Per-bucket audit state. Lazy-loaded on first expand; cached after
// to keep toggle interactions snappy.
const auditOpen = ref<Record<string, boolean>>({})
const auditRows = ref<Record<string, AuditRow[]>>({})
const auditLoading = ref<Record<string, boolean>>({})

function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

async function loadOverview() {
  loading.value = true
  err.value = ''
  try {
    // /overview returns counts for every milestone in one shot; the
    // `milestone` param only picks which one's lender pivot to include.
    // ALL mode doesn't show a pivot, so default to M2 for that query.
    const queryMs = milestone.value === 'ALL' ? 'M2' : milestone.value
    const res = await fetch(`/api/funding/overview?milestone=${queryMs}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    overview.value = await res.json() as Overview
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadAudit(bucketKey: string) {
  if (auditRows.value[bucketKey]) return
  auditLoading.value[bucketKey] = true
  try {
    const res = await fetch(`/api/funding/audit?bucket=${encodeURIComponent(bucketKey)}`, { headers: hdrs() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { rows: AuditRow[] }
    auditRows.value[bucketKey] = data.rows
  } catch {
    auditRows.value[bucketKey] = []
  } finally {
    auditLoading.value[bucketKey] = false
  }
}

async function toggleAudit(bucketKey: string) {
  const next = !auditOpen.value[bucketKey]
  auditOpen.value[bucketKey] = next
  if (next) await loadAudit(bucketKey)
}

function setMilestone(m: MilestoneMode) {
  if (milestone.value === m) return
  milestone.value = m
  try { localStorage.setItem(STORAGE_KEY, m) } catch { /* ignore */ }
  // Clear any open audits — they're milestone-specific.
  auditOpen.value = {}
  loadOverview()
}

onMounted(loadOverview)
watch(milestone, () => {
  // Re-fetch when milestone changes via toggle.
  auditRows.value = {}
})

function openProject(rid: number, e?: MouseEvent) { openProjectWithEvent(router, rid, e) }

// ─── Formatting ───────────────────────────────────────────────
function fmtMoney(n: number): string {
  if (!n) return '$0'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}
function fmtNum(n: number): string { return Math.round(n).toLocaleString() }
function fmtAuditDate(s: string): string { return s ? s.slice(0, 10) : '—' }

function daysSinceNum(s: string): number | null {
  if (!s) return null
  const then = new Date(s.slice(0, 10) + 'T00:00:00').getTime()
  if (!Number.isFinite(then)) return null
  const now = new Date(localTodayIso() + 'T00:00:00').getTime()
  const d = Math.floor((now - then) / 86400000)
  return d >= 0 ? d : null
}
function daysSince(s: string): string {
  const d = daysSinceNum(s)
  return d === null ? '—' : `${d}d`
}

// Install cell: completed = green "C", scheduled future = blue "S",
// scheduled past + not complete = red "S" (overdue install).
function installCell(r: AuditRow): { text: string; tone: string } {
  if (r.installCompleted) return { text: `C ${r.installCompleted.slice(0, 10)}`, tone: 'text-emerald-600' }
  if (r.installScheduled) {
    const date = r.installScheduled.slice(0, 10)
    const overdue = date < localTodayIso()
    return { text: `S ${date}`, tone: overdue ? 'text-rose-600' : 'text-sky-600' }
  }
  return { text: '—', tone: 'text-muted-foreground' }
}

// Milestone date cell: received > rejected > approved > submitted.
function milestoneCell(r: AuditRow): { text: string; tone: string } {
  const received = !!r.milestoneDepositDate && r.milestoneNetReceived > 0
  if (received) return { text: r.milestoneDepositDate.slice(0, 10), tone: 'text-emerald-600' }
  if (r.milestoneRejectedDate) return { text: `R ${r.milestoneRejectedDate.slice(0, 10)}`, tone: 'text-rose-600' }
  if (r.milestoneApprovedDate) return { text: `A ${r.milestoneApprovedDate.slice(0, 10)}`, tone: 'text-amber-600' }
  if (r.milestoneRequestedDate) return { text: `S ${r.milestoneRequestedDate.slice(0, 10)}`, tone: 'text-sky-600' }
  return { text: '—', tone: 'text-muted-foreground' }
}

// ─── Milestone toggle metadata ────────────────────────────────
const MILESTONES: Array<{ key: MilestoneMode; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'M1',  label: 'M1' },
  { key: 'M2',  label: 'M2' },
  { key: 'M3',  label: 'M3' },
  { key: 'DCA', label: 'DCA' },
]

// Accent palette per bucket — canonical color tokens only.
// Sky = primary, Violet = secondary, Emerald = success-leaning,
// Slate = inactive, Amber = warning, Rose = actionable failure.
type Accent = 'sky' | 'violet' | 'emerald' | 'slate' | 'amber' | 'rose'
const ACCENT_MAP: Record<string, Accent> = {
  // M1/M2/M3 share the same accent vocabulary; bucket key suffix wins.
  ready: 'sky', pending: 'violet', approved: 'emerald', notReady: 'slate',
  // DCA-specific
  createEvent: 'sky', pendingDeposit: 'emerald', overdue: 'rose', pendingM3: 'slate',
}
function accentFor(bucketKey: string): Accent {
  const suffix = bucketKey.split(':')[1] || ''
  return ACCENT_MAP[suffix] || 'sky'
}
// Tailwind needs literal class names — return the full token string.
function stripClass(accent: Accent): string {
  return ({ sky: 'bg-sky-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', slate: 'bg-slate-400', amber: 'bg-amber-500', rose: 'bg-rose-500' })[accent]
}
function textClass(accent: Accent): string {
  return ({ sky: 'text-sky-600', violet: 'text-violet-600', emerald: 'text-emerald-600', slate: 'text-slate-600', amber: 'text-amber-600', rose: 'text-rose-600' })[accent]
}

// Bucket views for a given milestone — status buckets followed by the
// stale follow-up bucket (for M1/M2/M3 only) so both sit in the same
// KPI grid. DCA has no follow-up. Used for both the KPI tile group
// and the audit-section dropdowns.
interface BucketView { key: string; bucket: Bucket; accent: Accent }
function bucketsForMilestone(m: Milestone): BucketView[] {
  if (!overview.value) return []
  const ms = overview.value.milestones[m]
  const list: BucketView[] = Object.entries(ms.buckets).map(([key, bucket]) => ({
    key, bucket, accent: accentFor(key),
  }))
  if (ms.followUp && m !== 'DCA') {
    list.push({
      key: `${m}:followUp`,
      bucket: { count: ms.followUp.count, expectedAmount: ms.followUp.expectedAmount, label: 'Stale Follow-Up' },
      accent: 'rose',
    })
  }
  return list
}

const activeBuckets = computed<BucketView[]>(() => {
  if (milestone.value === 'ALL') return []
  return bucketsForMilestone(milestone.value)
})

// Grid columns scale to the bucket count so DCA's 4-tile group stays
// 4-up while M1/M2/M3's 5-tile group lays out 5-up on lg.
function gridClassFor(count: number): string {
  if (count >= 5) return 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 min-w-0'
  return 'grid grid-cols-2 sm:grid-cols-4 gap-2 min-w-0'
}

const activeFollowUp = computed(() => {
  if (!overview.value || milestone.value === 'ALL') return null
  return overview.value.milestones[milestone.value]?.followUp ?? null
})

// Follow-up has its own bucket key on the server (M1:followUp etc.) so
// the click-to-drill audit can hit /api/funding/audit with the same
// contract as the other tiles. DCA doesn't have a follow-up bucket.
const followUpKey = computed(() => milestone.value === 'DCA' ? null : `${milestone.value}:followUp`)

// Lender pivot helpers — same shape as the M2-only version, but
// dynamically derived from the active milestone's actionable statuses.
const STATUSES_BY_MS: Record<Milestone, string[]> = {
  M1: ['Ready to Request M1', 'Pending M1 Approval', 'M1 Approved', 'Not Ready for M1'],
  M2: ['Ready to Request M2', 'Pending M2 Approval', 'M2 Approved', 'Not Ready for M2'],
  M3: ['Ready to Request M3', 'Pending M3 Approval', 'M3 Approved', 'Not Ready for M3'],
  DCA: ['Create DCA Event', 'Pending DCA Deposit', 'DCA Overdue', 'Pending M3'],
}
const STATUS_SHORT: Record<string, string> = {
  'Ready to Request M1': 'Ready', 'Pending M1 Approval': 'Pending', 'M1 Approved': 'Approved · Not Recv', 'Not Ready for M1': 'Not Ready',
  'Ready to Request M2': 'Ready', 'Pending M2 Approval': 'Pending', 'M2 Approved': 'Approved · Not Recv', 'Not Ready for M2': 'Not Ready',
  'Ready to Request M3': 'Ready', 'Pending M3 Approval': 'Pending', 'M3 Approved': 'Approved · Not Recv', 'Not Ready for M3': 'Not Ready',
  'Create DCA Event': 'Create Event', 'Pending DCA Deposit': 'Pending Dep', 'DCA Overdue': 'Overdue', 'Pending M3': 'Pending M3',
}
const lenderRows = computed(() => {
  if (!overview.value || milestone.value === 'ALL') return []
  const cols = STATUSES_BY_MS[milestone.value]
  const map = new Map<string, { lender: string; cells: Record<string, Bucket>; totalCount: number; totalAmount: number }>()
  for (const r of overview.value.byLender) {
    let row = map.get(r.lender)
    if (!row) { row = { lender: r.lender, cells: {}, totalCount: 0, totalAmount: 0 }; map.set(r.lender, row) }
    row.cells[r.status] = { count: r.count, expectedAmount: r.expectedAmount, label: r.status }
    row.totalCount += r.count
    row.totalAmount += r.expectedAmount
  }
  return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount).map(row => ({ ...row, cols }))
})
const lenderTotals = computed(() => {
  if (milestone.value === 'ALL') return { perStatus: {}, totalCount: 0, totalAmount: 0, cols: [] as string[] }
  const cols = STATUSES_BY_MS[milestone.value]
  const perStatus: Record<string, Bucket> = {}
  let totalCount = 0
  let totalAmount = 0
  for (const c of cols) perStatus[c] = { count: 0, expectedAmount: 0, label: c }
  for (const r of overview.value?.byLender ?? []) {
    if (!perStatus[r.status]) continue
    perStatus[r.status]!.count += r.count
    perStatus[r.status]!.expectedAmount += r.expectedAmount
    totalCount += r.count
    totalAmount += r.expectedAmount
  }
  return { perStatus, totalCount, totalAmount, cols }
})

// Audit summary for the collapsible header (count + $ across rows).
function auditSummary(bucketKey: string): { count: number; rev: number } {
  const rows = auditRows.value[bucketKey] || []
  return { count: rows.length, rev: Math.round(rows.reduce((s, r) => s + r.systemPrice, 0)) }
}

// Pull the milestone (M1/M2/M3/DCA) out of a bucket key — the audit
// drill needs this for column labels even when the global view is ALL.
function milestoneForBucket(bucketKey: string): Milestone {
  const head = bucketKey.split(':')[0]
  return (head === 'M1' || head === 'M2' || head === 'M3' || head === 'DCA') ? head : 'M2'
}
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Header: title + freshness on the left, as-of on the right -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">Funding</h1>
        <DataFreshness resource="projects" label="Cache" @refreshed="loadOverview" />
      </div>
      <p v-if="overview" class="text-[11px] tabular-nums text-muted-foreground self-end">
        As of {{ overview.asOf }}
      </p>
    </div>

    <!-- Milestone toggle (canonical segmented toggle) -->
    <div class="inline-flex rounded-md border overflow-hidden self-start" role="tablist" aria-label="Milestone">
      <button
        v-for="m in MILESTONES" :key="m.key"
        type="button"
        role="tab"
        :aria-selected="milestone === m.key"
        class="px-3 py-1.5 text-[11px] font-medium transition-colors cursor-pointer"
        :class="milestone === m.key ? 'bg-foreground text-background' : 'hover:bg-muted'"
        @click="setMilestone(m.key)"
      >
        {{ m.label }}
      </button>
    </div>

    <p v-if="loading" class="text-sm text-muted-foreground italic">Loading…</p>
    <div v-else-if="err" class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      Failed to load: {{ err }}
    </div>

    <template v-else-if="overview">
      <!-- ═══ KPI tiles · single-milestone view ═══ -->
      <section v-if="milestone !== 'ALL'" aria-label="Status KPIs" :class="gridClassFor(activeBuckets.length)">
        <button
          v-for="b in activeBuckets" :key="b.key"
          type="button"
          class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden text-left cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus:ring-2 focus:ring-foreground/10"
          :class="auditOpen[b.key] ? 'bg-muted/30 ring-2 ring-foreground/10' : ''"
          :title="`${b.bucket.label} — click to view projects`"
          @click="toggleAudit(b.key)"
        >
          <div class="absolute top-0 left-0 right-0 h-[3px]" :class="stripClass(b.accent)" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ b.bucket.label }}</p>
          <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xl font-extrabold tabular-nums leading-none" :class="textClass(b.accent)">{{ fmtNum(b.bucket.count) }}</span>
            <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtMoney(b.bucket.expectedAmount) }}</span>
          </p>
          <p class="mt-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
            {{ auditOpen[b.key] ? 'expected · ▾ open' : 'expected · ▸ tap to drill' }}
          </p>
        </button>
      </section>

      <!-- ═══ KPI tiles · ALL view ═══ Stacked per-milestone tile groups
           with their own section heading. Tiles are click-to-drill — the
           audit list at the bottom aggregates open buckets across all
           milestones into a single section. -->
      <template v-else>
        <section
          v-for="m in NUMERIC_MILESTONES" :key="`tiles-${m}`"
          :aria-label="`${m} status KPIs`"
          class="grid gap-2 min-w-0"
        >
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{{ m }}</p>
          <div :class="gridClassFor(bucketsForMilestone(m).length)">
            <button
              v-for="b in bucketsForMilestone(m)" :key="b.key"
              type="button"
              class="rounded-xl border bg-card p-3 min-w-0 relative overflow-hidden text-left cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus:ring-2 focus:ring-foreground/10"
              :class="auditOpen[b.key] ? 'bg-muted/30 ring-2 ring-foreground/10' : ''"
              :title="`${b.bucket.label} — click to view projects`"
              @click="toggleAudit(b.key)"
            >
              <div class="absolute top-0 left-0 right-0 h-[3px]" :class="stripClass(b.accent)" />
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ b.bucket.label }}</p>
              <p class="mt-1 flex items-baseline gap-1.5 min-w-0">
                <span class="text-2xl font-extrabold tabular-nums leading-none" :class="textClass(b.accent)">{{ fmtNum(b.bucket.count) }}</span>
                <span class="text-[11px] font-semibold tabular-nums text-muted-foreground truncate">/ {{ fmtMoney(b.bucket.expectedAmount) }}</span>
              </p>
              <p class="mt-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
                {{ auditOpen[b.key] ? 'expected · ▾ open' : 'expected · ▸ tap to drill' }}
              </p>
            </button>
          </div>
        </section>
      </template>

      <!-- ═══ Audit · per-KPI dropdowns (B&B pattern) ═══ -->
      <section class="space-y-2">
        <div class="flex items-baseline gap-2 flex-wrap">
          <h2 class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">AUDIT · {{ milestone === 'ALL' ? 'ALL BUCKETS' : `${milestone} BUCKETS` }}</h2>
          <p class="text-[10px] text-muted-foreground italic">Click a section to expand</p>
        </div>
        <div
          v-for="b in (milestone === 'ALL' ? NUMERIC_MILESTONES.flatMap(bucketsForMilestone) : activeBuckets)" :key="`audit-${b.key}`"
          class="rounded-xl border bg-card overflow-hidden min-w-0"
        >
          <button
            type="button"
            class="w-full px-3 py-2 flex items-baseline justify-between gap-2 hover:bg-muted/30 transition-colors cursor-pointer"
            :aria-expanded="!!auditOpen[b.key]"
            @click="toggleAudit(b.key)"
          >
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="text-[10px] text-muted-foreground">{{ auditOpen[b.key] ? '▾' : '▸' }}</span>
              <span class="text-[11px] font-semibold" :class="textClass(b.accent)">{{ b.bucket.label }}</span>
              <span class="text-[10px] tabular-nums text-muted-foreground">{{ fmtNum(b.bucket.count) }} · {{ fmtMoney(b.bucket.expectedAmount) }} expected</span>
            </div>
            <p v-if="auditOpen[b.key]" class="text-[10px] tabular-nums shrink-0 text-muted-foreground">
              loaded {{ fmtNum(auditSummary(b.key).count) }} · {{ fmtMoney(auditSummary(b.key).rev) }} system $
            </p>
          </button>
          <div v-if="auditOpen[b.key]">
            <p v-if="auditLoading[b.key]" class="px-3 pb-3 text-[11px] text-muted-foreground italic">Loading audit…</p>
            <div v-else-if="(auditRows[b.key] || []).length === 0" class="px-3 pb-3 text-[11px] text-muted-foreground italic">No records in this bucket.</div>
            <template v-else>
              <!-- Desktop table -->
              <div class="hidden sm:block overflow-auto max-h-[480px] border-t">
                <table class="w-full text-[11px] tabular-nums">
                  <thead class="bg-muted/30 text-muted-foreground sticky top-0">
                    <tr>
                      <th class="text-left font-medium px-3 py-2">Customer</th>
                      <th class="text-left font-medium px-2 py-2">State</th>
                      <th class="text-left font-medium px-2 py-2">Status</th>
                      <th class="text-left font-medium px-2 py-2">Lender</th>
                      <th class="text-left font-medium px-2 py-2">Sale</th>
                      <th class="text-left font-medium px-2 py-2">Install</th>
                      <th class="text-left font-medium px-2 py-2">{{ milestoneForBucket(b.key) }}</th>
                      <th class="text-right font-medium px-2 py-2" title="Days since milestone was requested">Req·d</th>
                      <th class="text-right font-medium px-2 py-2" title="Days since install was scheduled">Sched·d</th>
                      <th class="text-right font-medium px-3 py-2">Expected</th>
                      <th class="text-right font-medium px-2 py-2">kW</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y">
                    <tr
                      v-for="r in (auditRows[b.key] || [])" :key="r.recordId"
                      class="hover:bg-muted/30 cursor-pointer"
                      @click="openProject(r.recordId, $event)"
                      @auxclick.prevent="openProject(r.recordId, $event)"
                    >
                      <td class="px-3 py-1.5 font-medium truncate max-w-[180px]" :title="r.customerName">{{ r.customerName || '—' }}</td>
                      <td class="px-2 py-1.5 truncate max-w-[80px]">{{ r.state || '—' }}</td>
                      <td class="px-2 py-1.5 truncate max-w-[100px]">{{ r.status || '—' }}</td>
                      <td class="px-2 py-1.5 truncate max-w-[120px]">{{ r.lender || '—' }}</td>
                      <td class="px-2 py-1.5 font-mono text-muted-foreground">{{ fmtAuditDate(r.salesDate) }}</td>
                      <td class="px-2 py-1.5 font-mono font-semibold" :class="installCell(r).tone">{{ installCell(r).text }}</td>
                      <td class="px-2 py-1.5 font-mono font-semibold" :class="milestoneCell(r).tone">{{ milestoneCell(r).text }}</td>
                      <td class="text-right px-2 py-1.5 text-muted-foreground">{{ daysSince(r.milestoneRequestedDate) }}</td>
                      <td class="text-right px-2 py-1.5 text-muted-foreground">{{ daysSince(r.installScheduled) }}</td>
                      <td class="text-right px-3 py-1.5">{{ fmtMoney(r.milestoneExpectedAmount) }}</td>
                      <td class="text-right px-2 py-1.5 text-muted-foreground">{{ Math.round(r.systemSizeKw * 10) / 10 }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <!-- Mobile cards -->
              <div class="sm:hidden divide-y border-t">
                <div
                  v-for="r in (auditRows[b.key] || [])" :key="`m-${r.recordId}`"
                  class="px-3 py-2 min-w-0 cursor-pointer hover:bg-muted/30"
                  @click="openProject(r.recordId, $event)"
                  @auxclick.prevent="openProject(r.recordId, $event)"
                >
                  <div class="flex items-baseline justify-between gap-2 min-w-0">
                    <p class="font-semibold text-[12px] truncate" :title="r.customerName">{{ r.customerName || '—' }}</p>
                    <p class="text-[10px] tabular-nums text-muted-foreground shrink-0">{{ fmtMoney(r.milestoneExpectedAmount) }}</p>
                  </div>
                  <p class="text-[10px] text-muted-foreground truncate">{{ r.state || '—' }} · {{ r.lender || '—' }} · {{ r.status || '—' }}</p>
                  <div class="grid grid-cols-3 gap-1.5 mt-1.5 text-[10px] tabular-nums">
                    <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                      <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Install</p>
                      <p class="font-semibold" :class="installCell(r).tone">{{ installCell(r).text }}</p>
                    </div>
                    <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                      <p class="text-[9px] uppercase tracking-wider text-muted-foreground">{{ milestoneForBucket(b.key) }}</p>
                      <p class="font-semibold" :class="milestoneCell(r).tone">{{ milestoneCell(r).text }}</p>
                    </div>
                    <div class="rounded bg-muted/30 px-2 py-1 min-w-0">
                      <p class="text-[9px] uppercase tracking-wider text-muted-foreground">Req · d</p>
                      <p class="font-semibold">{{ daysSince(r.milestoneRequestedDate) }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>

      <!-- ═══ Status by Lender — pivot for the active milestone only;
           hidden in ALL mode since lender breakdown is per-milestone. -->
      <div v-if="milestone !== 'ALL'" class="rounded-xl border bg-card overflow-hidden min-w-0">
        <div class="px-3 py-2 border-b flex items-baseline justify-between gap-2 flex-wrap">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{{ milestone }} STATUS · BY LENDER</p>
          <p class="text-[10px] text-muted-foreground tabular-nums">{{ lenderRows.length }} lender{{ lenderRows.length === 1 ? '' : 's' }} · sorted by total $</p>
        </div>
        <div v-if="lenderRows.length === 0" class="px-3 py-6 text-center text-[11px] text-muted-foreground italic">
          No projects in actionable {{ milestone }} statuses.
        </div>
        <template v-else>
          <div class="hidden sm:block">
            <table class="w-full text-[11px] tabular-nums">
              <thead class="bg-muted/30 text-muted-foreground">
                <tr>
                  <th class="text-left font-medium px-3 py-2">Lender</th>
                  <th v-for="s in lenderTotals.cols" :key="s" class="text-right font-medium px-2 py-2">{{ STATUS_SHORT[s] || s }}</th>
                  <th class="text-right font-medium px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="row in lenderRows" :key="row.lender" class="hover:bg-muted/30">
                  <td class="px-3 py-1.5 font-medium truncate max-w-[200px]" :title="row.lender">{{ row.lender }}</td>
                  <td v-for="s in row.cols" :key="s" class="text-right px-2 py-1.5">
                    <template v-if="row.cells[s]">
                      <span class="font-semibold">{{ row.cells[s]!.count }}</span>
                      <span class="text-[10px] text-muted-foreground ml-1">{{ fmtMoney(row.cells[s]!.expectedAmount) }}</span>
                    </template>
                    <span v-else class="text-muted-foreground">—</span>
                  </td>
                  <td class="text-right px-3 py-1.5 font-semibold">
                    {{ row.totalCount }}
                    <span class="text-[10px] text-muted-foreground font-normal ml-1">{{ fmtMoney(row.totalAmount) }}</span>
                  </td>
                </tr>
              </tbody>
              <tfoot class="border-t-2 bg-muted/20 font-semibold">
                <tr>
                  <td class="px-3 py-1.5">Total</td>
                  <td v-for="s in lenderTotals.cols" :key="s" class="text-right px-2 py-1.5">
                    {{ lenderTotals.perStatus[s]!.count }}
                    <span class="text-[10px] text-muted-foreground font-normal ml-1">{{ fmtMoney(lenderTotals.perStatus[s]!.expectedAmount) }}</span>
                  </td>
                  <td class="text-right px-3 py-1.5">
                    {{ lenderTotals.totalCount }}
                    <span class="text-[10px] text-muted-foreground font-normal ml-1">{{ fmtMoney(lenderTotals.totalAmount) }}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div class="sm:hidden divide-y">
            <div v-for="row in lenderRows" :key="row.lender" class="px-3 py-2 min-w-0">
              <div class="flex items-baseline justify-between gap-2 min-w-0">
                <p class="font-semibold text-[12px] truncate" :title="row.lender">{{ row.lender }}</p>
                <p class="text-[10px] tabular-nums text-muted-foreground shrink-0">{{ row.totalCount }} · {{ fmtMoney(row.totalAmount) }}</p>
              </div>
              <div class="grid grid-cols-2 gap-1.5 mt-1.5 text-[10px] tabular-nums">
                <div v-for="s in row.cols" :key="s" class="rounded bg-muted/30 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground truncate">{{ STATUS_SHORT[s] || s }}</p>
                  <p class="font-semibold">
                    <template v-if="row.cells[s]">
                      {{ row.cells[s]!.count }}
                      <span class="text-[9px] text-muted-foreground font-normal ml-1">{{ fmtMoney(row.cells[s]!.expectedAmount) }}</span>
                    </template>
                    <span v-else class="text-muted-foreground">—</span>
                  </p>
                </div>
              </div>
            </div>
            <div class="px-3 py-2 bg-muted/30 min-w-0">
              <p class="font-semibold text-[12px]">Total</p>
              <div class="grid grid-cols-2 gap-1.5 mt-1 text-[10px] tabular-nums">
                <div v-for="s in lenderTotals.cols" :key="s" class="rounded bg-muted/40 px-2 py-1 min-w-0">
                  <p class="text-[9px] uppercase tracking-wider text-muted-foreground truncate">{{ STATUS_SHORT[s] || s }}</p>
                  <p class="font-semibold">
                    {{ lenderTotals.perStatus[s]!.count }}
                    <span class="text-[9px] text-muted-foreground font-normal ml-1">{{ fmtMoney(lenderTotals.perStatus[s]!.expectedAmount) }}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
