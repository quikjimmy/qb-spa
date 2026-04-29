import db from '../db'
import { runHoldClassifier } from './runner'
import { evaluateRoleAction } from './policy'
import { buildLivePcMorningBriefingPayload } from './pcMorningBriefing'
import { executeOpenClawTask } from './openClawRunner'
import {
  runInstallCompleteWithoutInspectionScan,
  runInspectionPassedWithoutPtoScan,
  runInstallScheduledWithoutPermitScan,
  runPermitAgingAlertScan,
  runRecentNotesDigest,
} from './pcCoordinatorScans'
import { runCoordinatorExceptionPipeline } from './pcCoordinatorPipeline'

interface AgentRoleRow {
  id: number
  name: string
  slug: string
  objective: string
  execution_mode: 'singleton' | 'manager' | 'worker'
  approval_required: number
  llm: string
}

interface AgentTaskRow {
  id: number
  agent_role_id: number
  name: string
  task_type: 'summary' | 'outreach' | 'classification' | 'escalation' | 'digest' | 'custom'
  runtime: 'builtin' | 'openclaw' | 'nemoclaw'
  instructions: string
}

export interface RoleRunResult {
  status: 'completed' | 'failed' | 'approval_pending'
  resultJson?: string
  error?: string
  tokensIn?: number
  tokensOut?: number
  costCents?: number
}

function safeJsonParse(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function stringifyResult(summary: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({ summary, ...extras })
}

function buildMorningBriefing(payload: Record<string, unknown>, role: AgentRoleRow): string {
  const coordinator = String(payload['coordinator'] || payload['name'] || 'Coordinator')
  const day = String(payload['day'] || 'day')
  const installs = Array.isArray(payload['installs']) ? payload['installs'] as Array<Record<string, unknown>> : []
  const attention = Array.isArray(payload['attention_items']) ? payload['attention_items'] as Array<Record<string, unknown>> : []
  const wins = Array.isArray(payload['wins']) ? payload['wins'] as Array<unknown> : []

  const installLines = installs.length
    ? installs.map(item => {
        const rid = String(item['rid'] || 'project')
        const customer = String(item['customer_name'] || item['project_name'] || 'Customer')
        const location = String(item['location'] || item['city_state'] || 'Location TBD')
        const lender = String(item['lender'] || 'Lender TBD')
        const permit = String(item['permit_status'] || 'Permit status unknown')
        return [
          `• *${customer}* — ${location} — ${lender}`,
          `  ${permit}`,
          `[[slack_buttons: View in Dashboard:https://kin-pc-dashboard.vercel.app, Call Script:call_script_${rid}, Escalate:escalate_${rid}]]`,
        ].join('\n')
      }).join('\n\n')
    : 'No installs were provided for this briefing.'

  const attentionLines = attention.length
    ? attention.map(item => {
        const rid = String(item['rid'] || 'project')
        const project = String(item['project_name'] || item['customer_name'] || 'Project')
        const issue = String(item['issue'] || item['summary'] || 'Needs coordinator review')
        const context = String(item['context'] || '')
        const systemKw = Number(item['system_kw'] || 0)
        const impact = systemKw > 0 ? `\nDelayed ops revenue at risk: $${Math.round(systemKw * 1000 * 2).toLocaleString()}` : ''
        return [
          `*${project} #${rid}* — ${issue}`,
          `${context}${impact}`.trim(),
          `[[slack_buttons: View in Dashboard:https://kin-pc-dashboard.vercel.app, Mark Resolved:resolved_${rid}, Escalate:escalate_${rid}]]`,
        ].filter(Boolean).join('\n')
      }).join('\n\n')
    : 'No urgent attention items were provided.'

  const winLines = wins.length
    ? wins.map(win => `• ${String(win)}`).join('\n')
    : '• No wins were provided yet.'

  return [
    `Morning briefing prepared by ${role.name}.`,
    '',
    `Morning ${coordinator}! Here's your ${day}:`,
    '',
    '---',
    '',
    `*Today's Installs (${installs.length}):*`,
    '',
    installLines,
    '',
    '---',
    '',
    '*Needs Your Attention:*',
    '',
    attentionLines,
    '',
    '---',
    '',
    '*Good News:*',
    winLines,
    '',
    '---',
    '',
    "Anything else you need? I'm on it.",
    '',
    'Draft only. No Slack message has been sent.',
  ].join('\n')
}

function buildDraft(task: AgentTaskRow, payload: Record<string, unknown>, role: AgentRoleRow): string {
  const customer = String(payload['customer_name'] || payload['project_name'] || 'customer')
  const coordinator = String(payload['coordinator'] || 'Project Coordinator')
  const context = String(payload['context'] || payload['message'] || payload['notes'] || '').trim()

  if (task.task_type === 'outreach') {
    return [
      `Draft prepared by ${role.name}.`,
      `Audience: ${String(payload['audience'] || 'customer')}.`,
      `Subject: Follow-up for ${customer}.`,
      `Body: Hi ${customer}, ${context || 'I wanted to follow up with an update on your project.'} Please reply with any questions. - ${coordinator}`,
      'This is a draft only and has not been sent.',
    ].join('\n')
  }

  if (task.task_type === 'digest' && task.name === 'Generate daily coordinator digest') {
    return buildMorningBriefing(payload, role)
  }

  if (task.task_type === 'digest') {
    return [
      `${task.name}`,
      `Prepared for ${coordinator}.`,
      context || 'No additional context was provided.',
    ].join('\n')
  }

  return [
    `${task.name}`,
    task.instructions,
    context || `Prepared by ${role.name}.`,
  ].join('\n')
}

function buildDigestActions(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const attention = Array.isArray(payload['attention_items']) ? payload['attention_items'] as Array<Record<string, unknown>> : []
  return attention.map(item => {
    const issue = String(item['issue'] || '').toLowerCase()
    const rid = String(item['rid'] || '')
    const project = String(item['project_name'] || item['customer_name'] || 'Project')
    let target = 'Project Coordinators'
    let action = 'Review project'
    if (issue.includes('inspection')) {
      target = 'Inspection'
      action = 'Review inspection blocker'
    } else if (issue.includes('permit')) {
      target = 'Permitting'
      action = 'Review permit blocker'
    } else if (issue.includes('pto')) {
      target = 'PTO'
      action = 'Review PTO blocker'
    }
    return {
      project_rid: rid,
      project,
      issue: item['issue'] || 'Needs review',
      target_department: target,
      action,
      action_type: 'agent_delegation',
      requires_human: false,
      status: 'recommended',
    }
  })
}

export async function executeRoleTask(role: AgentRoleRow, task: AgentTaskRow, payloadJson?: string | null, runId?: number): Promise<RoleRunResult> {
  let payload = safeJsonParse(payloadJson)

  if (task.runtime === 'openclaw') {
    return executeOpenClawTask({
      runId: runId || 0,
      role,
      task,
      payload,
    })
  }

  if (role.slug === 'pc-risk-hold-worker' && task.name === 'Hold classification') {
    const holdResult = await runHoldClassifier('manual')
    return {
      status: holdResult.status === 'failed' ? 'failed' : 'completed',
      resultJson: stringifyResult('Hold classification executed through the production role framework.', holdResult as unknown as Record<string, unknown>),
      error: holdResult.error,
      costCents: holdResult.cost_cents,
    }
  }

  if (task.task_type === 'outreach' && payload['requested_action'] === 'send_external_message') {
    const decision = evaluateRoleAction(role, 'external_message', 'draft', true)
    if (!decision.allowed) {
      return { status: 'failed', error: decision.reason || 'Action blocked by policy' }
    }
    return {
      status: 'approval_pending',
      resultJson: stringifyResult('External communication requires approval before execution.', {
        requested_action: 'send_external_message',
        draft: buildDraft(task, payload, role),
      }),
    }
  }

  const decision = evaluateRoleAction(role, 'projects', 'read', false)
  if (!decision.allowed) {
    return { status: 'failed', error: decision.reason || 'Action blocked by policy' }
  }

  if (task.name === 'Run coordinator exception pipeline') {
    const result = await runCoordinatorExceptionPipeline(payload)
    return {
      status: 'completed',
      resultJson: stringifyResult(result.summary, {
        role: role.name,
        task: task.name,
        payload: result.payload,
        actions: result.actions,
        query_counts: result.query_counts,
        query_errors: result.query_errors,
        mode: 'detect_review',
        pipeline: true,
        human_review_required: result.actions.length > 0,
        model: role.llm,
      }),
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    }
  }

  if (task.name === 'Permit aging alert scan') {
    const result = await runPermitAgingAlertScan(payload)
    return {
      status: 'completed',
      resultJson: stringifyResult(result.summary, {
        role: role.name,
        task: task.name,
        payload: result.payload,
        actions: result.actions,
        query_counts: result.query_counts,
        query_errors: result.query_errors,
        mode: 'detect_review',
        human_review_required: result.actions.length > 0,
        model: role.llm,
      }),
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    }
  }

  if (task.name === 'Install complete without inspection follow-up') {
    const result = await runInstallCompleteWithoutInspectionScan(payload)
    return {
      status: 'completed',
      resultJson: stringifyResult(result.summary, {
        role: role.name,
        task: task.name,
        payload: result.payload,
        actions: result.actions,
        query_counts: result.query_counts,
        query_errors: result.query_errors,
        mode: 'case_workflow',
        human_review_required: result.actions.length > 0,
        model: role.llm,
      }),
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    }
  }

  if (task.name === 'Inspection passed without PTO follow-up') {
    const result = await runInspectionPassedWithoutPtoScan(payload)
    return {
      status: 'completed',
      resultJson: stringifyResult(result.summary, {
        role: role.name,
        task: task.name,
        payload: result.payload,
        actions: result.actions,
        query_counts: result.query_counts,
        query_errors: result.query_errors,
        mode: 'detect_review',
        human_review_required: result.actions.length > 0,
        model: role.llm,
      }),
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    }
  }

  if (task.name === 'Install scheduled without permit check') {
    const result = await runInstallScheduledWithoutPermitScan(payload)
    return {
      status: 'completed',
      resultJson: stringifyResult(result.summary, {
        role: role.name,
        task: task.name,
        payload: result.payload,
        actions: result.actions,
        query_counts: result.query_counts,
        query_errors: result.query_errors,
        mode: 'detect_review',
        human_review_required: result.actions.length > 0,
        model: role.llm,
      }),
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    }
  }

  if (task.name === 'Recent notes digest' && payload['project_id']) {
    const result = await runRecentNotesDigest(payload)
    return {
      status: 'completed',
      resultJson: stringifyResult(result.summary, {
        role: role.name,
        task: task.name,
        payload: result.payload,
        actions: result.actions,
        query_counts: result.query_counts,
        query_errors: result.query_errors,
        mode: 'read_only',
        model: role.llm,
      }),
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    }
  }

  if (task.task_type === 'digest' && task.name === 'Generate daily coordinator digest' && payload['use_live_data']) {
    payload = await buildLivePcMorningBriefingPayload(payload)
  }

  const draft = buildDraft(task, payload, role)
  const actions = task.task_type === 'digest' && task.name === 'Generate daily coordinator digest'
    ? buildDigestActions(payload)
    : []
  return {
    status: 'completed',
    resultJson: stringifyResult(draft, {
      role: role.name,
      task: task.name,
      payload,
      actions,
      model: role.llm,
    }),
    tokensIn: 0,
    tokensOut: 0,
    costCents: 0,
  }
}

export function getRoleForRun(agentRoleId: number): AgentRoleRow | undefined {
  return db.prepare(
    `SELECT id, name, slug, objective, execution_mode, approval_required, llm
     FROM agent_roles WHERE id = ?`
  ).get(agentRoleId) as AgentRoleRow | undefined
}

export function getTaskForRun(taskId: number): AgentTaskRow | undefined {
  return db.prepare(
    `SELECT id, agent_role_id, name, task_type, runtime, instructions
     FROM agent_role_tasks WHERE id = ?`
  ).get(taskId) as AgentTaskRow | undefined
}
