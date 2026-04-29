<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Surfaces the next upcoming Arrivy task for a project, styled like a single
// row from the Field Ops list. Quiet by default — no banner background, just
// a subtle card with a colored left rail.

interface Props { projectRid: number }
const props = defineProps<Props>()

interface QbValue { value: unknown }
type QbRecord = Record<string, QbValue>
interface FieldIds {
  scheduledDateTime: number
  taskStatus: number
  templateName: number
  taskUrl: number
  enrouteStatus: number
  startedStatus: number
  submittedDateTime: number
  enrouteName: number
  crew: number
  assignedCrew: number
}

const auth = useAuthStore()
const records = ref<QbRecord[]>([])
const F = ref<FieldIds | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await fetch(`/api/field/project-tasks?project_rid=${props.projectRid}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) return
    const data = await res.json()
    records.value = data.records ?? []
    F.value = data.fields ?? null
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.projectRid, load)

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
  return val == null ? '' : String(val)
}

type StatusKey = 'submitted' | 'notsubmitted' | 'overdue' | 'onsite' | 'enroute' | 'scheduled'
interface StatusInfo { key: StatusKey; label: string; pillCls: string; borderCls: string }

function getStatus(t: QbRecord): StatusInfo {
  if (!F.value) return { key: 'scheduled', label: 'Scheduled', pillCls: 'bg-slate-100 text-slate-600', borderCls: 'border-l-slate-300' }
  const s = String(qbv(t, F.value.taskStatus) || '').toLowerCase()
  const submittedDt = qbv(t, F.value.submittedDateTime)
  const arrivedDt = qbv(t, F.value.startedStatus)
  const enrouteDt = qbv(t, F.value.enrouteStatus)
  if ((s === 'complete' || s === 'site work complete') && !submittedDt) return { key: 'notsubmitted', label: 'Not Submitted', pillCls: 'bg-rose-100 text-rose-700', borderCls: 'border-l-rose-500' }
  if (submittedDt) return { key: 'submitted', label: 'Submitted', pillCls: 'bg-emerald-100 text-emerald-700', borderCls: 'border-l-emerald-500' }
  if (s === 'overdue') return { key: 'overdue', label: 'Overdue', pillCls: 'bg-rose-100 text-rose-700', borderCls: 'border-l-rose-500' }
  if (arrivedDt) return { key: 'onsite', label: 'On Site', pillCls: 'bg-sky-100 text-sky-700', borderCls: 'border-l-sky-500' }
  if (enrouteDt) return { key: 'enroute', label: 'En Route', pillCls: 'bg-sky-100 text-sky-700', borderCls: 'border-l-sky-500' }
  return { key: 'scheduled', label: 'Scheduled', pillCls: 'bg-slate-100 text-slate-600', borderCls: 'border-l-slate-300' }
}

function getCrew(t: QbRecord): string {
  if (!F.value) return ''
  return qbStr(t, F.value.assignedCrew) || qbStr(t, F.value.crew) || qbStr(t, F.value.enrouteName) || ''
}

const todayIsoStr = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

interface NextEvent {
  template: string
  scheduled: Date | null
  status: StatusInfo
  crew: string
  taskUrl: string
}

// Pick the soonest non-completed task scheduled today or later.
const next = computed<NextEvent | null>(() => {
  if (!F.value) return null
  const candidates = records.value
    .map(r => {
      const sched = qbv(r, F.value!.scheduledDateTime)
      const d = sched ? new Date(String(sched)) : null
      const valid = d && !isNaN(d.getTime()) ? d : null
      const iso = valid
        ? `${valid.getFullYear()}-${String(valid.getMonth() + 1).padStart(2, '0')}-${String(valid.getDate()).padStart(2, '0')}`
        : ''
      const status = getStatus(r)
      return { r, valid, iso, status }
    })
    .filter(x => x.valid && x.iso >= todayIsoStr && x.status.key !== 'submitted')
    .sort((a, b) => +(a.valid as Date) - +(b.valid as Date))

  const best = candidates[0]
  if (!best || !best.valid) return null
  return {
    template: qbStr(best.r, F.value.templateName) || 'Task',
    scheduled: best.valid,
    status: best.status,
    crew: getCrew(best.r),
    taskUrl: qbStr(best.r, F.value.taskUrl),
  }
})

function fmtDow(d: Date): string {
  const t = new Date(); t.setHours(0, 0, 0, 0)
  const tomorrow = new Date(t); tomorrow.setDate(t.getDate() + 1)
  if (d.toDateString() === t.toDateString()) return 'Today'
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { weekday: 'short' })
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <div v-if="next" class="bg-white rounded-2xl overflow-hidden" style="box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03);">
    <div class="px-4 pt-3 pb-1 text-[11px] font-medium text-slate-500 tracking-[0.08em] uppercase">Next Up</div>
    <div
      class="flex items-stretch gap-3 mx-4 mb-3 mt-1 rounded-md border-l-[3px] py-1.5 pl-2.5 pr-2"
      :class="next.status.borderCls"
    >
      <div class="shrink-0 w-14 text-center">
        <div class="text-[10px] text-slate-400 leading-none">{{ fmtDow(next.scheduled!) }}</div>
        <div class="text-[12px] text-slate-700 tabular-nums leading-tight">{{ fmtDate(next.scheduled!) }}</div>
        <div class="text-[10px] text-slate-400 tabular-nums">{{ fmtTime(next.scheduled!) }}</div>
      </div>
      <div class="flex-1 min-w-0 flex flex-col justify-center">
        <div class="flex items-center gap-1.5 flex-wrap">
          <a
            v-if="next.taskUrl"
            :href="next.taskUrl"
            target="_blank"
            rel="noopener"
            class="text-[13px] font-medium text-slate-800 hover:text-teal-700 hover:underline truncate cursor-pointer"
            :title="next.template"
          >{{ next.template }}</a>
          <span v-else class="text-[13px] font-medium text-slate-800 truncate" :title="next.template">{{ next.template }}</span>
          <span class="inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] font-medium" :class="next.status.pillCls">
            {{ next.status.label }}
          </span>
        </div>
        <div v-if="next.crew" class="text-[11px] text-slate-500 truncate" :title="next.crew">{{ next.crew }}</div>
      </div>
    </div>
  </div>
</template>
