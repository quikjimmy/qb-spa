// ─── Funding domain (M1 / M2 / M3 / DCA status + clawback) ─────────────
// Exposes the funding-milestone backlog to agents. This does NOT
// re-implement the bucket SQL — it calls the SAME bucketSummary() and
// lenderBreakdown() the funding dashboard uses (exported from
// routes/funding.ts), so the agent and the UI can never disagree about
// what "Ready to Request M2" means. When a bucket definition changes in
// QuickBase, it changes in one place (funding.ts BUCKETS) and both follow.

import {
  BUCKETS,
  BUCKET_ORDER,
  bucketSummary,
  lenderBreakdown,
  type Milestone,
  type DashFilters,
} from '../../../routes/funding'

const MILESTONES: Milestone[] = ['M1', 'M2', 'M3', 'DCA']

export interface FundingStatusResult {
  milestone: Milestone
  filters: DashFilters
  buckets: Array<{ key: string; label: string; count: number; expected_amount: number }>
  total_count: number
  total_expected_amount: number
  // Clawback-risk callouts (see note below).
  clawback?: { label: string; count: number; expected_amount: number }[]
}

// Clawback risk = money already advanced at one milestone that is now
// overdue to roll to the next. We approximate from the existing buckets:
//   - M1 paid but stuck pre-M2 → the M2 "Stale Follow-Up" bucket
//   - M2 paid but stuck pre-M3 → the M2-Not-M3 "Stale Follow-Up" bucket
// These mirror the QB Funding-Dashboard stale-follow-up reports
// (m*_last_funding_check_date <= today-3). Exact day-threshold flags
// (M1→M2 >10d, M2→M3 >30d) need the funded-date columns and can be added
// as dedicated buckets later; this surfaces the actionable stale set today.
function clawbackFor(milestone: Milestone, filters: DashFilters): FundingStatusResult['clawback'] {
  if (milestone === 'M2') {
    const s = bucketSummary('M2:followUp', filters)
    return [{ label: 'M1 paid · stale before M2 (>3d unchecked)', count: s.count, expected_amount: s.expectedAmount }]
  }
  if (milestone === 'M3') {
    const s = bucketSummary('M2NotM3:followUp', filters)
    return [{ label: 'M2 paid · stale before M3 (>3d unchecked)', count: s.count, expected_amount: s.expectedAmount }]
  }
  return undefined
}

export function getFundingStatus(input: {
  milestone?: string
  state?: string
  closer?: string
  lender?: string
}): FundingStatusResult | { milestones: FundingStatusResult[] } {
  const filters: DashFilters = {}
  if (input.state) filters.state = input.state
  if (input.closer) filters.closer = input.closer
  if (input.lender) filters.lender = input.lender

  const compute = (m: Milestone): FundingStatusResult => {
    const keys = BUCKET_ORDER[m]
    const buckets = keys.map(key => {
      const s = bucketSummary(key, filters)
      return { key, label: BUCKETS[key]?.label ?? key, count: s.count, expected_amount: s.expectedAmount }
    })
    const result: FundingStatusResult = {
      milestone: m,
      filters,
      buckets,
      total_count: buckets.reduce((a, b) => a + b.count, 0),
      total_expected_amount: buckets.reduce((a, b) => a + b.expected_amount, 0),
    }
    const cb = clawbackFor(m, filters)
    if (cb) result.clawback = cb
    return result
  }

  if (input.milestone) {
    const m = input.milestone.toUpperCase() as Milestone
    if (!MILESTONES.includes(m)) throw new Error(`Unknown milestone "${input.milestone}". Use one of: ${MILESTONES.join(', ')}`)
    return compute(m)
  }
  // No milestone → return all four.
  return { milestones: MILESTONES.map(compute) }
}

// Lender pivot for a milestone — top lenders by backlog count, with the
// long tail folded into "Other". Powers the "Top 5 lenders + Other" view.
export function getFundingByLender(input: { milestone: string; top?: number; state?: string; closer?: string }): unknown {
  const m = input.milestone.toUpperCase() as Milestone
  if (!MILESTONES.includes(m)) throw new Error(`Unknown milestone "${input.milestone}". Use one of: ${MILESTONES.join(', ')}`)
  const filters: DashFilters = {}
  if (input.state) filters.state = input.state
  if (input.closer) filters.closer = input.closer

  const rows = lenderBreakdown(m, filters)
  // Roll the per-(lender,status) rows up to per-lender totals.
  const byLender = new Map<string, { lender: string; count: number; expected_amount: number }>()
  for (const r of rows) {
    let e = byLender.get(r.lender)
    if (!e) { e = { lender: r.lender, count: 0, expected_amount: 0 }; byLender.set(r.lender, e) }
    e.count += r.count
    e.expected_amount += r.expectedAmount
  }
  const sorted = [...byLender.values()].sort((a, b) => b.count - a.count)
  const top = Math.max(1, Math.min(input.top ?? 5, 20))
  const head = sorted.slice(0, top)
  const tail = sorted.slice(top)
  const other = tail.reduce(
    (acc, r) => ({ lender: 'Other', count: acc.count + r.count, expected_amount: acc.expected_amount + r.expected_amount }),
    { lender: 'Other', count: 0, expected_amount: 0 },
  )
  const lenders = other.count > 0 ? [...head, other] : head
  return { milestone: m, filters, lenders }
}
