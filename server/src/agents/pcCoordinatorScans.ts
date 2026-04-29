import db from '../db'
import { fetchProjectNotes } from './notesFetcher'

const QB_PROJECTS_TABLE = 'br9kwm8na'
const QB_NOTES_TABLE = 'bsb6bqt3b'
const QB_API = 'https://api.quickbase.com/v1/records/query'

const ACTIVE_FILTER = '{255.EX.Active}'
const PROJECT_COORDINATOR_EMAIL_FID = 822

interface QbField {
  value?: unknown
}

interface QbRecord {
  [fid: string]: QbField | undefined
}

interface QueryDefinition {
  label: string
  from: string
  where: string
  select: number[]
  sortFid?: number
  top?: number
}

interface QueryResult {
  label: string
  records: QbRecord[]
  count: number
  error: string | null
}

interface ScanPayload {
  coordinator?: string
  coordinator_email?: string
  project_id?: string | number
  permit_days?: number
  inspection_days?: number
  schedule_window_days?: number
  max_permit_age_days?: number
  max_post_install_age_days?: number
}

interface ArrivyTaskSnapshot {
  template: string
  status: string
  scheduled: string
}

interface InvestigationCheck {
  worker: string
  system: string
  status: 'clear' | 'warning' | 'blocked' | 'resolved'
  summary: string
  evidence?: string
}

export interface CoordinatorTaskResult {
  summary: string
  payload: Record<string, unknown>
  actions: Array<Record<string, unknown>>
  query_counts: Record<string, number>
  query_errors: Record<string, string>
}

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

function qbHeaders(realm: string, token: string) {
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

function val(record: QbRecord, fid: number): string {
  const raw = record[String(fid)]?.value
  if (raw === null || raw === undefined) return ''
  if (Array.isArray(raw)) return raw.map(v => String(v)).join(', ')
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (obj['name']) return String(obj['name'])
    if (obj['email']) return String(obj['email'])
  }
  return String(raw)
}

function num(record: QbRecord, fid: number): number {
  const n = Number(val(record, fid))
  return Number.isFinite(n) ? n : 0
}

function daysSince(raw: string): number | null {
  if (!raw) return null
  const ms = new Date(raw).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
}

function delayedOpsRevenue(systemKw: number): number {
  return Math.round(systemKw * 1000 * 2)
}

function coordinatorClause(coordinator?: string, coordinatorEmail?: string): string {
  const identity = (coordinatorEmail || coordinator || '').replace(/[{}]/g, '').trim()
  return identity ? `{${PROJECT_COORDINATOR_EMAIL_FID}.CT.${identity}}` : ''
}

function actionFeedbackKey(action: Record<string, unknown>): string {
  return [
    String(action['project_rid'] || ''),
    String(action['category'] || ''),
    String(action['issue'] || ''),
    String(action['action'] || ''),
  ].join('::')
}

function recentWindowClause(fid: number, olderThanDays: number, newerThanDays: number): string {
  const olderThan = new Date(Date.now() - olderThanDays * 86_400_000).toISOString().slice(0, 10)
  const newerThan = new Date(Date.now() - newerThanDays * 86_400_000).toISOString().slice(0, 10)
  return `{${fid}.OBF.${olderThan}}AND{${fid}.OAF.${newerThan}}`
}

function wasRecentlyDismissed(action: Record<string, unknown>): boolean {
  const row = db.prepare(
    `SELECT decision, created_at
     FROM agent_action_feedback
     WHERE action_key = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(actionFeedbackKey(action)) as { decision: string; created_at: string } | undefined
  if (!row || row.decision !== 'dismissed') return false
  const ageMs = Date.now() - new Date(row.created_at).getTime()
  return ageMs <= 14 * 86_400_000
}

function applyFeedbackLearning(actions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return actions.filter(action => !wasRecentlyDismissed(action))
}

async function qbQuery(query: QueryDefinition): Promise<QueryResult> {
  const { realm, token } = getQbConfig()
  if (!token) return { label: query.label, records: [], count: 0, error: 'QB_USER_TOKEN not configured on server' }

  const body: Record<string, unknown> = {
    from: query.from,
    select: query.select,
    where: query.where,
    options: { top: query.top || 100 },
  }
  if (query.sortFid) body['sortBy'] = [{ fieldId: query.sortFid, order: 'ASC' }]

  try {
    const res = await fetch(QB_API, {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify(body),
    })
    const data = await res.json() as { data?: QbRecord[]; metadata?: { totalRecords?: number }; message?: string; error?: string }
    if (!res.ok) {
      return { label: query.label, records: [], count: 0, error: data.message || data.error || `QuickBase error ${res.status}` }
    }
    return {
      label: query.label,
      records: data.data || [],
      count: Number(data.metadata?.totalRecords || data.data?.length || 0),
      error: null,
    }
  } catch (err) {
    return { label: query.label, records: [], count: 0, error: String(err) }
  }
}

function baseProjectSelect(): number[] {
  return [3, 6, 13, 178, 189, 207, 208, 255, 318, 344, 491, 534, 538, 822]
}

function priorityForRevenue(revenue: number): 'critical' | 'high' | 'medium' {
  if (revenue >= 20000) return 'critical'
  if (revenue >= 10000) return 'high'
  return 'medium'
}

function permitAlertQueries(payload: ScanPayload): QueryDefinition[] {
  const permitDays = Number(payload.permit_days || 21)
  const maxAge = Number(payload.max_permit_age_days || 180)
  const coordinator = coordinatorClause(payload.coordinator, payload.coordinator_email)
  const where = [
    coordinator,
    `{207.XEX.}`,
    '{208.EX.}',
    recentWindowClause(207, permitDays, maxAge),
    ACTIVE_FILTER,
  ].filter(Boolean).join('AND')
  return [{
    label: 'permit_aging',
    from: QB_PROJECTS_TABLE,
    where,
    select: baseProjectSelect(),
    sortFid: 207,
  }]
}

function icNoInspectionQueries(payload: ScanPayload): QueryDefinition[] {
  const inspectionDays = Number(payload.inspection_days || 7)
  const maxAge = Number(payload.max_post_install_age_days || 120)
  const coordinator = coordinatorClause(payload.coordinator, payload.coordinator_email)
  const where = [
    coordinator,
    `{534.XEX.}`,
    '{491.EX.}',
    recentWindowClause(534, inspectionDays, maxAge),
    ACTIVE_FILTER,
  ].filter(Boolean).join('AND')
  return [{
    label: 'ic_no_inspection',
    from: QB_PROJECTS_TABLE,
    where,
    select: baseProjectSelect(),
    sortFid: 534,
  }]
}

function inspectionNoPtoQueries(payload: ScanPayload): QueryDefinition[] {
  const inspectionDays = Number(payload.inspection_days || 7)
  const maxAge = Number(payload.max_post_install_age_days || 120)
  const coordinator = coordinatorClause(payload.coordinator, payload.coordinator_email)
  const where = [
    coordinator,
    `{491.XEX.}`,
    '{538.EX.}',
    recentWindowClause(491, inspectionDays, maxAge),
    ACTIVE_FILTER,
  ].filter(Boolean).join('AND')
  return [{
    label: 'inspection_no_pto',
    from: QB_PROJECTS_TABLE,
    where,
    select: baseProjectSelect(),
    sortFid: 491,
  }]
}

function installWithoutPermitQueries(payload: ScanPayload): QueryDefinition[] {
  const scheduleDays = Number(payload.schedule_window_days || 2)
  const start = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const end = new Date(Date.now() + scheduleDays * 86_400_000).toISOString().slice(0, 10)
  const coordinator = coordinatorClause(payload.coordinator, payload.coordinator_email)
  const where = [
    coordinator,
    `{178.XEX.}`,
    '{208.EX.}',
    `{178.OAF.${start}}`,
    `{178.OBF.${end}}`,
    ACTIVE_FILTER,
  ].filter(Boolean).join('AND')
  return [{
    label: 'scheduled_without_permit',
    from: QB_PROJECTS_TABLE,
    where,
    select: baseProjectSelect(),
    sortFid: 178,
  }]
}

function noteDigestQueries(payload: ScanPayload): QueryDefinition[] {
  if (!payload.project_id) return []
  return [{
    label: 'recent_notes',
    from: QB_NOTES_TABLE,
    where: `{13.EX.${String(payload.project_id)}}`,
    select: [3, 6, 7, 8, 9, 10, 13, 14],
    sortFid: 8,
    top: 10,
  }]
}

async function fetchArrivyProjectTasks(projectRid: string): Promise<ArrivyTaskSnapshot[]> {
  const query = await qbQuery({
    label: 'arrivy_project_tasks',
    from: 'bvbqgs5yc',
    where: `{6.EX.${projectRid}}`,
    select: [56, 85, 115],
    sortFid: 115,
    top: 50,
  })
  if (query.error) return []
  return query.records.map(record => ({
    template: val(record, 56),
    status: val(record, 85),
    scheduled: val(record, 115),
  }))
}

function normalizeText(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim()
}

function isInspectionTask(task: ArrivyTaskSnapshot): boolean {
  return normalizeText(task.template).includes('inspect')
}

function isTaskActive(task: ArrivyTaskSnapshot): boolean {
  const status = normalizeText(task.status)
  return !['complete', 'completed', 'cancelled', 'canceled'].includes(status)
}

function isFutureDate(raw: string): boolean {
  const ts = new Date(raw).getTime()
  return Number.isFinite(ts) && ts >= (Date.now() - 86_400_000)
}

function summarizeNotes(notes: Array<{ date: string; text: string }>): string {
  return notes.slice(0, 2).map(note => `${note.date}: ${note.text}`).join(' | ')
}

function latestInspectionSignal(notes: Array<{ date: string; text: string }>): {
  kind: 'scheduled' | 'waiting_external' | 'cancelled' | 'none'
  summary?: string
} {
  for (const note of notes) {
    const text = normalizeText(note.text)
    if (/(scheduled|booked|rescheduled|inspection set|inspection confirmed|passed inspection)/.test(text)) {
      return { kind: 'scheduled', summary: `${note.date}: ${note.text}` }
    }
    if (/(waiting on homeowner|waiting homeowner|waiting on customer|waiting on ahj|waiting on city|waiting on county|homeowner unavailable|customer unavailable|ahj|utility hold)/.test(text)) {
      return { kind: 'waiting_external', summary: `${note.date}: ${note.text}` }
    }
    if (/(cancelled|canceled|failed inspection|no show|noshow)/.test(text)) {
      return { kind: 'cancelled', summary: `${note.date}: ${note.text}` }
    }
  }
  return { kind: 'none' }
}

function activeInspectionWorkItem(projectRid: string): { id: number; title: string; status: string } | undefined {
  return db.prepare(
    `SELECT id, title, status
     FROM agent_work_items
     WHERE project_rid = ?
       AND category = 'inspection'
       AND status IN ('open', 'in_progress')
     ORDER BY updated_at DESC
     LIMIT 1`
  ).get(projectRid) as { id: number; title: string; status: string } | undefined
}

function inspectionCaseAction(record: QbRecord, details: {
  classification: string
  confidence: 'high' | 'medium'
  checks: InvestigationCheck[]
  hitlReason: string
  recommendedNextStep: string
  owner: string
  noteSummary?: string
}): Record<string, unknown> {
  const days = daysSince(val(record, 534)) || 0
  const revenue = delayedOpsRevenue(num(record, 13))
  return {
    action_type: 'case_review',
    category: 'inspection',
    priority: priorityForRevenue(revenue),
    project_rid: val(record, 3),
    project: val(record, 6),
    target_department: 'PC',
    issue: `Install complete with no inspection after ${days} days`,
    action: details.owner === 'PC Inbox Draft Worker' ? 'Review draft-worthy inspection follow-up' : 'Review inspection scheduling blocker',
    recommended_next_step: details.recommendedNextStep,
    delayed_ops_revenue: revenue,
    approval_required: false,
    classification: details.classification,
    confidence: details.confidence,
    checks: details.checks,
    hitl_reason: details.hitlReason,
    note_summary: details.noteSummary || null,
    next_owner: details.owner,
    workflow_key: 'pc_install_to_inspection_case',
    workflow_stage: 'investigated',
    orchestration_runtime: 'qb-spa-managed',
    openclaw_ready: true,
    worker_trace: details.checks.map(check => ({ worker: check.worker, status: check.status, system: check.system })),
  }
}

async function investigateInspectionGap(record: QbRecord): Promise<{
  surfaced: boolean
  classification: string
  checks: InvestigationCheck[]
  action?: Record<string, unknown>
}> {
  const projectRid = val(record, 3)
  const checks: InvestigationCheck[] = []
  const notes = await fetchProjectNotes(Number(projectRid), 45).catch(() => [])
  const trimmedNotes = notes.map(note => ({ date: note.date, text: note.text.trim().replace(/\s+/g, ' ') })).filter(note => note.text)
  const noteSignal = latestInspectionSignal(trimmedNotes)

  const inspectionTasks = (await fetchArrivyProjectTasks(projectRid)).filter(isInspectionTask)
  const upcomingInspection = inspectionTasks.find(task => isTaskActive(task) && isFutureDate(task.scheduled))
  const completedInspection = inspectionTasks.find(task => normalizeText(task.status).includes('complete'))
  const openWorkItem = activeInspectionWorkItem(projectRid)

  checks.push({
    worker: 'Schedule Integrity Worker',
    system: 'Arrivy',
    status: upcomingInspection ? 'resolved' : inspectionTasks.length ? 'warning' : 'clear',
    summary: upcomingInspection
      ? `Inspection task already scheduled for ${upcomingInspection.scheduled || 'a future date'}.`
      : inspectionTasks.length
        ? `Inspection-related Arrivy tasks exist but none are currently scheduled.`
        : 'No inspection task exists in Arrivy yet.',
    evidence: inspectionTasks.slice(0, 3).map(task => `${task.template} · ${task.status} · ${task.scheduled || 'no date'}`).join(' | ') || undefined,
  })

  checks.push({
    worker: 'PC Inbox Draft Worker',
    system: 'QuickBase Notes',
    status: noteSignal.kind === 'scheduled' ? 'resolved' : noteSignal.kind === 'waiting_external' ? 'warning' : noteSignal.kind === 'cancelled' ? 'blocked' : 'clear',
    summary: noteSignal.kind === 'scheduled'
      ? 'Recent notes already indicate an inspection is scheduled or completed.'
      : noteSignal.kind === 'waiting_external'
        ? 'Recent notes show the project is waiting on an external party.'
        : noteSignal.kind === 'cancelled'
          ? 'Recent notes show a cancellation or failed inspection path.'
          : 'No recent notes explain the inspection gap.',
    evidence: noteSignal.summary || summarizeNotes(trimmedNotes) || undefined,
  })

  checks.push({
    worker: 'Permit Intelligence Worker',
    system: 'QuickBase Projects',
    status: val(record, 208) ? 'clear' : 'blocked',
    summary: val(record, 208)
      ? `Permit approval is on file as of ${val(record, 208)}.`
      : 'Permit approval is still blank, which may block inspection progression.',
    evidence: val(record, 318) ? `AHJ: ${val(record, 318)}` : undefined,
  })

  checks.push({
    worker: 'Review Readiness Worker',
    system: 'Agent Ops',
    status: openWorkItem ? 'resolved' : 'clear',
    summary: openWorkItem
      ? `An active agent work item already exists: ${openWorkItem.title} (${openWorkItem.status}).`
      : 'No active internal follow-up task exists yet.',
    evidence: openWorkItem ? `Task #${openWorkItem.id}` : undefined,
  })

  if (upcomingInspection || completedInspection || noteSignal.kind === 'scheduled' || openWorkItem) {
    return {
      surfaced: false,
      classification: 'already_in_motion',
      checks,
    }
  }

  const noteSummary = summarizeNotes(trimmedNotes)
  if (noteSignal.kind === 'waiting_external') {
    return {
      surfaced: true,
      classification: 'waiting_external',
      checks,
      action: inspectionCaseAction(record, {
        classification: 'waiting_external',
        confidence: 'medium',
        checks,
        hitlReason: 'Ari found context, but a coordinator still needs to decide whether to wait, escalate, or draft an external follow-up.',
        recommendedNextStep: 'Review the external blocker, confirm whether the waiting reason is still valid, and approve a draft follow-up only if the case is no longer progressing.',
        owner: 'PC Inbox Draft Worker',
        noteSummary,
      }),
    }
  }

  return {
    surfaced: true,
    classification: noteSignal.kind === 'cancelled' ? 'needs_human_review' : 'needs_agent_follow_up',
    checks,
    action: inspectionCaseAction(record, {
      classification: noteSignal.kind === 'cancelled' ? 'needs_human_review' : 'needs_agent_follow_up',
      confidence: noteSignal.kind === 'cancelled' ? 'medium' : 'high',
      checks,
      hitlReason: noteSignal.kind === 'cancelled'
        ? 'The signals conflict or indicate a failed path, so Ari needs a coordinator to choose the next move.'
        : 'Ari checked Arrivy, notes, permit state, and internal work items and still found no evidence that inspection follow-up is already moving.',
      recommendedNextStep: noteSignal.kind === 'cancelled'
        ? 'Review the failed or cancelled inspection path, decide whether to reschedule, and create the next internal task.'
        : 'Create an inspection follow-up task or approve a draft coordinator update so the gap moves forward.',
      owner: noteSignal.kind === 'cancelled' ? 'Project Coordinator' : 'Schedule Integrity Worker',
      noteSummary,
    }),
  }
}

async function runQueries(queries: QueryDefinition[]): Promise<{ counts: Record<string, number>; errors: Record<string, string>; byLabel: Map<string, QueryResult> }> {
  const results = await Promise.all(queries.map(qbQuery))
  return {
    counts: Object.fromEntries(results.map(result => [result.label, result.count])),
    errors: Object.fromEntries(results.filter(result => result.error).map(result => [result.label, result.error || 'unknown error'])),
    byLabel: new Map(results.map(result => [result.label, result])),
  }
}

function buildPermitAlertAction(record: QbRecord): Record<string, unknown> {
  const days = daysSince(val(record, 207)) || 0
  const revenue = delayedOpsRevenue(num(record, 13))
  return {
    action_type: 'human_review',
    category: 'permit',
    priority: priorityForRevenue(revenue),
    project_rid: val(record, 3),
    project: val(record, 6),
    target_department: 'PC',
    issue: `Permit pending ${days} days`,
    action: 'Review permit blocker and decide follow-up',
    recommended_next_step: `Draft AHJ follow-up for ${val(record, 318) || 'this jurisdiction'} and confirm whether install timing needs to move.`,
    delayed_ops_revenue: revenue,
    approval_required: false,
  }
}

function buildIcInspectionAction(record: QbRecord): Record<string, unknown> {
  const days = daysSince(val(record, 534)) || 0
  const revenue = delayedOpsRevenue(num(record, 13))
  return {
    action_type: 'human_review',
    category: 'inspection',
    priority: priorityForRevenue(revenue),
    project_rid: val(record, 3),
    project: val(record, 6),
    target_department: 'PC',
    issue: `Install complete with no inspection after ${days} days`,
    action: 'Review inspection scheduling blocker',
    recommended_next_step: 'Check Arrivy/task status, confirm inspection request path, and create a follow-up task if still unscheduled.',
    delayed_ops_revenue: revenue,
    approval_required: false,
  }
}

function buildInspectionPtoAction(record: QbRecord): Record<string, unknown> {
  const days = daysSince(val(record, 491)) || 0
  const revenue = delayedOpsRevenue(num(record, 13))
  return {
    action_type: 'human_review',
    category: 'pto',
    priority: priorityForRevenue(revenue),
    project_rid: val(record, 3),
    project: val(record, 6),
    target_department: 'PC',
    issue: `Inspection passed with no PTO after ${days} days`,
    action: 'Review PTO blocker',
    recommended_next_step: 'Confirm utility/NEM status and determine whether a PTO follow-up or document chase is needed.',
    delayed_ops_revenue: revenue,
    approval_required: false,
  }
}

function buildSchedulePermitAction(record: QbRecord): Record<string, unknown> {
  const installDate = val(record, 178) || 'scheduled soon'
  const revenue = delayedOpsRevenue(num(record, 13))
  return {
    action_type: 'human_review',
    category: 'scheduling',
    priority: 'critical',
    project_rid: val(record, 3),
    project: val(record, 6),
    target_department: 'PC',
    issue: `Install scheduled ${installDate} without permit approval`,
    action: 'Confirm go / no-go before crew rolls',
    recommended_next_step: 'Review permit status, confirm whether the schedule must move, and notify the coordinator team if action is needed.',
    delayed_ops_revenue: revenue,
    approval_required: false,
  }
}

export async function runPermitAgingAlertScan(payload: ScanPayload = {}): Promise<CoordinatorTaskResult> {
  const { counts, errors, byLabel } = await runQueries(permitAlertQueries(payload))
  const records = byLabel.get('permit_aging')?.records || []
  const actions = applyFeedbackLearning(records.map(buildPermitAlertAction))
  return {
    summary: actions.length
      ? `Ari found ${actions.length} permit aging item${actions.length === 1 ? '' : 's'} that need coordinator review. These are detection-only recommendations; no follow-up was sent.`
      : 'Ari did not find any permits past the configured aging threshold.',
    payload: { permit_days: Number(payload.permit_days || 21), projects: records.map(record => ({ rid: val(record, 3), project: val(record, 6), permit_submitted: val(record, 207), ahj: val(record, 318), coordinator_email: val(record, 822) })) },
    actions,
    query_counts: counts,
    query_errors: errors,
  }
}

export async function runInstallCompleteWithoutInspectionScan(payload: ScanPayload = {}): Promise<CoordinatorTaskResult> {
  const { counts, errors, byLabel } = await runQueries(icNoInspectionQueries(payload))
  const records = byLabel.get('ic_no_inspection')?.records || []
  const investigations = await Promise.all(records.map(investigateInspectionGap))
  const surfacedActions = investigations
    .filter(result => result.surfaced && result.action)
    .map(result => result.action as Record<string, unknown>)
  const actions = applyFeedbackLearning(surfacedActions)
  const resolvedCount = investigations.filter(result => !result.surfaced).length
  const waitingExternalCount = investigations.filter(result => result.classification === 'waiting_external').length
  return {
    summary: actions.length
      ? `Ari investigated ${records.length} install-to-inspection case${records.length === 1 ? '' : 's'}. ${resolvedCount} already had movement or existing follow-up, ${waitingExternalCount} had external blockers in notes, and ${actions.length} still need coordinator review.`
      : `Ari investigated ${records.length} install-to-inspection case${records.length === 1 ? '' : 's'} and did not find any unresolved inspection gaps that still need coordinator review.`,
    payload: {
      inspection_days: Number(payload.inspection_days || 7),
      workflow_key: 'pc_install_to_inspection_case',
      workflow_template: {
        trigger: 'install_complete_without_inspection',
        orchestration_runtime: 'qb-spa-managed',
        openclaw_adapter: 'ready_for_runner',
        stages: ['detect', 'schedule_check', 'notes_check', 'permit_check', 'internal_task_check', 'classify', 'hitl_if_needed'],
      },
      projects: records.map((record, index) => ({
        rid: val(record, 3),
        project: val(record, 6),
        install_complete: val(record, 534),
        lender: val(record, 344),
        coordinator_email: val(record, 822),
        classification: investigations[index]?.classification || 'unknown',
        surfaced_to_human: investigations[index]?.surfaced || false,
        checks: investigations[index]?.checks || [],
      })),
      surfaced_count: actions.length,
      auto_resolved_count: resolvedCount,
    },
    actions,
    query_counts: counts,
    query_errors: errors,
  }
}

export async function runInspectionPassedWithoutPtoScan(payload: ScanPayload = {}): Promise<CoordinatorTaskResult> {
  const { counts, errors, byLabel } = await runQueries(inspectionNoPtoQueries(payload))
  const records = byLabel.get('inspection_no_pto')?.records || []
  const actions = applyFeedbackLearning(records.map(buildInspectionPtoAction))
  return {
    summary: actions.length
      ? `Ari found ${actions.length} inspection-passed project${actions.length === 1 ? '' : 's'} with PTO still outstanding. No external follow-up was sent.`
      : 'Ari did not find any inspection-passed projects missing PTO follow-up beyond the configured threshold.',
    payload: { inspection_days: Number(payload.inspection_days || 7), projects: records.map(record => ({ rid: val(record, 3), project: val(record, 6), inspection_passed: val(record, 491), lender: val(record, 344), coordinator_email: val(record, 822) })) },
    actions,
    query_counts: counts,
    query_errors: errors,
  }
}

export async function runInstallScheduledWithoutPermitScan(payload: ScanPayload = {}): Promise<CoordinatorTaskResult> {
  const { counts, errors, byLabel } = await runQueries(installWithoutPermitQueries(payload))
  const records = byLabel.get('scheduled_without_permit')?.records || []
  const actions = applyFeedbackLearning(records.map(buildSchedulePermitAction))
  return {
    summary: actions.length
      ? `Ari found ${actions.length} scheduled install${actions.length === 1 ? '' : 's'} without permit approval. These should be reviewed before crews roll.`
      : 'Ari did not find any scheduled installs without permit approval in the configured lookahead window.',
    payload: { schedule_window_days: Number(payload.schedule_window_days || 2), projects: records.map(record => ({ rid: val(record, 3), project: val(record, 6), install_scheduled: val(record, 178), permit_approved: val(record, 208), coordinator_email: val(record, 822) })) },
    actions,
    query_counts: counts,
    query_errors: errors,
  }
}

export async function runRecentNotesDigest(payload: ScanPayload = {}): Promise<CoordinatorTaskResult> {
  const { counts, errors, byLabel } = await runQueries(noteDigestQueries(payload))
  const records = byLabel.get('recent_notes')?.records || []
  const lines = records.map(record => {
    const when = val(record, 8)
    const category = val(record, 7) || 'General'
    const note = val(record, 6).replace(/\s+/g, ' ').trim()
    const author = val(record, 9) || 'Unknown'
    return `• ${when} · ${category} · ${author}: ${note}`
  })
  return {
    summary: lines.length ? lines.join('\n') : 'No recent project notes were found for this project.',
    payload: { project_id: payload.project_id || null, notes_found: records.length },
    actions: [],
    query_counts: counts,
    query_errors: errors,
  }
}
