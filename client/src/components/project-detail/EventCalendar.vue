<script setup lang="ts">
import { computed } from 'vue'
import SectionCard from './SectionCard.vue'

interface ScheduleProject {
  survey_scheduled?: string | null
  survey_submitted?: string | null
  survey_approved?: string | null
  install_scheduled?: string | null
  install_completed?: string | null
  inspection_scheduled?: string | null
  inspection_passed?: string | null
  pto_submitted?: string | null
  pto_approved?: string | null
  permit_submitted?: string | null
  permit_approved?: string | null
}

interface Ticket {
  record_id: number
  title: string
  status: string
  due_date?: string | null
  assigned_to?: string | null
}

const props = defineProps<{ project: ScheduleProject; tickets: Ticket[] }>()

interface CalendarEvent {
  date: string  // ISO YYYY-MM-DD
  label: string
  type: 'milestone' | 'inspection' | 'install' | 'survey' | 'permit' | 'pto' | 'ticket'
  detail?: string
  past: boolean
}

const todayIso = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

function toIso(s?: string | null): string | null {
  if (!s) return null
  const v = String(s)
  if (v.length === 10 && !v.includes('T')) return v
  const d = new Date(v)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

const events = computed<CalendarEvent[]>(() => {
  const out: CalendarEvent[] = []
  const p = props.project
  // Pull every "scheduled / submitted / approved" date that exists.
  const candidates: Array<{ raw: string | null | undefined; label: string; type: CalendarEvent['type']; detail?: string }> = [
    { raw: p.survey_scheduled,     label: 'Survey scheduled',  type: 'survey' },
    { raw: p.survey_submitted,     label: 'Survey submitted',  type: 'survey' },
    { raw: p.survey_approved,      label: 'Survey approved',   type: 'survey' },
    { raw: p.permit_submitted,     label: 'Permit submitted',  type: 'permit' },
    { raw: p.permit_approved,      label: 'Permit approved',   type: 'permit' },
    { raw: p.install_scheduled,    label: 'Install scheduled', type: 'install' },
    { raw: p.install_completed,    label: 'Install completed', type: 'install' },
    { raw: p.inspection_scheduled, label: 'Inspection scheduled', type: 'inspection' },
    { raw: p.inspection_passed,    label: 'Inspection passed', type: 'inspection' },
    { raw: p.pto_submitted,        label: 'PTO submitted',     type: 'pto' },
    { raw: p.pto_approved,         label: 'PTO approved',      type: 'pto' },
  ]
  for (const c of candidates) {
    const iso = toIso(c.raw)
    if (!iso) continue
    out.push({ date: iso, label: c.label, type: c.type, past: iso < todayIso })
  }
  for (const t of props.tickets) {
    const iso = toIso(t.due_date)
    if (!iso) continue
    out.push({ date: iso, label: t.title || 'Ticket due', type: 'ticket', detail: t.assigned_to ?? '', past: iso < todayIso })
  }
  return out
})

interface Bucket {
  key: 'overdue' | 'today' | 'upcoming' | 'past'
  label: string
  items: CalendarEvent[]
}

const buckets = computed<Bucket[]>(() => {
  const overdue: CalendarEvent[] = []
  const today: CalendarEvent[] = []
  const upcoming: CalendarEvent[] = []
  const past: CalendarEvent[] = []
  for (const e of events.value) {
    if (e.date === todayIso) today.push(e)
    else if (e.date < todayIso) {
      // Overdue = scheduled/due things past their date that aren't of a "completion" event
      const isCompletion = /completed|approved|passed/.test(e.label)
      if (isCompletion) past.push(e)
      else if (e.type === 'ticket') overdue.push(e)
      else overdue.push(e)
    }
    else upcoming.push(e)
  }
  overdue.sort((a, b) => a.date.localeCompare(b.date))
  today.sort((a, b) => a.label.localeCompare(b.label))
  upcoming.sort((a, b) => a.date.localeCompare(b.date))
  past.sort((a, b) => b.date.localeCompare(a.date))
  const all: Bucket[] = [
    { key: 'overdue',  label: 'Overdue',  items: overdue.slice(0, 6) },
    { key: 'today',    label: 'Today',    items: today.slice(0, 6) },
    { key: 'upcoming', label: 'Upcoming', items: upcoming.slice(0, 8) },
    { key: 'past',     label: 'Recent',   items: past.slice(0, 6) },
  ]
  return all.filter(b => b.items.length > 0)
})

function fmtMd(s: string): string {
  const d = new Date(`${s}T00:00:00`)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtDow(s: string): string {
  const d = new Date(`${s}T00:00:00`)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { weekday: 'short' })
}

const typeStyle: Record<CalendarEvent['type'], string> = {
  milestone: 'bg-emerald-100 text-emerald-700',
  inspection: 'bg-blue-100 text-blue-700',
  install: 'bg-amber-100 text-amber-700',
  survey: 'bg-violet-100 text-violet-700',
  permit: 'bg-sky-100 text-sky-700',
  pto: 'bg-teal-100 text-teal-700',
  ticket: 'bg-rose-100 text-rose-700',
}

const bucketTone: Record<Bucket['key'], string> = {
  overdue: 'text-rose-600',
  today: 'text-teal-700',
  upcoming: 'text-slate-700',
  past: 'text-slate-500',
}
</script>

<template>
  <SectionCard title="Schedule" :count="events.length" no-padding>
    <div v-if="!buckets.length" class="px-4 pb-4 text-[12px] text-slate-400">
      No scheduled or due events.
    </div>
    <div v-else class="px-4 pb-3.5">
      <div v-for="b in buckets" :key="b.key" class="py-2 border-b last:border-b-0" style="border-color: #e6dfd6;">
        <div class="text-[10px] uppercase tracking-wider mb-1.5" :class="bucketTone[b.key]">{{ b.label }}</div>
        <ul class="space-y-1.5">
          <li v-for="(e, i) in b.items" :key="i" class="flex items-center gap-2.5 text-[12.5px]">
            <div class="shrink-0 w-12 text-center">
              <div class="text-[10px] text-slate-400 leading-none">{{ fmtDow(e.date) }}</div>
              <div class="text-slate-700 tabular-nums leading-tight">{{ fmtMd(e.date) }}</div>
            </div>
            <span
              class="text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider shrink-0"
              :class="typeStyle[e.type]"
            >{{ e.type }}</span>
            <span class="text-slate-700 truncate flex-1" :title="e.label">{{ e.label }}</span>
          </li>
        </ul>
      </div>
    </div>
  </SectionCard>
</template>
