import { Router, type Request, type Response } from 'express'
import db from '../db'
import { buildM1NotM2, type Filters } from './reports'

const router = Router()

// ───────────────────────────────────────────────────────────────────
// Common baseline: Kin Home, not a test row, not yet fully funded.
// All funding queries layer their milestone-specific filter on top.
// ───────────────────────────────────────────────────────────────────
const BASE_WHERE = `
  WHERE epc = 'Kin Home'
    AND (test_project IS NULL OR test_project = 0)
    AND (is_funded IS NULL OR is_funded != 1)
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
  'M1:followUp':  { label: 'Stale Follow-Up',      where: `m1_status = 'Not Ready for M1' AND (qb_modified_at IS NULL OR substr(qb_modified_at,1,10) < date('now','-3 days'))`, amountCol: 'm1_expected_amount' },

  // ─── M2
  'M2:ready':     { label: 'Ready to Request',     where: `m2_status = 'Ready to Request M2'`,                                                               amountCol: 'm2_expected_amount' },
  'M2:pending':   { label: 'Pending Approval',     where: `m2_status = 'Pending M2 Approval'`,                                                               amountCol: 'm2_expected_amount' },
  'M2:approved':  { label: 'Approved · Not Recv',  where: `m2_status = 'M2 Approved'`,                                                                       amountCol: 'm2_expected_amount' },
  'M2:notReady':  { label: 'Not Ready',            where: `m2_status = 'Not Ready for M2'`,                                                                  amountCol: 'm2_expected_amount' },
  'M2:followUp':  { label: 'Stale Follow-Up',      where: `m2_status = 'Not Ready for M2' AND (qb_modified_at IS NULL OR substr(qb_modified_at,1,10) < date('now','-3 days'))`, amountCol: 'm2_expected_amount' },

  // ─── M3
  'M3:ready':     { label: 'Ready to Request',     where: `m3_status = 'Ready to Request M3'`,                                                               amountCol: 'm3_expected_amount' },
  'M3:pending':   { label: 'Pending Approval',     where: `m3_status = 'Pending M3 Approval'`,                                                               amountCol: 'm3_expected_amount' },
  'M3:approved':  { label: 'Approved · Not Recv',  where: `m3_status = 'M3 Approved'`,                                                                       amountCol: 'm3_expected_amount' },
  'M3:notReady':  { label: 'Not Ready',            where: `m3_status = 'Not Ready for M3'`,                                                                  amountCol: 'm3_expected_amount' },
  'M3:followUp':  { label: 'Stale Follow-Up',      where: `m3_status = 'Not Ready for M3' AND (qb_modified_at IS NULL OR substr(qb_modified_at,1,10) < date('now','-3 days'))`, amountCol: 'm3_expected_amount' },

  // ─── DCA · Domestic Content Adder. Buckets here are a different
  // shape than M1/M2/M3 — Create DCA Event ≈ "ready", Pending DCA
  // Deposit ≈ "approved not received", DCA Overdue is its own
  // actionable state, Pending M3 is "waiting upstream".
  'DCA:createEvent':    { label: 'Create DCA Event',  where: `dca_status = 'Create DCA Event'`,    amountCol: 'dca_expected_amount' },
  'DCA:pendingDeposit': { label: 'Pending Deposit',   where: `dca_status = 'Pending DCA Deposit'`, amountCol: 'dca_expected_amount' },
  'DCA:overdue':        { label: 'Overdue',           where: `dca_status = 'DCA Overdue'`,         amountCol: 'dca_expected_amount' },
  'DCA:pendingM3':      { label: 'Pending M3',        where: `dca_status = 'Pending M3'`,          amountCol: 'dca_expected_amount' },
}

// Bucket key order per milestone — drives which KPIs render and in what
// order. Follow-up is intentionally last (it's a sub-callout of Not Ready).
const BUCKET_ORDER: Record<Milestone, string[]> = {
  M1:  ['M1:ready', 'M1:pending', 'M1:approved', 'M1:notReady'],
  M2:  ['M2:ready', 'M2:pending', 'M2:approved', 'M2:notReady'],
  M3:  ['M3:ready', 'M3:pending', 'M3:approved', 'M3:notReady'],
  DCA: ['DCA:createEvent', 'DCA:pendingDeposit', 'DCA:overdue', 'DCA:pendingM3'],
}

function bucketSummary(key: string): { count: number; expectedAmount: number } {
  const def = BUCKETS[key]
  if (!def) return { count: 0, expectedAmount: 0 }
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(${def.amountCol}), 0) AS expected
    FROM project_cache ${BASE_WHERE} AND ${def.where}
  `).get() as { count: number; expected: number }
  return { count: row.count, expectedAmount: row.expected }
}

function lenderBreakdown(milestone: Milestone) {
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
      FROM project_cache ${BASE_WHERE} AND dca_status IN (${placeholders})
      GROUP BY lender, dca_status
      ORDER BY lender ASC, dca_status ASC
    `).all(...inList) as Array<{ lender: string; status: string; count: number; expectedAmount: number }>
  }
  const prefix = NUMERIC_PREFIX[milestone]
  const inList = [
    `Ready to Request ${milestone}`,
    `Pending ${milestone} Approval`,
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
    FROM project_cache ${BASE_WHERE} AND ${prefix}_status IN (${placeholders})
    GROUP BY lender, ${prefix}_status
    ORDER BY lender ASC, ${prefix}_status ASC
  `).all(...inList) as Array<{ lender: string; status: string; count: number; expectedAmount: number }>
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
  try {
    const milestones: Record<Milestone, { buckets: Record<string, { count: number; expectedAmount: number; label: string }>; followUp?: { count: number; expectedAmount: number } }> = {
      M1: { buckets: {}, followUp: bucketSummary('M1:followUp') },
      M2: { buckets: {}, followUp: bucketSummary('M2:followUp') },
      M3: { buckets: {}, followUp: bucketSummary('M3:followUp') },
      DCA: { buckets: {} },
    }
    for (const m of ['M1', 'M2', 'M3', 'DCA'] as const) {
      for (const key of BUCKET_ORDER[m]) {
        const s = bucketSummary(key)
        milestones[m].buckets[key] = { ...s, label: BUCKETS[key]!.label }
      }
    }
    res.json({
      asOf: new Date().toISOString().slice(0, 10),
      activeMilestone: milestone,
      milestones,
      byLender: lenderBreakdown(milestone),
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
  const milestonePrefix = isDca ? 'dca' : (bucketKey.startsWith('M1:') ? 'm1' : bucketKey.startsWith('M3:') ? 'm3' : 'm2')

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
          COALESCE(dca_total_received, 0) AS milestoneNetReceived
      `
      : `
          ${milestonePrefix}_status AS milestoneStatus,
          COALESCE(${milestonePrefix}_requested_date, '') AS milestoneRequestedDate,
          COALESCE(${milestonePrefix}_approved_date, '')  AS milestoneApprovedDate,
          COALESCE(${milestonePrefix}_rejected_date, '')  AS milestoneRejectedDate,
          COALESCE(${milestonePrefix}_deposit_date, '')   AS milestoneDepositDate,
          COALESCE(${milestonePrefix}_expected_amount, 0) AS milestoneExpectedAmount,
          COALESCE(${milestonePrefix}_net_received, 0)    AS milestoneNetReceived
      `

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
        COALESCE(system_size_kw, 0) AS systemSizeKw
      FROM project_cache ${BASE_WHERE} AND ${def.where}
      ORDER BY install_completed ASC
      LIMIT 5000`
    const rows = db.prepare(sql).all()
    res.json({ bucket: bucketKey, label: def.label, count: rows.length, rows })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

export { router as fundingRouter }
