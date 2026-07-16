// Shared Arrivy task shaping — status classification + template → task-type
// derivation. Ported from pc-dashboard.ts so other routes (survey-tasks)
// can normalize QB Arrivy rows the same way without importing the whole
// PC dashboard. pc-dashboard keeps its own inline copies for now.
import { F, fieldValue, type QbRecord } from '../routes/field'

export type ArrivyTaskStatusKey =
  | 'submitted' | 'notsubmitted' | 'overdue' | 'cancelled'
  | 'onsite' | 'enroute' | 'scheduled'

// Mirrors getTaskStatus() in FieldDashboardView.vue, minus the task-log
// cancel detection (covered by the raw-status substring match).
export function classifyArrivyStatus(rec: QbRecord): { status: ArrivyTaskStatusKey; label: string } {
  const arrivyStatus = String(fieldValue(rec, F.taskStatus) || '').toLowerCase()
  const submittedDt = fieldValue(rec, F.submittedDateTime)
  const arrivedDt = fieldValue(rec, F.startedStatus)
  const enrouteDt = fieldValue(rec, F.enrouteStatus)
  const isArrivyComplete = /\bcomplete\b/i.test(arrivyStatus)
  const isOverdue = /\boverdue\b/i.test(arrivyStatus)
  const isCancelled = /cancel|exception|notdone|not\s*done/i.test(arrivyStatus)
  if (isCancelled) return { status: 'cancelled', label: 'Cancelled' }
  if (isArrivyComplete && !submittedDt) return { status: 'notsubmitted', label: 'Not Submitted' }
  if (submittedDt) return { status: 'submitted', label: 'Submitted' }
  if (isOverdue) return { status: 'overdue', label: 'Overdue' }
  if (arrivedDt) return { status: 'onsite', label: 'On Site' }
  if (enrouteDt) return { status: 'enroute', label: 'En Route' }
  return { status: 'scheduled', label: 'Scheduled' }
}

// Template name (fid 56, free text) → coarse task type. "site visit"
// counts as survey for parity with classifyArrivyTemplate in daily-goals.
export function deriveArrivyTaskType(template: string): { key: string; label: string } {
  const t = template.toLowerCase()
  if (t.includes('install') && !t.includes('reinstall')) return { key: 'install', label: 'Solar Install' }
  if (t.includes('survey') || t.includes('site visit')) return { key: 'survey', label: 'Survey' }
  if (t.includes('final inspection') || t.includes('final-inspection')) return { key: 'final-inspection', label: 'Final Inspection' }
  if (t.includes('inspection')) return { key: 'inspection', label: 'Inspection' }
  if (t.includes('service')) return { key: 'service', label: 'Service' }
  if (t.includes('rework') || t.includes('repair')) return { key: 'rework', label: 'Rework' }
  if (t.includes('battery') || t.includes('ess')) return { key: 'battery', label: 'Battery' }
  return { key: 'other', label: template || 'Task' }
}

export function joinArrivyCustomerName(rec: QbRecord): string {
  const first = String(fieldValue(rec, F.customerFirstName) || '').trim()
  const last = String(fieldValue(rec, F.customerLastName) || '').trim()
  return [first, last].filter(Boolean).join(' ')
}
