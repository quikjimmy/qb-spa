// 9-step milestone strip data — Sales / Intake / Survey / Design / Permit /
// NEM / Install / Inspection / PTO. (HOA omitted until QB carries an HOA flag.)
//
// Mirrors the QB "Project Status Bar" formula behavior:
//   • date inside each step (the milestone date)
//   • biz-day duration inside the step (e.g. permit submitted → approved)
//   • biz-day transit between adjacent steps (e.g. survey done → design done)
//     with a colored SLA threshold per pair
//   • a per-step "infoFlag" (red dot) when something needs attention there
//     (rejected, missing items, overdue scheduled, etc.)
//
// Field IDs mapped from project_cache (see server/src/routes/projects.ts).
// Future: wire NTP/M1/M2/M3 funding chips when those QB fields are cached.

import type { StepState } from './milestones'
import { weekdaysBetween, weekdaysSinceToday } from './bizDays'

export interface SubStep {
  label: string
  date: string | null
  state: 'done' | 'pending' | 'rejected'
}

export interface InfoFlag {
  /** show a red dot top-right of the step's cell */
  show: boolean
  /** human-readable reason — surfaces in the detail panel + tooltip */
  reason: string
}

export interface StripStep {
  id: 'sale' | 'intake' | 'survey' | 'design' | 'permit' | 'nem' | 'install' | 'inspection' | 'pto'
  label: string
  abbrev: string
  state: StepState
  /** Primary date shown under the dot in the strip. */
  date: string | null
  /** Biz-day duration of this step (start → end). null if both bounds unknown. */
  durationDays: number | null
  /** Phrasing for the duration — "1d open" while in flight; "(2d)" when complete. */
  durationLabel: string | null
  /** Sub-checklist for the detail panel. */
  subSteps: SubStep[]
  /** Substring keywords for matching feed events in the detail panel. */
  feedKeywords: string[]
  /** Top-right red-dot indicator. */
  infoFlag: InfoFlag
}

export interface TransitDays {
  /** ID of the upstream step (the one being transit-ed FROM). */
  fromId: StripStep['id']
  /** ID of the downstream step the transit lands on. */
  toId: StripStep['id']
  /** Biz-day count. null if either side has no date. */
  days: number
  /** True if the downstream step has not yet completed (transit is still ticking). */
  inFlight: boolean
  /** Threshold tier — drives color (good/warn/bad). */
  tier: 'good' | 'warn' | 'bad'
}

export interface ProjectStripFields {
  sales_date?: string | null
  intake_completed?: string | null
  survey_scheduled?: string | null
  survey_submitted?: string | null
  survey_approved?: string | null
  cad_submitted?: string | null
  design_completed?: string | null
  permit_submitted?: string | null
  permit_approved?: string | null
  permit_rejected?: string | null
  nem_submitted?: string | null
  nem_approved?: string | null
  nem_rejected?: string | null
  install_scheduled?: string | null
  install_completed?: string | null
  inspection_scheduled?: string | null
  inspection_passed?: string | null
  pto_submitted?: string | null
  pto_approved?: string | null
  status?: string | null
}

function has(v: string | null | undefined): boolean {
  return !!(v && String(v).trim() !== '' && v !== '0' && v !== '-')
}

function localTodayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isPast(s: string | null | undefined): boolean {
  if (!has(s)) return false
  const v = String(s)
  if (v.length === 10 && !v.includes('T')) return v < localTodayIso()
  const d = new Date(v)
  if (isNaN(d.getTime())) return false
  return d.toISOString().slice(0, 10) < localTodayIso()
}

// MM/DD format (zero-padded) — what shows beneath the dot in the strip
export function fmtShort(v: string | null | undefined): string {
  if (!has(v)) return '—'
  const s = String(v)
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s)
  if (isNaN(d.getTime())) return '—'
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}`
}

export function fmtFull(v: string | null | undefined): string {
  if (!has(v)) return ''
  const s = String(v)
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function pickDate(...vs: Array<string | null | undefined>): string | null {
  for (const v of vs) if (has(v)) return String(v)
  return null
}

function subStateFromDates(date: string | null | undefined, rejected?: string | null | undefined): SubStep['state'] {
  if (has(rejected) && !has(date)) return 'rejected'
  if (has(date)) return 'done'
  return 'pending'
}

// Compute a duration label for a step:
//   • both start+end present → "Xd"  (closed duration)
//   • start present, no end  → "Xd open"  (in-flight, ticking against today)
//   • neither               → null
function durLabel(start: string | null | undefined, end: string | null | undefined): { days: number | null; label: string | null } {
  if (has(start) && has(end)) {
    const d = weekdaysBetween(start, end)
    if (d == null) return { days: null, label: null }
    return { days: d, label: `${d}d` }
  }
  if (has(start) && !has(end)) {
    const d = weekdaysSinceToday(start)
    if (d == null) return { days: null, label: null }
    return { days: d, label: `${d}d open` }
  }
  return { days: null, label: null }
}

export function computeStripSteps(p: ProjectStripFields): StripStep[] {
  // Sale Agreement
  const sale: StripStep = {
    id: 'sale', label: 'Sales', abbrev: 'Sal',
    state: has(p.sales_date) ? 'done' : 'not',
    date: pickDate(p.sales_date),
    durationDays: null, durationLabel: null,
    subSteps: [
      { label: 'Sale Agreement', date: pickDate(p.sales_date), state: has(p.sales_date) ? 'done' : 'pending' },
    ],
    feedKeywords: ['sale', 'agreement', 'sold', 'ntp'],
    infoFlag: { show: false, reason: '' },
  }

  // Intake (KCA / Welcome Call)
  const intake: StripStep = {
    id: 'intake', label: 'Intake', abbrev: 'Int',
    state: has(p.intake_completed)
      ? 'done'
      : (p.status || '').toLowerCase().includes('reject')
        ? 'rejected'
        : has(p.survey_scheduled) ? 'active' : 'not',
    date: pickDate(p.intake_completed),
    durationDays: null, durationLabel: null,
    subSteps: [
      { label: 'KCA / Intake', date: pickDate(p.intake_completed), state: subStateFromDates(p.intake_completed) },
      { label: 'Welcome Call', date: pickDate(p.intake_completed), state: subStateFromDates(p.intake_completed) },
    ],
    feedKeywords: ['intake', 'kca', 'welcome', 'rep promise'],
    infoFlag: { show: (p.status || '').toLowerCase().includes('reject') && !has(p.intake_completed), reason: 'Intake rejected' },
  }

  // Survey
  const survey: StripStep = (() => {
    let state: StepState = 'not'
    if (has(p.survey_approved)) state = 'done'
    else if (has(p.survey_submitted)) state = 'active'
    else if (has(p.survey_scheduled) && isPast(p.survey_scheduled)) state = 'overdue'
    else if (has(p.survey_scheduled)) state = 'scheduled'
    const d = durLabel(p.survey_submitted, p.survey_approved)
    return {
      id: 'survey', label: 'Survey', abbrev: 'Sur',
      state,
      date: pickDate(p.survey_approved, p.survey_submitted, p.survey_scheduled),
      durationDays: d.days, durationLabel: d.label,
      subSteps: [
        { label: 'Scheduled', date: pickDate(p.survey_scheduled), state: subStateFromDates(p.survey_scheduled) },
        { label: 'Submitted', date: pickDate(p.survey_submitted), state: subStateFromDates(p.survey_submitted) },
        { label: 'Approved',  date: pickDate(p.survey_approved),  state: subStateFromDates(p.survey_approved) },
      ],
      feedKeywords: ['survey', 'site visit', 'site survey'],
      infoFlag: { show: state === 'overdue', reason: 'Survey scheduled date passed' },
    }
  })()

  // Design (CAD + design completed)
  const design: StripStep = (() => {
    let state: StepState = 'not'
    if (has(p.design_completed)) state = 'done'
    else if (has(p.cad_submitted)) state = 'active'
    const d = durLabel(p.survey_submitted ?? p.cad_submitted, p.design_completed)
    return {
      id: 'design', label: 'Design', abbrev: 'Des',
      state,
      date: pickDate(p.design_completed, p.cad_submitted),
      durationDays: d.days, durationLabel: d.label,
      subSteps: [
        { label: 'CAD Submitted', date: pickDate(p.cad_submitted), state: subStateFromDates(p.cad_submitted) },
        { label: 'CAD Approved / Design Complete', date: pickDate(p.design_completed), state: subStateFromDates(p.design_completed) },
      ],
      feedKeywords: ['design', 'cad', 'engineering'],
      infoFlag: { show: false, reason: '' },
    }
  })()

  // Permit
  const permit: StripStep = (() => {
    let state: StepState = 'not'
    let flagReason = ''
    if (has(p.permit_approved)) state = 'done'
    else if (has(p.permit_rejected) && !has(p.permit_approved)) { state = 'rejected'; flagReason = 'Permit rejected' }
    else if (has(p.permit_submitted)) state = 'active'
    const d = durLabel(p.permit_submitted, p.permit_approved)
    return {
      id: 'permit', label: 'Permit', abbrev: 'Per',
      state,
      date: pickDate(p.permit_approved, p.permit_submitted, p.permit_rejected),
      durationDays: d.days, durationLabel: d.label,
      subSteps: [
        { label: 'Submitted', date: pickDate(p.permit_submitted), state: subStateFromDates(p.permit_submitted) },
        { label: 'Approved',  date: pickDate(p.permit_approved),  state: subStateFromDates(p.permit_approved, p.permit_rejected) },
      ],
      feedKeywords: ['permit', 'ahj', 'permitting'],
      infoFlag: { show: state === 'rejected', reason: flagReason },
    }
  })()

  // NEM
  const nem: StripStep = (() => {
    let state: StepState = 'not'
    let flagReason = ''
    if (has(p.nem_approved)) state = 'done'
    else if (has(p.nem_rejected) && !has(p.nem_approved)) { state = 'rejected'; flagReason = 'NEM rejected' }
    else if (has(p.nem_submitted)) state = 'active'
    const d = durLabel(p.nem_submitted, p.nem_approved)
    return {
      id: 'nem', label: 'NEM', abbrev: 'NEM',
      state,
      date: pickDate(p.nem_approved, p.nem_submitted, p.nem_rejected),
      durationDays: d.days, durationLabel: d.label,
      subSteps: [
        { label: 'Submitted', date: pickDate(p.nem_submitted), state: subStateFromDates(p.nem_submitted) },
        { label: 'Approved',  date: pickDate(p.nem_approved),  state: subStateFromDates(p.nem_approved, p.nem_rejected) },
      ],
      feedKeywords: ['nem', 'utility interconnect', 'interconnection'],
      infoFlag: { show: state === 'rejected', reason: flagReason },
    }
  })()

  // Install
  const install: StripStep = (() => {
    let state: StepState = 'not'
    if (has(p.install_completed)) state = 'done'
    else if (has(p.install_scheduled) && isPast(p.install_scheduled)) state = 'overdue'
    else if (has(p.install_scheduled)) state = 'scheduled'
    const d = durLabel(p.install_scheduled, p.install_completed)
    return {
      id: 'install', label: 'Install', abbrev: 'Ins',
      state,
      date: pickDate(p.install_completed, p.install_scheduled),
      durationDays: d.days, durationLabel: d.label,
      subSteps: [
        { label: 'Scheduled', date: pickDate(p.install_scheduled), state: subStateFromDates(p.install_scheduled) },
        { label: 'Completed', date: pickDate(p.install_completed), state: subStateFromDates(p.install_completed) },
      ],
      feedKeywords: ['install', 'crew', 'installation'],
      infoFlag: { show: state === 'overdue', reason: 'Install scheduled date passed' },
    }
  })()

  // Inspection
  const inspection: StripStep = (() => {
    let state: StepState = 'not'
    if (has(p.inspection_passed)) state = 'done'
    else if (has(p.inspection_scheduled) && isPast(p.inspection_scheduled)) state = 'overdue'
    else if (has(p.inspection_scheduled)) state = 'scheduled'
    const d = durLabel(p.inspection_scheduled, p.inspection_passed)
    return {
      id: 'inspection', label: 'Inspection', abbrev: 'Isp',
      state,
      date: pickDate(p.inspection_passed, p.inspection_scheduled),
      durationDays: d.days, durationLabel: d.label,
      subSteps: [
        { label: 'Scheduled', date: pickDate(p.inspection_scheduled), state: subStateFromDates(p.inspection_scheduled) },
        { label: 'Passed',    date: pickDate(p.inspection_passed),    state: subStateFromDates(p.inspection_passed) },
      ],
      feedKeywords: ['inspection', 'inspect', 'ahj inspection'],
      infoFlag: { show: state === 'overdue', reason: 'Inspection scheduled date passed' },
    }
  })()

  // PTO
  const pto: StripStep = (() => {
    let state: StepState = 'not'
    if (has(p.pto_approved)) state = 'done'
    else if (has(p.pto_submitted)) state = 'active'
    const d = durLabel(p.pto_submitted, p.pto_approved)
    return {
      id: 'pto', label: 'PTO', abbrev: 'PTO',
      state,
      date: pickDate(p.pto_approved, p.pto_submitted),
      durationDays: d.days, durationLabel: d.label,
      subSteps: [
        { label: 'Submitted', date: pickDate(p.pto_submitted), state: subStateFromDates(p.pto_submitted) },
        { label: 'Approved',  date: pickDate(p.pto_approved),  state: subStateFromDates(p.pto_approved) },
      ],
      feedKeywords: ['pto', 'permission to operate'],
      infoFlag: { show: false, reason: '' },
    }
  })()

  return [sale, intake, survey, design, permit, nem, install, inspection, pto]
}

// SLA thresholds matching the QB formula. The "from" date is the
// previous step's gating date; the "to" date is the next step's
// gating date. While in flight (no "to" yet) the count keeps ticking
// against today.
type Pair = { fromId: StripStep['id']; toId: StripStep['id']; from: keyof ProjectStripFields; to: keyof ProjectStripFields; thresholds: { good: number; warn: number } }

const SLA_PAIRS: Pair[] = [
  { fromId: 'survey',     toId: 'design',     from: 'survey_submitted',  to: 'design_completed', thresholds: { good: 1, warn: 2 } },
  { fromId: 'design',     toId: 'permit',     from: 'design_completed',  to: 'permit_submitted', thresholds: { good: 1, warn: 2 } },
  { fromId: 'install',    toId: 'inspection', from: 'install_completed', to: 'inspection_passed', thresholds: { good: 3, warn: 5 } },
  { fromId: 'inspection', toId: 'pto',        from: 'inspection_passed', to: 'pto_submitted',     thresholds: { good: 1, warn: 5 } },
]

export function computeTransits(p: ProjectStripFields): TransitDays[] {
  const out: TransitDays[] = []
  for (const pair of SLA_PAIRS) {
    const fromVal = p[pair.from] ?? null
    const toVal = p[pair.to] ?? null
    if (!has(fromVal as string)) continue
    const days = has(toVal as string)
      ? weekdaysBetween(fromVal as string, toVal as string)
      : weekdaysSinceToday(fromVal as string)
    if (days == null) continue
    const inFlight = !has(toVal as string)
    let tier: TransitDays['tier'] = 'good'
    if (days > pair.thresholds.warn) tier = 'bad'
    else if (days > pair.thresholds.good) tier = 'warn'
    out.push({ fromId: pair.fromId, toId: pair.toId, days, inFlight, tier })
  }
  return out
}

export function activeStripStep(steps: StripStep[]): StripStep | null {
  return steps.find(s => s.state !== 'done') ?? null
}
