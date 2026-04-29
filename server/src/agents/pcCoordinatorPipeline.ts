import {
  runInspectionPassedWithoutPtoScan,
  runInstallScheduledWithoutPermitScan,
  runPermitAgingAlertScan,
  type CoordinatorTaskResult,
} from './pcCoordinatorScans'
import { runInspectionCaseWorkflowViaOpenClaw } from './openClawRunner'

interface PipelinePayload {
  coordinator?: string
  coordinator_email?: string
  permit_days?: number
  inspection_days?: number
  schedule_window_days?: number
}

function priorityRank(priority: string): number {
  if (priority === 'critical') return 0
  if (priority === 'high') return 1
  if (priority === 'medium') return 2
  return 3
}

function dedupeActions(results: CoordinatorTaskResult[]): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>()

  for (const result of results) {
    for (const action of result.actions) {
      const rid = String(action['project_rid'] || '')
      const category = String(action['category'] || 'general')
      const key = `${rid}:${category}`
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, action)
        continue
      }
      const existingRank = priorityRank(String(existing['priority'] || 'low'))
      const nextRank = priorityRank(String(action['priority'] || 'low'))
      if (nextRank < existingRank) {
        merged.set(key, action)
      }
    }
  }

  return [...merged.values()].sort((a, b) => {
    const pr = priorityRank(String(a['priority'] || 'low')) - priorityRank(String(b['priority'] || 'low'))
    if (pr !== 0) return pr
    const revA = Number(a['delayed_ops_revenue'] || 0)
    const revB = Number(b['delayed_ops_revenue'] || 0)
    return revB - revA
  })
}

function buildSummary(actions: Array<Record<string, unknown>>): string {
  if (actions.length === 0) return 'Ari ran the coordinator exception pipeline and did not find any active exceptions above the current thresholds.'

  const counts = {
    critical: actions.filter(a => a['priority'] === 'critical').length,
    high: actions.filter(a => a['priority'] === 'high').length,
    medium: actions.filter(a => a['priority'] === 'medium').length,
  }
  const totalRevenue = actions.reduce((sum, action) => sum + Number(action['delayed_ops_revenue'] || 0), 0)
  const top = actions.slice(0, 5).map(action => {
    const project = String(action['project'] || 'Project')
    const issue = String(action['issue'] || '')
    return `• ${project} — ${issue}`
  }).join('\n')

  return [
    `Ari surfaced ${actions.length} coordinator exception${actions.length === 1 ? '' : 's'} across the current workstreams.`,
    `Critical: ${counts.critical} · High: ${counts.high} · Medium: ${counts.medium}`,
    totalRevenue > 0 ? `Delayed ops revenue currently at risk across surfaced items: $${totalRevenue.toLocaleString()}` : '',
    '',
    'Top surfaced exceptions:',
    top,
    '',
    'These findings are detect-first only. Review, dismiss, comment, or create follow-up work from Agent Ops.',
  ].filter(Boolean).join('\n')
}

export async function runCoordinatorExceptionPipeline(payload: PipelinePayload = {}): Promise<CoordinatorTaskResult> {
  const results = await Promise.all([
    runPermitAgingAlertScan(payload),
    runInspectionCaseWorkflowViaOpenClaw(payload as Record<string, unknown>),
    runInspectionPassedWithoutPtoScan(payload),
    runInstallScheduledWithoutPermitScan(payload),
  ])

  const actions = dedupeActions(results)
  const queryCounts: Record<string, number> = {}
  const queryErrors: Record<string, string> = {}
  for (const result of results) {
    Object.assign(queryCounts, result.query_counts)
    Object.assign(queryErrors, result.query_errors)
  }

  return {
    summary: buildSummary(actions),
    payload: {
      pipeline: 'ari_coordinator_exception_pipeline',
      sources: ['permit_aging', 'ic_no_inspection', 'inspection_no_pto', 'scheduled_without_permit'],
      thresholds: {
        permit_days: Number(payload.permit_days || 21),
        inspection_days: Number(payload.inspection_days || 7),
        schedule_window_days: Number(payload.schedule_window_days || 2),
      },
      runtimes: {
        permit_aging: 'builtin',
        install_to_inspection_case: 'openclaw',
        inspection_no_pto: 'builtin',
        scheduled_without_permit: 'builtin',
      },
      surfaced_count: actions.length,
    },
    actions,
    query_counts: queryCounts,
    query_errors: queryErrors,
  }
}
