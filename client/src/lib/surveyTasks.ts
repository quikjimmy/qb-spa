// Types + shaping for the Site Survey page — mirrors the responses of
// /api/survey-tasks/window and /api/survey-tasks/floating
// (server/src/routes/survey-tasks.ts) and normalizes BOTH into one card
// shape so every KPI drill renders the identical record format.

export interface FloatingTask {
  arrivy_record_id: string
  enerflo_deal_id: string   // '' when the Arrivy field held the non-UUID fallback
  template_name: string
  task_type_key: string
  task_type_label: string
  customer_name: string
  scheduled_at: string
  status: string
  status_label: string
  task_url: string
  submitted_at: string
  enroute_at: string
  started_at: string
  arrivy_complete: boolean
  is_probable_test: boolean
  is_stale: boolean
}

export interface FloatingDeal {
  enerflo_deal_id: string
  qb_record_id: number
  customer_name: string
  state: string
  system_size_kw: number
  lender_name: string
  epc_name: string
  signed_at: string
  deal_url: string
  install_url: string
  closer_name: string
  closer_email: string
  closer_phone: string
  sales_office: string
  cust_phone: string
  cust_email: string
  cust_address: string
  is_probable_test: boolean
  tasks: FloatingTask[]
}

export interface FloatingResponse {
  deals: FloatingDeal[]
  zeroTaskDeals: FloatingDeal[]
  unassignedTasks: FloatingTask[]
  kpi: {
    dealsWithTasks: number
    tasksOnDeals: number
    unassignedTasks: number
    floatingSurveys: number
    zeroTaskDeals: number
  }
  fetchedAt: string
}

// /api/survey-tasks/window response item — already survey-filtered and
// project-meta-joined server-side.
export interface WindowTask {
  arrivy_record_id: string
  project_rid: string
  customer_name: string
  template_name: string
  scheduled_at: string
  submitted_at: string
  enroute_at: string
  started_at: string
  arrivy_complete: boolean
  status: string
  status_label: string
  task_url: string
  crew: string
  kw: number
  state: string
  lender: string
  epc: string
}

export interface WindowResponse {
  preset: string
  from: string
  to: string
  tasks: WindowTask[]
}

// ─── The one card shape every section renders ─────

export interface SurveyCard {
  rid: string
  customer_name: string
  template_name: string
  scheduled_at: string
  crew: string
  kw: number
  task_url: string
  project_rid: string
  status: string
  status_label: string
  pillCls: string
  borderCls: string
  chips: Array<{ label: string; cls: string; title?: string }>
  state: string
  lender: string
  epc: string
  /** Enerflo deal link — set on floating (unsubmitted-deal) cards. */
  deal_url?: string
  /** e.g. "Signed 268d ago" — set on floating cards. */
  signed_note?: string
  /** Full deal context for the bump-out — set on floating cards. */
  deal?: FloatingDeal
  /** The floating task backing this card — set on floating cards. */
  floating_task?: FloatingTask
}

// Status presentation — same styling as FieldDashboardView's getTaskStatus
// so the cards here read identically to the Field dashboard.
const STATUS_PRESENTATION: Record<string, { label: string; pillCls: string; borderCls: string }> = {
  cancelled:    { label: 'Cancelled',     pillCls: 'bg-rose-600 text-white',           borderCls: 'border-l-rose-600 bg-rose-50/40' },
  notsubmitted: { label: 'Not Submitted', pillCls: 'bg-red-100 text-red-700',          borderCls: 'border-l-red-500 bg-red-50/40' },
  submitted:    { label: 'Submitted',     pillCls: 'bg-emerald-100 text-emerald-700',  borderCls: 'border-l-emerald-500' },
  overdue:      { label: 'Overdue',       pillCls: 'bg-red-100 text-red-700',          borderCls: 'border-l-red-500 bg-red-50/40' },
  onsite:       { label: 'On Site',       pillCls: 'bg-sky-100 text-sky-700',          borderCls: 'border-l-sky-500' },
  enroute:      { label: 'En Route',      pillCls: 'bg-sky-100 text-sky-700',          borderCls: 'border-l-sky-500' },
  scheduled:    { label: 'Scheduled',     pillCls: 'bg-muted text-muted-foreground',   borderCls: '' },
}

function presentStatus(key: string) {
  return STATUS_PRESENTATION[key] ?? STATUS_PRESENTATION['scheduled']!
}

function surveyChips(o: { enroute: boolean; onsite: boolean; submitted: boolean; complete: boolean; hasProject: boolean }) {
  const on = 'bg-emerald-100 text-emerald-700'
  const off = 'bg-slate-100 text-slate-400'
  const subCls = o.submitted ? on : o.complete ? 'bg-red-100 text-red-700' : off
  return [
    { label: '🚗 ER', cls: o.enroute ? on : off },
    { label: '🚧 OS', cls: o.onsite ? on : off },
    { label: (o.submitted ? '✅' : '❌') + ' SUB', cls: subCls },
    { label: (o.complete ? '✅' : '') + ' APPR', cls: o.complete ? on : off },
    o.hasProject
      ? { label: '✅ QB', cls: on, title: 'Linked to a project in the QB Projects table' }
      : { label: '❌ QB', cls: 'bg-amber-100 text-amber-700', title: 'No project in the QB Projects table — unsubmitted deal or unassigned task' },
  ]
}

export function windowTaskToCard(t: WindowTask): SurveyCard {
  const s = presentStatus(t.status)
  return {
    rid: t.arrivy_record_id,
    customer_name: t.customer_name,
    template_name: t.template_name,
    scheduled_at: t.scheduled_at,
    crew: t.crew,
    kw: t.kw,
    task_url: t.task_url,
    project_rid: t.project_rid,
    status: t.status,
    status_label: t.status_label || s.label,
    pillCls: s.pillCls,
    borderCls: s.borderCls,
    chips: surveyChips({
      enroute: !!t.enroute_at, onsite: !!t.started_at,
      submitted: !!t.submitted_at, complete: t.arrivy_complete,
      hasProject: !!t.project_rid,
    }),
    state: t.state,
    lender: t.lender,
    epc: t.epc,
  }
}

// Shape a floating (unsubmitted-deal or unassigned) task into the SAME
// card. Deal context folds into the card: kW, aging note, Enerflo link.
export function floatingTaskToCard(t: FloatingTask, deal?: FloatingDeal): SurveyCard {
  const s = presentStatus(t.status)
  const signedDays = deal?.signed_at ? Math.max(0, Math.floor((Date.now() - new Date(deal.signed_at).getTime()) / 86400000)) : 0
  return {
    rid: t.arrivy_record_id,
    customer_name: t.customer_name || deal?.customer_name || '',
    template_name: t.template_name,
    scheduled_at: t.scheduled_at,
    crew: '',
    kw: deal?.system_size_kw || 0,
    task_url: t.task_url,
    project_rid: '',
    status: t.status,
    status_label: t.status_label || s.label,
    pillCls: s.pillCls,
    borderCls: s.borderCls,
    chips: surveyChips({
      enroute: !!t.enroute_at, onsite: !!t.started_at,
      submitted: !!t.submitted_at, complete: t.arrivy_complete,
      hasProject: false,
    }),
    state: deal?.state || '',
    lender: deal?.lender_name || '',
    epc: deal?.epc_name || '',
    deal_url: deal?.deal_url || undefined,
    signed_note: deal?.signed_at ? `Signed ${signedDays}d ago` : undefined,
    deal,
    floating_task: t,
  }
}

export function windowTaskEmoji(status: string): string {
  if (status === 'submitted') return '✅'
  if (status === 'notsubmitted') return '❌'
  if (status === 'onsite') return '🚧'
  if (status === 'enroute') return '🚗'
  if (status === 'overdue') return '⚠️'
  return '⏳'
}
