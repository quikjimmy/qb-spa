import db from '../db'
import { runInstallCompleteWithoutInspectionScan, type CoordinatorTaskResult } from './pcCoordinatorScans'

interface AgentRoleLike {
  id: number
  slug: string
  name: string
  objective: string
  llm: string
}

interface AgentTaskLike {
  id: number
  name: string
  task_type: string
  instructions: string
  runtime?: string
}

interface OpenClawRunOptions {
  runId: number
  role: AgentRoleLike
  task: AgentTaskLike
  payload: Record<string, unknown>
}

interface OpenClawTaskResult {
  status: 'completed' | 'failed' | 'approval_pending'
  resultJson?: string
  error?: string
  tokensIn?: number
  tokensOut?: number
  costCents?: number
}

function roleGoals(agentRoleId: number): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT title, description, success_metric, priority, status
     FROM agent_goals
     WHERE agent_role_id = ? AND status != 'archived'
     ORDER BY priority ASC, id ASC`
  ).all(agentRoleId) as Array<Record<string, unknown>>
}

function rolePermissions(agentRoleId: number): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT resource, action, constraints_json
     FROM agent_permissions
     WHERE agent_role_id = ?
     ORDER BY resource ASC, action ASC`
  ).all(agentRoleId) as Array<Record<string, unknown>>
}

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function deliveryContext(runId: number): Record<string, unknown> | null {
  const row = db.prepare(
    `SELECT di.user_id AS recipient_user_id, adr.qb_coordinator_name, adr.qb_coordinator_email, di.channel
     FROM agent_delivery_items di
     LEFT JOIN agent_delivery_recipients adr
       ON adr.delivery_config_id = di.delivery_config_id AND adr.user_id = di.user_id
     WHERE di.task_run_id = ?
     ORDER BY di.id DESC
     LIMIT 1`
  ).get(runId) as Record<string, unknown> | undefined
  return row || null
}

function buildPolicy(agentRoleId: number): Record<string, unknown> {
  const external = db.prepare(
    `SELECT constraints_json
     FROM agent_permissions
     WHERE agent_role_id = ? AND resource = 'external_message' AND action = 'request_approval'
     LIMIT 1`
  ).get(agentRoleId) as { constraints_json: string | null } | undefined
  return {
    external_messages_allowed: false,
    mutations_allowed: false,
    approval_required_for_irreversible_actions: true,
    external_message_mode: safeJson(external?.constraints_json)['mode'] || 'draft_only',
  }
}

function buildWorkPacket(opts: OpenClawRunOptions): Record<string, unknown> {
  return {
    run_id: opts.runId,
    role: {
      slug: opts.role.slug,
      name: opts.role.name,
      objective: opts.role.objective,
      llm: opts.role.llm,
    },
    task: {
      id: opts.task.id,
      name: opts.task.name,
      type: opts.task.task_type,
      instructions: opts.task.instructions,
      runtime: opts.task.runtime || 'openclaw',
    },
    goals: roleGoals(opts.role.id),
    permissions: rolePermissions(opts.role.id),
    payload: opts.payload,
    delivery: deliveryContext(opts.runId),
    policy: buildPolicy(opts.role.id),
  }
}

function normalizedResult(summary: string, extras: Record<string, unknown>): string {
  return JSON.stringify({ summary, ...extras })
}

export async function runInspectionCaseWorkflowViaOpenClaw(payload: Record<string, unknown> | undefined): Promise<CoordinatorTaskResult> {
  const result = await runInstallCompleteWithoutInspectionScan(payload)
  return {
    ...result,
    payload: {
      ...result.payload,
      runtime: 'openclaw',
      orchestration_runtime: 'openclaw_adapter',
    },
  }
}

export async function executeOpenClawTask(opts: OpenClawRunOptions): Promise<OpenClawTaskResult> {
  const packet = buildWorkPacket(opts)

  if (opts.task.name === 'Install complete without inspection follow-up') {
    const result = await runInspectionCaseWorkflowViaOpenClaw(opts.payload)
    return {
      status: 'completed',
      resultJson: normalizedResult(result.summary, {
        role: opts.role.name,
        task: opts.task.name,
        payload: result.payload,
        actions: result.actions,
        query_counts: result.query_counts,
        query_errors: result.query_errors,
        mode: 'case_workflow',
        human_review_required: result.actions.length > 0,
        model: opts.role.llm,
        runtime: 'openclaw',
        orchestration_runtime: 'openclaw_adapter',
        openclaw: {
          packet,
          status: 'completed',
          summary: result.summary,
          result: {
            workflow_key: result.payload['workflow_key'] || 'pc_install_to_inspection_case',
            surfaced_count: result.payload['surfaced_count'] || result.actions.length,
            auto_resolved_count: result.payload['auto_resolved_count'] || 0,
          },
          requested_actions: [],
          tokens_in: 0,
          tokens_out: 0,
          cost_cents: 0,
          error: null,
        },
      }),
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    }
  }

  return {
    status: 'failed',
    error: `OpenClaw runtime is not configured for task "${opts.task.name}" yet.`,
    resultJson: normalizedResult('OpenClaw task failed.', {
      runtime: 'openclaw',
      orchestration_runtime: 'openclaw_adapter',
      openclaw: {
        packet,
        status: 'failed',
        summary: 'Task is not mapped in the current OpenClaw adapter.',
        result: {},
        requested_actions: [],
        tokens_in: 0,
        tokens_out: 0,
        cost_cents: 0,
        error: `Task is not mapped in the current OpenClaw adapter.`,
      },
    }),
  }
}
