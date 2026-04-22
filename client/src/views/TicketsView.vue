<script setup lang="ts">
import { ref, computed, inject, onMounted, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { fmtDate, fmtDateLong as fmtDateFull, daysBetween, timeAgo, localTodayIso, localDateKey } from '@/lib/dates'

const auth = useAuthStore()

interface Ticket {
  record_id: number; title: string; description: string; date_created: string
  project_name: string; project_rid: number | null; category: string; issue: string
  assigned_to: string; requested_by: string; status: string; priority: string
  due_date: string; coordinator: string; closer: string; state: string
  disposition: string; blocker: number; project_status: string
  date_modified: string; last_modified_by: string; recent_note: string
}

interface FilterOption { value: string; count: number }
interface PivotRow { name: string; past_due: number; today: number; future: number; total: number }

const tickets = ref<Ticket[]>([])
const total = ref(0)
const loading = ref(true)
const refreshing = ref(false)
const search = ref('')
const selectedTicket = ref<Ticket | null>(null)
const detailRef = ref<HTMLElement | null>(null)

async function openTicket(t: Ticket) {
  selectedTicket.value = t
  await nextTick()
  detailRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

const kpi = ref({ allOpen: 0, overdue: 0, dueToday: 0, futureDue: 0 })
const scope = ref<'mine' | 'all' | 'user'>('mine')
const scopeUser = ref('')
const dueFilter = ref('')
const fPriority = ref('')
const fCategory = ref('')
const fIssue = ref('')
const fCoordinator = ref('')
const showFilters = ref(false)
const viewMode = ref<'list' | 'activity'>('list')

// Pivot
const pivotDimension = ref('assigned_to')
const pivotData = ref<PivotRow[]>([])
const showPivot = ref(true)
const pivotOptions = [
  { key: 'assigned_to', label: 'Assigned To' },
  { key: 'requested_by', label: 'Requested By' },
  { key: 'category', label: 'Category' },
  { key: 'issue', label: 'Issue' },
  { key: 'state', label: 'State' },
  { key: 'coordinator', label: 'Coordinator' },
]

const filters = ref<{ priorities: FilterOption[]; assignees: FilterOption[]; categories: FilterOption[]; issues: FilterOption[]; coordinators: FilterOption[] }>({
  priorities: [], assignees: [], categories: [], issues: [], coordinators: []
})

let searchTimeout: ReturnType<typeof setTimeout> | null = null
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function loadTickets() {
  loading.value = true
  const params = new URLSearchParams({ limit: '100', pivot: pivotDimension.value, today: localTodayIso() })
  if (search.value.trim()) params.set('q', search.value.trim())
  if (dueFilter.value) params.set('due', dueFilter.value)
  if (fPriority.value) params.set('priority', fPriority.value)
  if (scope.value === 'mine' && auth.user?.name) params.set('assigned', auth.user.name)
  else if (scope.value === 'user' && scopeUser.value) params.set('assigned', scopeUser.value)
  if (fCategory.value) params.set('category', fCategory.value)
  if (fIssue.value) params.set('issue', fIssue.value)
  if (fCoordinator.value) params.set('coordinator', fCoordinator.value)

  try {
    const res = await fetch(`/api/tickets?${params}`, { headers: hdrs() })
    const data = await res.json()
    tickets.value = data.tickets; total.value = data.total; kpi.value = data.kpi
    filters.value = data.filters; pivotData.value = data.pivot.data
  } finally { loading.value = false }
}

async function refreshCache() {
  refreshing.value = true
  try { await fetch('/api/tickets/refresh', { method: 'POST', headers: hdrs() }); await loadTickets() }
  finally { refreshing.value = false }
}

function onSearch() { if (searchTimeout) clearTimeout(searchTimeout); searchTimeout = setTimeout(() => loadTickets(), 200) }
function setDue(val: string) { dueFilter.value = dueFilter.value === val ? '' : val; loadTickets() }
function setPriority(val: string) { fPriority.value = fPriority.value === val ? '' : val; loadTickets() }
function setScope(s: 'mine' | 'all' | 'user', user?: string) { scope.value = s; scopeUser.value = user || ''; loadTickets() }
function switchPivot(dim: string) { pivotDimension.value = dim; loadTickets() }

// Track what was drilled into from the pivot
const drillLabel = ref('')
const drillValue = ref('')

function drillPivot(name: string) {
  const dim = pivotDimension.value
  const label = pivotOptions.find(p => p.key === dim)?.label || dim
  drillLabel.value = label
  drillValue.value = name

  if (dim === 'assigned_to') setScope('user', name)
  else if (dim === 'requested_by') { /* requested_by not a filter yet — use search */ search.value = name; loadTickets() }
  else if (dim === 'category') { fCategory.value = name; loadTickets() }
  else if (dim === 'issue') { fIssue.value = name; loadTickets() }
  else if (dim === 'state') { /* state not a direct filter — use search */ search.value = name; loadTickets() }
  else if (dim === 'coordinator') { fCoordinator.value = name; loadTickets() }
  showPivot.value = false
  selectedTicket.value = null
}

function backToPivot() {
  drillLabel.value = ''
  drillValue.value = ''
  search.value = ''
  fCategory.value = ''
  fIssue.value = ''
  fCoordinator.value = ''
  if (scope.value === 'user') scope.value = 'all'
  scopeUser.value = ''
  showPivot.value = true
  selectedTicket.value = null
  loadTickets()
}

function clearFilters() {
  search.value = ''; dueFilter.value = ''; fPriority.value = ''; fCategory.value = ''
  fIssue.value = ''; fCoordinator.value = ''; scope.value = 'mine'; scopeUser.value = ''
  drillLabel.value = ''; drillValue.value = ''; showPivot.value = true; selectedTicket.value = null
  loadTickets()
}

const hasFilters = computed(() => search.value || dueFilter.value || fPriority.value || fCategory.value || fIssue.value || fCoordinator.value || scope.value !== 'mine')

// Activity view: sort by date_modified desc
const activityTickets = computed(() => {
  return [...tickets.value].sort((a, b) => {
    const da = a.date_modified || ''; const db = b.date_modified || ''
    return db.localeCompare(da)
  })
})

const priorityBorder: Record<string, string> = { 'High': 'border-l-red-400', 'Medium': 'border-l-orange-400', 'Low': 'border-l-emerald-400' }
function pBorder(p: string) { return priorityBorder[p] || 'border-l-muted-foreground/20' }

function dueStatus(d: string): { label: string; cls: string } {
  if (!d || d === '' || d === '0') return { label: '', cls: '' }
  const today = localTodayIso()
  const due = localDateKey(d)
  if (!due) return { label: '', cls: '' }
  if (due < today) return { label: 'Past Due', cls: 'bg-red-100 text-red-700' }
  if (due === today) return { label: 'Due Today', cls: 'bg-amber-100 text-amber-700' }
  return { label: 'On Track', cls: 'bg-emerald-100 text-emerald-700' }
}

function daysPastDue(d: string): number { return Math.max(0, daysBetween(d)) }
function ticketAge(d: string): number { return Math.max(0, daysBetween(d)) }

const registerRefresh = inject<(fn: () => Promise<void>) => void>('registerRefresh')
onMounted(() => { loadTickets().then(() => { if (kpi.value.allOpen === 0 && auth.isAdmin) refreshCache() }); registerRefresh?.(() => loadTickets()) })
</script>

<template>
  <div class="grid gap-2 sm:gap-3 min-w-0 max-w-full overflow-x-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-4">
        <div><h1 class="text-2xl font-semibold tracking-tight">Tickets</h1><p class="text-muted-foreground text-sm">{{ total.toLocaleString() }}{{ hasFilters ? ' matched' : '' }}</p></div>
        <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg">
          <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors" :class="viewMode === 'list' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'" @click="viewMode = 'list'">List</button>
          <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors" :class="viewMode === 'activity' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'" @click="viewMode = 'activity'">Activity</button>
        </div>
      </div>
      <Button v-if="auth.isAdmin" variant="outline" size="sm" class="shrink-0" :disabled="refreshing" @click="refreshCache">{{ refreshing ? 'Refreshing...' : 'Refresh' }}</Button>
    </div>

    <!-- ═══════ LIST VIEW ═══════ -->
    <template v-if="viewMode === 'list'">

    <!-- KPI chips (horizontal scroll) -->
    <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
      <button
        v-for="chip in [
          { key: '', label: 'All', value: kpi.allOpen, color: 'text-foreground', bar: 'bg-foreground' },
          { key: 'overdue', label: 'Past Due', value: kpi.overdue, color: 'text-red-600', bar: 'bg-red-500' },
          { key: 'today', label: 'Today', value: kpi.dueToday, color: 'text-amber-600', bar: 'bg-amber-400' },
          { key: 'future', label: 'Future', value: kpi.futureDue, color: 'text-emerald-600', bar: 'bg-emerald-500' },
        ]" :key="chip.key"
        class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] text-left transition-all active:scale-[0.97]"
        :class="dueFilter === chip.key ? 'bg-card shadow-md' : 'bg-card/60 hover:bg-card'"
        @click="setDue(chip.key)"
      >
        <div class="h-[3px] rounded-full -mt-0.5 mb-1" :class="chip.bar" />
        <p class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ chip.label }}</p>
        <p class="text-lg sm:text-xl font-extrabold" :class="chip.color">{{ chip.value }}</p>
      </button>
    </div>

    <!-- Scope: Mine / All / User -->
    <div class="flex items-center gap-2 flex-wrap">
      <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg shrink-0">
        <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors" :class="scope === 'mine' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'" @click="setScope('mine')">Mine</button>
        <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors" :class="scope === 'all' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'" @click="setScope('all')">All</button>
      </div>
      <Select :model-value="scope === 'user' ? scopeUser : '__pick__'" @update:model-value="(v: string) => { if (v !== '__pick__') setScope('user', v) }">
        <SelectTrigger class="h-8 w-auto min-w-[110px] text-xs"><SelectValue placeholder="Select user..." /></SelectTrigger>
        <SelectContent><SelectItem value="__pick__" disabled>Select user...</SelectItem><SelectItem v-for="a in filters.assignees" :key="a.value" :value="a.value">{{ a.value }} ({{ a.count }})</SelectItem></SelectContent>
      </Select>
      <span v-if="scope === 'user'" class="text-xs text-muted-foreground truncate max-w-[120px] inline-flex items-center gap-1">{{ scopeUser }} <button class="shrink-0 hover:text-foreground" @click="setScope('mine')"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></span>
    </div>

    <!-- Priority chips -->
    <div class="flex gap-1.5 flex-wrap">
      <button
        v-for="p in filters.priorities" :key="p.value"
        class="px-3 py-1 rounded-full text-xs font-semibold border transition-colors"
        :class="fPriority === p.value
          ? 'bg-foreground text-background border-foreground'
          : 'bg-card border-border text-muted-foreground hover:text-foreground'"
        @click="setPriority(p.value)"
      >{{ p.value }} <span class="opacity-60 ml-0.5">{{ p.count }}</span></button>
    </div>

    <!-- Search -->
    <div class="relative">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <Input v-model="search" @input="onSearch" placeholder="Search title, project, assignee..." class="pl-9 pr-9 h-9" />
      <button v-if="search" @click="search = ''; loadTickets()" class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" title="Clear search">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <!-- More filters -->
    <div class="flex gap-1.5 items-center flex-wrap">
      <Select :model-value="fCategory || '__all__'" @update:model-value="(v: string) => { fCategory = v === '__all__' ? '' : v; loadTickets() }">
        <SelectTrigger class="h-7 w-auto text-xs"><SelectValue placeholder="Category" /></SelectTrigger>
        <SelectContent><SelectItem value="__all__">All categories</SelectItem><SelectItem v-for="c in filters.categories" :key="c.value" :value="c.value">{{ c.value }} ({{ c.count }})</SelectItem></SelectContent>
      </Select>
      <Select :model-value="fIssue || '__all__'" @update:model-value="(v: string) => { fIssue = v === '__all__' ? '' : v; loadTickets() }">
        <SelectTrigger class="h-7 w-auto text-xs"><SelectValue placeholder="Issue" /></SelectTrigger>
        <SelectContent><SelectItem value="__all__">All issues</SelectItem><SelectItem v-for="i in filters.issues" :key="i.value" :value="i.value">{{ i.value }} ({{ i.count }})</SelectItem></SelectContent>
      </Select>
      <Select :model-value="fCoordinator || '__all__'" @update:model-value="(v: string) => { fCoordinator = v === '__all__' ? '' : v; loadTickets() }">
        <SelectTrigger class="h-7 w-auto text-xs"><SelectValue placeholder="PC" /></SelectTrigger>
        <SelectContent><SelectItem value="__all__">All PCs</SelectItem><SelectItem v-for="c in filters.coordinators" :key="c.value" :value="c.value">{{ c.value }} ({{ c.count }})</SelectItem></SelectContent>
      </Select>
      <button v-if="hasFilters" class="text-xs text-muted-foreground hover:text-foreground shrink-0" @click="clearFilters">Clear</button>
    </div>

    <!-- Pivot strip + summary -->
    <div v-if="showPivot" class="space-y-0">
      <div class="flex gap-1.5 overflow-x-auto pb-2 no-scrollbar">
        <button
          v-for="p in pivotOptions" :key="p.key"
          class="px-3 py-1.5 rounded-full text-xs font-semibold border whitespace-nowrap transition-colors"
          :class="pivotDimension === p.key
            ? 'bg-foreground text-background border-foreground'
            : 'bg-card border-border text-muted-foreground hover:text-foreground'"
          @click="switchPivot(p.key)"
        >{{ p.label }}</button>
      </div>

      <!-- Desktop: table -->
      <div v-if="pivotData.length" class="hidden sm:block rounded-xl border bg-card overflow-hidden">
        <Table class="table-fixed w-full">
          <TableHeader>
            <TableRow class="hover:bg-transparent text-xs">
              <TableHead class="text-xs">{{ pivotOptions.find(p => p.key === pivotDimension)?.label }}</TableHead>
              <TableHead class="text-xs text-right text-red-600 w-[55px]">Past Due</TableHead>
              <TableHead class="text-xs text-right text-amber-600 w-[55px]">Today</TableHead>
              <TableHead class="text-xs text-right text-emerald-600 w-[55px]">Future</TableHead>
              <TableHead class="text-xs text-right w-[50px]">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in pivotData" :key="row.name" class="cursor-pointer hover:bg-muted/40" @click="drillPivot(row.name)">
              <TableCell class="text-sm font-medium truncate max-w-[200px]">{{ row.name }}</TableCell>
              <TableCell class="text-right text-xs font-mono" :class="row.past_due > 0 ? 'text-red-600 font-bold' : 'text-muted-foreground'">{{ row.past_due || '—' }}</TableCell>
              <TableCell class="text-right text-xs font-mono" :class="row.today > 0 ? 'text-amber-600 font-bold' : 'text-muted-foreground'">{{ row.today || '—' }}</TableCell>
              <TableCell class="text-right text-xs font-mono text-muted-foreground">{{ row.future || '—' }}</TableCell>
              <TableCell class="text-right text-xs font-mono font-bold">{{ row.total }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <!-- Mobile: same table but designed to fit -->
      <div v-if="pivotData.length" class="sm:hidden rounded-xl border bg-card overflow-hidden">
        <table class="w-full border-collapse" style="table-layout:fixed">
          <thead>
            <tr class="bg-muted/30">
              <th class="text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground p-2" style="width:36%">{{ pivotOptions.find(p => p.key === pivotDimension)?.label }}</th>
              <th class="text-center text-[10px] font-bold uppercase tracking-wider text-red-500 p-2">Due</th>
              <th class="text-center text-[10px] font-bold uppercase tracking-wider text-amber-500 p-2">Today</th>
              <th class="text-center text-[10px] font-bold uppercase tracking-wider text-emerald-500 p-2">Future</th>
              <th class="text-center text-[10px] font-bold uppercase tracking-wider text-foreground p-2">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in pivotData" :key="row.name"
              class="border-t border-border/50 cursor-pointer active:bg-muted/30"
              @click="drillPivot(row.name)"
            >
              <td class="p-2 text-[13px] font-semibold truncate">{{ row.name }}</td>
              <td class="p-2 text-center text-[13px] font-medium" :class="row.past_due > 0 ? 'text-red-600 font-bold' : 'text-muted-foreground'">{{ row.past_due || '—' }}</td>
              <td class="p-2 text-center text-[13px] font-medium" :class="row.today > 0 ? 'text-amber-600 font-bold' : 'text-muted-foreground'">{{ row.today || '—' }}</td>
              <td class="p-2 text-center text-[13px] text-muted-foreground">{{ row.future || '—' }}</td>
              <td class="p-2 text-center text-[13px] font-bold">{{ row.total }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <!-- Drill context bar -->
    <div v-if="!showPivot && drillValue" class="flex items-center gap-3 rounded-lg bg-card px-4 py-2.5">
      <button
        class="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        @click="backToPivot"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
        Summary
      </button>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-muted-foreground/40"><path d="m9 18 6-6-6-6"/></svg>
      <span class="text-xs text-muted-foreground">{{ drillLabel }}</span>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-muted-foreground/40"><path d="m9 18 6-6-6-6"/></svg>
      <span class="text-sm font-semibold">{{ drillValue }}</span>
      <span class="text-xs text-muted-foreground ml-1">({{ total }})</span>
    </div>
    <button v-else-if="!showPivot" class="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground text-left" @click="backToPivot">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
      Back to summary
    </button>

    <!-- Loading -->
    <div v-if="loading && tickets.length === 0" class="space-y-2"><div v-for="i in 8" :key="i" class="rounded-lg border bg-card h-16 animate-pulse" /></div>

    <!-- Empty -->
    <div v-else-if="tickets.length === 0" class="rounded-xl border bg-card p-12 text-center"><p class="text-muted-foreground">No tickets found.</p></div>

    <!-- Ticket cards (matches example: title+pill, assignee, sub line) -->
    <div v-else class="space-y-2.5">
      <div
        v-for="t in tickets" :key="t.record_id"
        class="rounded-[14px] border border-border border-l-[3px] bg-card cursor-pointer transition-transform active:scale-[0.985]"
        :class="[pBorder(t.priority), t.due_date && dueStatus(t.due_date).label === 'Past Due' ? 'bg-red-50/40' : '']"
        @click="openTicket(t)"
      >
        <div class="px-4 py-3.5">
          <!-- Row 1: Title + status pill -->
          <div class="flex justify-between items-start gap-2">
            <p class="text-[15px] font-semibold flex-1 min-w-0 leading-snug truncate">{{ t.title || 'Untitled' }}</p>
            <span v-if="dueStatus(t.due_date).label" class="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold" :class="dueStatus(t.due_date).cls">{{ dueStatus(t.due_date).label }}</span>
          </div>
          <!-- Row 2: Assignee (bold) -->
          <p v-if="t.assigned_to" class="text-xs font-semibold mt-1 truncate">{{ t.assigned_to }}</p>
          <!-- Row 3: Sub line (dot separated) -->
          <p class="text-xs text-muted-foreground mt-0.5">
            <template v-if="t.due_date && t.due_date !== '0'">{{ fmtDate(t.due_date) }}</template>
            <template v-if="daysPastDue(t.due_date) > 0"><span class="text-red-500 font-semibold ml-1">{{ daysPastDue(t.due_date) }}d overdue</span></template>
            <template v-if="ticketAge(t.date_created) > 0"> · <span :class="ticketAge(t.date_created) > 14 ? 'text-red-500 font-semibold' : ticketAge(t.date_created) > 7 ? 'text-amber-600 font-semibold' : ''">{{ ticketAge(t.date_created) }}d old</span></template>
            <template v-if="t.category"> · {{ t.category }}</template>
            <template v-if="t.project_name"> · {{ t.project_name }}</template>
          </p>
        </div>
      </div>
    </div>

    <!-- Detail panel (inline, scrolls into view) -->
    <div v-if="selectedTicket" ref="detailRef" class="rounded-xl border bg-card">
      <div class="p-4 sm:p-5 border-b">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-lg font-bold leading-snug">{{ selectedTicket.title }}</p>
            <p class="text-sm text-muted-foreground mt-1">{{ selectedTicket.project_name }}</p>
          </div>
          <div class="flex gap-2 items-center shrink-0">
            <Badge v-if="dueStatus(selectedTicket.due_date).label" :class="dueStatus(selectedTicket.due_date).cls" class="text-xs font-semibold rounded-full px-2.5 py-0.5">{{ dueStatus(selectedTicket.due_date).label }}</Badge>
            <button class="size-8 rounded-md hover:bg-muted flex items-center justify-center" @click="selectedTicket = null" title="Close"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
        </div>
      </div>
      <div v-if="selectedTicket.description" class="px-4 sm:px-5 py-3 border-b"><p class="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">{{ selectedTicket.description }}</p></div>
      <div v-if="selectedTicket.recent_note" class="px-4 sm:px-5 py-3 border-b">
        <p class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-1.5">Latest Note</p>
        <p class="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{{ selectedTicket.recent_note }}</p>
        <p v-if="selectedTicket.last_modified_by" class="text-[11px] text-muted-foreground mt-1.5">{{ selectedTicket.last_modified_by }} · {{ timeAgo(selectedTicket.date_modified) }}</p>
      </div>
      <div class="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        <div v-for="field in [
          { label: 'Assigned To', value: selectedTicket.assigned_to },
          { label: 'Requested By', value: selectedTicket.requested_by },
          { label: 'Category', value: selectedTicket.category },
          { label: 'Issue', value: selectedTicket.issue },
          { label: 'Priority', value: selectedTicket.priority },
          { label: 'Status', value: selectedTicket.status },
          { label: 'Due Date', value: fmtDateFull(selectedTicket.due_date) },
          { label: 'Date Created', value: fmtDateFull(selectedTicket.date_created) },
          { label: 'Coordinator', value: selectedTicket.coordinator },
          { label: 'Closer', value: selectedTicket.closer },
          { label: 'State', value: selectedTicket.state },
          { label: 'Disposition', value: selectedTicket.disposition },
          { label: 'Project Status', value: selectedTicket.project_status },
        ].filter(f => f.value && f.value !== '—')" :key="field.label" class="text-sm">
          <span class="text-muted-foreground text-xs">{{ field.label }}</span>
          <p class="font-medium truncate">{{ field.value }}</p>
        </div>
        <div v-if="selectedTicket.blocker" class="text-sm"><span class="text-muted-foreground text-xs">Blocker</span><p class="font-semibold text-red-600">Yes</p></div>
      </div>
      <div class="px-4 sm:px-5 pb-4">
        <a :href="`https://kin.quickbase.com/db/bstdqwrkg?a=dr&rid=${selectedTicket.record_id}`" target="_blank" class="text-xs text-muted-foreground hover:text-foreground underline">Open in QuickBase</a>
      </div>
    </div>

    <p v-if="!loading && tickets.length > 0 && tickets.length < total" class="text-center text-xs text-muted-foreground py-2">Showing {{ tickets.length }} of {{ total.toLocaleString() }}</p>

    </template>

    <!-- ═══════ ACTIVITY VIEW ═══════ -->
    <template v-if="viewMode === 'activity'">
      <!-- Scope for activity -->
      <div class="flex items-center gap-2 flex-wrap">
        <div class="flex gap-0.5 p-0.5 bg-muted rounded-lg shrink-0">
          <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors" :class="scope === 'mine' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'" @click="setScope('mine')">Mine</button>
          <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors" :class="scope === 'all' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'" @click="setScope('all')">All</button>
        </div>
        <Select :model-value="scope === 'user' ? scopeUser : '__pick__'" @update:model-value="(v: string) => { if (v !== '__pick__') setScope('user', v) }">
          <SelectTrigger class="h-8 w-auto min-w-[110px] text-xs"><SelectValue placeholder="Select user..." /></SelectTrigger>
          <SelectContent><SelectItem value="__pick__" disabled>Select user...</SelectItem><SelectItem v-for="a in filters.assignees" :key="a.value" :value="a.value">{{ a.value }}</SelectItem></SelectContent>
        </Select>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="space-y-3">
        <div v-for="i in 6" :key="i" class="rounded-lg bg-card p-4 h-20 animate-pulse" />
      </div>

      <!-- Empty -->
      <div v-else-if="activityTickets.length === 0" class="rounded-xl bg-card p-12 text-center">
        <p class="text-muted-foreground">No recent activity.</p>
      </div>

      <!-- Activity feed -->
      <div v-else class="space-y-2.5">
        <div
          v-for="t in activityTickets" :key="t.record_id"
          class="rounded-[14px] border border-border border-l-[3px] bg-card cursor-pointer transition-transform active:scale-[0.985]"
          :class="[pBorder(t.priority), t.due_date && dueStatus(t.due_date).label === 'Past Due' ? 'bg-red-50/40' : '']"
          @click="selectedTicket = t; viewMode = 'list'"
        >
          <div class="px-4 py-3.5">
            <!-- Who updated + when -->
            <div class="flex items-center gap-2">
              <div class="size-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span class="text-[9px] font-bold text-primary">{{ (t.last_modified_by || '?').split(' ').map((w: string) => w[0]).join('').slice(0,2) }}</span>
              </div>
              <span class="text-xs font-bold flex-1 min-w-0 truncate">{{ t.last_modified_by || 'Unknown' }}</span>
              <span class="text-[11px] text-muted-foreground shrink-0">{{ timeAgo(t.date_modified) }}</span>
            </div>

            <!-- Title + pill -->
            <div class="flex justify-between items-start gap-2 mt-2">
              <p class="text-[15px] font-semibold flex-1 min-w-0 leading-snug truncate">{{ t.title || 'Untitled' }}</p>
              <span v-if="dueStatus(t.due_date).label" class="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold" :class="dueStatus(t.due_date).cls">{{ dueStatus(t.due_date).label }}</span>
            </div>

            <!-- Assignee -->
            <p v-if="t.assigned_to" class="text-xs font-semibold mt-1">{{ t.assigned_to }}</p>

            <!-- Sub line -->
            <p class="text-xs text-muted-foreground mt-0.5">
              <template v-if="t.due_date && t.due_date !== '0'">{{ fmtDate(t.due_date) }}</template>
              <template v-if="daysPastDue(t.due_date) > 0"><span class="text-red-500 font-semibold ml-1">{{ daysPastDue(t.due_date) }}d overdue</span></template>
              <template v-if="t.category"> · {{ t.category }}</template>
              <template v-if="t.project_name"> · {{ t.project_name }}</template>
            </p>

            <!-- Recent note -->
            <div v-if="t.recent_note" class="mt-2 px-3 py-2 rounded-[10px] bg-muted/30 text-xs text-muted-foreground leading-relaxed line-clamp-2">
              {{ t.recent_note }}
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
