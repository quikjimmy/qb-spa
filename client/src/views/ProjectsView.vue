1<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { getStatusConfig } from '@/lib/status'
import { computeMilestones, dotStyle, labelStyle, connectorStyle, type MilestoneStep } from '@/lib/milestones'
import DataFreshness from '@/components/DataFreshness.vue'

const auth = useAuthStore()

interface Project {
  record_id: number
  customer_name: string
  customer_address: string
  email: string
  phone: string
  status: string
  sales_office: string
  lender: string
  closer: string
  coordinator: string
  system_size_kw: number | null
  sales_date: string
  state: string
  intake_completed: string
  survey_scheduled: string
  survey_submitted: string
  survey_approved: string
  cad_submitted: string
  design_completed: string
  nem_submitted: string
  nem_approved: string
  nem_rejected: string
  permit_submitted: string
  permit_approved: string
  permit_rejected: string
  install_scheduled: string
  install_completed: string
  inspection_scheduled: string
  inspection_passed: string
  pto_submitted: string
  pto_approved: string
  next_task_type: string
  next_task_date: string
  is_favorite: boolean
  open_tickets?: number
}

interface FilterOption { value: string; count: number }
interface Filters { statuses: FilterOption[]; offices: FilterOption[]; coordinators: FilterOption[]; states: FilterOption[]; closers: FilterOption[]; lenders: FilterOption[]; epcs: FilterOption[] }

const projects = ref<Project[]>([])
const total = ref(0)
const loading = ref(true)
const refreshing = ref(false)
const search = ref('')
const showFavorites = ref(false)
const showDrawer = ref(false)

const f = ref({ status: '', coordinator: '', state: '', closer: '', office: '', lender: '', epc: 'Kin Home', dateField: 'sales_date', dateFrom: '', dateTo: '', sort: '' })
const activeKpi = ref('')
const filters = ref<Filters>({ statuses: [], offices: [], coordinators: [], states: [], closers: [], lenders: [], epcs: [] })
const cacheInfo = ref<{ total: number; last_refresh: string } | null>(null)

interface HoldClassification { category: string; subcategory: string; confidence: number; one_line_reason: string; suggested_next_action: string; last_movement_days: number; days_on_hold?: number }
const holdClassifications = ref<Record<number, HoldClassification>>({})
const classifierRunning = ref(false)
const aiExpanded = ref<Record<number, boolean>>({})
function toggleAi(e: Event, projectId: number) { e.stopPropagation(); aiExpanded.value = { ...aiExpanded.value, [projectId]: !aiExpanded.value[projectId] } }
function isStuck(c: HoldClassification): boolean { return (c.last_movement_days ?? 0) >= 3 }

interface KpiItem { count: number; kw: number; pct?: number }
const kpi = ref<{
  preInstall: KpiItem; hold: KpiItem & { pct: number }; futureInstall: KpiItem
  wip: KpiItem; needInspx: KpiItem; needPto: KpiItem
}>({
  preInstall: { count: 0, kw: 0 }, hold: { count: 0, kw: 0, pct: 0 },
  futureInstall: { count: 0, kw: 0 }, wip: { count: 0, kw: 0 },
  needInspx: { count: 0, kw: 0 }, needPto: { count: 0, kw: 0 },
})
let searchTimeout: ReturnType<typeof setTimeout> | null = null

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const dateFieldOptions = [
  { value: 'sales_date', label: 'Sale Date' }, { value: 'survey_scheduled', label: 'Survey Date' },
  { value: 'permit_submitted', label: 'Permit Sub' }, { value: 'permit_approved', label: 'Permit Appr' },
  { value: 'install_scheduled', label: 'Install Sched' }, { value: 'install_completed', label: 'Install Done' },
  { value: 'inspection_scheduled', label: 'Inspection' }, { value: 'pto_approved', label: 'PTO Approved' },
]
const datePresets = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'this_week', label: 'This week' }, { key: 'last_week', label: 'Last week' },
  { key: 'this_month', label: 'This month' }, { key: 'last_month', label: 'Last month' },
]

function setDatePreset(preset: string) {
  const today = new Date(); const fmt = (d: Date) => d.toISOString().split('T')[0]!
  const sow = new Date(today); sow.setDate(today.getDate() - today.getDay())
  switch (preset) {
    case 'today': f.value.dateFrom = f.value.dateTo = fmt(today); break
    case 'yesterday': { const d = new Date(today); d.setDate(d.getDate() - 1); f.value.dateFrom = f.value.dateTo = fmt(d); break }
    case 'tomorrow': { const d = new Date(today); d.setDate(d.getDate() + 1); f.value.dateFrom = f.value.dateTo = fmt(d); break }
    case 'this_week': f.value.dateFrom = fmt(sow); f.value.dateTo = fmt(new Date(sow.getTime() + 6 * 86400000)); break
    case 'last_week': { const d = new Date(sow); d.setDate(d.getDate() - 7); f.value.dateFrom = fmt(d); f.value.dateTo = fmt(new Date(d.getTime() + 6 * 86400000)); break }
    case 'this_month': f.value.dateFrom = fmt(new Date(today.getFullYear(), today.getMonth(), 1)); f.value.dateTo = fmt(new Date(today.getFullYear(), today.getMonth() + 1, 0)); break
    case 'last_month': { const d = new Date(today.getFullYear(), today.getMonth() - 1, 1); f.value.dateFrom = fmt(d); f.value.dateTo = fmt(new Date(today.getFullYear(), today.getMonth(), 0)); break }
  }
  loadProjects()
}

async function loadProjects() {
  loading.value = true
  const now = new Date()
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const params = new URLSearchParams({ limit: '100', today: localToday })
  if (search.value.trim()) params.set('q', search.value.trim())
  if (showFavorites.value) params.set('favorites', '1')
  if (f.value.status) params.set('status', f.value.status)
  if (f.value.coordinator) params.set('coordinator', f.value.coordinator)
  if (f.value.state) params.set('state', f.value.state)
  if (f.value.closer) params.set('closer', f.value.closer)
  if (f.value.office) params.set('office', f.value.office)
  if (f.value.lender) params.set('lender', f.value.lender)
  if (f.value.epc) params.set('epc', f.value.epc)
  if (f.value.sort) params.set('sort', f.value.sort)
  if (activeKpi.value) params.set('pipeline', activeKpi.value)
  if (f.value.dateFrom || f.value.dateTo) {
    const df = f.value.dateField
    const fromKey = df === 'sales_date' ? 'sales_from' : df.startsWith('survey') ? 'survey_from' : 'install_from'
    if (f.value.dateFrom) params.set(fromKey, f.value.dateFrom)
    if (f.value.dateTo) params.set(fromKey.replace('_from', '_to'), f.value.dateTo)
  }
  try {
    const res = await fetch(`/api/projects?${params}`, { headers: hdrs() })
    const data = await res.json()
    projects.value = data.projects; total.value = data.total; filters.value = data.filters; cacheInfo.value = data.cache; kpi.value = data.kpi || kpi.value
  } finally { loading.value = false }
}

async function refreshCache() { refreshing.value = true; try { await fetch('/api/projects/refresh', { method: 'POST', headers: hdrs() }); await loadProjects() } finally { refreshing.value = false } }

async function loadHoldClassifications() {
  if (!auth.isAdmin) return
  try {
    const res = await fetch('/api/agents/outputs?agent=hold-classifier&limit=500', { headers: hdrs() })
    if (!res.ok) return
    const data = await res.json() as { outputs: Array<{ project_id: number; payload: HoldClassification }> }
    const map: Record<number, HoldClassification> = {}
    for (const o of data.outputs) map[o.project_id] = o.payload
    holdClassifications.value = map
  } catch { /* ignore */ }
}

async function runHoldClassifier() {
  if (classifierRunning.value) return
  classifierRunning.value = true
  try {
    await fetch('/api/agents/hold-classifier/run', { method: 'POST', headers: hdrs() })
    await loadHoldClassifications()
  } finally { classifierRunning.value = false }
}
function onSearch() { if (searchTimeout) clearTimeout(searchTimeout); searchTimeout = setTimeout(() => loadProjects(), 200) }
function clearFilters() { search.value = ''; showFavorites.value = false; activeKpi.value = ''; f.value = { status: '', coordinator: '', state: '', closer: '', office: '', lender: '', epc: 'Kin Home', dateField: 'sales_date', dateFrom: '', dateTo: '', sort: '' }; loadProjects() }

function setKpiFilter(key: string) {
  activeKpi.value = activeKpi.value === key ? '' : key
  loadProjects()
}

function openProject(rid: number) {
  window.open(`https://kin.quickbase.com/nav/app/br9kwm8bk/table/br9kwm8na/action/dr?rid=${rid}&rl=bzuz`, '_blank')
}
function setFilter(key: keyof typeof f.value, val: string) { f.value[key] = val === '__all__' ? '' : val; loadProjects() }

const drawerFilterCount = computed(() => { let c = 0; if (f.value.status) c++; if (f.value.coordinator) c++; if (f.value.state) c++; if (f.value.epc && f.value.epc !== 'Kin Home') c++; if (f.value.closer) c++; if (f.value.office) c++; if (f.value.lender) c++; if (f.value.dateFrom || f.value.dateTo) c++; return c })
const hasFilters = computed(() => search.value || showFavorites.value || activeKpi.value || f.value.status || f.value.coordinator || f.value.state || drawerFilterCount.value > 0)

const statusOrder = ['Active', 'Hold', 'On Hold', 'Pending Cancel', 'Cancelled', 'Completed', 'Complete', 'Completed | Paid', 'Rejected', 'Lost', 'ROR', 'Surrendered']
const sortedStatuses = computed(() => {
  const all = filters.value.statuses.map((s: { value: string }) => s.value)
  const ordered = statusOrder.filter(s => all.includes(s))
  const rest = all.filter((s: string) => !statusOrder.includes(s)).sort()
  return [...ordered, ...rest]
})

async function toggleFavorite(e: Event, projectId: number) {
  e.stopPropagation()
  const res = await fetch(`/api/projects/favorites/${projectId}`, { method: 'POST', headers: hdrs() })
  const data = await res.json()
  const project = projects.value.find(p => p.record_id === projectId)
  if (project) project.is_favorite = data.favorited
}

// ─── Milestones ──────────────────────────────────────────

function getMilestones(p: Project): MilestoneStep[] {
  return computeMilestones(p)
}

function has(val: string): boolean { return !!val && val !== '' && val !== '0' && val !== '-' }

import { fmtDate, fmtDateFull, isPast } from '@/lib/dates'

// Next upcoming task: prefer Arrivy task, fall back to project milestone dates
function nextTask(p: Project): string {
  if (p.next_task_type && p.next_task_date) {
    return `${shortTaskType(p.next_task_type)} · ${fmtDate(p.next_task_date)}`
  }
  // Fall back to earliest future milestone date from cached fields
  const upcoming: Array<{ label: string; date: string }> = []
  if (has(p.survey_scheduled) && !isPast(p.survey_scheduled) && !has(p.survey_approved)) upcoming.push({ label: 'Survey', date: p.survey_scheduled })
  if (has(p.install_scheduled) && !isPast(p.install_scheduled) && !has(p.install_completed)) upcoming.push({ label: 'Install', date: p.install_scheduled })
  if (has(p.inspection_scheduled) && !isPast(p.inspection_scheduled) && !has(p.inspection_passed)) upcoming.push({ label: 'Inspect', date: p.inspection_scheduled })

  if (upcoming.length === 0) return ''
  // Sort by date, return earliest
  upcoming.sort((a, b) => a.date.localeCompare(b.date))
  return `${upcoming[0]!.label} · ${fmtDate(upcoming[0]!.date)}`
}

function shortTaskType(t: string): string {
  if (!t) return 'Task'
  const lower = t.toLowerCase()
  if (lower.includes('survey') || lower.includes('site survey')) return 'Survey'
  if (lower.includes('install')) return 'Install'
  if (lower.includes('inspection') || lower.includes('final inspection')) return 'Inspect'
  if (lower.includes('electrical') || lower.includes('elec upgrade')) return 'Elec Upgrade'
  if (lower.includes('service')) return 'Service'
  if (lower.includes('trench')) return 'Trench'
  if (lower.includes('roof')) return 'Roof'
  // Return first 12 chars of whatever it is
  return t.length > 12 ? t.slice(0, 12) : t
}

const registerRefresh = inject<(fn: () => Promise<void>) => void>('registerRefresh')
onMounted(() => { loadProjects().then(() => { if (cacheInfo.value && cacheInfo.value.total === 0 && auth.isAdmin) refreshCache() }); loadHoldClassifications(); registerRefresh?.(() => loadProjects()) })
</script>

<template>
  <div class="grid gap-2 sm:gap-3">
    <!-- Header (sticky so count stays visible on scroll) -->
    <div class="sticky top-0 z-20 bg-background flex items-center justify-between gap-3 -mx-3 px-3 sm:-mx-6 sm:px-6 py-2">
      <div class="flex flex-col gap-0.5 min-w-0">
        <div class="flex items-baseline gap-2 min-w-0">
          <h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
          <span class="text-sm font-medium text-muted-foreground tabular-nums shrink-0">{{ total.toLocaleString() }}</span>
        </div>
        <DataFreshness label="Cache" />
      </div>
    </div>

    <!-- KPI strip -->
    <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
      <button v-for="chip in [
        { key: 'preInstall', label: 'Pre-Inst', count: kpi.preInstall.count, kw: kpi.preInstall.kw, color: 'text-blue-600', bar: 'bg-blue-500' },
        { key: 'hold', label: 'Hold ' + kpi.hold.pct + '%', count: kpi.hold.count, kw: kpi.hold.kw, color: 'text-amber-600', bar: 'bg-amber-400' },
        { key: 'futureInstall', label: 'F. Install', count: kpi.futureInstall.count, kw: kpi.futureInstall.kw, color: 'text-teal-600', bar: 'bg-teal-500' },
        { key: 'wip', label: 'WIP', count: kpi.wip.count, kw: kpi.wip.kw, color: 'text-violet-600', bar: 'bg-violet-500' },
        { key: 'needInspx', label: 'Need INSPX', count: kpi.needInspx.count, kw: kpi.needInspx.kw, color: 'text-orange-600', bar: 'bg-orange-500' },
        { key: 'needPto', label: 'Need PTO', count: kpi.needPto.count, kw: kpi.needPto.kw, color: 'text-emerald-600', bar: 'bg-emerald-500' },
      ]" :key="chip.key"
        class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] text-left transition-all active:scale-[0.97]"
        :class="activeKpi === chip.key ? 'bg-card shadow-md' : 'bg-card/60 hover:bg-card'"
        @click="setKpiFilter(chip.key)"
      >
        <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="chip.bar" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{{ chip.label }}</p>
        <p class="mt-0.5">
          <span class="text-lg sm:text-xl font-extrabold" :class="chip.color">{{ chip.count }}</span>
          <span class="text-[10px] font-bold" :class="chip.color"> / {{ Math.round(chip.kw).toLocaleString() }} kW</span>
        </p>
      </button>
    </div>

    <!-- Search + filter toggle -->
    <div class="flex gap-2 items-center">
      <div class="relative flex-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <Input v-model="search" @input="onSearch" placeholder="Search name, address, email, phone..." class="pl-8 pr-8 h-8 text-xs" />
        <button v-if="search" @click="search = ''; loadProjects()" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" title="Clear search">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <button class="inline-flex items-center justify-center rounded-md border size-8 shrink-0 transition-colors" :class="showFavorites ? 'bg-amber-50 border-amber-300 text-amber-700' : 'hover:bg-muted'" @click="showFavorites = !showFavorites; loadProjects()" title="Favorites">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" :fill="showFavorites ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </button>
      <button class="relative inline-flex items-center justify-center rounded-md border size-8 shrink-0 transition-colors" :class="showDrawer ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'" @click="showDrawer = !showDrawer" title="Filters">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        <span v-if="drawerFilterCount > 0" class="absolute -top-1 -right-1 size-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center font-bold">{{ drawerFilterCount }}</span>
      </button>
      <button v-if="hasFilters" class="text-xs text-muted-foreground hover:text-foreground shrink-0" @click="clearFilters">Clear</button>
    </div>

    <!-- Filter drawer -->
    <div v-if="showDrawer" class="rounded-xl border bg-card overflow-hidden">
      <div class="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Status</Label><Select :model-value="f.status || '__all__'" @update:model-value="(v: string) => setFilter('status', v)"><SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger><SelectContent><SelectItem value="__all__">All statuses</SelectItem><SelectItem v-for="s in sortedStatuses" :key="s" :value="s">{{ s }}</SelectItem></SelectContent></Select></div>
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">PC</Label><Select :model-value="f.coordinator || '__all__'" @update:model-value="(v: string) => setFilter('coordinator', v)"><SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All PCs" /></SelectTrigger><SelectContent><SelectItem value="__all__">All PCs</SelectItem><SelectItem v-for="c in filters.coordinators" :key="c.value" :value="c.value">{{ c.value }}</SelectItem></SelectContent></Select></div>
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">State</Label><Select :model-value="f.state || '__all__'" @update:model-value="(v: string) => setFilter('state', v)"><SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All states" /></SelectTrigger><SelectContent><SelectItem value="__all__">All states</SelectItem><SelectItem v-for="s in filters.states" :key="s.value" :value="s.value">{{ s.value }}</SelectItem></SelectContent></Select></div>
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">EPC</Label><Select :model-value="f.epc || '__all__'" @update:model-value="(v: string) => setFilter('epc', v)"><SelectTrigger class="h-8 text-xs"><SelectValue placeholder="All EPCs" /></SelectTrigger><SelectContent><SelectItem value="__all__">All EPCs</SelectItem><SelectItem v-for="e in filters.epcs" :key="e.value" :value="e.value">{{ e.value }}</SelectItem></SelectContent></Select></div>
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Closer</Label><Select :model-value="f.closer || '__all__'" @update:model-value="(v: string) => setFilter('closer', v)"><SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">All closers</SelectItem><SelectItem v-for="c in filters.closers" :key="c.value" :value="c.value">{{ c.value }} ({{ c.count }})</SelectItem></SelectContent></Select></div>
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Sales Office</Label><Select :model-value="f.office || '__all__'" @update:model-value="(v: string) => setFilter('office', v)"><SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">All offices</SelectItem><SelectItem v-for="o in filters.offices" :key="o.value" :value="o.value">{{ o.value }} ({{ o.count }})</SelectItem></SelectContent></Select></div>
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Lender</Label><Select :model-value="f.lender || '__all__'" @update:model-value="(v: string) => setFilter('lender', v)"><SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">All lenders</SelectItem><SelectItem v-for="l in filters.lenders" :key="l.value" :value="l.value">{{ l.value }} ({{ l.count }})</SelectItem></SelectContent></Select></div>
        <div class="space-y-1.5"><Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Sort</Label><Select :model-value="f.sort || '__default__'" @update:model-value="(v: string) => { f.sort = v === '__default__' ? '' : v; loadProjects() }"><SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default__">Default</SelectItem><SelectItem value="sales_desc">Sale Date (newest)</SelectItem><SelectItem value="sales_asc">Sale Date (oldest)</SelectItem></SelectContent></Select></div>
      </div>
      <div class="px-4 pb-4 pt-0 border-t">
        <div class="flex items-center gap-2 pt-3 flex-wrap">
          <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold shrink-0">Date</Label>
          <Select :model-value="f.dateField" @update:model-value="(v: string) => { f.dateField = v; if (f.dateFrom || f.dateTo) loadProjects() }"><SelectTrigger class="h-7 w-auto min-w-[110px] text-[11px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="d in dateFieldOptions" :key="d.value" :value="d.value">{{ d.label }}</SelectItem></SelectContent></Select>
          <Input v-model="f.dateFrom" type="date" class="h-7 w-[125px] text-[11px]" @change="loadProjects()" />
          <span class="text-[11px] text-muted-foreground">—</span>
          <Input v-model="f.dateTo" type="date" class="h-7 w-[125px] text-[11px]" @change="loadProjects()" />
          <button v-if="f.dateFrom || f.dateTo" class="text-[11px] text-muted-foreground hover:text-foreground" @click="f.dateFrom = ''; f.dateTo = ''; loadProjects()">Clear</button>
        </div>
        <div class="flex gap-1.5 flex-wrap mt-2">
          <button v-for="p in datePresets" :key="p.key" class="px-2 py-0.5 rounded border text-[10px] font-medium hover:bg-muted transition-colors" @click="setDatePreset(p.key)">{{ p.label }}</button>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && projects.length === 0" class="space-y-2"><div v-for="i in 10" :key="i" class="rounded-lg border bg-card h-16 animate-pulse" /></div>

    <!-- Empty -->
    <div v-else-if="projects.length === 0" class="rounded-xl border bg-card p-12 text-center"><p class="text-muted-foreground">No projects found{{ search ? ` for "${search}"` : '' }}.</p></div>

    <!-- ═══ Project Cards ═══ -->
    <div v-else class="space-y-1 sm:space-y-1.5">
      <div
        v-for="p in projects" :key="p.record_id"
        class="rounded-lg border-l-[3px] border border-border bg-card cursor-pointer group transition-colors hover:bg-muted/30 active:scale-[0.998]"
        :class="getStatusConfig(p.status).border"
        @click="openProject(p.record_id)"
      >
        <!-- ── Mobile card (matches qb-skin quick glance) ── -->
        <div class="sm:hidden px-3 py-3">
          <!-- Row 1: Star + Title + Pills -->
          <div class="flex items-center gap-1.5">
            <button class="shrink-0" @click="toggleFavorite($event, p.record_id)">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" :fill="p.is_favorite ? '#f59e0b' : 'none'" :stroke="p.is_favorite ? '#f59e0b' : 'currentColor'" stroke-width="2.5" :class="p.is_favorite ? '' : 'text-muted-foreground/70'"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
            <p class="text-[12px] font-semibold flex-1 min-w-0 truncate">{{ p.customer_name || 'Unnamed' }}</p>
            <div class="flex gap-1 shrink-0 items-center">
              <span v-if="p.state" class="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ p.state }}</span>
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold" :class="[getStatusConfig(p.status).bg, getStatusConfig(p.status).text]">{{ p.status }}</span>
            </div>
          </div>

          <!-- Row 2: Subtitle (date · kW · closer · lender) -->
          <p class="text-[10px] text-muted-foreground mt-0.5 truncate">
            {{ fmtDate(p.sales_date) }}<template v-if="p.system_size_kw"> · {{ p.system_size_kw.toFixed(1) }} kW</template><template v-if="p.closer"> · {{ p.closer }}</template><template v-if="p.lender"> · {{ p.lender }}</template>
          </p>

          <!-- Row 3: Next task -->
          <div v-if="nextTask(p)" class="flex justify-between items-center text-[10px]">
            <span class="text-muted-foreground">Next</span>
            <span class="font-medium">{{ nextTask(p) }}</span>
          </div>

          <!-- Row 5: Milestone tracker (full dots + labels) -->
          <div class="mt-2 pt-2 border-t border-border/50 flex items-start justify-between gap-2">
            <div class="flex items-start">
              <template v-for="(ms, i) in getMilestones(p)" :key="ms.key">
                <div v-if="i > 0" class="mt-[8px] shrink-0" :class="getMilestones(p)[i-1]!.state === 'done' ? 'bg-emerald-400' : 'bg-[#e2e8f0]'" style="width:6px;height:2px" />
                <div class="flex flex-col items-center flex-none">
                  <div class="relative">
                    <div
                      class="flex items-center justify-center rounded-full text-[9px] font-bold"
                      style="width:18px;height:18px;box-shadow:0 1px 3px rgba(0,0,0,0.1)"
                      :class="{
                        'bg-emerald-500 text-white': ms.state === 'done',
                        'bg-amber-400 text-white': ms.state === 'active',
                        'bg-blue-500 text-white animate-pulse': ms.state === 'scheduled',
                        'bg-red-500 text-white': ms.state === 'rejected',
                        'bg-violet-500 text-white': ms.state === 'overdue',
                        'bg-[#e2e8f0] text-transparent': ms.state === 'not',
                      }"
                    >{{ dotStyle[ms.state].icon }}</div>
                    <span v-if="ms.notify" class="absolute -top-[3px] -right-[3px] size-2 rounded-full bg-red-500 border-[1.5px] border-white" />
                  </div>
                  <span
                    class="text-[9px] font-semibold mt-[3px] whitespace-nowrap"
                    :class="labelStyle[ms.state]"
                  >{{ ms.label }}</span>
                </div>
              </template>
            </div>
            <div v-if="p.open_tickets && p.open_tickets > 0" class="flex items-center gap-1 text-muted-foreground shrink-0" :title="`${p.open_tickets} open ticket${p.open_tickets === 1 ? '' : 's'}`">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>
              <span class="text-[10px] font-semibold">{{ p.open_tickets }}</span>
            </div>
          </div>

          <!-- AI: hold classifier (collapsible) -->
          <div v-if="holdClassifications[p.record_id]" class="mt-1.5 pt-1.5 border-t border-dashed border-border/60">
            <button @click="toggleAi($event, p.record_id)" class="flex items-center gap-1.5 text-[10px] w-full text-left min-w-0">
              <span class="flex items-center gap-1 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="url(#aig-m)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="aig-m" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#6366f1"/></linearGradient></defs><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>
                <span class="text-[9px] font-semibold tracking-widest bg-gradient-to-r from-violet-500 to-indigo-500 bg-clip-text text-transparent">AI</span>
              </span>
              <span v-if="isStuck(holdClassifications[p.record_id]!)" class="size-1.5 rounded-full bg-red-500 animate-pulse shrink-0" :title="`Stuck ${holdClassifications[p.record_id]!.last_movement_days}d`" />
              <span class="font-medium text-foreground truncate flex-1 min-w-0">{{ holdClassifications[p.record_id]!.category }} · {{ holdClassifications[p.record_id]!.subcategory }}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0 transition-transform" :class="aiExpanded[p.record_id] ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div v-if="aiExpanded[p.record_id]" class="mt-1 pl-[14px] text-[10px] space-y-0.5">
              <div class="flex gap-3 text-muted-foreground">
                <span v-if="holdClassifications[p.record_id]!.days_on_hold != null"><span>On hold</span> <span class="font-medium text-foreground">{{ holdClassifications[p.record_id]!.days_on_hold }}d</span></span>
                <span><span>Last note</span> <span class="font-medium" :class="isStuck(holdClassifications[p.record_id]!) ? 'text-red-600' : 'text-foreground'">{{ holdClassifications[p.record_id]!.last_movement_days }}d ago</span></span>
              </div>
              <p class="text-foreground">{{ holdClassifications[p.record_id]!.suggested_next_action }}</p>
              <p class="text-muted-foreground italic">{{ holdClassifications[p.record_id]!.one_line_reason }}</p>
            </div>
          </div>
        </div>

        <!-- ── Desktop card ── -->
        <div class="hidden sm:block px-4 py-3">
          <div class="flex gap-3">
            <!-- Left: name, address, meta rows -->
            <div class="flex-1 min-w-0">
              <!-- Row 1: Star + Name + pills -->
              <div class="flex items-center gap-1.5">
                <button class="shrink-0" @click="toggleFavorite($event, p.record_id)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" :fill="p.is_favorite ? '#f59e0b' : 'none'" :stroke="p.is_favorite ? '#f59e0b' : 'currentColor'" stroke-width="2.5" :class="p.is_favorite ? '' : 'text-muted-foreground/70 group-hover:text-muted-foreground'"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
                <p class="text-[12px] font-semibold truncate group-hover:text-primary transition-colors">{{ p.customer_name || 'Unnamed' }}</p>
                <span v-if="p.state" class="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ p.state }}</span>
                <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold" :class="[getStatusConfig(p.status).bg, getStatusConfig(p.status).text]">{{ p.status }}</span>
              </div>
              <!-- Row 2: Address -->
              <p class="text-[10px] text-muted-foreground truncate mt-0.5">{{ p.customer_address }}</p>
              <!-- Row 3: Key-value pairs -->
              <div class="flex gap-x-5 mt-1 text-[10px]">
                <div v-if="p.coordinator" class="flex gap-1.5"><span class="text-muted-foreground">PC</span><span class="font-medium">{{ p.coordinator }}</span></div>
                <div v-if="p.closer" class="flex gap-1.5"><span class="text-muted-foreground">Closer</span><span class="font-medium truncate max-w-[120px]">{{ p.closer }}</span></div>
                <div v-if="p.lender" class="flex gap-1.5"><span class="text-muted-foreground">Lender</span><span class="font-medium truncate max-w-[120px]">{{ p.lender }}</span></div>
                <div v-if="p.system_size_kw" class="flex gap-1.5"><span class="text-muted-foreground">kW</span><span class="font-medium">{{ p.system_size_kw.toFixed(1) }}</span></div>
                <div class="flex gap-1.5"><span class="text-muted-foreground">Sale</span><span class="font-medium">{{ fmtDateFull(p.sales_date) }}</span></div>
              </div>
            </div>

            <!-- Right: Milestone tracker + AI read -->
            <div class="shrink-0 flex flex-col items-end gap-0.5 pt-0.5 min-w-[200px] max-w-[320px]">
              <!-- Dot tracker with labels -->
              <div class="flex items-start gap-0">
                <template v-for="(ms, i) in getMilestones(p)" :key="ms.key">
                  <div v-if="i > 0" class="w-[8px] h-[2px] mt-[8px]" :class="connectorStyle(getMilestones(p)[i-1]!.state === 'done')" />
                  <div class="flex flex-col items-center">
                    <div class="relative">
                      <div
                        class="size-[18px] rounded-full flex items-center justify-center text-[9px] font-bold leading-none shadow-sm"
                        :class="[dotStyle[ms.state].bg, dotStyle[ms.state].text, ms.state === 'scheduled' ? 'animate-pulse' : '']"
                        :title="ms.label"
                      >{{ dotStyle[ms.state].icon }}</div>
                      <span v-if="ms.notify" class="absolute -top-[3px] -right-[3px] size-[8px] rounded-full bg-red-500 border-[1.5px] border-white" />
                    </div>
                    <span class="text-[8px] font-semibold mt-[2px] whitespace-nowrap" :class="labelStyle[ms.state]">{{ ms.label }}</span>
                  </div>
                </template>
              </div>
              <!-- Next task + tickets -->
              <div class="flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
                <div class="text-right">
                  <p v-if="nextTask(p)"><span class="text-muted-foreground">Next</span> <span class="font-medium text-foreground">{{ nextTask(p) }}</span></p>
                  <p v-else-if="has(p.pto_approved)">PTO: <span class="font-medium text-foreground">{{ fmtDate(p.pto_approved) }}</span></p>
                </div>
                <div v-if="p.open_tickets && p.open_tickets > 0" class="flex items-center gap-1" :title="`${p.open_tickets} open ticket${p.open_tickets === 1 ? '' : 's'}`">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>
                  <span class="text-[10px] font-semibold">{{ p.open_tickets }}</span>
                </div>
              </div>
              <!-- AI: hold classifier (collapsible) -->
              <div v-if="holdClassifications[p.record_id]" class="mt-1.5 pt-1.5 border-t border-dashed border-border/60 w-full self-end">
                <button @click="toggleAi($event, p.record_id)" class="flex items-center gap-1.5 text-[10px] w-full text-left min-w-0">
                  <span class="flex items-center gap-1 shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="url(#aig-d)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="aig-d" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#6366f1"/></linearGradient></defs><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>
                    <span class="text-[9px] font-semibold tracking-widest bg-gradient-to-r from-violet-500 to-indigo-500 bg-clip-text text-transparent">AI</span>
                  </span>
                  <span v-if="isStuck(holdClassifications[p.record_id]!)" class="size-1.5 rounded-full bg-red-500 animate-pulse shrink-0" :title="`Stuck ${holdClassifications[p.record_id]!.last_movement_days}d`" />
                  <span class="font-medium text-foreground truncate flex-1 min-w-0 text-right">{{ holdClassifications[p.record_id]!.category }} · {{ holdClassifications[p.record_id]!.subcategory }}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0 transition-transform" :class="aiExpanded[p.record_id] ? 'rotate-180' : ''"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div v-if="aiExpanded[p.record_id]" class="mt-1 text-[10px] space-y-0.5 text-right">
                  <div class="flex gap-3 text-muted-foreground justify-end">
                    <span v-if="holdClassifications[p.record_id]!.days_on_hold != null"><span>On hold</span> <span class="font-medium text-foreground">{{ holdClassifications[p.record_id]!.days_on_hold }}d</span></span>
                    <span><span>Last note</span> <span class="font-medium" :class="isStuck(holdClassifications[p.record_id]!) ? 'text-red-600' : 'text-foreground'">{{ holdClassifications[p.record_id]!.last_movement_days }}d ago</span></span>
                  </div>
                  <p class="text-foreground">{{ holdClassifications[p.record_id]!.suggested_next_action }}</p>
                  <p class="text-muted-foreground italic">{{ holdClassifications[p.record_id]!.one_line_reason }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p v-if="!loading && projects.length > 0 && projects.length < total" class="text-center text-xs text-muted-foreground py-2">Showing {{ projects.length }} of {{ total.toLocaleString() }}</p>
  </div>
</template>
