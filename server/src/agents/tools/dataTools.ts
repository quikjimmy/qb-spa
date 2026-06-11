// ─── Agent Data Tools (provider-neutral) ──────────────────────────────
// Read-only toolkit over the KPI registry and project_cache, defined
// ONCE in a vendor-neutral shape so ANY LLM or agent runtime can use it:
//   - Anthropic SDK         → toAnthropicTools()
//   - OpenAI / compatible   → toOpenAIFunctions()
//   - MCP clients (Claude   → see ./mcpServer.ts (consumes TOOL_SPECS
//     Desktop, Cursor, etc.)   directly)
//
// The two portable artifacts are TOOL_SPECS (what the tools are) and
// executeDataTool (how to run one). Both are plain data / plain functions
// with no vendor coupling — every adapter ends up calling executeDataTool
// with a tool name and a plain input object.
//
// Everything here is read-only and column-allowlisted. No writes, no
// arbitrary SQL. Write/outreach actions stay behind the agent_approvals
// gate and do not belong in this toolkit.

import db from '../../db'
import { listMetrics, computeMetric } from '../kpi/registry'
import { getFundingStatus, getFundingByLender } from './domains/funding'
import { getCommsStats } from './domains/comms'
import { getTickets } from './domains/tickets'
import { getBreakdown } from './domains/breakdown'
import { getSchedule } from './domains/schedule'

// ─── Neutral tool spec ─────────────────────────────────────────────────
// `inputSchema` is plain JSON Schema — the lingua franca every provider
// speaks. Anthropic calls it `input_schema`, OpenAI nests it under
// `function.parameters`, MCP calls it `inputSchema`; all are this object.

export interface ToolSpec {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_kpis',
    description:
      'List every operational KPI available, with its slug, plain-English description, and the QuickBase source it mirrors. Call this first to discover what you can measure.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_kpi',
    description:
      'Compute one KPI from the live project cache. Returns the current count, the average days-in-stage of the backlog, and oldest-first example projects (record_id, customer, coordinator, days_in_stage) so you can name specific projects to chase.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'KPI slug from list_kpis, e.g. "inspection_passed_not_pto".' },
        sample_limit: {
          type: 'integer',
          description: 'How many example projects to return (0-100, default 10).',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'query_projects',
    description:
      'Query the project cache directly with structured filters when no single KPI fits. Returns matching projects (record_id, customer, status, coordinator, state, milestone dates). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        status_contains: { type: 'string', description: 'Case-insensitive substring match on project status, e.g. "Hold".' },
        coordinator: { type: 'string', description: 'Exact coordinator name.' },
        state: { type: 'string', description: 'Two-letter state code, e.g. "AZ".' },
        has_set: {
          type: 'string',
          description: 'Milestone date column that must be set (non-empty). Allowed columns only.',
        },
        not_set: {
          type: 'string',
          description: 'Milestone date column that must be empty. Allowed columns only.',
        },
        limit: { type: 'integer', description: 'Max rows (1-100, default 25).' },
      },
    },
  },
  {
    name: 'get_funding_status',
    description:
      'Funding-milestone backlog. Returns status buckets (Ready to Request / Pending Approval / Approved-Not-Received / Not Ready) with project counts and expected $ for a milestone, plus clawback-risk callouts (money advanced that is now stale before the next milestone). Omit milestone to get all of M1, M2, M3, DCA.',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'string', description: 'M1 | M2 | M3 | DCA. Omit for all four.' },
        state: { type: 'string', description: 'Optional state filter.' },
        closer: { type: 'string', description: 'Optional closer filter.' },
        lender: { type: 'string', description: 'Optional lender filter.' },
      },
    },
  },
  {
    name: 'get_funding_by_lender',
    description:
      'Funding backlog for one milestone pivoted by lender — top N lenders by backlog count with the long tail folded into "Other". Use to see which lenders hold the most stuck funding.',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'string', description: 'M1 | M2 | M3 | DCA (required).' },
        top: { type: 'integer', description: 'How many lenders before folding into Other (default 5).' },
        state: { type: 'string', description: 'Optional state filter.' },
        closer: { type: 'string', description: 'Optional closer filter.' },
      },
      required: ['milestone'],
    },
  },
  {
    name: 'get_comms_stats',
    description:
      'Customer-support phone/SMS stats over a rolling window. Returns inbound/outbound call volume, inbound answer rate, outbound connect rate, and SMS in/out counts. Use window_days 7 or 30. Optionally scope to one coordinator.',
    inputSchema: {
      type: 'object',
      properties: {
        window_days: { type: 'integer', description: 'Rolling window in days (1-90, default 7). Use 7 and 30 for the two standard views.' },
        coordinator: { type: 'string', description: 'Optional coordinator name to scope to one person.' },
      },
    },
  },
  {
    name: 'get_tickets',
    description:
      'Support-ticket backlog: open / overdue / due-today / future counts, plus the top offenders by assignee and by category (past_due, today, future, total). Use to see who and what is behind on tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'integer', description: 'How many rows per pivot (assignee/category), default 5.' },
      },
    },
  },
  {
    name: 'get_breakdown',
    description:
      'Intake/sales performance grouped by a dimension. Returns per-group projects sold, kW sold, KCA\'d count, KCA rate %, and first-time inspection-pass rate %. dimension = state | lender | closer | coordinator. Pass top to fold the long tail into "Other" (e.g. top 5 lenders).',
    inputSchema: {
      type: 'object',
      properties: {
        dimension: { type: 'string', description: 'state | lender | closer | coordinator (required).' },
        top: { type: 'integer', description: 'Keep the top N groups, fold the rest into "Other". Omit to return all.' },
      },
      required: ['dimension'],
    },
  },
  {
    name: 'get_schedule',
    description:
      'Installs or site surveys on the calendar for a window, with count, total kW, and a per-state location breakdown. task = install | survey. window = today | yesterday | next_7_days | prev_7_days.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'install | survey (required).' },
        window: { type: 'string', description: 'today | yesterday | next_7_days | prev_7_days (default today).' },
      },
      required: ['task'],
    },
  },
]

// ─── Provider adapters ─────────────────────────────────────────────────
// Thin, lossless format conversions. Add a new provider by adding a
// mapper here — the specs and the dispatcher never change.

interface AnthropicToolShape {
  name: string
  description: string
  input_schema: ToolSpec['inputSchema']
}

export function toAnthropicTools(specs: ToolSpec[] = TOOL_SPECS): AnthropicToolShape[] {
  return specs.map(s => ({ name: s.name, description: s.description, input_schema: s.inputSchema }))
}

interface OpenAIFunctionShape {
  type: 'function'
  function: { name: string; description: string; parameters: ToolSpec['inputSchema'] }
}

export function toOpenAIFunctions(specs: ToolSpec[] = TOOL_SPECS): OpenAIFunctionShape[] {
  return specs.map(s => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.inputSchema },
  }))
}

// ─── Backing query helpers ─────────────────────────────────────────────

// Columns query_projects is allowed to filter on. Keeps the tool from
// touching free-form columns and prevents injection via field names.
const ALLOWED_DATE_COLUMNS = new Set([
  'sales_date', 'intake_completed', 'survey_scheduled', 'survey_submitted', 'survey_approved',
  'cad_submitted', 'design_completed', 'nem_submitted', 'nem_approved',
  'permit_submitted', 'permit_approved', 'permit_rejected',
  'install_scheduled', 'install_completed', 'inspection_scheduled', 'inspection_passed',
  'pto_submitted', 'pto_approved',
  'm1_approved_date', 'm2_approved_date', 'm3_approved_date',
  'cancel_date',
])

const SELECT_COLUMNS =
  'record_id, customer_name, status, coordinator, state, system_size_kw, ' +
  'sales_date, install_completed, inspection_passed, pto_approved, next_task_type, next_task_date'

interface QueryProjectsInput {
  status_contains?: string
  coordinator?: string
  state?: string
  has_set?: string
  not_set?: string
  limit?: number
}

function queryProjects(input: QueryProjectsInput): unknown {
  const where: string[] = []
  const params: unknown[] = []

  if (input.status_contains) {
    where.push(`status LIKE ?`)
    params.push(`%${input.status_contains}%`)
  }
  if (input.coordinator) {
    where.push(`coordinator = ?`)
    params.push(input.coordinator)
  }
  if (input.state) {
    where.push(`state = ?`)
    params.push(input.state)
  }
  if (input.has_set) {
    if (!ALLOWED_DATE_COLUMNS.has(input.has_set)) throw new Error(`Column not allowed: ${input.has_set}`)
    where.push(`(${input.has_set} IS NOT NULL AND ${input.has_set} != '')`)
  }
  if (input.not_set) {
    if (!ALLOWED_DATE_COLUMNS.has(input.not_set)) throw new Error(`Column not allowed: ${input.not_set}`)
    where.push(`(${input.not_set} IS NULL OR ${input.not_set} = '')`)
  }

  const limit = Math.max(1, Math.min(input.limit ?? 25, 100))
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM project_cache ${whereSql} ORDER BY record_id DESC LIMIT ?`)
    .all(...params, limit)

  return { count: rows.length, limit, projects: rows }
}

// ─── Dispatcher (provider-neutral) ─────────────────────────────────────
// Maps a tool name + plain input object to its result. Every provider
// loop and the MCP server funnel through here. Throws on bad input; the
// caller is expected to surface a throw to the model as a tool error so
// it can recover rather than failing the whole run.

export function executeDataTool(name: string, input: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_kpis':
      return { kpis: listMetrics() }
    case 'get_kpi': {
      const slug = String(input['slug'] ?? '')
      if (!slug) throw new Error('get_kpi requires a "slug"')
      const sampleLimit = typeof input['sample_limit'] === 'number' ? input['sample_limit'] : undefined
      return computeMetric(slug, { sampleLimit })
    }
    case 'query_projects':
      return queryProjects(input as QueryProjectsInput)
    case 'get_funding_status':
      return getFundingStatus(input as { milestone?: string; state?: string; closer?: string; lender?: string })
    case 'get_funding_by_lender':
      return getFundingByLender(input as { milestone: string; top?: number; state?: string; closer?: string })
    case 'get_comms_stats':
      return getCommsStats(input as { window_days?: number; coordinator?: string })
    case 'get_tickets':
      return getTickets(input as { top?: number })
    case 'get_breakdown':
      return getBreakdown(input as { dimension: string; top?: number })
    case 'get_schedule':
      return getSchedule(input as { task: string; window?: string })
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
