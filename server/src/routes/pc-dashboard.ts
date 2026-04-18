import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return { realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com', token: process.env['QB_USER_TOKEN'] || '' }
}

// ── Outreach cache table ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    touchpoint_name TEXT,
    customer_name TEXT,
    project_status TEXT,
    project_state TEXT,
    project_lender TEXT,
    preferred_outreach TEXT,
    due_date TEXT,
    update_outreach TEXT,
    project_coordinator TEXT,
    coordinator_user TEXT,
    outreach_completed_date TEXT,
    display_order REAL,
    outreach_status TEXT,
    attempts INTEGER DEFAULT 0,
    is_unresponsive TEXT,
    preferred_comms TEXT,
    note TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_touchpoint ON outreach_cache(touchpoint_name)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_coordinator ON outreach_cache(coordinator_user)`)

// ── Completed outreach cache (for analytics) ────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_completed_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    touchpoint_name TEXT,
    customer_name TEXT,
    project_coordinator TEXT,
    outreach_completed_date TEXT,
    due_date TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_oc_touchpoint ON outreach_completed_cache(touchpoint_name)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_oc_coordinator ON outreach_completed_cache(project_coordinator)`)

const OUTREACH_TABLE = 'btvik5kwi'

// Field IDs from actual QB reports
const fMap: Array<{ fid: number; col: string }> = [
  { fid: 3, col: 'record_id' },
  { fid: 10, col: 'project_rid' },
  { fid: 6, col: 'touchpoint_name' },
  { fid: 11, col: 'customer_name' },       // Full Name
  { fid: 56, col: 'project_status' },
  { fid: 63, col: 'project_state' },
  { fid: 65, col: 'project_lender' },
  { fid: 87, col: 'preferred_outreach' },
  { fid: 20, col: 'due_date' },            // Dashboard Visibility Function
  { fid: 33, col: 'update_outreach' },      // Rich-text link
  { fid: 17, col: 'project_coordinator' },
  { fid: 94, col: 'coordinator_user' },     // User field for personal filter
  { fid: 18, col: 'outreach_completed_date' },
  { fid: 36, col: 'display_order' },
  { fid: 43, col: 'outreach_status' },
  { fid: 44, col: 'attempts' },
  { fid: 77, col: 'is_unresponsive' },      // "Project - Is Unresponsive?"
  { fid: 51, col: 'preferred_comms' },       // Welcome Call Preferred Communications
  { fid: 8, col: 'note' },
]

// Status exclusion formula from QB report -1:
// Exclude: ARC, ROR, Cancelled, Rejected, Pending Cancel, Pending KCA, Complete, Completed
// Exception: Rep Cancel touchpoints are always included
const EXCLUDED_STATUSES = ['ARC', 'ROR', 'Cancelled', 'Rejected', 'Pending Cancel', 'Pending KCA', 'Complete', 'Completed']

function passesStatusExclusion(touchpoint: string, projectStatus: string): boolean {
  if (touchpoint.includes('Rep Cancel') || touchpoint.includes('Cancel Reactivation')) return true
  return !EXCLUDED_STATUSES.some(s => projectStatus === s)
}

function val(r: Record<string, { value: unknown }>, fid: number): string {
  const v = r[String(fid)]?.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if ('name' in (v as Record<string, unknown>)) return String((v as { name: string }).name)
    if ('email' in (v as Record<string, unknown>)) return String((v as { email: string }).email)
  }
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

// ── Refresh cache ────────────────────────────────────────

async function refreshOutreachCache(): Promise<{ total: number; duration: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()

  // Fetch non-completed outreach with due date populated (matches report 64 base filter)
  // {'18'.EX.''} AND {'20'.XEX.''}
  let allRecords: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: OUTREACH_TABLE,
        select: fMap.map(f => f.fid),
        where: "{'18'.EX.''}AND{'20'.XEX.''}AND{'20'.OAF.'2024-01-01'}",
        sortBy: [{ fieldId: 36, order: 'ASC' }, { fieldId: 6, order: 'ASC' }],
        options: { skip, top: batchSize },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`QB outreach query failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    const records = data.data || []
    allRecords = allRecords.concat(records)
    if (records.length < batchSize) break
    skip += batchSize
  }

  db.prepare('DELETE FROM outreach_cache').run()

  const cols = fMap.map(f => f.col).join(', ')
  const placeholders = fMap.map(() => '?').join(', ')
  const insert = db.prepare(
    `INSERT OR REPLACE INTO outreach_cache (${cols}, cached_at) VALUES (${placeholders}, datetime('now'))`
  )

  db.transaction(() => {
    for (const record of allRecords) {
      const values = fMap.map(f => {
        if (f.col === 'attempts' || f.col === 'display_order') return parseFloat(val(record, f.fid)) || 0
        return val(record, f.fid)
      })
      insert.run(...values)
    }
  })()

  return { total: allRecords.length, duration: Date.now() - start }
}

// ── API Routes ───────────────────────────────────────────

router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await refreshOutreachCache()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Touchpoint stage order (matches QB KPI report layout)
// Ordered by project milestone lifecycle
const STAGE_ORDER = [
  'Initial Outreach', 'Check-In', 'Design Approval',
  'Permit Submitted', 'Permit Received',
  'Install Complete',
  'Inspection Scheduled', 'Inspection Complete',
  'PTO Approval',
  'Cancel Reactivation', 'Rep Cancel Request',
]

// Dashboard data
router.get('/', (req: Request, res: Response): void => {
  const coordinator = req.query['coordinator'] as string | undefined
  const state = req.query['state'] as string | undefined
  const lender = req.query['lender'] as string | undefined
  const today = new Date().toISOString().split('T')[0]!

  // Get all non-completed outreach where due_date <= today
  let allRows = db.prepare(
    `SELECT * FROM outreach_cache WHERE due_date <= ? ORDER BY display_order ASC, due_date ASC`
  ).all(today) as Array<Record<string, unknown>>

  // Apply status exclusion formula (matches QB formula field -1)
  allRows = allRows.filter(r =>
    passesStatusExclusion(String(r.touchpoint_name || ''), String(r.project_status || ''))
  )

  // Split into main list vs unresponsive
  // Report logic: main list shows non-unresponsive (PLUS Rep Cancel unresponsive)
  // Unresponsive panel shows unresponsive records (excluding ARC/ROR/Cancelled/Rejected/Pending Cancel/Sales Aid)
  const isUnresponsive = (r: Record<string, unknown>) => String(r.is_unresponsive || '').includes('Unresponsive')
  const UNRESPONSIVE_EXCLUDED = ['ARC', 'ROR', 'Cancelled', 'Rejected', 'Pending Cancel', 'Sales Aid']

  let mainRows = allRows.filter(r => {
    if (isUnresponsive(r)) {
      // Unresponsive records only show in main list if touchpoint is Rep Cancel Request
      return String(r.touchpoint_name) === 'Rep Cancel Request'
    }
    return true
  })

  const unresponsiveRows = allRows.filter(r =>
    isUnresponsive(r) && !UNRESPONSIVE_EXCLUDED.some(s => String(r.project_status) === s)
  )

  // Apply user filters
  if (coordinator) {
    mainRows = mainRows.filter(r => String(r.project_coordinator || '') === coordinator)
  }
  if (state) mainRows = mainRows.filter(r => String(r.project_state) === state)
  if (lender) mainRows = mainRows.filter(r => String(r.project_lender) === lender)

  // KPI counts per stage
  const kpi: Record<string, number> = {}
  for (const s of STAGE_ORDER) kpi[s] = 0
  for (const r of mainRows) {
    const tp = String(r.touchpoint_name)
    if (kpi[tp] !== undefined) kpi[tp]++
    else kpi[tp] = 1
  }

  // Group records by touchpoint
  const groups: Record<string, Array<Record<string, unknown>>> = {}
  for (const s of STAGE_ORDER) groups[s] = []
  for (const r of mainRows) {
    const tp = String(r.touchpoint_name)
    if (!groups[tp]) groups[tp] = []
    groups[tp].push(r)
  }

  // Blocked NEM from project_cache
  const blockedNemWhere = coordinator
    ? `AND pc.coordinator = ?`
    : ''
  const blockedNem = db.prepare(
    `SELECT pc.record_id, pc.customer_name, pc.coordinator, pc.state, pc.nem_submitted, pc.nem_approved,
            pc.nem_rejected, pc.status
     FROM project_cache pc
     WHERE pc.nem_submitted != '' AND pc.nem_submitted IS NOT NULL
       AND (pc.nem_approved = '' OR pc.nem_approved IS NULL)
       AND (pc.nem_rejected = '' OR pc.nem_rejected IS NULL)
       ${blockedNemWhere}
     ORDER BY pc.nem_submitted ASC`
  ).all(...(coordinator ? [coordinator] : [])) as Array<Record<string, unknown>>

  // Filter options
  const coordRows = db.prepare(`SELECT DISTINCT project_coordinator AS v FROM outreach_cache WHERE project_coordinator != '' ORDER BY v`).all() as Array<{ v: string }>
  const stateRows = db.prepare(`SELECT DISTINCT project_state AS v FROM outreach_cache WHERE project_state != '' ORDER BY v`).all() as Array<{ v: string }>
  const lenderRows = db.prepare(`SELECT DISTINCT project_lender AS v FROM outreach_cache WHERE project_lender != '' ORDER BY v`).all() as Array<{ v: string }>

  const cacheRow = db.prepare('SELECT COUNT(*) AS total, MAX(cached_at) AS last_refresh FROM outreach_cache').get() as { total: number; last_refresh: string }

  res.json({
    kpi,
    groups,
    exceptions: {
      unresponsive: coordinator
        ? unresponsiveRows.filter(r => String(r.project_coordinator || '') === coordinator)
        : unresponsiveRows,
      blockedNem,
    },
    filters: {
      coordinators: coordRows.map(r => r.v),
      states: stateRows.map(r => r.v),
      lenders: lenderRows.map(r => r.v),
    },
    cache: cacheRow,
    stageOrder: STAGE_ORDER,
  })
})

// ── Analytics: completed outreach for performance metrics ──

async function refreshCompletedCache(): Promise<{ total: number; duration: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()

  // Fetch completed outreach for Initial Outreach + Design Approval from last 6 months
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const analyticsFields = [3, 10, 6, 11, 17, 18, 20]

  let allRecords: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: OUTREACH_TABLE,
        select: analyticsFields,
        where: `{'18'.XEX.''}AND{'18'.OAF.'${sixMonthsAgo}'}`,
        sortBy: [{ fieldId: 18, order: 'DESC' }],
        options: { skip, top: batchSize },
      }),
    })

    if (!res.ok) break
    const data = await res.json()
    const records = data.data || []
    allRecords = allRecords.concat(records)
    if (records.length < batchSize) break
    skip += batchSize
  }

  db.prepare('DELETE FROM outreach_completed_cache').run()
  const insert = db.prepare(
    `INSERT OR REPLACE INTO outreach_completed_cache (record_id, project_rid, touchpoint_name, customer_name, project_coordinator, outreach_completed_date, due_date, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  )

  db.transaction(() => {
    for (const r of allRecords) {
      insert.run(
        parseInt(val(r, 3)) || 0,
        parseInt(val(r, 10)) || 0,
        val(r, 6),
        val(r, 11),
        val(r, 17),
        val(r, 18),
        val(r, 20),
      )
    }
  })()

  return { total: allRecords.length, duration: Date.now() - start }
}

router.post('/refresh-analytics', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await refreshCompletedCache()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Touchpoint → project milestone field mapping for time-to-event calculation
const TOUCHPOINT_MILESTONE: Record<string, string> = {
  'Initial Outreach': 'sales_date',
  'Design Approval': 'design_completed',
  'Permit Submitted': 'permit_submitted',
  'Permit Received': 'permit_approved',
  'Install Complete': 'install_completed',
  'Inspection Scheduled': 'inspection_scheduled',
  'Inspection Complete': 'inspection_passed',
  'PTO Approval': 'pto_submitted',
  'Check-In': 'sales_date',
}

router.get('/analytics', (req: Request, res: Response): void => {
  const coordinator = req.query['coordinator'] as string | undefined
  const touchpoint = req.query['touchpoint'] as string || 'Initial Outreach'
  const dateFrom = req.query['date_from'] as string | undefined
  const dateTo = req.query['date_to'] as string | undefined
  const useBizDays = req.query['biz_days'] === '1'
  const bizFactor = useBizDays ? 5 / 7 : 1

  const milestoneCol = TOUCHPOINT_MILESTONE[touchpoint] || 'sales_date'

  const where: string[] = [`oc.touchpoint_name = ?`]
  const params: unknown[] = [touchpoint]
  if (coordinator) { where.push('oc.project_coordinator = ?'); params.push(coordinator) }
  if (dateFrom) { where.push('oc.outreach_completed_date >= ?'); params.push(dateFrom) }
  if (dateTo) { where.push('oc.outreach_completed_date <= ?'); params.push(dateTo) }

  const rows = db.prepare(`
    SELECT oc.record_id, oc.project_rid, oc.project_coordinator AS coordinator, oc.customer_name,
           oc.outreach_completed_date,
           pc.${milestoneCol} AS milestone_date,
           pc.status, pc.state, pc.system_size_kw, pc.lender,
           CAST(julianday(oc.outreach_completed_date) - julianday(pc.${milestoneCol}) AS INTEGER) AS days_raw
    FROM outreach_completed_cache oc
    JOIN project_cache pc ON oc.project_rid = pc.record_id
    WHERE ${where.join(' AND ')}
      AND pc.${milestoneCol} != '' AND pc.${milestoneCol} IS NOT NULL
    ORDER BY oc.outreach_completed_date DESC
  `).all(...params) as Array<{
    record_id: number; project_rid: number; coordinator: string; customer_name: string
    outreach_completed_date: string; milestone_date: string; status: string; state: string
    system_size_kw: number | null; lender: string; days_raw: number
  }>

  const valid = rows.filter(r => r.days_raw >= 0 && r.days_raw <= 365)
  const withBiz = valid.map(r => ({ ...r, days: Math.round(r.days_raw * bizFactor) }))

  // By coordinator
  const coordMap = new Map<string, number[]>()
  for (const r of withBiz) {
    const arr = coordMap.get(r.coordinator) || []
    arr.push(r.days)
    coordMap.set(r.coordinator, arr)
  }
  const byCoordinator = [...coordMap].map(([coord, days]) => {
    days.sort((a, b) => a - b)
    return {
      coordinator: coord, count: days.length,
      avg: Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10,
      median: days[Math.floor(days.length / 2)] || 0,
      p90: days[Math.floor(days.length * 0.9)] || 0,
    }
  }).sort((a, b) => a.avg - b.avg)

  // Volume + metrics by week or month (auto-select: ≤3 months → weekly, else monthly)
  const dateSpanDays = dateFrom && dateTo
    ? Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (1000 * 60 * 60 * 24))
    : 90
  const useWeekly = dateSpanDays <= 93

  const volumeMap = new Map<string, number[]>()
  for (const r of withBiz) {
    let bucket: string
    if (useWeekly) {
      const d = new Date(r.outreach_completed_date)
      const day = d.getDay()
      const monday = new Date(d)
      monday.setDate(d.getDate() - ((day + 6) % 7))
      bucket = monday.toISOString().split('T')[0]!
    } else {
      bucket = r.outreach_completed_date.slice(0, 7)
    }
    const arr = volumeMap.get(bucket) || []
    arr.push(r.days)
    volumeMap.set(bucket, arr)
  }

  const volume = [...volumeMap].sort(([a], [b]) => a.localeCompare(b)).map(([period, days]) => {
    days.sort((a, b) => a - b)
    return {
      period,
      count: days.length,
      avg: Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10,
      p90: days[Math.floor(days.length * 0.9)] || 0,
    }
  })

  // Drill data (for clicking chart bars) — top 100 most recent
  const drillData = withBiz.slice(0, 100).map(r => ({
    record_id: r.record_id,
    project_rid: r.project_rid,
    customer_name: r.customer_name,
    coordinator: r.coordinator,
    outreach_completed_date: r.outreach_completed_date,
    milestone_date: r.milestone_date,
    days: r.days,
    status: r.status,
    state: r.state,
    lender: r.lender,
  }))

  res.json({
    touchpoint,
    milestoneField: milestoneCol,
    binning: useWeekly ? 'weekly' : 'monthly',
    total: withBiz.length,
    byCoordinator,
    volume,
    drillData,
  })
})

export { router as pcDashboardRouter }
