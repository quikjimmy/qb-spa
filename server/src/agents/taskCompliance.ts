export interface TaskComplianceFinding {
  severity: 'low' | 'medium' | 'high' | 'blocked'
  category: string
  text: string
  reason: string
}

export interface TaskComplianceReview {
  risk_score: number
  compliance_score: number
  review_required: 'none' | 'manager' | 'risk_compliance' | 'blocked'
  allowed_to_save: boolean
  summary: string
  findings: TaskComplianceFinding[]
}

const BLOCKED_PATTERNS: Array<{ category: string; re: RegExp; reason: string }> = [
  { category: 'customer_financial_data', re: /\b(credit score|bank account|routing number|ssn|social security|tax return|income verification|paystub|loan application)\b/i, reason: 'Customer financial or identity data cannot be requested by this task.' },
  { category: 'credentials', re: /\b(password|api key|secret token|private key|login code|mfa code)\b/i, reason: 'Secrets and credentials cannot be collected or exposed by an agent task.' },
  { category: 'regulated_advice', re: /\b(legal advice|medical advice|investment advice|credit decision|loan approval)\b/i, reason: 'Regulated advice or decisioning requires a separate approved workflow.' },
]

const HIGH_PATTERNS: Array<{ category: string; re: RegExp; reason: string }> = [
  { category: 'external_communication', re: /\b(send (an )?(email|sms|text|slack)|notify customer|message customer|call customer)\b/i, reason: 'External communication must stay draft-only unless explicitly approved.' },
  { category: 'business_record_mutation', re: /\b(update quickbase|change status|mark resolved|close ticket|reschedule|write back|modify record|delete)\b/i, reason: 'Business record mutation requires approval and audit trail.' },
]

const MEDIUM_PATTERNS: Array<{ category: string; re: RegExp; reason: string }> = [
  { category: 'personal_data', re: /\b(phone|address|email|homeowner|customer)\b/i, reason: 'Personal data must be minimized in outputs.' },
  { category: 'financial_impact', re: /\b(revenue|funding|loan|lender|payment|invoice|cost|margin)\b/i, reason: 'Financial impact can be summarized, but customer financial details are not allowed.' },
  { category: 'cross_department_delegation', re: /\b(route to|assign to|delegate to|handoff to|escalate to)\b/i, reason: 'Agent-to-agent delegation is allowed, but requires traceable routing and ownership.' },
]

function snippets(text: string, re: RegExp): string {
  const match = text.match(re)
  if (!match?.index && match?.index !== 0) return match?.[0] || ''
  return text.slice(Math.max(0, match.index - 40), Math.min(text.length, match.index + 80)).trim()
}

export function reviewTaskPatch(currentTask: Record<string, unknown>, patch: Record<string, unknown>): TaskComplianceReview {
  const merged = {
    name: patch['name'] ?? currentTask['name'] ?? '',
    task_type: patch['task_type'] ?? currentTask['task_type'] ?? '',
    instructions: patch['instructions'] ?? currentTask['instructions'] ?? '',
    input_template_json: patch['input_template_json'] ?? currentTask['input_template_json'] ?? '',
    output_schema_json: patch['output_schema_json'] ?? currentTask['output_schema_json'] ?? '',
  }
  const text = JSON.stringify(merged)
  const findings: TaskComplianceFinding[] = []

  for (const item of BLOCKED_PATTERNS) {
    if (item.re.test(text)) findings.push({ severity: 'blocked', category: item.category, text: snippets(text, item.re), reason: item.reason })
  }
  for (const item of HIGH_PATTERNS) {
    if (item.re.test(text)) findings.push({ severity: 'high', category: item.category, text: snippets(text, item.re), reason: item.reason })
  }
  for (const item of MEDIUM_PATTERNS) {
    if (item.re.test(text)) findings.push({ severity: 'medium', category: item.category, text: snippets(text, item.re), reason: item.reason })
  }

  const blocked = findings.some(f => f.severity === 'blocked')
  const highCount = findings.filter(f => f.severity === 'high').length
  const mediumCount = findings.filter(f => f.severity === 'medium').length
  const riskScore = Math.min(100, (blocked ? 100 : 0) + highCount * 25 + mediumCount * 10)
  const complianceScore = Math.max(0, 100 - riskScore)
  const reviewRequired = blocked ? 'blocked' : highCount > 0 || riskScore >= 50 ? 'risk_compliance' : mediumCount > 0 ? 'manager' : 'none'

  return {
    risk_score: riskScore,
    compliance_score: complianceScore,
    review_required: reviewRequired,
    allowed_to_save: !blocked && reviewRequired !== 'risk_compliance',
    summary: blocked
      ? 'Blocked content found. Remove the flagged sections before saving.'
      : reviewRequired === 'risk_compliance'
        ? 'Risk and Compliance review is required before this task can be updated or enabled.'
        : reviewRequired === 'manager'
          ? 'Manager review recommended. Save is allowed for draft-safe changes.'
          : 'No material compliance issues found.',
    findings,
  }
}

function looksLikeDesignQuestion(message: string): boolean {
  return /\?|^\s*(which|what|how|why|when|where|should|can|could|would|do we|does this|tell me|explain|recommend|options)\b/i.test(message)
}

function roleAwareOptions(currentTask: Record<string, unknown>): string {
  const role = String(currentTask['role_name'] || 'this agent')
  const department = String(currentTask['department'] || 'the department')
  const taskName = String(currentTask['name'] || 'this task')
  if (/daily coordinator digest/i.test(taskName) || /Project Coordinators/i.test(department)) {
    return [
      `For ${role}, I would make the project scope explicit instead of broad:`,
      '',
      'Option 1 - Daily execution view:',
      '- Today and tomorrow installs assigned to the coordinator.',
      '- Projects with permit submitted but not approved.',
      '- Install complete with no inspection scheduled or passed.',
      '- Inspection passed with no PTO movement.',
      '',
      'Option 2 - Agent work queue:',
      '- Projects where another department/agent needs to act next.',
      '- Include owner, reason, age, current milestone, and requested next action.',
      '- Hide normal-status projects unless they explain workload or risk.',
      '',
      'Option 3 - Exception-only digest:',
      '- Only include projects outside expected SLA or blocked by missing data.',
      '- Good for inbox delivery because every item has a clear action.',
      '',
      'Known QuickBase context for this PC task:',
      '- Projects table: br9kwm8na.',
      '- Coordinator mapping: app user email to Project Coordinator - Email field 822.',
      '- Active projects filter: field 255 = Active.',
      '- Install date: field 178.',
      '- Permit submitted/approved: fields 207 and 208.',
      '- Inspection passed/date context: field 491.',
      '- Install complete: field 534.',
      '- PTO-related status: field 538.',
      '',
      'My recommendation: use Option 2 as the product shape, with Option 1 as the data source. The inbox should show action requests for agents first, then human approval/input only when needed.',
    ].join('\n')
  }
  return [
    `For ${role}, I would define the scope around decisions and handoffs, not just records.`,
    '',
    'Useful options:',
    '- Include records this role owns directly.',
    '- Include records where this role is the next accountable department.',
    '- Include exception records that are blocked, stale, or missing required data.',
    '- Exclude normal-status records unless they are needed for volume or trend context.',
    '',
    'If you want, ask me to turn one option into draft instructions and I will propose the exact config changes.',
  ].join('\n')
}

export function proposeTaskPatch(currentTask: Record<string, unknown>, message: string): { reply: string; patch: Record<string, unknown> } {
  const instructions = String(currentTask['instructions'] || '')
  const trimmed = message.trim()
  const patch: Record<string, unknown> = {}

  if (looksLikeDesignQuestion(trimmed) && !/\b(update|change|add|remove|replace|set|make|edit|save|enable|disable|pause|turn off|turn on)\b/i.test(trimmed)) {
    return {
      reply: roleAwareOptions(currentTask),
      patch,
    }
  }

  if (/\b(disable|pause|turn off)\b/i.test(trimmed)) patch['enabled'] = 0
  if (/\b(enable|turn on)\b/i.test(trimmed)) patch['enabled'] = 1
  if (trimmed) {
    patch['instructions'] = [
      instructions,
      '',
      'Requested update:',
      trimmed,
      '',
      'Guardrails: keep outputs draft-only, use least necessary customer data, route cross-department work as agent action requests, and require approval before external messages or business-record updates.',
    ].filter(Boolean).join('\n')
  }

  return {
    reply: 'I drafted a task update and ran the compliance review. Review the proposed instructions and flagged sections before saving.',
    patch,
  }
}
