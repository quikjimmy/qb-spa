// Milestone tracker logic matching the qb-skin progress tracker
// Color rules:
//   done     = green  (#10b981) with ✓  — completed/approved
//   active   = amber  (#f59e0b)         — submitted, in progress
//   scheduled= blue   (#3b82f6)         — scheduled, not yet past
//   rejected = red    (#ef4444) with ✗  — rejected
//   overdue  = purple (#8b5cf6) with !  — past date, not completed
//   not      = grey   (#e2e8f0)         — not started

export type StepState = 'done' | 'active' | 'scheduled' | 'rejected' | 'overdue' | 'not'

export interface MilestoneStep {
  key: string
  label: string
  state: StepState
  notify: boolean // red dot for blockers
}

export interface ProjectMilestoneFields {
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
  status: string
}

function has(v: string): boolean {
  return !!v && v !== '' && v !== '0' && v !== '-'
}

function isPast(dateStr: string): boolean {
  try { return new Date(dateStr + 'T23:59:59') < new Date() } catch { return false }
}

export function computeMilestones(p: ProjectMilestoneFields): MilestoneStep[] {
  const statusLow = (p.status || '').toLowerCase()

  // KCA
  let kca: StepState = 'not'
  if (has(p.intake_completed)) kca = 'done'
  else if (statusLow.includes('reject')) kca = 'rejected'
  else if (has(p.survey_scheduled)) kca = 'active' // something is moving

  // Survey
  let ss: StepState = 'not'
  if (has(p.survey_approved)) ss = 'done'
  else if (has(p.survey_submitted)) ss = 'active'
  else if (has(p.survey_scheduled) && isPast(p.survey_scheduled)) ss = 'overdue'
  else if (has(p.survey_scheduled)) ss = 'scheduled'

  // Design
  let des: StepState = 'not'
  const desNotify = has(p.permit_rejected) && !has(p.design_completed)
  if (has(p.design_completed)) des = 'done'
  else if (has(p.cad_submitted)) des = 'active'

  // NEM
  let nem: StepState = 'not'
  const nemNotify = has(p.nem_rejected) && !has(p.nem_approved)
  if (has(p.nem_approved)) nem = 'done'
  else if (has(p.nem_submitted)) nem = 'active'

  // Permit
  let perm: StepState = 'not'
  const permNotify = has(p.permit_rejected) && !has(p.permit_approved)
  if (has(p.permit_approved)) perm = 'done'
  else if (has(p.permit_submitted)) perm = 'active'

  // Install
  let inst: StepState = 'not'
  if (has(p.install_completed)) inst = 'done'
  else if (has(p.install_scheduled) && isPast(p.install_scheduled)) inst = 'overdue'
  else if (has(p.install_scheduled)) inst = 'scheduled'

  // Inspection
  let insp: StepState = 'not'
  if (has(p.inspection_passed)) insp = 'done'
  else if (has(p.inspection_scheduled) && isPast(p.inspection_scheduled)) insp = 'overdue'
  else if (has(p.inspection_scheduled)) insp = 'scheduled'

  // PTO
  let pto: StepState = 'not'
  const ptoNotify = has(p.install_completed) && !has(p.inspection_passed) && !has(p.pto_approved)
  if (has(p.pto_approved)) pto = 'done'
  else if (has(p.pto_submitted)) pto = 'active'

  return [
    { key: 'kca', label: 'KCA', state: kca, notify: false },
    { key: 'survey', label: 'SS', state: ss, notify: false },
    { key: 'design', label: 'Des', state: des, notify: desNotify },
    { key: 'nem', label: 'NEM', state: nem, notify: nemNotify },
    { key: 'permit', label: 'Perm', state: perm, notify: permNotify },
    { key: 'install', label: 'Inst', state: inst, notify: false },
    { key: 'inspection', label: 'Insp', state: insp, notify: false },
    { key: 'pto', label: 'PTO', state: pto, notify: ptoNotify },
  ]
}

// Dot styling per state
export const dotStyle: Record<StepState, { bg: string; text: string; icon: string }> = {
  done:      { bg: 'bg-emerald-500', text: 'text-white', icon: '✓' },
  active:    { bg: 'bg-amber-400',   text: 'text-white', icon: '' },
  scheduled: { bg: 'bg-blue-500',    text: 'text-white', icon: '' },
  rejected:  { bg: 'bg-red-500',     text: 'text-white', icon: '✗' },
  overdue:   { bg: 'bg-violet-500',  text: 'text-white', icon: '!' },
  not:       { bg: 'bg-[#e2e8f0]',   text: 'text-transparent', icon: '' },
}

export const labelStyle: Record<StepState, string> = {
  done:      'text-emerald-700',
  active:    'text-amber-700',
  scheduled: 'text-blue-700',
  rejected:  'text-red-700',
  overdue:   'text-violet-700',
  not:       'text-muted-foreground',
}

export const connectorStyle = (prevDone: boolean) => prevDone ? 'bg-emerald-400' : 'bg-[#e2e8f0]'
