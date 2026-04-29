<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import SectionCard from './SectionCard.vue'

// Per-project Arrivy task feed. Backed by /api/field/project-tasks which
// proxies QB's Arrivy table (bvbqgs5yc). Shows past + upcoming events with
// a list view always available, and a calendar view on desktop.

interface Props {
  projectRid: number
  /** Hide the calendar tab even on desktop (list-only) — useful when this
   *  component sits in a narrow rail. */
  listOnly?: boolean
}
const props = defineProps<Props>()

interface QbValue { value: unknown }
type QbRecord = Record<string, QbValue>
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

const auth = useAuthStore()
const records = ref<QbRecord[]>([])
const F = ref<FieldIds | null>(null)
const loading = ref(true)
const errorMsg = ref('')
const isDesktop = ref(false)
const view = ref<'list' | 'calendar'>('list')

function syncBp() {
  isDesktop.value = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
}
let mq: MediaQueryList | null = null

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/field/project-tasks?project_rid=${props.projectRid}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    records.value = data.records ?? []
    F.value = data.fields ?? null
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  syncBp()
  if (typeof window !== 'undefined') {
    mq = window.matchMedia('(min-width: 1024px)')
    mq.addEventListener('change', syncBp)
  }
  load()
})
watch(() => props.projectRid, () => load())

// ── Helpers ──
function qbv(rec: QbRecord, fid: number): unknown { return rec[String(fid)]?.value ?? null }
function qbStr(rec: QbRecord, fid: number): string {
  const v = rec[String(fid)]
  if (!v) return ''
  const val = v.value
  if (Array.isArray(val)) {
    const names = (val as Array<unknown>).map(item => {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        return (o['name'] as string) || (o['email'] as string) || ''
      }
      return String(item ?? '')
    }).filter(Boolean)
    return names.join(', ')
  }
  if (val == null) return ''
  return String(val)
}

function getCrew(t: QbRecord): string {
  if (!F.value) return ''
  return qbStr(t, F.value.assignedCrew) || qbStr(t, F.value.crew) || qbStr(t, F.value.enrouteName) || ''
}

type StatusKey = 'submitted' | 'notsubmitted' | 'overdue' | 'cancelled' | 'exception' | 'onsite' | 'enroute' | 'scheduled'
interface StatusInfo { key: StatusKey; label: string; pillCls: string; borderCls: string; emoji: string }

function getStatus(t: QbRecord): StatusInfo {
  if (!F.value) return { key: 'scheduled', label: 'Scheduled', pillCls: 'bg-slate-100 text-slate-600', borderCls: 'border-l-slate-300', emoji: '⏳' }
  const arrivyStatus = String(qbv(t, F.value.taskStatus) || '').toLowerCase()
  const submittedDt = qbv(t, F.value.submittedDateTime)
  const arrivedDt = qbv(t, F.value.startedStatus)
  const enrouteDt = qbv(t, F.value.enrouteStatus)
  const isArrivyComplete = arrivyStatus === 'complete' || arrivyStatus === 'site work complete'
  const isOverdue = arrivyStatus === 'overdue'
  // Calm tones for cancelled/exception — these are factual, not alerts.
  const isCancelled = arrivyStatus === 'cancelled' || arrivyStatus === 'cancel'
  const isException = arrivyStatus === 'exception' || arrivyStatus === 'not done' || arrivyStatus === 'notdone'
  if (isCancelled) return { key: 'cancelled', label: 'Cancelled', pillCls: 'bg-amber-50 text-amber-800', borderCls: 'border-l-amber-400', emoji: '⊘' }
  if (isException) return { key: 'exception', label: 'Exception', pillCls: 'bg-amber-50 text-amber-800', borderCls: 'border-l-amber-400', emoji: '⊘' }
  if (isArrivyComplete && !submittedDt) return { key: 'notsubmitted', label: 'Not Submitted', pillCls: 'bg-rose-100 text-rose-700', borderCls: 'border-l-rose-500', emoji: '❌' }
  if (submittedDt) return { key: 'submitted', label: 'Submitted', pillCls: 'bg-emerald-100 text-emerald-700', borderCls: 'border-l-emerald-500', emoji: '✅' }
  if (isOverdue) return { key: 'overdue', label: 'Overdue', pillCls: 'bg-rose-100 text-rose-700', borderCls: 'border-l-rose-500', emoji: '⚠️' }
  if (arrivedDt) return { key: 'onsite', label: 'On Site', pillCls: 'bg-sky-100 text-sky-700', borderCls: 'border-l-sky-500', emoji: '🚧' }
  if (enrouteDt) return { key: 'enroute', label: 'En Route', pillCls: 'bg-sky-100 text-sky-700', borderCls: 'border-l-sky-500', emoji: '🚗' }
  return { key: 'scheduled', label: 'Scheduled', pillCls: 'bg-slate-100 text-slate-600', borderCls: 'border-l-slate-300', emoji: '⏳' }
}

interface TaskItem {
  rid: string
  template: string
  scheduled: Date | null
  scheduledIso: string
  crew: string
  status: StatusInfo
  taskUrl: string
  past: boolean
  today: boolean
  // Cancellation evidence — derived directly from the task record.
  arrivedAt: Date | null
  enrouteAt: Date | null
  arrivedOnTime: boolean
  arrivedCrew: string
}

// Minutes a tech can be after the scheduled slot and still count as "on-time".
const ON_TIME_GRACE_MIN = 15

const todayIsoStr = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

const tasks = computed<TaskItem[]>(() => {
  if (!F.value) return []
  return records.value.map(t => {
    const sched = qbv(t, F.value!.scheduledDateTime)
    const d = sched ? new Date(String(sched)) : null
    const valid = d && !isNaN(d.getTime()) ? d : null
    const isoDay = valid
      ? `${valid.getFullYear()}-${String(valid.getMonth() + 1).padStart(2, '0')}-${String(valid.getDate()).padStart(2, '0')}`
      : ''
    const arrivedRaw = qbv(t, F.value!.startedStatus)
    const enrouteRaw = qbv(t, F.value!.enrouteStatus)
    const arrived = arrivedRaw ? new Date(String(arrivedRaw)) : null
    const enroute = enrouteRaw ? new Date(String(enrouteRaw)) : null
    const arrivedValid = arrived && !isNaN(arrived.getTime()) ? arrived : null
    const enrouteValid = enroute && !isNaN(enroute.getTime()) ? enroute : null
    const onTime = !!(arrivedValid && valid &&
      (arrivedValid.getTime() - valid.getTime()) <= ON_TIME_GRACE_MIN * 60_000)
    return {
      rid: String(qbv(t, 3) ?? ''),
      template: qbStr(t, F.value!.templateName) || 'Task',
      scheduled: valid,
      scheduledIso: isoDay,
      crew: getCrew(t),
      status: getStatus(t),
      taskUrl: qbStr(t, F.value!.taskUrl),
      past: !!isoDay && isoDay < todayIsoStr,
      today: !!isoDay && isoDay === todayIsoStr,
      arrivedAt: arrivedValid,
      enrouteAt: enrouteValid,
      arrivedOnTime: onTime,
      arrivedCrew: qbStr(t, F.value!.enrouteName) || getCrew(t),
    } as TaskItem
  })
})

// Bucketed list: Today / Upcoming / Past — chronological within each.
interface Bucket { key: 'today' | 'upcoming' | 'past'; label: string; items: TaskItem[] }
const buckets = computed<Bucket[]>(() => {
  const today: TaskItem[] = []
  const upcoming: TaskItem[] = []
  const past: TaskItem[] = []
  for (const t of tasks.value) {
    if (t.today) today.push(t)
    else if (t.past) past.push(t)
    else if (t.scheduled) upcoming.push(t)
    else past.push(t) // unscheduled events fall to past for now
  }
  today.sort((a, b) => +(a.scheduled ?? 0) - +(b.scheduled ?? 0))
  upcoming.sort((a, b) => +(a.scheduled ?? 0) - +(b.scheduled ?? 0))
  past.sort((a, b) => +(b.scheduled ?? 0) - +(a.scheduled ?? 0))
  const all: Bucket[] = [
    { key: 'today',    label: 'Today',    items: today },
    { key: 'upcoming', label: 'Upcoming', items: upcoming },
    { key: 'past',     label: 'Past',     items: past },
  ]
  return all.filter(b => b.items.length > 0)
})

const bucketTone: Record<string, string> = {
  today: 'text-teal-700',
  upcoming: 'text-slate-700',
  past: 'text-slate-500',
}

function fmtDate(d: Date | null): string {
  if (!d) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function fmtTime(d: Date | null): string {
  if (!d) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// ── Calendar (desktop only) ──
const calCursor = ref(new Date()) // first day of the displayed month
calCursor.value.setDate(1)
calCursor.value.setHours(0, 0, 0, 0)

const calMonthLabel = computed(() => calCursor.value.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))

interface CalCell { iso: string; day: number; inMonth: boolean; isToday: boolean; tasks: TaskItem[] }
const calCells = computed<CalCell[]>(() => {
  const start = new Date(calCursor.value)
  // Sunday-aligned start
  const firstDow = start.getDay()
  const gridStart = new Date(start)
  gridStart.setDate(1 - firstDow)

  const month = start.getMonth()
  const cells: CalCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    cells.push({
      iso,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      isToday: iso === todayIsoStr,
      tasks: tasks.value.filter(t => t.scheduledIso === iso),
    })
  }
  return cells
})

function shiftMonth(delta: number) {
  const d = new Date(calCursor.value)
  d.setMonth(d.getMonth() + delta)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  calCursor.value = d
}
function goToday() {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0)
  calCursor.value = d
}

const showCalendar = computed(() => isDesktop.value && !props.listOnly && view.value === 'calendar')
const dotColor: Record<StatusKey, string> = {
  submitted: 'bg-emerald-500',
  notsubmitted: 'bg-rose-500',
  overdue: 'bg-rose-500',
  cancelled: 'bg-amber-400',
  exception: 'bg-amber-400',
  onsite: 'bg-sky-500',
  enroute: 'bg-sky-500',
  scheduled: 'bg-slate-400',
}

// ── Cancelled-event detail (timeline + proof) ──
//
// When a task is cancelled, the user needs to see what *did* happen before
// the cancel: was the crew assigned, did they go en-route, did they arrive
// on-site on-time, who pulled the plug, and when. We fetch the per-task
// log (bvbbznmdb) lazily on expansion to keep the list render cheap.

interface LogEntry {
  ts: Date | null
  eventType: string         // CREW_ASSIGNED, TASK_RESCHEDULED, TASK_STATUS, …
  subType: string           // STARTED, ENROUTE, COMPLETE, CANCELLED, EXCEPTION, …
  reportedBy: string
  title: string
  description: string
}

interface LogState {
  loading: boolean
  error: string
  entries: LogEntry[] | null
}

const expandedRid = ref<string | null>(null)
const logCache = ref<Record<string, LogState>>({})

interface QbLogRecord { [k: string]: { value: unknown } }
interface LogFields {
  relatedTask: number
  eventType: number
  statusSubType: number
  reportedBy: number
  title: number
  description: number
  timestamp: number
  scheduled: number
  reporterName: number
  relatedProject: number
}

function logVal(rec: QbLogRecord, fid: number): string {
  const v = rec[String(fid)]?.value
  return v == null ? '' : String(v)
}

async function fetchLog(rid: string) {
  if (logCache.value[rid]?.entries) return
  logCache.value = { ...logCache.value, [rid]: { loading: true, error: '', entries: null } }
  try {
    const res = await fetch(`/api/field/task-log?task_rid=${encodeURIComponent(rid)}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { records: QbLogRecord[]; fields: LogFields }
    const f = json.fields
    const entries: LogEntry[] = (json.records || []).map(r => {
      const tsStr = logVal(r, f.timestamp)
      const ts = tsStr ? new Date(tsStr) : null
      return {
        ts: ts && !isNaN(ts.getTime()) ? ts : null,
        eventType: logVal(r, f.eventType).toUpperCase(),
        subType: logVal(r, f.statusSubType).toUpperCase(),
        reportedBy: logVal(r, f.reportedBy),
        title: logVal(r, f.title),
        description: logVal(r, f.description),
      }
    })
    logCache.value = { ...logCache.value, [rid]: { loading: false, error: '', entries } }
  } catch (e) {
    logCache.value = {
      ...logCache.value,
      [rid]: { loading: false, error: e instanceof Error ? e.message : String(e), entries: null },
    }
  }
}

function isExpandable(t: TaskItem): boolean {
  return t.status.key === 'cancelled' || t.status.key === 'exception'
}

function toggleExpand(t: TaskItem) {
  if (!isExpandable(t)) return
  if (expandedRid.value === t.rid) {
    expandedRid.value = null
    return
  }
  expandedRid.value = t.rid
  fetchLog(t.rid)
}

// Filter the raw log to the events that matter for cancellation context.
function timelineFor(rid: string): LogEntry[] {
  const state = logCache.value[rid]
  if (!state?.entries) return []
  const KEEP = new Set(['CREW_ASSIGNED', 'TASK_RESCHEDULED', 'TASK_STATUS', 'NO_SHOW', 'LATE'])
  return state.entries.filter(e => KEEP.has(e.eventType))
}

// Pull the actor + timestamp who hit "cancel" — the latest TASK_STATUS
// log entry whose sub-type is CANCELLED/EXCEPTION/CANCEL.
function cancelEvent(rid: string): LogEntry | null {
  const entries = logCache.value[rid]?.entries
  if (!entries) return null
  const cancelTypes = new Set(['CANCELLED', 'CANCEL', 'EXCEPTION', 'NOTDONE', 'NOT_DONE'])
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.eventType === 'TASK_STATUS' && cancelTypes.has(e.subType)) return e
  }
  return null
}

function fmtFull(d: Date | null): string {
  if (!d) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Pretty label + tone for log timeline entries.
function eventLabel(e: LogEntry): { label: string; tone: string } {
  if (e.eventType === 'CREW_ASSIGNED') return { label: 'Crew assigned', tone: 'text-slate-600' }
  if (e.eventType === 'TASK_RESCHEDULED') return { label: 'Rescheduled', tone: 'text-slate-600' }
  if (e.eventType === 'NO_SHOW') return { label: 'No-show flagged', tone: 'text-rose-700' }
  if (e.eventType === 'LATE') return { label: 'Late', tone: 'text-amber-700' }
  if (e.eventType === 'TASK_STATUS') {
    switch (e.subType) {
      case 'ENROUTE': return { label: 'En-route', tone: 'text-sky-700' }
      case 'STARTED': return { label: 'Arrived on-site', tone: 'text-sky-700' }
      case 'COMPLETE': return { label: 'Marked complete', tone: 'text-emerald-700' }
      case 'FORM_COMPLETE': return { label: 'Form complete', tone: 'text-emerald-700' }
      case 'CANCELLED':
      case 'CANCEL': return { label: 'Cancelled', tone: 'text-amber-800' }
      case 'EXCEPTION':
      case 'NOTDONE':
      case 'NOT_DONE': return { label: 'Exception', tone: 'text-amber-800' }
      default: return { label: e.subType.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()), tone: 'text-slate-600' }
    }
  }
  return { label: e.eventType.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()), tone: 'text-slate-600' }
}
</script>

<template>
  <SectionCard no-padding>
    <!-- Header: title + view toggle (calendar only on desktop unless listOnly) -->
    <div class="flex items-center gap-2 px-4 pt-3.5 pb-2">
      <div class="text-[11px] font-medium text-slate-500 tracking-[0.08em] uppercase">Events</div>
      <span v-if="tasks.length" class="bg-slate-100 text-slate-700 font-medium text-[11px] px-1.5 rounded-full min-w-[18px] text-center">{{ tasks.length }}</span>
      <div class="flex-1" />
      <div v-if="isDesktop && !listOnly" class="inline-flex items-center bg-slate-100 rounded-md p-0.5 text-[11px]">
        <button
          type="button"
          class="px-2 py-0.5 rounded transition-colors cursor-pointer"
          :class="view === 'list' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
          @click="view = 'list'"
        >List</button>
        <button
          type="button"
          class="px-2 py-0.5 rounded transition-colors cursor-pointer"
          :class="view === 'calendar' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
          @click="view = 'calendar'"
        >Calendar</button>
      </div>
    </div>

    <!-- Loading / error / empty -->
    <div v-if="loading" class="px-4 pb-4 text-[12px] text-slate-400">Loading events…</div>
    <div v-else-if="errorMsg" class="px-4 pb-4 text-[12px] text-rose-600">{{ errorMsg }}</div>
    <div v-else-if="!tasks.length" class="px-4 pb-4 text-[12px] text-slate-400">No Arrivy tasks for this project.</div>

    <!-- LIST -->
    <div v-else-if="!showCalendar" class="px-4 pb-3.5">
      <div v-for="b in buckets" :key="b.key" class="py-2 border-b last:border-b-0" style="border-color: #e6dfd6;">
        <div class="text-[10px] uppercase tracking-wider mb-1.5" :class="bucketTone[b.key]">{{ b.label }}</div>
        <ul class="space-y-1.5">
          <template v-for="t in b.items" :key="t.rid">
            <li
              class="rounded-md bg-white border-l-[3px]"
              :class="[t.status.borderCls, isExpandable(t) ? 'cursor-pointer hover:bg-amber-50/40 transition-colors' : '']"
              @click="isExpandable(t) ? toggleExpand(t) : null"
            >
              <div class="flex items-stretch gap-3 py-1.5 pl-2.5 pr-2">
                <div class="shrink-0 w-12 text-center">
                  <div class="text-[10px] text-slate-400 leading-none">{{ t.scheduled ? t.scheduled.toLocaleDateString('en-US', { weekday: 'short' }) : '' }}</div>
                  <div class="text-[12px] text-slate-700 tabular-nums leading-tight">{{ fmtDate(t.scheduled) }}</div>
                  <div class="text-[10px] text-slate-400 tabular-nums">{{ fmtTime(t.scheduled) }}</div>
                </div>
                <div class="flex-1 min-w-0 flex flex-col justify-center">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <a
                      v-if="t.taskUrl"
                      :href="t.taskUrl"
                      target="_blank"
                      rel="noopener"
                      class="text-[12.5px] font-medium text-slate-800 hover:text-teal-700 hover:underline truncate cursor-pointer"
                      :title="t.template"
                      @click.stop
                    >{{ t.template }}</a>
                    <span v-else class="text-[12.5px] font-medium text-slate-800 truncate" :title="t.template">{{ t.template }}</span>
                    <span class="inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] font-medium" :class="t.status.pillCls">
                      {{ t.status.label }}
                    </span>
                    <!-- At-a-glance proof for cancelled rows: showed up + on-time -->
                    <template v-if="isExpandable(t) && t.arrivedAt">
                      <span class="inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] font-medium bg-sky-50 text-sky-700">Arrived</span>
                      <span
                        v-if="t.arrivedOnTime"
                        class="inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700"
                      >On-time</span>
                    </template>
                    <span
                      v-if="isExpandable(t)"
                      class="ml-auto text-[11px] text-amber-700/70 select-none"
                      aria-hidden="true"
                    >{{ expandedRid === t.rid ? '▾' : '▸' }}</span>
                  </div>
                  <div v-if="t.crew" class="text-[11px] text-slate-500 truncate" :title="t.crew">{{ t.crew }}</div>
                </div>
              </div>

              <!-- Cancelled-event detail surface -->
              <div
                v-if="isExpandable(t) && expandedRid === t.rid"
                class="border-t px-3 py-3 bg-gradient-to-b from-amber-50/40 to-white"
                style="border-color: #efe6d8;"
                @click.stop
              >
                <!-- Evidence chips: arrived / on-time / who arrived -->
                <div v-if="t.arrivedAt" class="flex flex-wrap items-center gap-1.5 mb-2.5">
                  <span class="inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium bg-sky-50 text-sky-800">
                    Arrived {{ fmtFull(t.arrivedAt) }}
                  </span>
                  <span
                    v-if="t.arrivedOnTime"
                    class="inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-800"
                  >On-time</span>
                  <span
                    v-else
                    class="inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium bg-amber-50 text-amber-800"
                  >Late arrival</span>
                  <span v-if="t.arrivedCrew" class="text-[11px] text-slate-600">by {{ t.arrivedCrew }}</span>
                </div>
                <div v-else class="text-[11px] text-slate-500 mb-2.5">No on-site arrival logged.</div>

                <!-- Loading / error -->
                <div v-if="logCache[t.rid]?.loading" class="text-[11px] text-slate-400">Loading task log…</div>
                <div v-else-if="logCache[t.rid]?.error" class="text-[11px] text-rose-600">{{ logCache[t.rid]?.error }}</div>

                <!-- Cancelled-by callout -->
                <template v-else-if="logCache[t.rid]?.entries">
                  <div
                    v-if="cancelEvent(t.rid)"
                    class="rounded-md border bg-white px-2.5 py-2 mb-2.5"
                    style="border-color: #efe6d8;"
                  >
                    <div class="text-[10px] uppercase tracking-wider text-amber-700/80 mb-0.5">Cancelled</div>
                    <div class="text-[12.5px] text-slate-800">
                      <span class="font-medium">{{ cancelEvent(t.rid)?.reportedBy || 'Unknown' }}</span>
                      <span class="text-slate-500"> · {{ fmtFull(cancelEvent(t.rid)?.ts ?? null) }}</span>
                    </div>
                    <div v-if="cancelEvent(t.rid)?.description" class="text-[11.5px] text-slate-600 mt-0.5">
                      {{ cancelEvent(t.rid)?.description }}
                    </div>
                  </div>

                  <!-- Timeline -->
                  <div class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Timeline</div>
                  <ol class="relative pl-3 space-y-1.5 border-l" style="border-color: #efe6d8;">
                    <li v-for="(e, i) in timelineFor(t.rid)" :key="i" class="relative">
                      <span
                        class="absolute -left-[15px] top-[5px] size-2 rounded-full"
                        :class="e.eventType === 'TASK_STATUS' && (e.subType === 'CANCELLED' || e.subType === 'CANCEL' || e.subType === 'EXCEPTION') ? 'bg-amber-400' :
                                e.eventType === 'TASK_STATUS' && e.subType === 'STARTED' ? 'bg-sky-500' :
                                e.eventType === 'TASK_STATUS' && e.subType === 'ENROUTE' ? 'bg-sky-400' :
                                'bg-slate-300'"
                      ></span>
                      <div class="flex items-baseline gap-2 flex-wrap">
                        <span class="text-[11.5px] font-medium" :class="eventLabel(e).tone">{{ eventLabel(e).label }}</span>
                        <span class="text-[10.5px] text-slate-400 tabular-nums">{{ fmtFull(e.ts) }}</span>
                        <span v-if="e.reportedBy" class="text-[11px] text-slate-600">· {{ e.reportedBy }}</span>
                      </div>
                    </li>
                  </ol>

                  <!-- Open-in-Arrivy footer (where photos live) -->
                  <div v-if="t.taskUrl" class="mt-2.5 flex items-center justify-between">
                    <a
                      :href="t.taskUrl"
                      target="_blank"
                      rel="noopener"
                      class="inline-flex items-center gap-1 text-[11.5px] text-teal-700 hover:text-teal-800 hover:underline cursor-pointer"
                      @click.stop
                    >
                      Open in Arrivy for photos & details
                      <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M7 17L17 7"/><path d="M8 7h9v9"/>
                      </svg>
                    </a>
                  </div>
                </template>
              </div>
            </li>
          </template>
        </ul>
      </div>
    </div>

    <!-- CALENDAR (desktop only) -->
    <div v-else class="px-4 pb-3.5">
      <div class="flex items-center gap-2 mb-2">
        <button
          type="button"
          class="size-7 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-800 flex items-center justify-center transition-colors cursor-pointer"
          aria-label="Previous month"
          @click="shiftMonth(-1)"
        >‹</button>
        <div class="text-[13px] font-medium text-slate-800 tabular-nums min-w-[140px] text-center">{{ calMonthLabel }}</div>
        <button
          type="button"
          class="size-7 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-800 flex items-center justify-center transition-colors cursor-pointer"
          aria-label="Next month"
          @click="shiftMonth(1)"
        >›</button>
        <button
          type="button"
          class="ml-auto text-[11px] text-slate-500 hover:text-slate-800 px-2 py-1 rounded-md hover:bg-slate-100 transition-colors cursor-pointer"
          @click="goToday"
        >Today</button>
      </div>
      <div class="grid grid-cols-7 text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1">
        <div v-for="d in ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']" :key="d" class="text-center">{{ d }}</div>
      </div>
      <div class="grid grid-cols-7 gap-px bg-slate-100 rounded-md overflow-hidden">
        <div
          v-for="cell in calCells"
          :key="cell.iso"
          class="min-h-[64px] bg-white p-1 flex flex-col"
          :class="!cell.inMonth ? 'bg-slate-50/60' : ''"
        >
          <div class="flex items-center justify-between">
            <span
              class="text-[11px] tabular-nums leading-none"
              :class="[
                cell.isToday ? 'rounded-full bg-teal-700 text-white px-1.5 py-0.5' : '',
                !cell.isToday && cell.inMonth ? 'text-slate-700' : '',
                !cell.isToday && !cell.inMonth ? 'text-slate-300' : '',
              ]"
            >{{ cell.day }}</span>
          </div>
          <ul class="mt-1 space-y-0.5 overflow-hidden">
            <li
              v-for="(t, i) in cell.tasks.slice(0, 3)"
              :key="t.rid"
              class="flex items-center gap-1 text-[10px] truncate"
              :title="`${t.template} — ${t.status.label}${t.crew ? ' · ' + t.crew : ''}`"
            >
              <span class="size-1.5 rounded-full shrink-0" :class="dotColor[t.status.key]"></span>
              <span class="text-slate-700 truncate">{{ t.template }}</span>
            </li>
            <li v-if="cell.tasks.length > 3" class="text-[10px] text-slate-400">+{{ cell.tasks.length - 3 }} more</li>
          </ul>
        </div>
      </div>
    </div>
  </SectionCard>
</template>
