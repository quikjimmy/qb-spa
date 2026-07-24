<script setup lang="ts">
// Field Ops — Crew Lifecycle scorecard. A filterable install COHORT: pick a time
// period + the standard dropdown filters; every KPI + the crew leaderboard
// reflect installs completed in that window. Mirrors the crew-scorecard
// reference (app design system). RTR Pass/Fail/Coach and Service Category are
// intentionally omitted — those fields are empty in the live QB/Arrivy data.

import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import MilestoneFilterBar, { type FilterDef } from '@/components/milestone/MilestoneFilterBar.vue'
import MarkdownMessage from '@/components/chat/MarkdownMessage.vue'
import ProjectDetailDialog from '@/components/milestone/ProjectDetailDialog.vue'
import { renderMarkdown } from '@/lib/markdown'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, MarkAreaComponent, DataZoomComponent } from 'echarts/components'

use([CanvasRenderer, BarChart, LineChart, GridComponent, TooltipComponent, MarkAreaComponent, DataZoomComponent])

const auth = useAuthStore()

interface Crew {
  crew: string; type: 'W2' | 'Sub' | 'Unassigned'; installs: number; kw: number
  firstTimeCount: number; firstTimeRate: number; avgDaysI2I: number; avgRolls: number
  ptoCount: number; ptoRate: number; onRoutePct: number; onSitePct: number; submittedPct: number; techCompletePct: number; oneTouchRate: number
}
type CrewTotals = Omit<Crew, 'crew' | 'type' | 'techCompletePct' | 'oneTouchRate'>
interface SegMetrics { installs: number; kw: number; firstTimeRate: number; avgRolls: number; avgDaysI2I: number; ptoRate: number }
interface Proj { recordId: number; crew: string; type: string; customer: string; installDate: string; kw: number; passed: boolean; firstTime: boolean; daysI2I: number | null; rolls: number; oneTouch: boolean; pto: string }
interface FundRow { recordId: number; customer: string; state: string; installDate: string; days: number; status: string; resolved: boolean }
interface FundDelay {
  cohortSize: number; fieldReached: number; requested: number; avgGapDays: number
  openCount: number; cantSubmitCount: number; delayRate: number; delayedCount: number
  delayed: FundRow[]
  open: FundRow[]
  notReady: Array<{ recordId: number; customer: string; state: string; status: string; lender: string; installDate: string }>
}
interface Overview {
  from: string; to: string
  headline: { installs: number; kw: number; passed: number; inspPassRate: number; awaitingInspx: number; firstTimeRate: number; avgDaysI2I: number; avgDaysI2IPermitted: number; noPermitAtInstall: number; avgRolls: number; oneTouchRate: number; ptoRate: number }
  crews: Crew[]
  crewTotals: CrewTotals | null
  byType: Array<{ type: string; installs: number; kw: number }>
  batteryMix: { battery: SegMetrics; pv: SegMetrics } | null
  utilization: { basis: string; totalKw: number; w2Kw: number; subKw: number; w2Installs: number; subInstalls: number; w2Pct: number; subPct: number; w2CrewCount: number; weeks: number; kwPerCrewWeek: number; w2CapacityKw: number; w2UtilPct: number } | null
  utilizationMatrix: {
    weeks: string[]
    crews: Array<{ crew: string; type: string; cells: Array<{ installs: number; kw: number; util: number } | null>; total: { installs: number; kw: number } }>
    weeklyTotals: Array<{ installs: number; kw: number; w2Kw: number; subKw: number; w2Util: number; subMix: number }>
    grandTotal: { installs: number; kw: number; installsPerWeek: number; kwPerWeek: number }
  } | null
  funding: { m2: FundDelay; m3: FundDelay } | null
  projects: Proj[]
  throughput: Array<{ week: string; count: number; kw: number }>
  filters: { states: string[]; offices: string[]; coordinators: string[]; closers: string[]; lenders: string[]; epcs: string[] }
}

const data = ref<Overview | null>(null)
const loading = ref(true)
const error = ref('')

// ── Time-period quick selectors ──
type Period = 'this_week' | 'next_week' | 'this_month' | 'last_month' | 'this_quarter' | 'last_30' | 'last_90' | 'ytd' | 'custom'
const PERIODS: Array<{ k: Period; l: string }> = [
  { k: 'this_week', l: 'This Week' }, { k: 'next_week', l: 'Next Week' }, { k: 'this_month', l: 'This Month' }, { k: 'last_month', l: 'Last Month' },
  { k: 'this_quarter', l: 'This Quarter' }, { k: 'last_30', l: 'Last 30d' }, { k: 'last_90', l: 'Last 90d' }, { k: 'ytd', l: 'YTD' }, { k: 'custom', l: 'Custom' },
]
const period = ref<Period>('this_month')
const customFrom = ref(''); const customTo = ref('')
function iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function rangeFor(p: Period): { from: string; to: string } {
  const now = new Date(); const to = iso(now); const y = now.getFullYear(), m = now.getMonth()
  const shift = (days: number) => { const d = new Date(now); d.setDate(d.getDate() - days); return iso(d) }
  switch (p) {
    case 'custom': return { from: customFrom.value || iso(new Date(y, m, 1)), to: customTo.value || to }
    case 'this_week': { const dow = now.getDay(); return { from: shift(dow === 0 ? 6 : dow - 1), to } }
    case 'next_week': {
      // Next Monday … next Sunday — a forward planning window. Completed-cohort
      // KPIs are empty (future); the scheduled utilization matrix carries it.
      const dow = now.getDay(); const toMon = dow === 0 ? 6 : dow - 1
      const mon = new Date(now); mon.setDate(mon.getDate() - toMon + 7)
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6)
      return { from: iso(mon), to: iso(sun) }
    }
    case 'this_month': return { from: iso(new Date(y, m, 1)), to }
    case 'last_month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case 'this_quarter': return { from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to }
    case 'last_30': return { from: shift(30), to }
    case 'last_90': return { from: shift(90), to }
    case 'ytd': return { from: `${y}-01-01`, to }
  }
}

// ── Filters ──
const fState = ref(''); const fOffice = ref(''); const fCoordinator = ref('')
const fCloser = ref(''); const fLender = ref(''); const fEpc = ref('')
const showBatteryOnly = ref(false)
// Shared filter params for the overview + trend endpoints.
function applyFilterParams(p: URLSearchParams) {
  if (fState.value) p.set('state', fState.value); if (fOffice.value) p.set('office', fOffice.value)
  if (fCoordinator.value) p.set('coordinator', fCoordinator.value); if (fCloser.value) p.set('closer', fCloser.value)
  if (fLender.value) p.set('lender', fLender.value); if (fEpc.value) p.set('epc', fEpc.value)
  if (showBatteryOnly.value) p.set('battery_only', '1')
}
function toggleBatteryOnly() { showBatteryOnly.value = !showBatteryOnly.value; load() }

function load() {
  loading.value = true
  const { from, to } = rangeFor(period.value)
  const p = new URLSearchParams({ from, to })
  applyFilterParams(p)
  fetch(`/api/field-ops/overview?${p}`, { headers: { Authorization: `Bearer ${auth.token}` } })
    .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
    .then(d => { data.value = d; error.value = ''; selectedCrew.value = null })
    .catch(e => { error.value = e instanceof Error ? e.message : String(e) })
    .finally(() => { loading.value = false })
  // Period/filters changed → any open trend must refetch for the new scope.
  inlinePoints.value = []
  if (trendTile.value) loadInline()
  if (trendLarge.value) loadLarge()
}
onMounted(load)
defineExpose({ refresh: load })
function setPeriod(p: Period) {
  // Seed the custom range from the current view the first time it's opened.
  if (p === 'custom' && (!customFrom.value || !customTo.value)) { const r = rangeFor(period.value === 'custom' ? 'this_month' : period.value); customFrom.value = r.from; customTo.value = r.to }
  period.value = p; load()
}
function applyCustom() { if (customFrom.value && customTo.value) load() }

const opts = computed(() => data.value?.filters ?? { states: [], offices: [], coordinators: [], closers: [], lenders: [], epcs: [] })
const filterDefs = computed<FilterDef[]>(() => [
  { key: 'state', placeholder: 'State', options: opts.value.states, value: fState.value },
  { key: 'office', placeholder: 'Office', options: opts.value.offices, value: fOffice.value },
  { key: 'coordinator', placeholder: 'PC', options: opts.value.coordinators, value: fCoordinator.value },
  { key: 'closer', placeholder: 'Closer', options: opts.value.closers, value: fCloser.value },
  { key: 'lender', placeholder: 'Lender', options: opts.value.lenders, value: fLender.value },
  { key: 'epc', placeholder: 'EPC', options: opts.value.epcs, value: fEpc.value },
])
const filterActive = computed(() => !!(fState.value || fOffice.value || fCoordinator.value || fCloser.value || fLender.value || fEpc.value))
function setFilter(key: string, value: string) {
  if (key === 'state') fState.value = value; else if (key === 'office') fOffice.value = value
  else if (key === 'coordinator') fCoordinator.value = value; else if (key === 'closer') fCloser.value = value
  else if (key === 'lender') fLender.value = value; else if (key === 'epc') fEpc.value = value
  load()
}
function resetFilters() { fState.value = ''; fOffice.value = ''; fCoordinator.value = ''; fCloser.value = ''; fLender.value = ''; fEpc.value = ''; load() }

// ── KPI tiles. `kw` renders as "/ N kW" in-accent; `info` is the disclaimer.
// `maturity` flags metrics that only mean something once a share of the cohort
// has matured (been inspected / reached PTO) — a low % = provisional. ──
type TrendKey = 'installs' | 'inspPassRate' | 'firstTimeRate' | 'avgDaysI2I' | 'avgRolls' | 'oneTouchRate' | 'ptoRate'
interface Tile { label: string; value: string | number; kw?: number; sub?: string; info?: string; accent: string; vtone: string; maturity?: { pct: number; label: string }; trendKey: TrendKey; unit: '%' | ''; foot?: number }
const tiles = computed<Tile[]>(() => {
  const h = data.value?.headline; if (!h) return []
  return [
    { label: 'Installs', value: h.installs, kw: h.kw, accent: 'bg-emerald-500', vtone: 'text-emerald-600', info: 'Installs completed in the selected period + filters.', trendKey: 'installs', unit: '' },
    { label: 'Insp Pass Rate', value: `${h.inspPassRate}%`, sub: `${h.passed} of ${h.installs} · ${h.awaitingInspx} awaiting`, accent: 'bg-teal-500', vtone: 'text-teal-600', info: 'Share of the WHOLE selected cohort with a passing inspection (not-yet-inspected count against it).', trendKey: 'inspPassRate', unit: '%' },
    { label: 'First-Time Pass', value: `${h.firstTimeRate}%`, accent: 'bg-teal-500', vtone: 'text-teal-600', info: 'Of installs that passed, the share that passed on the FIRST inspection attempt (≤1 inspection). Only reflects the inspected share of the cohort.', maturity: { pct: h.inspPassRate, label: 'inspected' }, trendKey: 'firstTimeRate', unit: '%', foot: 4 },
    { label: 'Avg Days I→I', value: h.avgDaysI2I, sub: h.noPermitAtInstall ? `${h.avgDaysI2IPermitted}d w/ permit @ install` : undefined, accent: 'bg-blue-500', vtone: 'text-blue-600', info: `Avg Days Install → Inspection — calendar days from install-completed to passing-inspection. ${h.noPermitAtInstall} install(s) here lacked an approved permit on install day; the permit wait inflates I→I. Permit-adjusted average (permitted on install day): ${h.avgDaysI2IPermitted} days.`, trendKey: 'avgDaysI2I', unit: '', foot: 5 },
    { label: 'Avg Truck Rolls', value: h.avgRolls, accent: 'bg-amber-500', vtone: 'text-amber-600', info: 'Avg post-install site visits per install — Arrivy Service / Inspection / Document / MPU tasks between install and PTO. Computed from Arrivy (QB roll field is unpopulated). Accrues until PTO, so it is provisional while few installs have reached PTO.', maturity: { pct: h.ptoRate, label: 'at PTO' }, trendKey: 'avgRolls', unit: '', foot: 2 },
    { label: '1-Touch Rate', value: `${h.oneTouchRate}%`, sub: 'excl. inspection', accent: 'bg-blue-500', vtone: 'text-blue-600', info: 'Installs with NO post-install return visit except routine inspection accompaniment. Accrues until PTO, so it is provisional while few installs have reached PTO.', maturity: { pct: h.ptoRate, label: 'at PTO' }, trendKey: 'oneTouchRate', unit: '%', foot: 3 },
    { label: 'PTO Approved', value: `${h.ptoRate}%`, accent: 'bg-emerald-500', vtone: 'text-emerald-600', info: 'Share of the selected cohort with PTO approved.', trendKey: 'ptoRate', unit: '%' },
  ]
})
// Numbered methodology — the superscripts on KPIs/columns index into this list.
const METHODOLOGY = [
  'Crew attribution, truck rolls, and On-Route / On-Site / Submitted come from Arrivy install & post-install tasks — the QuickBase crew, subcontractor and roll-count fields are unpopulated. W-2 = Ukaia + Humberto; all others = Sub.',
  'Avg Truck Rolls = post-install Arrivy site visits (Service / Inspection / Document / MPU) between install and PTO. Accrues until PTO, so it is provisional while few installs have reached PTO.',
  '1-Touch = an install whose only post-install visit is routine inspection accompaniment. Also accrues until PTO → provisional early.',
  'First-Time Pass = of installs that passed inspection, the share that passed on the first attempt (≤ 1 inspection). Only reflects the inspected share of the cohort.',
  'Avg Days I→I (install → inspection) = calendar days from the install-completed date to the passing-inspection date. Installs that lacked an approved permit on install day wait on the permit before inspection can happen, inflating I→I — the tile also shows the permit-adjusted average (installs permitted by install day).',
  'Funding gaps are business days (Mon–Fri, no holiday calendar). Delay Rate = share of the install cohort ever unable to request funds on time — request took > 5 business days (even once resolved), or it is still Not Ready / open past the SLA.',
  'Not Ready mirrors the Funding Dashboard\'s Not-Ready bucket (Kin Home; not funded / excluded / archived). It is a live whole-pipeline count scoped by state / closer / lender only, NOT limited to the selected install period.',
  'RTR Pass/Fail/Coach and Service-Category breakdown are omitted — not captured in the live QB/Arrivy data.',
]
// Maturity tone — always clearly colored (never muted) so the reader can see at
// a glance whether the metric above it is trustworthy: red (low) → amber →
// emerald (high/mature). Emerald here signals data completeness, not KPI value.
function maturityTone(pct: number) { return pct < 25 ? 'text-rose-600' : pct < 50 ? 'text-amber-600' : 'text-emerald-600' }

// ── Project drawer (shared ProjectDetailDialog) — click any listed project ──
type PeekRow = Record<string, unknown> & { record_id: number; customer_name: string }
const selectedPeekProject = ref<PeekRow | null>(null)
async function openProjectPeek(rid: number) {
  if (!Number.isFinite(rid) || rid <= 0) return
  try {
    const res = await fetch(`/api/projects/${rid}?live=0`, { headers: { Authorization: `Bearer ${auth.token}` } })
    if (!res.ok) return
    const d = await res.json() as { project?: PeekRow }
    if (d.project) selectedPeekProject.value = d.project
  } catch { /* silent — row stays clickable for retry */ }
}

// ── Crew drill-down ──
const selectedCrew = ref<string | null>(null)
function toggleCrew(c: string) { selectedCrew.value = selectedCrew.value === c ? null : c }
const crewProjects = computed(() => data.value && selectedCrew.value ? data.value.projects.filter(p => p.crew === selectedCrew.value) : [])

// ── Green = best in column ──
const best = computed(() => {
  const cs = data.value?.crews ?? []; if (!cs.length) return {} as Record<string, number>
  const max = (k: keyof Crew) => Math.max(...cs.map(c => Number(c[k])))
  const minNonZero = (k: keyof Crew) => { const v = cs.map(c => Number(c[k])).filter(x => x > 0); return v.length ? Math.min(...v) : 0 }
  return {
    installs: max('installs'), kw: max('kw'), firstTimeRate: max('firstTimeRate'), ptoRate: max('ptoRate'),
    onRoutePct: max('onRoutePct'), onSitePct: max('onSitePct'), submittedPct: max('submittedPct'),
    avgDaysI2I: minNonZero('avgDaysI2I'), avgRolls: minNonZero('avgRolls'), // lower is better
  } as Record<string, number>
})
function bestCls(key: string, v: number) { return v > 0 && best.value[key] === v ? 'text-emerald-600 font-bold' : 'text-muted-foreground' }

const typeBadge = (t: string) => t === 'W2' ? 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400'
  : t === 'Sub' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
  : 'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400'
const rateTone = (r: number) => r >= 90 ? 'text-emerald-600' : r >= 70 ? 'text-amber-600' : 'text-rose-600'

function fmtWeek(w: string) { const [, m, d] = w.split('-'); return `${m}/${d}` }
const throughputOption = computed(() => {
  const t = data.value?.throughput ?? []
  return {
    grid: { left: 26, right: 8, top: 22, bottom: 34 }, tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v}` },
    xAxis: {
      type: 'category', data: t.map(x => fmtWeek(x.week)), axisLine: { lineStyle: { color: '#cbd5e1' } }, axisTick: { show: false },
      // Two-line base label: the week on top, that week's summed kW (whole
      // number) beneath it. No extra series, so no points or connecting line.
      axisLabel: {
        color: '#94a3b8', fontSize: 9, lineHeight: 11, interval: 0,
        formatter: (val: string, idx: number) => `${val}\n{kw|${t[idx]?.kw ?? 0} kW}`,
        rich: { kw: { color: '#64748b', fontSize: 8, fontWeight: 600, padding: [2, 0, 0, 0] } },
      },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(148,163,184,0.18)' } }, axisLabel: { color: '#94a3b8', fontSize: 10 } },
    series: [{ type: 'bar', data: t.map(x => x.count), itemStyle: { color: '#10b981', borderRadius: [3, 3, 0, 0] }, label: { show: true, position: 'top', color: '#94a3b8', fontSize: 9 }, barMaxWidth: 26 }],
  }
})
const util = computed(() => data.value?.utilization)
const matrix = computed(() => data.value?.utilizationMatrix ?? null)
function utilCls(u: number | null): string {
  if (u == null) return 'text-muted-foreground/40'
  if (u >= 80) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
  if (u >= 50) return 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
  return 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
}
function wkLabel(w: string) { const [, m, d] = w.split('-'); return `${m}/${d}` }
const fundingBlocks = computed(() => {
  const f = data.value?.funding; if (!f) return []
  return [
    { m: 'M2', gate: 'install → request', reachedLabel: 'installs', d: f.m2 },
    { m: 'M3', gate: 'PTO → request', reachedLabel: 'PTO-approved', d: f.m3 },
  ]
})
// Battery-Only vs PV breakout — shown only when the battery segment is material
// (≥5 installs) and we're not already filtered to battery-only.
const showBatteryBreakout = computed(() => {
  const m = data.value?.batteryMix
  return !!m && !showBatteryOnly.value && m.battery.installs >= 5
})
const batterySmallSample = computed(() => (data.value?.batteryMix?.battery.installs ?? 0) < 15)
// Funding drill-down: click Delay Rate / Open / Not Ready to list its projects.
type DrillKind = 'delay' | 'open' | 'notReady'
const fundingDrill = ref<{ m: string; kind: DrillKind } | null>(null)
function toggleDrill(m: string, kind: DrillKind) {
  fundingDrill.value = (fundingDrill.value?.m === m && fundingDrill.value.kind === kind) ? null : { m, kind }
}
function drillActive(m: string, kind: DrillKind) { return fundingDrill.value?.m === m && fundingDrill.value.kind === kind }
const DRILL_LABEL: Record<DrillKind, string> = { delay: 'Delayed installs', open: 'Open — awaiting request', notReady: 'Not Ready — all active' }
function drillRows(col: { m: string; d: FundDelay }): Array<{ recordId: number; customer: string; state: string; installDate?: string; days?: number; status: string; resolved?: boolean; lender?: string }> {
  if (fundingDrill.value?.m !== col.m) return []
  const k = fundingDrill.value.kind
  return k === 'delay' ? col.d.delayed : k === 'open' ? col.d.open : col.d.notReady
}

// ── Export + AI insights ──
function downloadJson() {
  if (!data.value) return
  const blob = new Blob([JSON.stringify(data.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `field-ops_${data.value.from}_${data.value.to}.json`
  a.click(); URL.revokeObjectURL(url)
}
const aiOpen = ref(false); const aiLoading = ref(false); const aiSummary = ref(''); const aiError = ref(''); const aiGeneratedAt = ref(''); const aiGeneratedStamp = ref('')
function runAiSummary() {
  if (!data.value) return
  aiOpen.value = true; aiLoading.value = true; aiSummary.value = ''; aiError.value = ''
  fetch('/api/field-ops/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ data: data.value }),
  })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        aiSummary.value = d.summary || '_(empty summary)_'
        const now = new Date(); const p2 = (n: number) => String(n).padStart(2, '0')
        aiGeneratedAt.value = now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        aiGeneratedStamp.value = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}`
      } else aiError.value = d.error || 'Failed to summarize'
    })
    .catch(e => { aiError.value = e instanceof Error ? e.message : String(e) })
    .finally(() => { aiLoading.value = false })
}
// Human-readable summary of the active filters, for the printed report header.
const activeFilterText = computed(() => {
  const parts: string[] = []
  if (fState.value) parts.push(fState.value)
  if (fOffice.value) parts.push(fOffice.value)
  if (fCoordinator.value) parts.push(`PC: ${fCoordinator.value}`)
  if (fCloser.value) parts.push(`Closer: ${fCloser.value}`)
  if (fLender.value) parts.push(fLender.value)
  if (fEpc.value) parts.push(fEpc.value)
  return parts.join(' · ')
})
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
// A self-contained, print-styled report (branded header + KPI band + the AI
// brief). Rendered inside a hidden iframe and printed → the browser's
// "Save as PDF" produces a clean, shareable document.
function buildReportHtml(): string {
  const d = data.value
  if (!d) return ''
  const h = d.headline
  const f = d.funding
  const fmt = (n: number) => Math.round(n).toLocaleString()
  const stat = (val: string, sub: string, color: string) =>
    `<div class="stat"><div class="stat-val" style="color:${color}">${val}</div><div class="stat-sub">${sub}</div></div>`
  const notReady = f ? f.m2.cantSubmitCount + f.m3.cantSubmitCount : 0
  const stats = [
    stat(`${h.installs}`, `installs · ${fmt(h.kw)} kW`, '#111827'),
    stat(`${h.inspPassRate}%`, 'inspection pass', h.inspPassRate >= 50 ? '#111827' : '#d97706'),
    stat(`${h.firstTimeRate}%`, 'first-time pass', h.firstTimeRate >= 70 ? '#16a34a' : '#d97706'),
    stat(`${f ? f.m2.delayRate : 0}%`, 'M2 funding delay', (f && f.m2.delayRate > 0) ? '#d97706' : '#16a34a'),
    stat(`${notReady}`, 'M2 + M3 not ready', notReady > 0 ? '#dc2626' : '#16a34a'),
  ].join('')
  const filterLine = activeFilterText.value ? ` · ${escapeHtml(activeFilterText.value)}` : ''
  // Promote whole-line bold section labels (**Headline**) to headings so they
  // read like the report's section titles instead of inline bold.
  const md = aiSummary.value.replace(/^\*\*(.+?)\*\*\s*$/gm, '### $1')
  const body = renderMarkdown(md)
  // The <title> becomes the browser's default "Save as PDF" filename. Include
  // the selected period + run timestamp, filesystem-safe (no spaces/slashes/colons).
  const periodLabel = (PERIODS.find(p => p.k === period.value)?.l ?? 'Period').replace(/\s+/g, '-')
  const docTitle = `Field-Ops-AI-Insights_${periodLabel}_${d.from}_to_${d.to}${aiGeneratedStamp.value ? `_run-${aiGeneratedStamp.value}` : ''}`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:720px;margin:0 auto;padding:40px 44px}
header{border-bottom:1px solid #e5e7eb;padding-bottom:16px;margin-bottom:20px}
.eyebrow{color:#2563eb;font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}
h1{font-size:26px;font-weight:800;line-height:1.15;margin:6px 0 8px;letter-spacing:-.01em}
.sub{color:#4b5563;font-size:14px}
.sub-sm{color:#9ca3af;font-size:11px;margin-top:3px}
.kpis{display:flex;gap:12px;background:#f3f4f6;border-radius:12px;padding:18px 12px;margin-bottom:24px}
.stat{flex:1;text-align:center}
.stat-val{font-size:26px;font-weight:800;line-height:1}
.stat-sub{font-size:10px;color:#6b7280;margin-top:6px;line-height:1.3}
.body{font-size:13px;line-height:1.6;color:#1f2937}
.body h1,.body h2,.body h3{font-size:13.5px;font-weight:700;color:#111827;margin:15px 0 4px}
.body h1:first-child,.body h2:first-child,.body h3:first-child{margin-top:0}
.body p{margin:5px 0}
.body strong{color:#111827;font-weight:700}
.body ul,.body ol{margin:4px 0 10px;padding-left:20px}
.body li{margin:3px 0}
footer{margin-top:28px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af}
@page{margin:16mm}
</style></head><body><div class="doc">
<header>
<div class="eyebrow">Kin Home · Field Operations</div>
<h1>AI Insights — Crew Scorecard</h1>
<p class="sub">Install cohort ${escapeHtml(d.from)} → ${escapeHtml(d.to)}${filterLine}</p>
<p class="sub-sm">Generated ${escapeHtml(aiGeneratedAt.value)}</p>
</header>
<div class="kpis">${stats}</div>
<div class="body">${body}</div>
<footer>Internal — Kin Home Field Operations · AI-generated from the live dashboard; figures reflect cached data at generation time. Verify before acting.</footer>
</div></body></html>`
}
function savePdf() {
  if (!data.value || !aiSummary.value) return
  const html = buildReportHtml()
  // Print via a hidden iframe — no popup blocker, and the app's theme/CSS can't
  // leak into the printed document.
  const iframe = document.createElement('iframe')
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' })
  document.body.appendChild(iframe)
  const win = iframe.contentWindow
  const doc = win?.document
  if (!win || !doc) { iframe.remove(); return }
  doc.open(); doc.write(html); doc.close()
  const print = () => { try { win.focus(); win.print() } finally { window.setTimeout(() => iframe.remove(), 1500) } }
  // Give the iframe a beat to lay out before printing.
  if (doc.readyState === 'complete') window.setTimeout(print, 200)
  else iframe.onload = () => window.setTimeout(print, 200)
}

// ── Filters live behind a filter button (app-wide pattern) ──
const showFilters = ref(false)

// ── KPI trend: click a tile → inline 12-week line; expand for a longer window,
// standard filters, and split-by-dimension (one line per state/lender/…). ──
interface TrendPoint { week: string; installs: number; inspPassRate: number; firstTimeRate: number; avgDaysI2I: number; avgRolls: number; oneTouchRate: number; ptoRate: number }
interface TrendGroup { group: string; points: TrendPoint[] }
const trendTile = ref<Tile | null>(null)
const trendLarge = ref(false)
const WEEK_OPTIONS = [12, 26, 52]
const LINE_COLOR = '#6366f1' // neutral indigo — deliberately not a performance color
const SERIES_PALETTE = ['#6366f1', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#0ea5e9', '#64748b']
const selectedRange = computed(() => rangeFor(period.value))

// Inline (small) chart — always 12 weeks, the main-page filters, single line.
const inlinePoints = ref<TrendPoint[]>([])
const inlineLoading = ref(false)
function loadInline() {
  if (!trendTile.value) return
  inlineLoading.value = true
  const { to } = rangeFor(period.value)
  const p = new URLSearchParams({ to, weeks: '12' })
  applyFilterParams(p)
  fetch(`/api/field-ops/trend?${p}`, { headers: { Authorization: `Bearer ${auth.token}` } })
    .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
    .then(d => { inlinePoints.value = d.groups?.[0]?.points ?? [] })
    .catch(() => { inlinePoints.value = [] })
    .finally(() => { inlineLoading.value = false })
}
function openTrend(t: Tile) {
  if (trendTile.value?.trendKey === t.trendKey && !trendLarge.value) { trendTile.value = null; return } // toggle off
  trendTile.value = t
  loadInline()
}
function closeTrend() { trendTile.value = null; trendLarge.value = false }

// Large (modal) chart — its own week window, its own filters + split-by dimension.
const trendWeeks = ref(12)
const mState = ref(''), mOffice = ref(''), mCoordinator = ref(''), mCloser = ref(''), mLender = ref(''), mEpc = ref('')
const mGroupBy = ref('')
const GROUP_DIMS = [
  { k: '', l: 'None' }, { k: 'state', l: 'State' }, { k: 'office', l: 'Office' }, { k: 'coordinator', l: 'PC' },
  { k: 'closer', l: 'Closer' }, { k: 'lender', l: 'Lender' }, { k: 'epc', l: 'EPC' },
]
const largeGroups = ref<TrendGroup[]>([])
const largeLoading = ref(false)
const largeGroupsTotal = ref(0)
const mFilterDefs = computed<FilterDef[]>(() => [
  { key: 'state', placeholder: 'State', options: opts.value.states, value: mState.value },
  { key: 'office', placeholder: 'Office', options: opts.value.offices, value: mOffice.value },
  { key: 'coordinator', placeholder: 'PC', options: opts.value.coordinators, value: mCoordinator.value },
  { key: 'closer', placeholder: 'Closer', options: opts.value.closers, value: mCloser.value },
  { key: 'lender', placeholder: 'Lender', options: opts.value.lenders, value: mLender.value },
  { key: 'epc', placeholder: 'EPC', options: opts.value.epcs, value: mEpc.value },
])
const mFilterActive = computed(() => !!(mState.value || mOffice.value || mCoordinator.value || mCloser.value || mLender.value || mEpc.value))
function setMFilter(key: string, value: string) {
  if (key === 'state') mState.value = value; else if (key === 'office') mOffice.value = value
  else if (key === 'coordinator') mCoordinator.value = value; else if (key === 'closer') mCloser.value = value
  else if (key === 'lender') mLender.value = value; else if (key === 'epc') mEpc.value = value
  loadLarge()
}
function resetMFilters() { mState.value = ''; mOffice.value = ''; mCoordinator.value = ''; mCloser.value = ''; mLender.value = ''; mEpc.value = ''; loadLarge() }
function setMGroupBy(k: string) { mGroupBy.value = k; loadLarge() }
function setTrendWeeks(w: number) { trendWeeks.value = w; loadLarge() }
function loadLarge() {
  if (!trendTile.value) return
  largeLoading.value = true
  const { to } = rangeFor(period.value)
  const p = new URLSearchParams({ to, weeks: String(trendWeeks.value) })
  if (mState.value) p.set('state', mState.value); if (mOffice.value) p.set('office', mOffice.value)
  if (mCoordinator.value) p.set('coordinator', mCoordinator.value); if (mCloser.value) p.set('closer', mCloser.value)
  if (mLender.value) p.set('lender', mLender.value); if (mEpc.value) p.set('epc', mEpc.value)
  if (mGroupBy.value) p.set('groupBy', mGroupBy.value)
  if (showBatteryOnly.value) p.set('battery_only', '1')
  fetch(`/api/field-ops/trend?${p}`, { headers: { Authorization: `Bearer ${auth.token}` } })
    .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
    .then(d => { largeGroups.value = d.groups ?? []; largeGroupsTotal.value = d.groupsTotal ?? 0 })
    .catch(() => { largeGroups.value = []; largeGroupsTotal.value = 0 })
    .finally(() => { largeLoading.value = false })
}
function openLarge() {
  mState.value = fState.value; mOffice.value = fOffice.value; mCoordinator.value = fCoordinator.value
  mCloser.value = fCloser.value; mLender.value = fLender.value; mEpc.value = fEpc.value
  mGroupBy.value = ''
  trendLarge.value = true
  loadLarge()
}

// A week with no installs has no meaningful rate/average → plot a gap (null),
// not a misleading 0. Counts (installs) stay 0.
function pointVal(p: TrendPoint, t: Tile): number | null {
  if (t.trendKey === 'installs') return p.installs
  return p.installs === 0 ? null : Number(p[t.trendKey])
}
// markArea shading the weeks inside the currently-selected filter period.
function markAreaFor(weeks: string[]) {
  const { from, to } = selectedRange.value
  const inSel = weeks.map(w => w >= from.slice(0, 10) && w <= to.slice(0, 10))
  const lo = inSel.indexOf(true), hi = inSel.lastIndexOf(true)
  return lo >= 0 ? { silent: true, itemStyle: { color: 'rgba(148,163,184,0.16)' }, data: [[{ xAxis: weeks[lo].slice(5) }, { xAxis: weeks[hi].slice(5) }]] } : undefined
}
const trendOption = computed(() => {
  const t = trendTile.value, pts = inlinePoints.value
  if (!t || !pts.length) return {}
  return {
    grid: { left: 34, right: 14, top: 22, bottom: 24 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v}${t.unit}` },
    xAxis: { type: 'category', data: pts.map(p => p.week.slice(5)), boundaryGap: false, axisLabel: { color: '#94a3b8', fontSize: 9 }, axisLine: { lineStyle: { color: '#cbd5e1' } } },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.18)' } }, axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (v: number) => `${Math.round(v)}${t.unit}` } },
    series: [{
      type: 'line', data: pts.map(p => pointVal(p, t)), smooth: true, symbol: 'circle', symbolSize: 5, connectNulls: false,
      lineStyle: { color: LINE_COLOR, width: 2 }, itemStyle: { color: LINE_COLOR }, areaStyle: { color: 'rgba(99,102,241,0.08)' },
      markArea: markAreaFor(pts.map(p => p.week)),
      label: { show: pts.length <= 16, position: 'top', color: '#94a3b8', fontSize: 9, formatter: (o: { value: number }) => `${o.value}${t.unit}` },
    }],
  }
})
const trendOptionLarge = computed(() => {
  const t = trendTile.value, gs = largeGroups.value
  if (!t || !gs.length) return {}
  const weeks = gs[0].points.map(p => p.week)
  const grouped = !!mGroupBy.value
  const series = gs.map((g, i) => ({
    name: g.group, type: 'line', smooth: true, symbol: 'circle', symbolSize: 5, connectNulls: false,
    data: g.points.map(p => pointVal(p, t)),
    lineStyle: { color: grouped ? SERIES_PALETTE[i % SERIES_PALETTE.length] : LINE_COLOR, width: 2 },
    itemStyle: { color: grouped ? SERIES_PALETTE[i % SERIES_PALETTE.length] : LINE_COLOR },
    areaStyle: grouped ? undefined : { color: 'rgba(99,102,241,0.08)' },
    markArea: i === 0 ? markAreaFor(weeks) : undefined,
    label: (!grouped && weeks.length <= 20) ? { show: true, position: 'top', color: '#94a3b8', fontSize: 9, formatter: (o: { value: number }) => `${o.value}${t.unit}` } : { show: false },
  }))
  return {
    grid: { left: 44, right: 18, top: grouped ? 34 : 20, bottom: weeks.length > 20 ? 52 : 30 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v}${t.unit}` },
    legend: grouped ? { top: 0, type: 'scroll', textStyle: { fontSize: 10, color: '#94a3b8' } } : undefined,
    xAxis: { type: 'category', data: weeks.map(w => w.slice(5)), boundaryGap: false, axisLabel: { color: '#94a3b8', fontSize: 11, interval: weeks.length > 20 ? 2 : 1 }, axisLine: { lineStyle: { color: '#cbd5e1' } } },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.18)' } }, axisLabel: { color: '#94a3b8', fontSize: 11, formatter: (v: number) => `${Math.round(v)}${t.unit}` } },
    ...(weeks.length > 20 ? { dataZoom: [{ type: 'slider', height: 16, bottom: 14 }] } : {}),
    series,
  }
})
</script>

<template>
  <!-- grid-cols-1 pins the track to minmax(0,1fr) so wide tables scroll inside
       their own overflow-x-auto wrapper instead of stretching the page. -->
  <div class="grid grid-cols-1 gap-3">
    <!-- Time period + filters -->
    <div class="rounded-xl bg-card/60 p-2.5 grid gap-2">
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Period</span>
        <!-- Horizontally scrollable quick-selector strip (app-wide pattern). -->
        <div class="flex gap-1 overflow-x-auto no-scrollbar min-w-0 flex-1 py-0.5">
          <button v-for="p in PERIODS" :key="p.k" type="button"
            class="px-2.5 py-1 rounded-full text-[11.5px] font-medium tracking-tight transition cursor-pointer shrink-0 whitespace-nowrap"
            :class="period === p.k ? 'bg-foreground text-background shadow-sm' : 'bg-foreground/[0.04] text-foreground/70 hover:bg-foreground/[0.08]'"
            @click="setPeriod(p.k)">{{ p.l }}</button>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span v-if="data" class="text-[10px] text-muted-foreground tabular-nums hidden lg:inline mr-1">{{ data.from }} → {{ data.to }}</span>
          <button type="button" title="AI insights — summarize this view" :disabled="!data"
            class="inline-flex items-center gap-1 rounded-md border h-8 px-2 shrink-0 transition-colors cursor-pointer hover:bg-muted disabled:opacity-40 disabled:cursor-default"
            @click="runAiSummary">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>
            <span class="text-[11px] font-medium hidden sm:inline">AI</span>
          </button>
          <button type="button" title="Download this view as JSON" :disabled="!data"
            class="inline-flex items-center justify-center rounded-md border size-8 shrink-0 transition-colors cursor-pointer hover:bg-muted disabled:opacity-40 disabled:cursor-default"
            @click="downloadJson">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button type="button" title="Battery-only projects"
            class="inline-flex items-center justify-center rounded-md border size-8 shrink-0 transition-colors cursor-pointer"
            :class="showBatteryOnly ? 'bg-teal-50 border-teal-300 text-teal-700 dark:bg-teal-950/40 dark:border-teal-800 dark:text-teal-400' : 'hover:bg-muted'"
            @click="toggleBatteryOnly">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="10" x="2" y="7" rx="2" ry="2"/><line x1="22" x2="22" y1="11" y2="13"/></svg>
          </button>
          <button type="button" title="Filters"
            class="relative inline-flex items-center justify-center rounded-md border size-8 shrink-0 transition-colors cursor-pointer"
            :class="showFilters || filterActive ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
            @click="showFilters = !showFilters">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
            <span v-if="filterActive" class="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500" />
          </button>
        </div>
      </div>
      <!-- Custom time frame -->
      <div v-if="period === 'custom'" class="flex items-center gap-2 flex-wrap text-[11px]">
        <label class="inline-flex items-center gap-1.5 text-muted-foreground">From
          <input type="date" v-model="customFrom" :max="customTo || undefined" @change="applyCustom" class="rounded-md border bg-background px-2 h-7 text-foreground tabular-nums cursor-pointer" />
        </label>
        <label class="inline-flex items-center gap-1.5 text-muted-foreground">To
          <input type="date" v-model="customTo" :min="customFrom || undefined" @change="applyCustom" class="rounded-md border bg-background px-2 h-7 text-foreground tabular-nums cursor-pointer" />
        </label>
      </div>
      <MilestoneFilterBar v-if="showFilters" :filters="filterDefs" :extra-active="filterActive" @update="setFilter" @reset="resetFilters" />
    </div>

    <div v-if="error" role="alert" class="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/30 rounded-lg px-3 py-2">Couldn't load the crew scorecard: {{ error }}</div>
    <div v-else-if="loading && !data" class="grid gap-3"><div class="h-20 rounded-xl bg-muted animate-pulse" /><div class="h-64 rounded-xl bg-muted animate-pulse" /></div>

    <template v-else-if="data">
      <!-- KPI tiles — click to chart the trend -->
      <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
        <div v-for="t in tiles" :key="t.label" role="button" tabindex="0" :title="`${t.info}\n\nClick for the trend.`"
          class="flex-none w-[142px] rounded-xl bg-card px-3 py-2.5 cursor-pointer transition-colors hover:bg-muted/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40"
          :class="trendTile?.trendKey === t.trendKey ? 'ring-1 ring-inset ring-primary/50 bg-primary/[0.04]' : ''"
          @click="openTrend(t)" @keydown.enter="openTrend(t)" @keydown.space.prevent="openTrend(t)">
          <div class="h-[3px] rounded-full mb-1.5" :class="t.accent" />
          <p class="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <span class="truncate">{{ t.label }}<sup v-if="t.foot" class="text-[7px] text-muted-foreground/70 ml-0.5">{{ t.foot }}</sup></span>
            <svg class="ml-auto shrink-0 transition-colors" :class="trendTile?.trendKey === t.trendKey ? 'text-primary' : 'text-muted-foreground/40'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>
          </p>
          <p class="text-xl font-extrabold mt-0.5 tabular-nums" :class="t.vtone">
            {{ t.value }}<span v-if="t.kw != null" class="text-sm font-bold"> / {{ t.kw.toLocaleString() }} kW</span>
          </p>
          <p v-if="t.sub" class="text-[9.5px] text-muted-foreground truncate">{{ t.sub }}</p>
          <p v-if="t.maturity" class="text-[9px] mt-0.5 font-semibold tabular-nums flex items-center gap-0.5" :class="maturityTone(t.maturity.pct)" :title="`${t.maturity.pct}% of the cohort has matured (${t.maturity.label}) — higher = more trustworthy; low = provisional.`">
            <span class="size-1.5 rounded-full" :class="t.maturity.pct < 25 ? 'bg-rose-500' : t.maturity.pct < 50 ? 'bg-amber-500' : 'bg-emerald-500'" />{{ t.maturity.pct }}% {{ t.maturity.label }}
          </p>
        </div>
      </div>

      <!-- Inline KPI trend (12 weeks; shaded band = selected period) -->
      <div v-if="trendTile" class="rounded-xl bg-card p-3">
        <div class="flex items-center justify-between mb-1 gap-2">
          <p class="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground truncate">
            {{ trendTile.label }} <span class="normal-case tracking-normal text-muted-foreground/60">· {{ trendWeeks }}-week trend</span>
          </p>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" class="text-[10px] inline-flex items-center gap-1 rounded-md border px-2 h-7 hover:bg-muted transition-colors cursor-pointer" @click="openLarge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              Expand
            </button>
            <button type="button" class="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer" @click="closeTrend">Close</button>
          </div>
        </div>
        <div v-if="inlineLoading" class="h-[160px] rounded-lg bg-muted animate-pulse" />
        <div v-else-if="inlinePoints.length" class="w-full h-[160px]">
          <VChart :option="trendOption" autoresize class="w-full h-full" />
        </div>
        <p v-else class="text-[11px] text-muted-foreground text-center py-10">No trend data.</p>
        <p class="text-[9px] text-muted-foreground/70 mt-1">Shaded band = the weeks in your selected period. Each point is that week's install cohort.</p>
      </div>

      <!-- Battery-Only vs PV breakout (only when the battery segment is material) -->
      <section v-if="showBatteryBreakout && data.batteryMix" class="min-w-0">
        <div class="flex items-baseline justify-between mb-2 flex-wrap gap-x-2">
          <h3 class="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Project Mix — PV vs Battery-Only</h3>
          <span class="text-[9.5px] text-muted-foreground/70">battery-only carry ~0 kW — segmented so they don't skew PV metrics</span>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-xl bg-card p-4">
            <div class="flex items-baseline justify-between mb-2.5">
              <p class="text-xs font-semibold">PV / Solar</p>
              <p class="text-[10px] text-muted-foreground tabular-nums">{{ data.batteryMix.pv.installs }} installs · {{ data.batteryMix.pv.kw.toLocaleString() }} kW</p>
            </div>
            <div class="grid grid-cols-4 gap-2 text-center">
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.pv.firstTimeRate }}%</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">1st-Time</p></div>
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.pv.avgRolls }}</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">Rolls</p></div>
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.pv.avgDaysI2I }}</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">Days I→I</p></div>
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.pv.ptoRate }}%</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">PTO</p></div>
            </div>
          </div>
          <div class="rounded-xl bg-card p-4">
            <div class="flex items-baseline justify-between mb-2.5">
              <p class="text-xs font-semibold inline-flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-teal-600"><rect width="16" height="10" x="2" y="7" rx="2" ry="2"/><line x1="22" x2="22" y1="11" y2="13"/></svg>
                Battery-Only
              </p>
              <button class="text-[10px] text-teal-600 hover:underline cursor-pointer tabular-nums" @click="toggleBatteryOnly">{{ data.batteryMix.battery.installs }} installs · filter →</button>
            </div>
            <div class="grid grid-cols-4 gap-2 text-center">
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.battery.firstTimeRate }}%</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">1st-Time</p></div>
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.battery.avgRolls }}</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">Rolls</p></div>
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.battery.avgDaysI2I }}</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">Days I→I</p></div>
              <div class="rounded-lg bg-muted/40 p-2"><p class="text-base font-extrabold tabular-nums leading-none">{{ data.batteryMix.battery.ptoRate }}%</p><p class="text-[8px] uppercase tracking-wider text-muted-foreground mt-1">PTO</p></div>
            </div>
            <p v-if="batterySmallSample" class="text-[10px] text-amber-600 mt-2">Small sample (n={{ data.batteryMix.battery.installs }}) — rates are indicative only.</p>
          </div>
        </div>
      </section>

      <!-- W2 vs Sub: utilization + kW mix -->
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-2 min-w-0">
        <div class="rounded-xl bg-card p-4">
          <p class="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-2">W-2 vs Subcontractor <span class="normal-case tracking-normal text-muted-foreground/60">· by scheduled date</span></p>
          <div class="grid grid-cols-2 gap-3 mb-3">
            <div class="rounded-lg bg-teal-50 dark:bg-teal-950/30 p-3">
              <p class="text-[10px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">W-2 Utilization</p>
              <p class="text-2xl font-extrabold tabular-nums mt-0.5" :class="rateTone(util?.w2UtilPct || 0)">{{ util?.w2UtilPct || 0 }}%</p>
              <p class="text-[10px] text-muted-foreground tabular-nums">{{ util?.w2Kw || 0 }} of {{ util?.w2CapacityKw || 0 }} kW capacity</p>
            </div>
            <div class="rounded-lg bg-muted/40 p-3">
              <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">kW Mix</p>
              <p class="text-2xl font-extrabold tabular-nums mt-0.5">{{ util?.w2Pct || 0 }}<span class="text-sm text-muted-foreground">/{{ util?.subPct || 0 }}%</span></p>
              <p class="text-[10px] text-muted-foreground">W-2 / Sub of scheduled kW</p>
            </div>
          </div>
          <div class="h-2.5 rounded-full overflow-hidden flex">
            <div class="bg-teal-500 h-full" :style="{ width: (util?.w2Pct || 0) + '%' }" :title="`W-2 ${util?.w2Kw} kW`" />
            <div class="bg-amber-400 h-full" :style="{ width: (util?.subPct || 0) + '%' }" :title="`Sub ${util?.subKw} kW`" />
          </div>
          <p class="text-[10px] text-muted-foreground mt-1.5">
            W-2: {{ util?.w2Installs || 0 }} scheduled · {{ util?.w2Kw }} kW &nbsp;·&nbsp;
            Sub: {{ util?.subInstalls || 0 }} scheduled · {{ util?.subKw }} kW
          </p>
          <p class="text-[9.5px] text-muted-foreground/70 mt-1">Utilization = scheduled W-2 kW ÷ ({{ util?.w2CrewCount }} W-2 crew(s) × {{ util?.kwPerCrewWeek }} kW/wk × {{ util?.weeks }} wks).</p>
        </div>
        <div class="rounded-xl bg-card p-3">
          <p class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Installs completed by week</p>
          <div class="w-full h-[150px]">
            <VChart :option="throughputOption" autoresize class="w-full h-full" />
          </div>
        </div>
      </div>

      <!-- Week-by-week crew utilization matrix (scheduled) -->
      <section v-if="matrix && matrix.crews.length" class="min-w-0">
        <div class="flex items-center justify-between mb-2 flex-wrap gap-y-1">
          <h3 class="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Week-by-Week Crew Utilization <span class="normal-case tracking-normal text-muted-foreground/60">· scheduled · W-2 utilization</span></h3>
          <div class="flex items-center gap-2.5 text-[9.5px] text-muted-foreground">
            <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-emerald-500/50" />≥80%</span>
            <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-amber-400/50" />50–79%</span>
            <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-rose-500/50" />&lt;50%</span>
            <span class="hidden sm:inline">· W-2: 5 installs or 50 kW/wk = 100% · mix = Sub ÷ total kW</span>
          </div>
        </div>
        <div class="rounded-xl bg-card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-[12px] min-w-max">
              <thead class="text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                <tr>
                  <th class="sticky left-0 z-20 bg-card border-r border-border/50 px-3 py-2 text-left font-semibold whitespace-nowrap">Crew</th>
                  <th v-for="w in matrix.weeks" :key="w" class="px-2 py-2 text-center font-semibold whitespace-nowrap">Wk {{ wkLabel(w) }}</th>
                  <th class="px-3 py-2 text-right font-semibold whitespace-nowrap">Total</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="c in matrix.crews" :key="c.crew">
                  <td class="sticky left-0 z-10 bg-card border-r border-border/50 px-3 py-1.5 whitespace-nowrap"><span class="font-medium">{{ c.crew }}</span><span class="ml-1.5 text-[9px] font-semibold uppercase rounded-full px-1.5 py-0.5" :class="typeBadge(c.type)">{{ c.type }}</span></td>
                  <td v-for="(cell, i) in c.cells" :key="i" class="px-1.5 py-1 text-center whitespace-nowrap" :class="c.type === 'W2' && cell ? utilCls(cell.util) : ''">
                    <template v-if="cell">
                      <div class="tabular-nums font-medium leading-tight">{{ cell.installs }} / {{ cell.kw }} kW</div>
                      <div v-if="c.type === 'W2'" class="tabular-nums text-[10px] leading-tight">{{ cell.util }}%</div>
                    </template>
                    <span v-else class="text-muted-foreground/40">—</span>
                  </td>
                  <td class="px-3 py-1.5 text-right font-bold tabular-nums whitespace-nowrap">{{ c.total.installs }} / {{ c.total.kw }} kW</td>
                </tr>
              </tbody>
              <tfoot class="border-t-2 border-border">
                <tr class="font-semibold">
                  <td class="sticky left-0 z-10 bg-card border-r border-border/50 px-3 py-2 whitespace-nowrap">Weekly Totals</td>
                  <td v-for="(t, i) in matrix.weeklyTotals" :key="i" class="px-1.5 py-1 text-center whitespace-nowrap" :class="utilCls(t.w2Util)">
                    <div class="tabular-nums leading-tight">{{ t.installs }} / {{ t.kw }} kW</div>
                    <div class="tabular-nums text-[10px] leading-tight opacity-90">W2 {{ t.w2Util }}% · Sub {{ t.subMix }}%</div>
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">{{ matrix.grandTotal.installs }} / {{ matrix.grandTotal.kw }} kW</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      <!-- Crew leaderboard -->
      <section class="min-w-0">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Crew Leaderboard — by first-time pass</h3>
          <span class="text-[9.5px] text-muted-foreground">green = best in column · tap a crew for its projects</span>
        </div>
        <div v-if="!data.crews.length" class="text-xs text-muted-foreground rounded-xl bg-card p-4 text-center">No installs in this period / filter.</div>
        <div v-else class="rounded-xl bg-card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm min-w-[820px]">
              <thead class="text-left text-[10.5px] uppercase tracking-wider text-muted-foreground border-b">
                <tr>
                  <th class="sticky left-0 z-20 bg-card border-r border-border/50 px-3 py-2 font-semibold">Crew</th>
                  <th class="px-2 py-2 font-semibold text-right">Installs</th>
                  <th class="px-2 py-2 font-semibold text-right">kW</th>
                  <th class="px-2 py-2 font-semibold text-right">1st-Time<sup class="text-[8px] text-muted-foreground/60 ml-0.5">4</sup></th>
                  <th class="px-2 py-2 font-semibold text-right">Days I→I<sup class="text-[8px] text-muted-foreground/60 ml-0.5">5</sup></th>
                  <th class="px-2 py-2 font-semibold text-right">Avg Rolls<sup class="text-[8px] text-muted-foreground/60 ml-0.5">2</sup></th>
                  <th class="px-2 py-2 font-semibold text-right">PTO</th>
                  <th class="px-2 py-2 font-semibold text-right" title="Share of installs whose Arrivy task logged an en-route status (crew departed for the job).">On-Route<sup class="text-[8px] text-muted-foreground/60 ml-0.5">1</sup></th>
                  <th class="px-2 py-2 font-semibold text-right" title="Share of installs whose Arrivy task logged an on-site / STARTED status (crew arrived and began work).">On Site<sup class="text-[8px] text-muted-foreground/60 ml-0.5">1</sup></th>
                  <th class="px-2 py-2 font-semibold text-right" title="Share of installs whose Arrivy task was submitted (paperwork/photos filed after the visit).">Submitted<sup class="text-[8px] text-muted-foreground/60 ml-0.5">1</sup></th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="c in data.crews" :key="c.crew" class="cursor-pointer transition-colors" :class="selectedCrew === c.crew ? 'bg-muted/60' : 'hover:bg-muted/30'" @click="toggleCrew(c.crew)">
                  <td class="sticky left-0 z-10 border-r border-border/50 px-3 py-2 whitespace-nowrap" :class="selectedCrew === c.crew ? 'bg-muted' : 'bg-card'">
                    <span class="font-medium">{{ c.crew }}</span>
                    <span class="ml-2 text-[9px] font-semibold uppercase tracking-wider rounded-full px-1.5 py-0.5" :class="typeBadge(c.type)">{{ c.type }}</span>
                  </td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('installs', c.installs)">{{ c.installs }}</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('kw', c.kw)">{{ c.kw.toLocaleString() }}</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('firstTimeRate', c.firstTimeRate)">{{ c.firstTimeCount }}/{{ c.installs }} ({{ c.firstTimeRate }}%)</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('avgDaysI2I', c.avgDaysI2I)">{{ c.avgDaysI2I }}</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('avgRolls', c.avgRolls)">{{ c.avgRolls }}</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('ptoRate', c.ptoRate)">{{ c.ptoCount }}/{{ c.installs }} ({{ c.ptoRate }}%)</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('onRoutePct', c.onRoutePct)">{{ c.onRoutePct }}%</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('onSitePct', c.onSitePct)">{{ c.onSitePct }}%</td>
                  <td class="px-2 py-2 text-right tabular-nums" :class="bestCls('submittedPct', c.submittedPct)">{{ c.submittedPct }}%</td>
                </tr>
              </tbody>
              <tfoot v-if="data.crewTotals" class="border-t-2 border-border">
                <tr class="font-bold bg-muted/30">
                  <td class="sticky left-0 z-10 bg-card border-r border-border/50 px-3 py-2 whitespace-nowrap">Total <span class="text-[9px] font-medium text-muted-foreground">· all crews</span></td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.installs }}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.kw.toLocaleString() }}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.firstTimeCount }}/{{ data.crewTotals.installs }} ({{ data.crewTotals.firstTimeRate }}%)</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.avgDaysI2I }}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.avgRolls }}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.ptoCount }}/{{ data.crewTotals.installs }} ({{ data.crewTotals.ptoRate }}%)</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.onRoutePct }}%</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.onSitePct }}%</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ data.crewTotals.submittedPct }}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <!-- Drill-down: projects for the selected crew -->
        <div v-if="selectedCrew" class="mt-2 rounded-xl bg-card overflow-hidden">
          <div class="px-3 py-2 border-b flex items-center justify-between">
            <p class="text-xs font-semibold">{{ selectedCrew }} — {{ crewProjects.length }} project{{ crewProjects.length === 1 ? '' : 's' }}</p>
            <button class="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer" @click="selectedCrew = null">Close</button>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-[13px] min-w-[640px]">
              <thead class="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                <tr><th class="sticky left-0 z-20 bg-card border-r border-border/50 px-3 py-1.5 font-semibold">Customer</th><th class="px-2 py-1.5 font-semibold">Installed</th><th class="px-2 py-1.5 font-semibold text-right">kW</th><th class="px-2 py-1.5 font-semibold text-center">1st Pass</th><th class="px-2 py-1.5 font-semibold text-right">Days I→I</th><th class="px-2 py-1.5 font-semibold text-right">Rolls</th><th class="px-2 py-1.5 font-semibold text-center">1-Touch</th><th class="px-2 py-1.5 font-semibold">PTO</th></tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="(p, i) in crewProjects" :key="i" class="hover:bg-muted/30">
                  <td class="sticky left-0 z-10 bg-card border-r border-border/50 px-3 py-1.5 whitespace-nowrap"><button type="button" class="font-medium text-left hover:text-primary hover:underline cursor-pointer" @click.stop="openProjectPeek(p.recordId)">{{ p.customer || '—' }}</button></td>
                  <td class="px-2 py-1.5 tabular-nums text-muted-foreground whitespace-nowrap">{{ p.installDate }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums">{{ p.kw }}</td>
                  <td class="px-2 py-1.5 text-center">{{ !p.passed ? '—' : p.firstTime ? '✓' : '↺' }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{{ p.daysI2I ?? '—' }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{{ p.rolls }}</td>
                  <td class="px-2 py-1.5 text-center">{{ p.oneTouch ? '✓' : '' }}</td>
                  <td class="px-2 py-1.5 text-muted-foreground">{{ p.pto }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- Field-related funding delays -->
      <section v-if="data.funding" class="min-w-0">
        <div class="flex items-baseline justify-between mb-2 flex-wrap gap-x-2">
          <h3 class="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Field-Related Funding Delays</h3>
          <span class="text-[9.5px] text-muted-foreground/70">milestone done, funding request stuck — is the delay field-caused?</span>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div v-for="col in fundingBlocks" :key="col.m" class="rounded-xl bg-card p-4">
            <div class="flex items-baseline justify-between mb-2.5">
              <p class="text-xs font-semibold">{{ col.m }} <span class="text-muted-foreground font-normal">· {{ col.gate }}</span></p>
              <p class="text-[10px] text-muted-foreground tabular-nums">{{ col.d.requested }} requested · {{ col.d.fieldReached }} {{ col.reachedLabel }} of {{ col.d.cohortSize }}</p>
            </div>
            <div class="grid grid-cols-4 gap-2">
              <button type="button" @click="toggleDrill(col.m, 'delay')"
                class="rounded-lg p-2 text-center transition cursor-pointer hover:brightness-95"
                :class="[col.d.delayRate >= 25 ? 'bg-rose-500/10' : col.d.delayRate > 0 ? 'bg-amber-500/10' : 'bg-emerald-500/10', drillActive(col.m, 'delay') ? 'ring-2 ring-inset ring-primary/50' : '']">
                <p class="text-lg font-extrabold tabular-nums leading-none" :class="col.d.delayRate >= 25 ? 'text-rose-600' : col.d.delayRate > 0 ? 'text-amber-600' : 'text-emerald-600'">{{ col.d.delayRate }}<span class="text-[10px] font-medium">%</span></p>
                <p class="text-[8.5px] uppercase tracking-wider text-muted-foreground mt-1">Delay Rate<sup class="ml-0.5">6</sup></p>
              </button>
              <div class="rounded-lg bg-muted/40 p-2 text-center" title="Average business-day gap from the field milestone to the funding request (requested projects).">
                <p class="text-lg font-extrabold tabular-nums leading-none">{{ col.d.avgGapDays }}<span class="text-[10px] font-medium text-muted-foreground">bd</span></p>
                <p class="text-[8.5px] uppercase tracking-wider text-muted-foreground mt-1">Avg Gap<sup class="ml-0.5">6</sup></p>
              </div>
              <button type="button" @click="toggleDrill(col.m, 'open')"
                class="rounded-lg bg-muted/40 p-2 text-center transition cursor-pointer hover:bg-muted/60"
                :class="drillActive(col.m, 'open') ? 'ring-2 ring-inset ring-primary/50' : ''">
                <p class="text-lg font-extrabold tabular-nums leading-none" :class="col.d.openCount ? 'text-amber-600' : ''">{{ col.d.openCount }}</p>
                <p class="text-[8.5px] uppercase tracking-wider text-muted-foreground mt-1">Open</p>
              </button>
              <button type="button" @click="toggleDrill(col.m, 'notReady')"
                class="rounded-lg bg-muted/40 p-2 text-center transition cursor-pointer hover:bg-muted/60"
                :class="drillActive(col.m, 'notReady') ? 'ring-2 ring-inset ring-primary/50' : ''"
                title="Live count of all active projects in Not-Ready status — the Funding Dashboard's Not-Ready bucket. Whole-pipeline, NOT limited to the selected install period.">
                <p class="text-lg font-extrabold tabular-nums leading-none" :class="col.d.cantSubmitCount ? 'text-rose-600' : ''">{{ col.d.cantSubmitCount }}</p>
                <p class="text-[8.5px] uppercase tracking-wider text-muted-foreground mt-1">Not Ready<sup class="ml-0.5">7</sup></p>
                <p class="text-[7.5px] text-muted-foreground/60 leading-none mt-0.5">all active</p>
              </button>
            </div>
            <!-- Drill-down list for the selected stat -->
            <div v-if="fundingDrill && fundingDrill.m === col.m" class="mt-2.5">
              <div class="flex items-center justify-between mb-1">
                <p class="text-[10px] font-semibold text-muted-foreground">{{ DRILL_LABEL[fundingDrill.kind] }} · {{ drillRows(col).length }}</p>
                <button class="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer" @click="fundingDrill = null">Close</button>
              </div>
              <div v-if="drillRows(col).length" class="overflow-x-auto max-h-64 overflow-y-auto rounded-lg border">
                <table class="w-full text-[11.5px] min-w-max">
                  <thead class="text-left text-[9px] uppercase tracking-wider text-muted-foreground border-b sticky top-0 z-20 bg-card">
                    <tr>
                      <th class="sticky left-0 z-30 bg-card border-r border-border/50 px-2 py-1 font-semibold">Customer</th>
                      <template v-if="fundingDrill.kind === 'notReady'"><th class="px-2 py-1 font-semibold">Lender</th></template>
                      <template v-else><th class="px-2 py-1 font-semibold">Installed</th><th class="px-2 py-1 font-semibold text-right">Biz&nbsp;Days</th></template>
                      <th class="px-2 py-1 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y">
                    <tr v-for="(r, i) in drillRows(col)" :key="i" :class="r.resolved ? 'opacity-60' : ''">
                      <td class="sticky left-0 z-10 bg-card border-r border-border/50 px-2 py-1 whitespace-nowrap"><button type="button" class="font-medium text-left hover:text-primary hover:underline cursor-pointer" @click="openProjectPeek(r.recordId)">{{ r.customer || '—' }}</button><span v-if="r.state" class="text-muted-foreground font-normal"> · {{ r.state }}</span></td>
                      <template v-if="fundingDrill.kind === 'notReady'"><td class="px-2 py-1 text-muted-foreground whitespace-nowrap">{{ r.lender || '—' }}</td></template>
                      <template v-else>
                        <td class="px-2 py-1 tabular-nums text-muted-foreground whitespace-nowrap">{{ r.installDate }}</td>
                        <td class="px-2 py-1 text-right tabular-nums" :class="(r.days ?? 0) > 10 ? 'text-rose-600 font-semibold' : 'text-amber-600'">{{ r.days }}</td>
                      </template>
                      <td class="px-2 py-1 text-muted-foreground whitespace-nowrap">{{ r.status }}<span v-if="r.resolved" class="text-[9px] text-emerald-600"> · resolved</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="text-[11px] text-emerald-600">None.</p>
            </div>
            <p v-else class="text-[10px] text-muted-foreground/60 mt-2.5">Tap Delay Rate, Open, or Not Ready to list those projects.</p>
          </div>
        </div>
      </section>

      <div class="text-[10px] text-muted-foreground/80 leading-relaxed">
        <p class="font-semibold uppercase tracking-wider text-[9px] text-muted-foreground mb-1">Methodology</p>
        <ol class="list-decimal ml-3.5 space-y-0.5">
          <li v-for="(m, i) in METHODOLOGY" :key="i">{{ m }}</li>
        </ol>
      </div>
      <p v-if="loading" class="text-[11px] text-muted-foreground text-center">Updating…</p>
    </template>

    <!-- AI insights summary -->
    <Teleport to="body">
      <div v-if="aiOpen" class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/50" @click.self="aiOpen = false">
        <div class="w-full max-w-2xl rounded-2xl bg-card shadow-2xl max-h-[88vh] flex flex-col">
          <div class="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b">
            <p class="text-sm font-bold flex items-center gap-2">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>
              AI Insights <span class="font-normal text-muted-foreground">· {{ data?.from }} → {{ data?.to }}</span>
            </p>
            <button class="text-muted-foreground hover:text-foreground cursor-pointer" title="Close" @click="aiOpen = false">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="px-4 sm:px-5 py-4 overflow-y-auto">
            <div v-if="aiLoading" class="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <span class="size-4 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" /> Analyzing this view…
            </div>
            <div v-else-if="aiError" class="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950/30 rounded-lg px-3 py-2">
              {{ aiError }}
              <p class="text-[11px] text-muted-foreground mt-1">AI insights use your connected LLM provider — add a key in Settings if none is configured.</p>
            </div>
            <MarkdownMessage v-else-if="aiSummary" :content="aiSummary" />
          </div>
          <div class="px-4 sm:px-5 py-2.5 border-t flex items-center justify-between gap-2">
            <p class="text-[10px] text-muted-foreground hidden sm:block">Generated from the current period + filters. Verify before acting.</p>
            <div class="flex items-center gap-2">
              <button class="text-[11px] inline-flex items-center gap-1 rounded-md border px-2.5 h-7 hover:bg-muted transition-colors cursor-pointer disabled:opacity-40" :disabled="aiLoading || !aiSummary" @click="savePdf">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                Save as PDF
              </button>
              <button class="text-[11px] rounded-md border px-2.5 h-7 hover:bg-muted transition-colors cursor-pointer disabled:opacity-40" :disabled="aiLoading" @click="runAiSummary">Regenerate</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Large trend view — fuller window, its own filters + split-by dimension -->
    <Teleport to="body">
      <div v-if="trendLarge && trendTile" class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/50" @click.self="trendLarge = false">
        <div class="w-full max-w-5xl rounded-2xl bg-card shadow-2xl p-4 sm:p-5 max-h-[92vh] overflow-y-auto">
          <div class="flex items-start justify-between gap-3 mb-3">
            <div>
              <p class="text-sm font-bold">{{ trendTile.label }} <span class="font-normal text-muted-foreground">· weekly trend</span></p>
              <p class="text-[10px] text-muted-foreground">Shaded band = your selected period. Each point is that week's install cohort.</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <div class="inline-flex rounded-lg bg-muted p-0.5">
                <button v-for="w in WEEK_OPTIONS" :key="w" type="button"
                  class="px-2.5 h-7 text-[11px] font-medium rounded-md transition-colors cursor-pointer"
                  :class="trendWeeks === w ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'"
                  @click="setTrendWeeks(w)">{{ w }}w</button>
              </div>
              <button type="button" class="text-muted-foreground hover:text-foreground cursor-pointer" title="Close" @click="trendLarge = false">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>

          <!-- Split-by dimension -->
          <div class="flex items-center gap-2 flex-wrap mb-2">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Split by</span>
            <div class="flex gap-1 flex-wrap">
              <button v-for="dim in GROUP_DIMS" :key="dim.k" type="button"
                class="px-2.5 py-1 rounded-full text-[11px] font-medium transition cursor-pointer"
                :class="mGroupBy === dim.k ? 'bg-foreground text-background shadow-sm' : 'bg-foreground/[0.04] text-foreground/70 hover:bg-foreground/[0.08]'"
                @click="setMGroupBy(dim.k)">{{ dim.l }}</button>
            </div>
            <span v-if="mGroupBy && largeGroupsTotal > largeGroups.length" class="text-[10px] text-amber-600 ml-auto">Top {{ largeGroups.length }} of {{ largeGroupsTotal }} shown</span>
          </div>
          <!-- Standard filters -->
          <div class="mb-3">
            <MilestoneFilterBar :filters="mFilterDefs" :extra-active="mFilterActive" @update="setMFilter" @reset="resetMFilters" />
          </div>

          <div v-if="largeLoading" class="h-[58vh] rounded-xl bg-muted animate-pulse" />
          <div v-else-if="largeGroups.length" class="w-full h-[58vh] min-h-[320px]">
            <VChart :key="`${trendTile.trendKey}-${trendWeeks}-${mGroupBy}`" :option="trendOptionLarge" autoresize class="w-full h-full" />
          </div>
          <p v-else class="text-sm text-muted-foreground text-center py-20">No trend data for this window.</p>
        </div>
      </div>
    </Teleport>

    <!-- Shared project snapshot drawer — opens when any listed project is clicked -->
    <ProjectDetailDialog
      :project="selectedPeekProject"
      @update:open="(v: boolean) => { if (!v) selectedPeekProject = null }"
    />
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
