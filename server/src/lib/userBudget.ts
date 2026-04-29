import db from '../db'

export interface BudgetCheck {
  allowed: boolean
  reason?: string
  cap_cents: number | null
  spent_cents: number
  remaining_cents: number | null
}

// Check whether a user can make a billable LLM call right now.
// `usingOwnKey` = true means the call is on the user's BYOK; if their budget
// has byok_bypasses_cap set, that call won't be blocked or counted.
// Returns allowed=true and remaining=null when the user has no cap configured.
export function checkUserBudget(userId: number, usingOwnKey: boolean): BudgetCheck {
  const budget = db.prepare(
    `SELECT monthly_cap_cents, byok_bypasses_cap FROM user_budgets WHERE user_id = ?`
  ).get(userId) as { monthly_cap_cents: number | null; byok_bypasses_cap: number } | undefined

  const cap = budget?.monthly_cap_cents ?? null
  const bypassByok = (budget?.byok_bypasses_cap ?? 1) === 1

  if (cap == null) {
    return { allowed: true, cap_cents: null, spent_cents: 0, remaining_cents: null }
  }
  if (usingOwnKey && bypassByok) {
    return { allowed: true, cap_cents: cap, spent_cents: 0, remaining_cents: null }
  }

  const monthStart = `datetime('now', 'start of month')`
  const agentSpend = (db.prepare(
    `SELECT COALESCE(SUM(cost_cents),0) AS c FROM agent_runs WHERE user_id = ? AND started_at >= ${monthStart}`
  ).get(userId) as { c: number }).c
  const ledgerSpend = (db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN ? = 1 AND used_own_key = 1 THEN 0 ELSE cost_cents END),0) AS c
       FROM user_llm_usage WHERE user_id = ? AND created_at >= ${monthStart}`
  ).get(bypassByok ? 1 : 0, userId) as { c: number }).c

  const spent = agentSpend + ledgerSpend
  const remaining = cap - spent
  if (remaining <= 0) {
    return { allowed: false, reason: 'Monthly LLM budget exhausted', cap_cents: cap, spent_cents: spent, remaining_cents: 0 }
  }
  return { allowed: true, cap_cents: cap, spent_cents: spent, remaining_cents: remaining }
}

// Append a row to the per-user usage ledger (chatbot + ad-hoc LLM features).
// Use checkUserBudget BEFORE the call; this is the after-call write.
export function recordUserLlmUsage(opts: {
  userId: number
  provider: string
  model: string
  feature: string
  tokensIn: number
  tokensOut: number
  costCents: number
  usedOwnKey: boolean
  error?: string | null
}): void {
  db.prepare(
    `INSERT INTO user_llm_usage (user_id, provider, model, feature, tokens_in, tokens_out, cost_cents, used_own_key, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.userId, opts.provider, opts.model, opts.feature, opts.tokensIn, opts.tokensOut, opts.costCents, opts.usedOwnKey ? 1 : 0, opts.error ?? null)
}
