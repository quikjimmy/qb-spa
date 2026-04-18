import Anthropic from '@anthropic-ai/sdk'
import { HOLD_CLASSIFIER_SYSTEM, HOLD_CLASSIFIER_MODEL_DEFAULT, HOLD_CLASSIFIER_MODEL_FALLBACK } from './prompt'

export interface HoldProject {
  record_id: number
  customer_name: string | null
  status: string | null
  state: string | null
  system_size_kw: number | null
  sales_date: string | null
  lender: string | null
  coordinator: string | null
  intake_completed?: string | null
  survey_submitted?: string | null
  survey_approved?: string | null
  design_completed?: string | null
  nem_submitted?: string | null
  nem_approved?: string | null
  nem_rejected?: string | null
  permit_submitted?: string | null
  permit_approved?: string | null
  permit_rejected?: string | null
  install_scheduled?: string | null
  install_completed?: string | null
  inspection_scheduled?: string | null
  inspection_passed?: string | null
  pto_submitted?: string | null
  pto_approved?: string | null
}

export interface ProjectNote {
  record_id: number
  date: string
  category: string
  note_by: string
  text: string
  disposition?: string
  new_status?: string
  current_status?: string
  internal_note?: boolean
}

export interface Classification {
  category: 'utility' | 'permitting' | 'HOA' | 'finance' | 'customer' | 'design' | 'site' | 'internal' | 'other'
  subcategory: string
  confidence: number
  one_line_reason: string
  evidence_note_ids: number[]
  last_movement_days: number
  days_on_hold: number
  suggested_next_action: string
}

export interface ClassificationResult {
  classification: Classification
  tokens_in: number
  tokens_out: number
  model: string
  cost_cents: number
}

const PRICING = {
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
} as const

function computeCostCents(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model as keyof typeof PRICING]
  if (!p) return 0
  const inCost = (tokensIn / 1_000_000) * p.in
  const outCost = (tokensOut / 1_000_000) * p.out
  return Math.ceil((inCost + outCost) * 100)
}

function buildUserPrompt(project: HoldProject, notes: ProjectNote[]): string {
  const milestones: Record<string, string | null | undefined> = {
    intake_completed: project.intake_completed,
    survey_submitted: project.survey_submitted,
    survey_approved: project.survey_approved,
    design_completed: project.design_completed,
    nem_submitted: project.nem_submitted,
    nem_approved: project.nem_approved,
    nem_rejected: project.nem_rejected,
    permit_submitted: project.permit_submitted,
    permit_approved: project.permit_approved,
    permit_rejected: project.permit_rejected,
    install_scheduled: project.install_scheduled,
    install_completed: project.install_completed,
    inspection_scheduled: project.inspection_scheduled,
    inspection_passed: project.inspection_passed,
    pto_submitted: project.pto_submitted,
    pto_approved: project.pto_approved,
  }
  const milestoneLines = Object.entries(milestones)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')

  const noteLines = notes.length
    ? notes
        .map(n => {
          const flags = [n.internal_note ? 'internal' : null, n.disposition, n.new_status ? `→ ${n.new_status}` : null].filter(Boolean).join(' | ')
          return `[note_id=${n.record_id}] ${n.date} | ${n.category} | ${n.note_by}${flags ? ` | ${flags}` : ''}\n  ${n.text.replace(/\s+/g, ' ').trim()}`
        })
        .join('\n\n')
    : '(no notes on file)'

  return `## Project
record_id: ${project.record_id}
customer: ${project.customer_name ?? 'Unknown'}
state: ${project.state ?? 'Unknown'}
status: ${project.status ?? 'Unknown'}
system_size_kw: ${project.system_size_kw ?? 'Unknown'}
lender: ${project.lender ?? 'Unknown'}
coordinator: ${project.coordinator ?? 'Unknown'}
sales_date: ${project.sales_date ?? 'Unknown'}

## Milestones (populated only)
${milestoneLines || '(none)'}

## Notes (most recent first)
${noteLines}

Classify this project. Return only JSON per the system instructions.`
}

function parseClassification(raw: string): Classification {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  const parsed = JSON.parse(trimmed) as Classification
  const allowed = ['utility', 'permitting', 'HOA', 'finance', 'customer', 'design', 'site', 'internal', 'other']
  if (!allowed.includes(parsed.category)) throw new Error(`Invalid category: ${parsed.category}`)
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) throw new Error('Invalid confidence')
  if (!Array.isArray(parsed.evidence_note_ids)) parsed.evidence_note_ids = []
  if (typeof parsed.last_movement_days !== 'number') parsed.last_movement_days = 0
  return parsed
}

export async function classifyHoldProject(project: HoldProject, notes: ProjectNote[], opts?: { model?: string }): Promise<ClassificationResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })
  const model = opts?.model || HOLD_CLASSIFIER_MODEL_DEFAULT
  const userPrompt = buildUserPrompt(project, notes)

  const response = await client.messages.create({
    model,
    max_tokens: 400,
    system: [{ type: 'text', text: HOLD_CLASSIFIER_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text response from model')

  const classification = parseClassification(textBlock.text)
  const tokensIn = (response.usage.input_tokens || 0) + (response.usage.cache_creation_input_tokens || 0) + (response.usage.cache_read_input_tokens || 0)
  const tokensOut = response.usage.output_tokens || 0

  return {
    classification,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    model,
    cost_cents: computeCostCents(model, tokensIn, tokensOut),
  }
}

export { HOLD_CLASSIFIER_MODEL_DEFAULT, HOLD_CLASSIFIER_MODEL_FALLBACK }
