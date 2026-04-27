<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, inject } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'

// Field Ops dashboard — Vue rebuild of context-files/Field/example view.
// Pulls Arrivy task data from /api/field/tasks (which proxies QuickBase),
// derives the same status logic, and renders KPI strip + tabs (Leaderboard
// / Activity Feed) with drill-down. Mobile-first; horizontal-scroll only on
// the approved KPI strip.

const auth = useAuthStore()

// ─── Field IDs (mirrored from server) ──
interface FieldIds {
  scheduledDateTime: number
  customerFirstName: number
  customerLastName: number
  taskStatus: number
  templateName: number
  taskUrl: number
  enrouteStatus: number
  startedStatus: number
  submittedDateTime: number
  techCompleteDateTime: number
  enrouteName: number
  crew: number
  assignedCrew: number
  installComplete: number
  kw: number
  relatedProject: number
  rtrStatus: number
  rtrReadyCount: number
}
type QbValue = { value: unknown }
type QbRecord = Record<string, QbValue>
interface TasksResponse { preset: string; from: string; to: string; records: QbRecord[]; fields: FieldIds }

const records = ref<QbRecord[]>([])
const fieldIds = ref<FieldIds | null>(null)
const loading = ref(true)
const errorMsg = ref('')

// Late-event data (second-pass fetch). Keyed by task RID.
interface LateInfo { type: 'LATE' | 'PREDICTED_LATE' | 'NOSHOW'; timestamp: string; scheduled: string; crew: string }
const lateByTask = ref<Record<string, LateInfo>>({})
const lateLoaded = ref(false)

// ─── Filters / state ──
type Preset = 'today' | 'yesterday' | 'week' | 'month' | '30days'
const preset = ref<Preset>('today')
type Tab = 'leaderboard' | 'activity'
const tab = ref<Tab>('leaderboard')
const searchTerm = ref('')

// Drill-down state — when set, replaces the main view with grouped task cards.
const drillTitle = ref('')
const drillTasks = ref<QbRecord[]>([])
const drilling = computed(() => drillTitle.value !== '')

// Section collapse state for leaderboard sub-sections.
const collapsed = ref<Record<string, boolean>>({})
function toggleCollapsed(k: string) { collapsed.value = { ...collapsed.value, [k]: !collapsed.value[k] } }

// ─── Helpers — direct ports of the example file's utility functions ──
function qbv(rec: QbRecord, fid: number): unknown { return rec[String(fid)]?.value ?? null }
function qbStr(rec: QbRecord, fid: number): string {
  const v = rec[String(fid)]
  if (!v) return ''
  const val = v.value
  if (val === null || val === undefined) return ''
  if (typeof val === 'object') {
    const obj = val as { name?: unknown; email?: unknown }
    if (obj.name) return String(obj.name)
    if (obj.email) return String(obj.email)
    return ''
  }
  return String(val)
}
function getCrewName(t: QbRecord): string {
  const F = fieldIds.value
  if (!F) return ''
  return qbStr(t, F.crew) || qbStr(t, F.assignedCrew) || qbStr(t, F.enrouteName) || ''
}
function getInitials(name: string): string {
  return name.split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2)
}
function fmtDateTime(ds: unknown): string {
  if (!ds) return '-'
  const d = new Date(String(ds))
  if (isNaN(d.getTime())) return String(ds)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}
function fmtTime(ds: unknown): string {
  if (!ds) return '--:--'
  const d = new Date(String(ds))
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

// ─── Status classifier — direct port of getTaskStatus from the example ──
type StatusKey = 'submitted' | 'notsubmitted' | 'overdue' | 'onsite' | 'enroute' | 'scheduled'
interface StatusInfo { key: StatusKey; label: string; pillCls: string; borderCls: string }
function getTaskStatus(t: QbRecord): StatusInfo {
  const F = fieldIds.value
  if (!F) return { key: 'scheduled', label: 'Scheduled', pillCls: '', borderCls: '' }
  const arrivyStatus = String(qbv(t, F.taskStatus) || '').toLowerCase()
  const submittedDt = qbv(t, F.submittedDateTime)
  const arrivedDt = qbv(t, F.startedStatus)
  const enrouteDt = qbv(t, F.enrouteStatus)
  const isArrivyComplete = arrivyStatus === 'complete' || arrivyStatus === 'site work complete'
  const isOverdue = arrivyStatus === 'overdue'
  // 1. Arrivy says complete but tech never submitted = Not Submitted (red flag)
  if (isArrivyComplete && !submittedDt) return { key: 'notsubmitted', label: 'Not Submitted', pillCls: 'bg-red-100 text-red-700', borderCls: 'border-l-red-500 bg-red-50/40' }
  // 2. Tech submitted = Submitted (the real completion signal)
  if (submittedDt) return { key: 'submitted', label: 'Submitted', pillCls: 'bg-emerald-100 text-emerald-700', borderCls: 'border-l-emerald-500' }
  // 3. Overdue = past scheduled, nothing done
  if (isOverdue) return { key: 'overdue', label: 'Overdue', pillCls: 'bg-red-100 text-red-700', borderCls: 'border-l-red-500 bg-red-50/40' }
  // 4. Tech arrived on site
  if (arrivedDt) return { key: 'onsite', label: 'On Site', pillCls: 'bg-sky-100 text-sky-700', borderCls: 'border-l-sky-500' }
  // 5. Tech en route
  if (enrouteDt) return { key: 'enroute', label: 'En Route', pillCls: 'bg-sky-100 text-sky-700', borderCls: 'border-l-sky-500' }
  // 6. Nothing yet
  return { key: 'scheduled', label: 'Scheduled', pillCls: 'bg-muted text-muted-foreground', borderCls: '' }
}

function statusEmoji(t: QbRecord): string {
  const s = getTaskStatus(t)
  if (s.key === 'submitted') return '✅'
  if (s.key === 'notsubmitted') return '❌'
  if (s.key === 'onsite') return '🚧'
  if (s.key === 'enroute') return '🚗'
  if (s.key === 'overdue') return '⚠️'
  return '⏳'
}

function isSurveyOverdue(t: QbRecord): boolean {
  const F = fieldIds.value
  if (!F) return false
  const tmpl = String(qbv(t, F.templateName) || '').toLowerCase()
  if (!tmpl.includes('survey')) return false
  if (qbv(t, F.submittedDateTime)) return false
  const sched = qbv(t, F.scheduledDateTime)
  if (!sched) return false
  const schedDate = new Date(String(sched))
  const cutoff = new Date(schedDate.getTime() + 2 * 60 * 60 * 1000) // +2h
  return new Date() > cutoff
}

// Search filter
const filteredTasks = computed<QbRecord[]>(() => {
  const F = fieldIds.value
  if (!F) return []
  if (!searchTerm.value) return records.value
  const q = searchTerm.value.toLowerCase()
  return records.value.filter(t => {
    const tech = getCrewName(t).toLowerCase()
    const tmpl = String(qbv(t, F.templateName) || '').toLowerCase()
    const fn = String(qbv(t, F.customerFirstName) || '').toLowerCase()
    const ln = String(qbv(t, F.customerLastName) || '').toLowerCase()
    return tech.includes(q) || tmpl.includes(q) || fn.includes(q) || ln.includes(q)
  })
})

// ─── KPIs ──
interface Kpi { label: string; value: number; tone: 'info' | 'danger' | 'warning' | 'success' | 'teal'; key: string }
const kpis = computed<Kpi[]>(() => {
  const tasks = filteredTasks.value
  const F = fieldIds.value
  if (!F) return []
  let submitted = 0, notSubmitted = 0, ssOverdue = 0, active = 0, lateCount = 0
  for (const t of tasks) {
    const s = getTaskStatus(t)
    if (s.key === 'submitted') submitted++
    else if (s.key === 'notsubmitted') notSubmitted++
    else if (s.key === 'onsite' || s.key === 'enroute') active++
    if (isSurveyOverdue(t)) ssOverdue++
    if (lateLoaded.value) {
      const rid = String(qbv(t, 3) || '')
      const tmpl = String(qbv(t, F.templateName) || '').toLowerCase()
      if (lateByTask.value[rid] && tmpl.includes('survey')) lateCount++
    }
  }
  const list: Kpi[] = [
    { key: 'all', label: 'Total', value: tasks.length, tone: 'info' },
    { key: 'notsubmitted', label: 'Not Submitted', value: notSubmitted, tone: 'danger' },
  ]
  if (lateLoaded.value) list.push({ key: 'late', label: 'SS Late', value: lateCount, tone: 'warning' })
  list.push(
    { key: 'ssoverdue', label: 'SS Overdue', value: ssOverdue, tone: 'danger' },
    { key: 'submitted', label: 'Submitted', value: submitted, tone: 'success' },
    { key: 'active', label: 'On Site Now', value: active, tone: 'teal' },
  )
  return list
})

// Tone classes — accent bar + value color
const toneClass: Record<Kpi['tone'], { accent: string; value: string }> = {
  info: { accent: 'bg-sky-500', value: 'text-sky-600' },
  danger: { accent: 'bg-red-500', value: 'text-red-600' },
  warning: { accent: 'bg-amber-500', value: 'text-amber-600' },
  success: { accent: 'bg-emerald-500', value: 'text-emerald-600' },
  teal: { accent: 'bg-teal-500', value: 'text-teal-600' },
}

// ─── Leaderboard ──
interface TechRow { name: string; total: number; completed: number; rate: number }
const techRows = computed<TechRow[]>(() => {
  const F = fieldIds.value
  if (!F) return []
  const map: Record<string, { total: number; completed: number }> = {}
  for (const t of filteredTasks.value) {
    const name = getCrewName(t) || 'Unassigned'
    if (!map[name]) map[name] = { total: 0, completed: 0 }
    map[name].total++
    if (qbv(t, F.submittedDateTime)) map[name].completed++
  }
  return Object.entries(map)
    .map(([name, d]) => ({ name, total: d.total, completed: d.completed, rate: d.total ? Math.round((d.completed / d.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total)
})

// ─── Event-type breakdown ──
interface EventTypeRow { type: string; total: number; submitted: number; notsubmitted: number; onsite: number; scheduled: number; late: number; rate: number; onTimePct: number }
const eventTypeRows = computed<EventTypeRow[]>(() => {
  const F = fieldIds.value
  if (!F) return []
  const map: Record<string, EventTypeRow> = {}
  for (const t of filteredTasks.value) {
    const tmpl = String(qbv(t, F.templateName) || 'Other')
    if (!map[tmpl]) map[tmpl] = { type: tmpl, total: 0, submitted: 0, notsubmitted: 0, onsite: 0, scheduled: 0, late: 0, rate: 0, onTimePct: 100 }
    const m = map[tmpl]
    m.total++
    const s = getTaskStatus(t)
    if (s.key === 'submitted') m.submitted++
    else if (s.key === 'notsubmitted') m.notsubmitted++
    else if (s.key === 'onsite' || s.key === 'enroute') m.onsite++
    else m.scheduled++
    if (lateLoaded.value && tmpl.toLowerCase().includes('survey') && lateByTask.value[String(qbv(t, 3) || '')]) m.late++
  }
  return Object.values(map).map(m => ({
    ...m,
    rate: m.total ? Math.round((m.submitted / m.total) * 100) : 0,
    onTimePct: m.total ? Math.round(((m.total - m.late) / m.total) * 100) : 100,
  })).sort((a, b) => b.total - a.total)
})

// ─── Activity feed (morning / afternoon / evening) ──
interface Period { key: 'morning' | 'afternoon' | 'evening'; label: string }
const PERIODS: Period[] = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
]
const activityByPeriod = computed<Record<Period['key'], QbRecord[]>>(() => {
  const F = fieldIds.value
  const out = { morning: [] as QbRecord[], afternoon: [] as QbRecord[], evening: [] as QbRecord[] }
  if (!F) return out
  for (const t of filteredTasks.value) {
    const sched = qbv(t, F.scheduledDateTime)
    if (!sched) continue
    const hour = new Date(String(sched)).getHours()
    if (hour < 12) out.morning.push(t)
    else if (hour < 17) out.afternoon.push(t)
    else out.evening.push(t)
  }
  return out
})
function activityDot(t: QbRecord): string {
  const s = getTaskStatus(t)
  if (s.key === 'submitted') return 'bg-emerald-500'
  if (s.key === 'onsite') return 'bg-amber-500'
  if (s.key === 'enroute') return 'bg-sky-500'
  return 'bg-slate-300'
}

// ─── Drill-down ──
function drillKpi(key: string) {
  let tasks: QbRecord[]; let title: string
  if (key === 'all') { tasks = filteredTasks.value; title = 'All Events' }
  else if (key === 'notsubmitted') { tasks = filteredTasks.value.filter(t => getTaskStatus(t).key === 'notsubmitted'); title = 'Not Submitted' }
  else if (key === 'ssoverdue') { tasks = filteredTasks.value.filter(t => isSurveyOverdue(t)); title = 'SS Overdue' }
  else if (key === 'submitted') { tasks = filteredTasks.value.filter(t => getTaskStatus(t).key === 'submitted'); title = 'Submitted' }
  else if (key === 'late') {
    const F = fieldIds.value
    tasks = filteredTasks.value.filter(t => {
      const tmpl = String(qbv(t, F!.templateName) || '').toLowerCase()
      return tmpl.includes('survey') && lateByTask.value[String(qbv(t, 3) || '')]
    })
    title = 'Late Surveys'
  }
  else if (key === 'active') { tasks = filteredTasks.value.filter(t => { const k = getTaskStatus(t).key; return k === 'onsite' || k === 'enroute' }); title = 'On Site Now' }
  else { tasks = filteredTasks.value; title = 'Events' }
  drillTitle.value = title
  drillTasks.value = tasks
}
function drillTech(name: string) {
  const tasks = filteredTasks.value.filter(t => (getCrewName(t) || 'Unassigned') === name)
  drillTitle.value = name
  drillTasks.value = tasks
}
function drillEventType(type: string) {
  const F = fieldIds.value!
  const tasks = filteredTasks.value.filter(t => (qbv(t, F.templateName) || 'Other') === type)
  drillTitle.value = type
  drillTasks.value = tasks
}
function exitDrill() {
  drillTitle.value = ''
  drillTasks.value = []
  // Scroll the main container back to top so re-entering the dashboard
  // doesn't leave you mid-page.
  if (typeof window !== 'undefined') {
    const main = document.querySelector('main')
    main?.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// Escape key escapes drill-down. Mobile-friendly bonus: clicking anywhere
// on the sticky back-row also returns (handled by the row buttons).
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && drilling.value) {
    e.preventDefault()
    exitDrill()
  }
}

// Drill rows grouped by status — same order as the example.
const drillGroups = computed(() => {
  const groups: Array<{ key: StatusKey; label: string; color: string; rows: QbRecord[] }> = [
    { key: 'notsubmitted', label: 'Not Submitted', color: 'text-red-600', rows: [] },
    { key: 'overdue', label: 'Overdue', color: 'text-red-600', rows: [] },
    { key: 'onsite', label: 'On Site', color: 'text-sky-600', rows: [] },
    { key: 'enroute', label: 'En Route', color: 'text-sky-600', rows: [] },
    { key: 'scheduled', label: 'Scheduled', color: 'text-muted-foreground', rows: [] },
    { key: 'submitted', label: 'Submitted', color: 'text-emerald-600', rows: [] },
  ]
  for (const t of drillTasks.value) {
    const k = getTaskStatus(t).key
    const g = groups.find(g => g.key === k)
    if (g) g.rows.push(t)
    else groups.find(g => g.key === 'scheduled')!.rows.push(t)
  }
  return groups.filter(g => g.rows.length > 0)
})

// Per-card chips row — derived from event category
function chipsFor(t: QbRecord): Array<{ label: string; cls: string }> {
  const F = fieldIds.value
  if (!F) return []
  const tmpl = String(qbv(t, F.templateName) || '').toLowerCase()
  const arrivyStatus = String(qbv(t, F.taskStatus) || '').toLowerCase()
  const isComplete = arrivyStatus === 'complete' || arrivyStatus === 'site work complete'
  const submittedDt = qbv(t, F.submittedDateTime)
  const installComp = String(qbv(t, F.installComplete) || '').toLowerCase() === 'yes'
  const rtrStatus = String(qbv(t, F.rtrStatus) || '').toLowerCase()

  const erOn = qbv(t, F.enrouteStatus) ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
  const osOn = qbv(t, F.startedStatus) ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
  const subCls = submittedDt ? 'bg-emerald-100 text-emerald-700'
    : (installComp && !submittedDt) ? 'bg-red-100 text-red-700'
      : 'bg-slate-100 text-slate-400'
  const compCls = installComp ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'

  let category: 'install' | 'survey' | 'inspection' | 'service' = 'install'
  if (tmpl.includes('survey') || tmpl.includes('document')) category = 'survey'
  else if (tmpl.includes('inspection') || tmpl.includes('inspect')) category = 'inspection'
  else if (tmpl.includes('service')) category = 'service'

  if (category === 'install') {
    let rtrChip = { label: 'RTR', cls: 'bg-slate-100 text-slate-400' }
    if (rtrStatus.includes('pass')) rtrChip = { label: '✅ RTR', cls: 'bg-emerald-100 text-emerald-700' }
    else if (rtrStatus.includes('fail')) rtrChip = { label: '❌ RTR', cls: 'bg-red-100 text-red-700' }
    else if (rtrStatus) rtrChip = { label: '⚠️ RTR', cls: 'bg-amber-100 text-amber-700' }
    else if (installComp) rtrChip = { label: '!RTR', cls: 'bg-orange-500 text-white' }
    return [
      { label: '🚗 ER', cls: erOn },
      { label: '🚧 OS', cls: osOn },
      { label: (submittedDt ? '✅' : '❌') + ' SUB', cls: subCls },
      { label: (installComp ? '✅' : '') + ' COMP', cls: compCls },
      rtrChip,
    ]
  }
  if (category === 'survey') {
    const apprCls = isComplete ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
    return [
      { label: '🚗 ER', cls: erOn },
      { label: '🚧 OS', cls: osOn },
      { label: (submittedDt ? '✅' : '❌') + ' SUB', cls: subCls },
      { label: (isComplete ? '✅' : '') + ' APPR', cls: apprCls },
    ]
  }
  if (category === 'inspection') {
    const isFailed = arrivyStatus.includes('fail')
    const passCls = isComplete && !isFailed ? 'bg-emerald-100 text-emerald-700' : isFailed ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-400'
    const passIcon = isComplete && !isFailed ? '✅' : isFailed ? '❌' : ''
    return [
      { label: '🚗 ER', cls: erOn },
      { label: '🚧 OS', cls: osOn },
      { label: (submittedDt ? '✅' : isComplete ? '❌' : '') + ' SUB', cls: subCls },
      { label: passIcon + ' PASS', cls: passCls },
    ]
  }
  // service
  const resolvedCls = isComplete ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
  return [
    { label: '🚗 ER', cls: erOn },
    { label: '🚧 OS', cls: osOn },
    { label: (submittedDt ? '✅' : '❌') + ' SUB', cls: subCls },
    { label: (isComplete ? '✅' : '') + ' DONE', cls: resolvedCls },
  ]
}

function lateBadgeFor(t: QbRecord): { label: string; cls: string } | null {
  if (!lateLoaded.value) return null
  const F = fieldIds.value
  if (!F) return null
  const taskRid = String(qbv(t, 3) || '')
  const li = lateByTask.value[taskRid]
  if (!li) return null
  const tmpl = String(qbv(t, F.templateName) || '').toLowerCase()
  if (!tmpl.includes('survey')) return null
  const curSt = String(qbv(t, F.taskStatus) || '').toLowerCase().replace(/\s+/g, '')
  const isStill = curSt === 'late' || curSt === 'predictedlate' || curSt === 'predicted_late' || curSt === 'noshow'
  if (!isStill) return { label: 'was late', cls: 'bg-slate-100 text-slate-400' }
  if (li.type === 'NOSHOW') return { label: 'NO SHOW', cls: 'bg-pink-700 text-white' }
  if (li.type === 'LATE') return { label: 'LATE', cls: 'bg-red-500 text-white' }
  return { label: 'PRED. LATE', cls: 'bg-amber-500 text-white' }
}

function projectUrl(t: QbRecord): string {
  const F = fieldIds.value
  if (!F) return ''
  const rid = qbv(t, F.relatedProject)
  return rid ? `https://kin.quickbase.com/db/br9kwm8bk?a=dbpage&pagename=qb-skin-project-detail.html#rid=${rid}` : ''
}

// ─── Loading ──
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/field/tasks?preset=${preset.value}`, { headers: hdrs() })
    if (!res.ok) { errorMsg.value = `Field tasks failed (${res.status})`; return }
    const data = await res.json() as TasksResponse
    records.value = data.records
    fieldIds.value = data.fields
    lateLoaded.value = false
    lateByTask.value = {}
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
  // Second-pass: late events. Don't block initial render.
  loadLateData()
}

async function loadLateData() {
  const F = fieldIds.value
  if (!F) return
  const projRids = [...new Set(records.value.map(t => String(qbv(t, F.relatedProject) || '')).filter(Boolean))]
  if (projRids.length === 0) return
  try {
    const res = await fetch(`/api/field/late?project_rids=${encodeURIComponent(projRids.join(','))}`, { headers: hdrs() })
    if (res.ok) {
      const data = await res.json() as { lateByTask: Record<string, LateInfo> }
      lateByTask.value = data.lateByTask || {}
      lateLoaded.value = true
    }
  } catch { /* non-fatal */ }
}

const registerRefresh = inject<(fn: () => Promise<void>) => void>('registerRefresh')
onMounted(() => {
  load()
  registerRefresh?.(async () => { await load() })
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
watch(preset, load)
</script>

<template>
  <div class="grid gap-3 min-w-0">
    <!-- Header — when drilling, this row sticks to the top of the scroll
         container so the back-out path is always one tap away no matter
         how far down you've scrolled. Big tap target (44px) for mobile. -->
    <div
      class="flex items-center gap-2 flex-wrap"
      :class="drilling ? 'sticky top-0 z-30 -mx-3 px-3 sm:-mx-6 sm:px-6 py-2 bg-background/95 backdrop-blur-sm border-b' : ''"
    >
      <button
        v-if="drilling"
        type="button"
        class="size-11 -ml-2 rounded-lg flex items-center justify-center hover:bg-muted/60 active:bg-muted transition-colors shrink-0"
        title="Back to Field"
        @click="exitDrill"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <div class="flex-1 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight truncate">{{ drilling ? drillTitle : 'Field' }}</h1>
        <p v-if="drilling" class="text-[11px] text-muted-foreground -mt-0.5">{{ drillTasks.length }} {{ drillTasks.length === 1 ? 'task' : 'tasks' }} · tap arrow to return</p>
      </div>
      <Button v-if="drilling" variant="outline" size="sm" class="h-9 text-xs shrink-0" @click="exitDrill">All Field</Button>
    </div>

    <template v-if="!drilling">
      <!-- KPI strip — horizontal scroll allowed (filter strip) -->
      <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
        <button v-for="k in kpis" :key="k.key"
          class="flex-none rounded-xl px-3 py-2 w-[110px] text-left transition-all active:scale-[0.97] bg-card border border-border relative overflow-hidden"
          @click="drillKpi(k.key)"
        >
          <div class="absolute top-0 left-0 right-0 h-[3px]" :class="toneClass[k.tone].accent" />
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ k.label }}</p>
          <p class="text-2xl font-extrabold tabular-nums mt-0.5" :class="toneClass[k.tone].value">{{ k.value }}</p>
        </button>
      </div>

      <!-- Date presets -->
      <div class="flex flex-wrap gap-1.5">
        <button v-for="p in [
          { k: 'today', l: 'Today' },
          { k: 'yesterday', l: 'Yesterday' },
          { k: 'week', l: 'This Week' },
          { k: 'month', l: 'This Month' },
          { k: '30days', l: 'Last 30' },
        ] as Array<{ k: Preset; l: string }>" :key="p.k"
          class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
          :class="preset === p.k ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'"
          @click="preset = p.k"
        >{{ p.l }}</button>
      </div>

      <!-- Search -->
      <input v-model="searchTerm" placeholder="Search techs, customers, templates…" class="h-9 px-3 rounded-lg border bg-card text-sm" />

      <!-- Tabs -->
      <div class="flex border-b border-border">
        <button v-for="t in [{ k: 'leaderboard', l: 'Leaderboard' }, { k: 'activity', l: 'Activity Feed' }] as Array<{ k: Tab; l: string }>" :key="t.k"
          class="flex-1 py-2.5 px-4 text-sm font-medium border-b-2 transition-colors"
          :class="tab === t.k ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground'"
          @click="tab = t.k"
        >{{ t.l }}</button>
      </div>

      <div v-if="loading" class="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">Loading field data…</div>
      <div v-else-if="errorMsg" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{{ errorMsg }}</div>

      <!-- Leaderboard tab -->
      <template v-else-if="tab === 'leaderboard'">
        <!-- Technicians -->
        <button class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center justify-between" @click="toggleCollapsed('tech')">
          <span>Technicians ({{ techRows.length }})</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="transition-transform" :class="collapsed.tech ? '-rotate-90' : ''"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div v-if="!collapsed.tech" class="grid gap-2">
          <button v-for="r in techRows" :key="r.name"
            class="rounded-xl border bg-card p-3 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors active:scale-[0.99]"
            @click="drillTech(r.name)"
          >
            <div class="size-10 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-bold shrink-0">{{ getInitials(r.name) }}</div>
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-sm truncate">{{ r.name }}</p>
              <p class="text-[11px] text-muted-foreground">{{ r.total }} events · {{ r.completed }} completed · {{ r.rate }}%</p>
              <div class="h-1 rounded-full bg-muted mt-1 overflow-hidden"><div class="h-full transition-all" :class="r.rate >= 80 ? 'bg-emerald-500' : r.rate >= 50 ? 'bg-amber-500' : 'bg-red-500'" :style="{ width: r.rate + '%' }" /></div>
            </div>
            <span class="text-2xl font-extrabold tabular-nums shrink-0">{{ r.total }}</span>
          </button>
          <p v-if="techRows.length === 0" class="text-center text-sm text-muted-foreground py-4">No tasks in selected date range</p>
        </div>

        <!-- Event type breakdown -->
        <button class="mt-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center justify-between" @click="toggleCollapsed('etype')">
          <span>By Event Type</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="transition-transform" :class="collapsed.etype ? '-rotate-90' : ''"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div v-if="!collapsed.etype" class="rounded-xl border bg-card p-3 space-y-3">
          <button v-for="r in eventTypeRows" :key="r.type"
            class="block w-full text-left rounded-md p-1.5 -mx-1.5 hover:bg-muted/30 transition-colors"
            @click="drillEventType(r.type)"
          >
            <div class="flex items-center justify-between gap-2 mb-1">
              <p class="text-[13px] font-semibold">
                {{ r.type }}
                <span v-if="lateLoaded && r.late > 0" class="ml-1 text-[10px] font-semibold" :class="r.onTimePct >= 90 ? 'text-emerald-600' : r.onTimePct >= 70 ? 'text-amber-600' : 'text-red-600'">{{ r.onTimePct }}% on-time</span>
              </p>
              <p class="text-[12px] font-bold tabular-nums">{{ r.total }} <span class="text-[10px] font-semibold text-muted-foreground">{{ r.rate }}%</span></p>
            </div>
            <div class="h-2 rounded-full bg-muted overflow-hidden flex">
              <div v-if="r.submitted" class="h-full bg-emerald-500" :style="{ width: (r.submitted / r.total * 100) + '%' }" />
              <div v-if="r.notsubmitted" class="h-full bg-red-500" :style="{ width: (r.notsubmitted / r.total * 100) + '%' }" />
              <div v-if="r.onsite" class="h-full bg-sky-500" :style="{ width: (r.onsite / r.total * 100) + '%' }" />
              <div v-if="r.scheduled" class="h-full bg-stone-300" :style="{ width: (r.scheduled / r.total * 100) + '%' }" />
            </div>
          </button>
          <div class="flex flex-wrap gap-2.5 pt-2 border-t text-[10px] text-muted-foreground">
            <span class="flex items-center gap-1"><span class="size-2 rounded bg-emerald-500" />Submitted</span>
            <span class="flex items-center gap-1"><span class="size-2 rounded bg-red-500" />Not Submitted</span>
            <span class="flex items-center gap-1"><span class="size-2 rounded bg-sky-500" />On Site</span>
            <span class="flex items-center gap-1"><span class="size-2 rounded bg-stone-300" />Scheduled</span>
          </div>
        </div>
      </template>

      <!-- Activity feed tab -->
      <template v-else>
        <template v-for="p in PERIODS" :key="p.key">
          <p v-if="activityByPeriod[p.key].length" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground pt-2">{{ p.label }}</p>
          <div v-if="activityByPeriod[p.key].length" class="grid gap-2">
            <div v-for="t in activityByPeriod[p.key]" :key="String(qbv(t, 3))" class="rounded-xl border bg-card p-3 flex items-start gap-2.5">
              <span class="size-2.5 rounded-full mt-1 shrink-0" :class="activityDot(t)" />
              <div class="flex-1 min-w-0">
                <p class="text-[13px] font-medium truncate">{{ getCrewName(t) || 'Unassigned' }} — {{ String(qbv(t, fieldIds!.customerFirstName) || '') }} {{ String(qbv(t, fieldIds!.customerLastName) || '') }}</p>
                <p class="text-[11px] text-muted-foreground truncate">
                  {{ fmtTime(qbv(t, fieldIds!.scheduledDateTime)) }} · {{ String(qbv(t, fieldIds!.templateName) || 'Task') }}
                  <span class="ml-1 px-1.5 py-0.5 rounded text-[9px] font-semibold" :class="getTaskStatus(t).pillCls">{{ getTaskStatus(t).label }}</span>
                </p>
              </div>
            </div>
          </div>
        </template>
        <p v-if="!filteredTasks.length" class="text-center text-sm text-muted-foreground py-6">No activities for this date range</p>
      </template>
    </template>

    <!-- ─── DRILL-DOWN ─── -->
    <template v-else>
      <div v-if="drillTasks.length === 0" class="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">No tasks found</div>
      <div v-else class="space-y-3">
        <template v-for="g in drillGroups" :key="g.key">
          <p class="text-[11px] font-semibold uppercase tracking-widest pb-1 border-b" :class="g.color">
            {{ g.label }} <span class="ml-1 text-muted-foreground">({{ g.rows.length }})</span>
          </p>
          <div class="grid gap-2">
            <a v-for="t in g.rows" :key="String(qbv(t, 3))"
              :href="projectUrl(t) || undefined" target="_blank" rel="noopener"
              class="block rounded-xl border-l-[3px] border bg-card p-3 transition-transform active:scale-[0.99]"
              :class="getTaskStatus(t).borderCls"
            >
              <div class="flex items-start justify-between gap-2 mb-0.5">
                <p class="font-semibold text-sm flex-1 min-w-0 truncate">
                  {{ statusEmoji(t) }} {{ String(qbv(t, fieldIds!.customerFirstName) || '') }} {{ String(qbv(t, fieldIds!.customerLastName) || '') || 'Unknown' }}
                </p>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0" :class="getTaskStatus(t).pillCls">{{ getTaskStatus(t).label }}</span>
                <span v-if="lateBadgeFor(t)" class="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide shrink-0" :class="lateBadgeFor(t)!.cls">{{ lateBadgeFor(t)!.label }}</span>
              </div>
              <p class="text-[11px] text-muted-foreground truncate mb-1">
                {{ fmtDateTime(qbv(t, fieldIds!.scheduledDateTime)) }} ·
                {{ String(qbv(t, fieldIds!.templateName) || 'Task') }}
                <template v-if="parseFloat(String(qbv(t, fieldIds!.kw) || '0')) > 0"> · {{ parseFloat(String(qbv(t, fieldIds!.kw) || '0')).toFixed(1) }} kW</template>
                · {{ getCrewName(t) || 'TBA' }}
              </p>
              <div class="flex flex-wrap gap-1">
                <span v-for="(c, i) in chipsFor(t)" :key="i" class="text-[9px] font-bold px-1.5 py-0.5 rounded" :class="c.cls">{{ c.label }}</span>
              </div>
              <a v-if="qbv(t, fieldIds!.taskUrl)" :href="String(qbv(t, fieldIds!.taskUrl))" target="_blank" rel="noopener" class="text-[11px] text-sky-600 font-semibold mt-1 inline-block" @click.stop>Open in Arrivy ↗</a>
            </a>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
