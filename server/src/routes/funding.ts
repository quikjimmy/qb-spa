import { Router, type Request, type Response } from 'express'
import db from '../db'
import { officeTodayIso } from '../lib/officeTime'
import { buildM1NotM2, type Filters } from './reports'
import { refreshFundingLive, refreshFundingFull, fundingFullAgeMs, FUNDING_FULL_MAX_AGE_MS } from './projects'

const router = Router()

// ───────────────────────────────────────────────────────────────────
// Live refresh — the dashboard calls this on load so M1/M2/M3 dates
// reflect QB *now*, not the tier-cadence cache (which lags and is gated
// off-hours). Delta pull, coalesced + rate-limited server-side; on QB
// failure we still 200 so the page falls back to the (stale) cache.
// ───────────────────────────────────────────────────────────────────
router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Accuracy guarantee: if the last FULL sweep is stale (>1h) or has
    // never run, do the sledgehammer instead of the delta — one QB query
    // over the whole funding universe, immune to formula/lookup
    // watermark blind spots.
    const age = fundingFullAgeMs()
    if (age == null || age > FUNDING_FULL_MAX_AGE_MS) {
      const full = await refreshFundingFull()
      const delta = await refreshFundingLive()
      res.json({ refreshed: true, full: true, rows: full.rows + delta.rows, skipped: false })
      return
    }
    const result = await refreshFundingLive()
    res.json({ refreshed: !result.skipped, ...result })
  } catch (err) {
    res.status(200).json({ refreshed: false, rows: 0, skipped: false, error: err instanceof Error ? err.message : String(err) })
  }
})

// Manual "make it match QB right now" — full sweep on demand, no
// watermarks involved. Wired to the dashboard's Full Sync button.
router.post('/refresh-full', async (_req: Request, res: Response): Promise<void> => {
  try {
    const full = await refreshFundingFull()
    const delta = await refreshFundingLive().catch(() => ({ rows: 0, skipped: true }))
    res.json({ refreshed: !full.skipped, full: true, rows: full.rows + delta.rows, skipped: full.skipped })
  } catch (err) {
    res.status(200).json({ refreshed: false, rows: 0, skipped: false, error: err instanceof Error ? err.message : String(err) })
  }
})

// ───────────────────────────────────────────────────────────────────
// Common baseline: Kin Home, not a test row, not yet fully funded,
// not archived, and not status-excluded. Mirrors the QB Funding-
// Dashboard report filter `{2569.XEX.'1'}AND{2568.XEX.'1'}AND
// {1942.XEX.'1'}` plus our app-side EPC + test-project gates. All
// funding queries layer their milestone-specific filter on top.
// ───────────────────────────────────────────────────────────────────
const BASE_WHERE = `
  WHERE epc = 'Kin Home'
    AND (test_project IS NULL OR test_project = 0)
    AND (is_funded IS NULL OR is_funded != 1)
    AND (status_exclusion IS NULL OR status_exclusion != 1)
    AND (general_archive IS NULL OR general_archive != 1)
`

// (milestone, bucket) → SQL fragment. Buckets are intentionally limited
// to actionable statuses; non-actionable states like "Received", "No
// Expected", "Waiting for milestone", "Not Eligible" are excluded.
type Milestone = 'M1' | 'M2' | 'M3' | 'DCA'
const NUMERIC_PREFIX: Record<Exclude<Milestone, 'DCA'>, 'm1' | 'm2' | 'm3'> = {
  M1: 'm1', M2: 'm2', M3: 'm3',
}

interface BucketDef { label: string; where: string; amountCol: string }
const BUCKETS: Record<string, BucketDef> = {
  // ─── M1
  'M1:ready':     { label: 'Ready to Request',     where: `m1_status = 'Ready to Request M1'`,                                                              amountCol: 'm1_expected_amount' },
  'M1:pending':   { label: 'Pending Approval',     where: `m1_status = 'Pending M1 Approval'`,                                                               amountCol: 'm1_expected_amount' },
  'M1:approved':  { label: 'Approved · Not Recv',  where: `m1_status = 'M1 Approved'`,                                                                       amountCol: 'm1_expected_amount' },
  'M1:notReady':  { label: 'Not Ready',            where: `m1_status = 'Not Ready for M1'`,                                                                  amountCol: 'm1_expected_amount' },
  'M1:followUp':  { label: 'Stale Follow-Up',      where: `m1_status = 'Not Ready for M1' AND m1_last_funding_check_date IS NOT NULL AND m1_last_funding_check_date != '' AND substr(m1_last_funding_check_date,1,10) <= date('now','-3 days')`, amountCol: 'm1_expected_amount' },

  // ─── M2
  // Pending Approval is ALL M2 projects awaiting a decision — status in
  // ('Pending M2 Approval', 'Pending M2 Deposit'), submitted-not-rejected —
  // regardless of funding-check recency. The prior recency split (in-SLA
  // headline tile + a separate "Pending · Follow-Up" stale sub-callout,
  // mirroring QB reports 1033/1027's `>= today−2` gate) was merged into a
  // single Pending Approval bucket per James 2026-07-17. The status union
  // covers both 'Pending M2 Approval' and 'Pending M2 Deposit' per report
  // 1033's CT-OR filter. This matches how M2 Not Ready already behaves
  // (all statuses, no recency split).
  'M2:ready':            { label: 'Ready to Request',       where: `m2_status = 'Ready to Request M2'`,                                                                                                                                                                                                                              amountCol: 'm2_expected_amount' },
  'M2:pending':          { label: 'Pending Approval',       where: `m2_status IN ('Pending M2 Approval', 'Pending M2 Deposit')`,                                                                                                                                                                                                     amountCol: 'm2_expected_amount' },
  'M2:approved':         { label: 'Approved · Not Recv',    where: `m2_status = 'M2 Approved'`,                                                                                                                                                                                                                                      amountCol: 'm2_expected_amount' },
  'M2:notReady':         { label: 'Not Ready',              where: `m2_status = 'Not Ready for M2'`,                                                                                                                                                                                                                                 amountCol: 'm2_expected_amount' },

  // ─── M3
  'M3:ready':     { label: 'Ready to Request',     where: `m3_status = 'Ready to Request M3'`,                                                               amountCol: 'm3_expected_amount' },
  'M3:pending':   { label: 'Pending Approval',     where: `m3_status = 'Pending M3 Approval'`,                                                               amountCol: 'm3_expected_amount' },
  'M3:approved':  { label: 'Approved · Not Recv',  where: `m3_status = 'M3 Approved'`,                                                                       amountCol: 'm3_expected_amount' },
  'M3:notReady':  { label: 'Not Ready',            where: `m3_status = 'Not Ready for M3'`,                                                                  amountCol: 'm3_expected_amount' },
  'M3:followUp':  { label: 'Stale Follow-Up',      where: `m3_status = 'Not Ready for M3' AND m3_last_funding_check_date IS NOT NULL AND m3_last_funding_check_date != '' AND substr(m3_last_funding_check_date,1,10) <= date('now','-3 days')`, amountCol: 'm3_expected_amount' },

  // ─── DCA · Domestic Content Adder. Buckets here are a different
  // shape than M1/M2/M3 — Create DCA Event ≈ "ready", Pending DCA
  // Deposit ≈ "approved not received", DCA Overdue is its own
  // actionable state, Pending M3 is "waiting upstream".
  'DCA:createEvent':    { label: 'Create DCA Event',  where: `dca_status = 'Create DCA Event'`,    amountCol: 'dca_expected_amount' },
  'DCA:pendingDeposit': { label: 'Pending Deposit',   where: `dca_status = 'Pending DCA Deposit'`, amountCol: 'dca_expected_amount' },
  'DCA:overdue':        { label: 'Overdue',           where: `dca_status = 'DCA Overdue'`,         amountCol: 'dca_expected_amount' },
  'DCA:pendingM3':      { label: 'Pending M3',        where: `dca_status = 'Pending M3'`,          amountCol: 'dca_expected_amount' },

  // ─── M2 · Not M3 page · KPI tiles mirror six QB reports for the
  // post-M2 / pre-M3-funding population. SQL uses m3_status and the
  // m3_last_funding_check_date (FID 2593) recency gate. BASE_WHERE
  // still applies (Kin Home + exclusion flags); QB's M3-Ready report
  // 950 happens to omit the is_funded gate but a funded project can't
  // be in 'Ready to Request M3' anyway, so layering BASE_WHERE is a
  // no-op for that bucket and keeps the query shape consistent.
  'M2NotM3:ready':     { label: 'Ready to Request',     where: `m3_status = 'Ready to Request M3'`,                                                                                                                                                                                                                              amountCol: 'm3_expected_amount' },
  'M2NotM3:pending':   { label: 'Pending Approval',     where: `m3_status IN ('Pending M3 Approval', 'Pending M3 Deposit') AND m3_last_funding_check_date IS NOT NULL AND m3_last_funding_check_date != '' AND substr(m3_last_funding_check_date,1,10) >= date('now','-2 days')`,                                                amountCol: 'm3_expected_amount' },
  'M2NotM3:approved':  { label: 'Approved · Not Recv',  where: `m3_status = 'M3 Approved' AND m3_last_funding_check_date IS NOT NULL AND m3_last_funding_check_date != '' AND substr(m3_last_funding_check_date,1,10) >= date('now','-2 days')`,                                                                                amountCol: 'm3_expected_amount' },
  'M2NotM3:notReady':  { label: 'Not Ready',            where: `m3_status = 'Not Ready for M3' AND m3_last_funding_check_date IS NOT NULL AND m3_last_funding_check_date != '' AND substr(m3_last_funding_check_date,1,10) >= date('now','-2 days')`,                                                                            amountCol: 'm3_expected_amount' },
  'M2NotM3:followUp':  { label: 'Stale Follow-Up',      where: `m3_status = 'Not Ready for M3' AND m3_last_funding_check_date IS NOT NULL AND m3_last_funding_check_date != '' AND substr(m3_last_funding_check_date,1,10) <= date('now','-3 days')`,                                                                            amountCol: 'm3_expected_amount' },
  'M2NotM3:rejected':  { label: 'Rejected',             where: `m3_status = 'M3 Rejected' AND m3_last_funding_check_date IS NOT NULL AND m3_last_funding_check_date != '' AND substr(m3_last_funding_check_date,1,10) >= date('now','-2 days')`,                                                                                 amountCol: 'm3_expected_amount' },
}

const M2NOTM3_BUCKET_ORDER = ['M2NotM3:ready', 'M2NotM3:pending', 'M2NotM3:approved', 'M2NotM3:notReady', 'M2NotM3:followUp', 'M2NotM3:rejected'] as const

// Bucket key order per milestone — drives which KPIs render and in what
// order. Follow-up is intentionally last (it's a sub-callout of Not Ready).
const BUCKET_ORDER: Record<Milestone, string[]> = {
  M1:  ['M1:ready', 'M1:pending', 'M1:approved', 'M1:notReady'],
  M2:  ['M2:ready', 'M2:pending', 'M2:approved', 'M2:notReady'],
  M3:  ['M3:ready', 'M3:pending', 'M3:approved', 'M3:notReady'],
  DCA: ['DCA:createEvent', 'DCA:pendingDeposit', 'DCA:overdue', 'DCA:pendingM3'],
}

// Dashboard-scope filters layered onto BASE_WHERE for every funding
// query. Equality on `state`/`closer`/`lender`; null/empty values are
// ignored so an unset filter is a no-op. Lender uses the same
// '— Unassigned' bucket the lender pivot uses so the chip choice maps
// 1:1 to the lender row.
interface DashFilters { state?: string; closer?: string; lender?: string; status?: string }
function filterClauses(f: DashFilters): { sql: string; params: string[] } {
  const parts: string[] = []
  const params: string[] = []
  if (f.state)  { parts.push(`state = ?`);  params.push(f.state) }
  if (f.closer) { parts.push(`closer = ?`); params.push(f.closer) }
  if (f.status) { parts.push(`status = ?`); params.push(f.status) }
  if (f.lender) {
    if (f.lender === '— Unassigned') parts.push(`(lender IS NULL OR lender = '')`)
    else { parts.push(`lender = ?`); params.push(f.lender) }
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params }
}
function parseFilters(req: Request): DashFilters {
  const pick = (k: string) => {
    const v = req.query[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  return { state: pick('state'), closer: pick('closer'), lender: pick('lender'), status: pick('status') }
}

function bucketSummary(key: string, filters: DashFilters = {}): { count: number; expectedAmount: number } {
  const def = BUCKETS[key]
  if (!def) return { count: 0, expectedAmount: 0 }
  const fc = filterClauses(filters)
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(${def.amountCol}), 0) AS expected
    FROM project_cache ${BASE_WHERE} AND ${def.where}${fc.sql}
  `).get(...fc.params) as { count: number; expected: number }
  return { count: row.count, expectedAmount: row.expected }
}

function lenderBreakdown(milestone: Milestone, filters: DashFilters = {}) {
  const fc = filterClauses(filters)
  if (milestone === 'DCA') {
    // DCA uses different statuses; pivot over the four actionable ones.
    const inList = ['Create DCA Event', 'Pending DCA Deposit', 'DCA Overdue', 'Pending M3']
    const placeholders = inList.map(() => '?').join(',')
    return db.prepare(`
      SELECT
        COALESCE(NULLIF(lender, ''), '— Unassigned') AS lender,
        dca_status AS status,
        COUNT(*) AS count,
        COALESCE(SUM(dca_expected_amount), 0) AS expectedAmount
      FROM project_cache ${BASE_WHERE} AND dca_status IN (${placeholders})${fc.sql}
      GROUP BY lender, dca_status
      ORDER BY lender ASC, dca_status ASC
    `).all(...inList, ...fc.params) as Array<{ lender: string; status: string; count: number; expectedAmount: number }>
  }
  const prefix = NUMERIC_PREFIX[milestone]
  const inList = [
    `Ready to Request ${milestone}`,
    `Pending ${milestone} Approval`,
    `Pending ${milestone} Deposit`,
    `${milestone} Approved`,
    `Not Ready for ${milestone}`,
  ]
  const placeholders = inList.map(() => '?').join(',')
  return db.prepare(`
    SELECT
      COALESCE(NULLIF(lender, ''), '— Unassigned') AS lender,
      ${prefix}_status AS status,
      COUNT(*) AS count,
      COALESCE(SUM(${prefix}_expected_amount), 0) AS expectedAmount
    FROM project_cache ${BASE_WHERE} AND ${prefix}_status IN (${placeholders})${fc.sql}
    GROUP BY lender, ${prefix}_status
    ORDER BY lender ASC, ${prefix}_status ASC
  `).all(...inList, ...fc.params) as Array<{ lender: string; status: string; count: number; expectedAmount: number }>
}

// ───────────────────────────────────────────────────────────────────
// M1 · Not M2 standalone audit — kept for the dedicated report page.
// ───────────────────────────────────────────────────────────────────
router.get('/m1-not-m2', (req: Request, res: Response): void => {
  const filters: Filters = {
    state: (req.query['state'] as string) || undefined,
    closer: (req.query['closer'] as string) || undefined,
    lender: (req.query['lender'] as string) || undefined,
    epc: (req.query['epc'] as string) || undefined,
  }
  try {
    res.set('Cache-Control', 'no-store')
    res.json(buildM1NotM2(filters))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ───────────────────────────────────────────────────────────────────
// Funding overview — KPI counts for every milestone + lender pivot
// for the active one. Mirrors the QB Funding Dashboard gauges.
// ───────────────────────────────────────────────────────────────────
router.get('/overview', (req: Request, res: Response): void => {
  const activeRaw = String(req.query['milestone'] || 'M2').toUpperCase()
  const milestone = (['M1', 'M2', 'M3', 'DCA'] as const).find(m => m === activeRaw) || 'M2'
  const filters = parseFilters(req)
  try {
    const milestones: Record<Milestone, { buckets: Record<string, { count: number; expectedAmount: number; label: string }>; followUp?: { count: number; expectedAmount: number } }> = {
      M1: { buckets: {}, followUp: bucketSummary('M1:followUp', filters) },
      M2: { buckets: {} },
      M3: { buckets: {}, followUp: bucketSummary('M3:followUp', filters) },
      DCA: { buckets: {} },
    }
    for (const m of ['M1', 'M2', 'M3', 'DCA'] as const) {
      for (const key of BUCKET_ORDER[m]) {
        const s = bucketSummary(key, filters)
        milestones[m].buckets[key] = { ...s, label: BUCKETS[key]!.label }
      }
    }
    res.json({
      asOf: officeTodayIso(),
      activeMilestone: milestone,
      milestones,
      byLender: lenderBreakdown(milestone, filters),
      appliedFilters: filters,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// M2 · Not M3 overview — six KPI tiles mirroring QB reports 950 /
// 1036 / 1039 / 1034 / 1035 / 1040, plus a flat row list for the
// unified table below the tiles. The table holds every project sitting
// in any actionable M3 state (union of the six bucket statuses) so
// users have one sortable view; per-bucket drill-through lives on the
// Funding Dashboard.
router.get('/m2-not-m3', (req: Request, res: Response): void => {
  const filters = parseFilters(req)
  const fc = filterClauses(filters)
  try {
    const buckets: Record<string, { count: number; expectedAmount: number; label: string }> = {}
    for (const key of M2NOTM3_BUCKET_ORDER) {
      const s = bucketSummary(key, filters)
      buckets[key] = { ...s, label: BUCKETS[key]!.label }
    }
    const ACTIONABLE_M3 = [
      'Ready to Request M3', 'Pending M3 Approval', 'Pending M3 Deposit',
      'M3 Approved', 'Not Ready for M3', 'M3 Rejected',
    ]
    const placeholders = ACTIONABLE_M3.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT
        record_id AS recordId,
        customer_name AS customerName,
        COALESCE(state, '')  AS state,
        COALESCE(status, '') AS status,
        COALESCE(lender, '') AS lender,
        COALESCE(closer, '') AS closer,
        COALESCE(sales_date, '') AS salesDate,
        COALESCE(m3_status, '')         AS m3Status,
        COALESCE(m3_not_ready_note, '') AS m3NotReadyNote,
        COALESCE(m3_funding_note, '')   AS m3FundingNote,
        COALESCE(m3_expected_amount, 0) AS m3ExpectedAmount,
        COALESCE(m3_net_received, 0)    AS m3NetReceived,
        COALESCE(m3_requested_date, '') AS m3RequestedDate,
        COALESCE(m3_approved_date, '')  AS m3ApprovedDate,
        COALESCE(m3_rejected_date, '')  AS m3RejectedDate,
        COALESCE(m3_deposit_date, '')   AS m3DepositDate,
        COALESCE(m3_last_funding_check_date, '') AS m3LastFundingCheckDate,
        COALESCE(m2_status, '')         AS m2Status,
        COALESCE(m2_requested_date, '') AS m2RequestedDate,
        COALESCE(m2_approved_date, '')  AS m2ApprovedDate,
        COALESCE(m2_rejected_date, '')  AS m2RejectedDate,
        COALESCE(m2_deposit_date, '')   AS m2DepositDate,
        COALESCE(m2_net_received, 0)    AS m2NetReceived,
        COALESCE(system_price, 0)       AS systemPrice,
        COALESCE(system_size_kw, 0)     AS systemSizeKw
      FROM project_cache ${BASE_WHERE}
        AND m3_status IN (${placeholders})${fc.sql}
      ORDER BY COALESCE(m2_deposit_date, m2_approved_date, m2_requested_date, '') DESC
      LIMIT 5000
    `).all(...ACTIONABLE_M3, ...fc.params)
    res.json({
      asOf: officeTodayIso(),
      buckets,
      rows,
      appliedFilters: filters,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Distinct values for the filter chip strip — scoped to the same
// BASE_WHERE so options never include archived/excluded/funded rows
// the user can't see in any KPI anyway.
router.get('/filter-options', (_req: Request, res: Response): void => {
  try {
    const states  = db.prepare(`SELECT DISTINCT state  AS v FROM project_cache ${BASE_WHERE} AND state  IS NOT NULL AND state  != '' ORDER BY state  ASC`).all() as Array<{ v: string }>
    const closers = db.prepare(`SELECT DISTINCT closer AS v FROM project_cache ${BASE_WHERE} AND closer IS NOT NULL AND closer != '' ORDER BY closer ASC`).all() as Array<{ v: string }>
    const lenders = db.prepare(`
      SELECT DISTINCT COALESCE(NULLIF(lender, ''), '— Unassigned') AS v
      FROM project_cache ${BASE_WHERE}
      ORDER BY v ASC
    `).all() as Array<{ v: string }>
    // Project statuses ordered by population size — the useful ones
    // (Active, holds) surface first in the dropdown (feedback #22).
    const statuses = db.prepare(`
      SELECT status AS v, COUNT(*) AS n FROM project_cache ${BASE_WHERE} AND status IS NOT NULL AND status != ''
      GROUP BY status ORDER BY n DESC
    `).all() as Array<{ v: string }>
    res.json({
      states:  states.map(r => r.v),
      closers: closers.map(r => r.v),
      lenders: lenders.map(r => r.v),
      statuses: statuses.map(r => r.v),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ───────────────────────────────────────────────────────────────────
// Audit drill — projects in a given (milestone, bucket). Same row
// shape across milestones so the client can render one table.
// ───────────────────────────────────────────────────────────────────
router.get('/audit', (req: Request, res: Response): void => {
  const bucketKey = String(req.query['bucket'] || '')
  const def = BUCKETS[bucketKey]
  if (!def) { res.status(400).json({ error: 'invalid bucket' }); return }
  const isDca = bucketKey.startsWith('DCA:')
  const isM2NotM3 = bucketKey.startsWith('M2NotM3:')
  // M2 · Not M3 buckets sit on M3 statuses but the view wants M2 dates
  // alongside, so we set the primary milestone to M3 and unconditionally
  // attach m2* fields below.
  const milestonePrefix = isDca ? 'dca'
    : isM2NotM3 ? 'm3'
    : (bucketKey.startsWith('M1:') ? 'm1' : bucketKey.startsWith('M3:') ? 'm3' : 'm2')
  const filters = parseFilters(req)
  const fc = filterClauses(filters)
  // Opt-in extra columns — drives the M2 → M3 Progress view's "is M3
  // submitted/approved/rejected" columns without bloating the default
  // audit response.
  const includeM3 = String(req.query['include'] || '') === 'm3' && !isDca

  try {
    // DCA fields don't share the requested/approved/rejected/deposit
    // shape — substitute the four DCA dates and net columns.
    const milestoneSelects = isDca
      ? `
          dca_status AS milestoneStatus,
          COALESCE(dca_timer_start, '') AS milestoneRequestedDate,
          '' AS milestoneApprovedDate,
          '' AS milestoneRejectedDate,
          COALESCE(dca_actual_deposit, '') AS milestoneDepositDate,
          COALESCE(dca_expected_amount, 0) AS milestoneExpectedAmount,
          COALESCE(dca_total_received, 0) AS milestoneNetReceived,
          '' AS milestoneNotReadyNote,
          '' AS milestoneFundingNote
      `
      : `
          ${milestonePrefix}_status AS milestoneStatus,
          COALESCE(${milestonePrefix}_requested_date, '') AS milestoneRequestedDate,
          COALESCE(${milestonePrefix}_approved_date, '')  AS milestoneApprovedDate,
          COALESCE(${milestonePrefix}_rejected_date, '')  AS milestoneRejectedDate,
          COALESCE(${milestonePrefix}_deposit_date, '')   AS milestoneDepositDate,
          COALESCE(${milestonePrefix}_expected_amount, 0) AS milestoneExpectedAmount,
          COALESCE(${milestonePrefix}_net_received, 0)    AS milestoneNetReceived,
          COALESCE(${milestonePrefix}_not_ready_note, '') AS milestoneNotReadyNote,
          COALESCE(${milestonePrefix}_funding_note, '')   AS milestoneFundingNote
      `
    const m3Selects = includeM3
      ? `,
          COALESCE(m3_status, '')         AS m3Status,
          COALESCE(m3_requested_date, '') AS m3SubmittedDate,
          COALESCE(m3_approved_date, '')  AS m3ApprovedDate,
          COALESCE(m3_rejected_date, '')  AS m3RejectedDate,
          COALESCE(m3_deposit_date, '')   AS m3DepositDate`
      : ''
    // M2 supplemental fields when drilling M2-Not-M3 buckets — the
    // page shows the M2 date (deposit > approved > requested) and
    // "days since M2" alongside the M3 progress columns.
    const m2Selects = isM2NotM3
      ? `,
          COALESCE(m2_status, '')         AS m2Status,
          COALESCE(m2_requested_date, '') AS m2RequestedDate,
          COALESCE(m2_approved_date, '')  AS m2ApprovedDate,
          COALESCE(m2_rejected_date, '')  AS m2RejectedDate,
          COALESCE(m2_deposit_date, '')   AS m2DepositDate,
          COALESCE(m2_net_received, 0)    AS m2NetReceived`
      : ''

    const sql = `SELECT
        record_id AS recordId,
        customer_name AS customerName,
        COALESCE(state, '') AS state,
        COALESCE(status, '') AS status,
        COALESCE(lender, '') AS lender,
        COALESCE(sales_date, '') AS salesDate,
        COALESCE(install_scheduled, '') AS installScheduled,
        COALESCE(install_completed, '') AS installCompleted,
        ${milestoneSelects},
        COALESCE(system_price, 0) AS systemPrice,
        COALESCE(system_size_kw, 0) AS systemSizeKw${m3Selects}${m2Selects}
      FROM project_cache ${BASE_WHERE} AND ${def.where}${fc.sql}
      ORDER BY install_completed ASC
      LIMIT 5000`
    const rows = db.prepare(sql).all(...fc.params) as Array<Record<string, unknown>>
    // Attach the human "reason why" (server-side so every client renders
    // the same cleaned text) — sourced from the milestone's MAX funding
    // event in funding_events_cache, falling back to the project-level
    // note columns already selected.
    if (!isDca) {
      const msLabel = milestonePrefix.toUpperCase()   // 'M1' | 'M2' | 'M3'
      const evStmt = db.prepare(`
        SELECT not_ready_note, not_ready_note_list, funding_note_list
          FROM funding_events_cache
         WHERE project_rid = ? AND milestone = ? AND is_max = 1
         ORDER BY event_rid DESC LIMIT 1
      `)
      // Open funding-related ticket on the project — often the richest
      // blocker context ("Mindi assigned a ticket…" points here). Newest
      // first; its recent note usually IS the reason.
      const ticketStmt = db.prepare(`
        SELECT record_id, issue, status, recent_note, description
          FROM ticket_cache
         WHERE project_rid = ?
           AND status NOT IN ('Complete', 'Completed', 'Closed', 'Cancelled')
           AND (lower(category) = 'funding' OR lower(issue || ' ' || title) LIKE '%funding%')
         ORDER BY date_modified DESC LIMIT 1
      `)
      for (const r of rows) {
        const rid = String(r['recordId'])
        const ev = evStmt.get(rid, msLabel) as { not_ready_note: string | null; not_ready_note_list: string | null; funding_note_list: string | null } | undefined
        const tk = ticketStmt.get(Number(rid)) as { record_id: number; issue: string | null; status: string | null; recent_note: string | null; description: string | null } | undefined
        r['milestoneReason'] = pickFundingReason(
          String(r['milestoneNotReadyNote'] ?? ''),
          tk?.recent_note ?? '',
          tk?.description ?? '',
          ev?.not_ready_note ?? '',
          ev?.not_ready_note_list ?? '',
          ev?.funding_note_list ?? '',
          String(r['milestoneFundingNote'] ?? ''),
        )
        if (tk) r['milestoneTicket'] = { recordId: tk.record_id, issue: tk.issue || 'Funding ticket', status: tk.status || '' }
      }
    }
    res.json({ bucket: bucketKey, label: def.label, count: rows.length, rows, appliedFilters: filters })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// The funding-note rollups mix real blocker reasons with workflow log
// lines ("Mindi assigned a ticket to Mindi", "adding Dylan") and
// boilerplate headers ("Unable to Request Funding"). Walk the candidate
// sources in priority order, strip [MMM-DD-YY 1:23 PM Actor] stamps, drop
// the noise lines, and return the first line that reads like a reason.
const NOISE_LINE_RX = [
  /assigned a ticket/i,
  /^unable to request funding\.?$/i,
  /^adding\s+\S+$/i,
  /^ticket (created|completed|closed)/i,
]
const STAMP_PREFIX_RX = /^\[[^\]]*\]\s*/
export function pickFundingReason(...sources: string[]): string {
  for (const src of sources) {
    if (!src || !src.trim()) continue
    const lines = src.split('\n')
      .map(l => l.replace(STAMP_PREFIX_RX, '').trim())
      .filter(l => l && !NOISE_LINE_RX.some(rx => rx.test(l)))
    if (lines.length) return lines[0]!.slice(0, 160)
  }
  return ''
}

export { router as fundingRouter }
