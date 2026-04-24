import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

// ─── Cache table ─────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS project_cache (
    record_id INTEGER PRIMARY KEY,
    customer_name TEXT,
    customer_address TEXT,
    email TEXT,
    phone TEXT,
    mobile_phone TEXT,
    alt_phone TEXT,
    status TEXT,
    sales_office TEXT,
    lender TEXT,
    closer TEXT,
    coordinator TEXT,
    system_size_kw REAL,
    sales_date TEXT,
    state TEXT,
    intake_completed TEXT,
    survey_scheduled TEXT,
    survey_submitted TEXT,
    survey_approved TEXT,
    cad_submitted TEXT,
    design_completed TEXT,
    nem_submitted TEXT,
    nem_approved TEXT,
    nem_rejected TEXT,
    permit_submitted TEXT,
    permit_approved TEXT,
    permit_rejected TEXT,
    install_scheduled TEXT,
    install_completed TEXT,
    inspection_scheduled TEXT,
    inspection_passed TEXT,
    pto_submitted TEXT,
    pto_approved TEXT,
    epc TEXT,
    nem_user TEXT,
    inspx_first_time_pass INTEGER,
    inspx_pass_fail TEXT,
    inspx_fail_date TEXT,
    inspx_count INTEGER DEFAULT 0,
    inspx_passed_count INTEGER DEFAULT 0,
    next_task_type TEXT,
    next_task_date TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_status ON project_cache(status)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_name ON project_cache(customer_name COLLATE NOCASE)`)
// Additive migration for the extra phone columns — existing deployments
// have the narrower table shape, so ALTER guarded via PRAGMA.
{
  const cols = db.prepare(`PRAGMA table_info(project_cache)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('mobile_phone')) db.exec(`ALTER TABLE project_cache ADD COLUMN mobile_phone TEXT`)
  if (!names.has('alt_phone')) db.exec(`ALTER TABLE project_cache ADD COLUMN alt_phone TEXT`)
}

// Field mapping: QB field ID → cache column
const fieldMap: Array<{ fid: number; col: string }> = [
  { fid: 3, col: 'record_id' },
  { fid: 145, col: 'customer_name' },
  { fid: 146, col: 'customer_address' },
  { fid: 149, col: 'email' },
  { fid: 148, col: 'phone' },
  { fid: 255, col: 'status' },
  { fid: 339, col: 'sales_office' },
  { fid: 344, col: 'lender' },
  { fid: 355, col: 'closer' },
  { fid: 820, col: 'coordinator' },
  { fid: 13, col: 'system_size_kw' },
  { fid: 522, col: 'sales_date' },
  { fid: 189, col: 'state' },
  { fid: 461, col: 'intake_completed' },
  { fid: 166, col: 'survey_scheduled' },
  { fid: 164, col: 'survey_submitted' },
  { fid: 165, col: 'survey_approved' },
  { fid: 699, col: 'cad_submitted' },
  { fid: 1774, col: 'design_completed' },
  { fid: 326, col: 'nem_submitted' },
  { fid: 327, col: 'nem_approved' },
  { fid: 1878, col: 'nem_rejected' },
  { fid: 207, col: 'permit_submitted' },
  { fid: 208, col: 'permit_approved' },
  { fid: 706, col: 'permit_rejected' },
  { fid: 178, col: 'install_scheduled' },
  { fid: 534, col: 'install_completed' },
  { fid: 226, col: 'inspection_scheduled' },
  { fid: 491, col: 'inspection_passed' },
  { fid: 537, col: 'pto_submitted' },
  { fid: 538, col: 'pto_approved' },
  { fid: 606, col: 'epc' },
  { fid: 1743, col: 'nem_user' },
  { fid: 1757, col: 'inspx_first_time_pass' },
  { fid: 571, col: 'inspx_pass_fail' },
  { fid: 1469, col: 'inspx_fail_date' },
  { fid: 1410, col: 'inspx_count' },
  { fid: 1073, col: 'inspx_passed_count' },
]

const selectFids = fieldMap.map(f => f.fid)

function val(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}

// ─── Refresh cache ───────────────────────────────────────

async function refreshCache(): Promise<{ total: number; duration: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()

  // Pull in batches — QB max is 1000 per request
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
        from: 'br9kwm8na',
        select: selectFids,
        where: "{'622'.EX.'false'}",
        options: { skip, top: batchSize },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`QB query failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    const records = data.data || []
    allRecords = allRecords.concat(records)

    if (records.length < batchSize) break
    skip += batchSize
  }

  // Clear old cache and write fresh data
  db.prepare('DELETE FROM project_cache').run()

  const cols = fieldMap.map(f => f.col).join(', ')
  const placeholders = fieldMap.map(() => '?').join(', ')
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO project_cache (${cols}, cached_at)
    VALUES (${placeholders}, datetime('now'))
  `)

  db.transaction(() => {
    for (const record of allRecords) {
      const rid = parseInt(val(record, 3))
      if (!rid) continue

      const values = fieldMap.map(f => {
        if (f.col === 'system_size_kw') return parseFloat(val(record, f.fid)) || null
        if (f.col === 'inspx_first_time_pass') return val(record, f.fid) === 'true' ? 1 : 0
        if (f.col === 'inspx_count' || f.col === 'inspx_passed_count') return parseInt(val(record, f.fid)) || 0
        if (f.col === 'inspx_pass_fail') { const v = record[String(f.fid)]?.value; return Array.isArray(v) ? v.join(', ') : val(record, f.fid) }
        // User fields return { name, email, id } — extract name
        if (f.col === 'nem_user') {
          const raw = record[String(f.fid)]?.value
          if (raw && typeof raw === 'object' && 'name' in (raw as Record<string, unknown>)) return (raw as { name: string }).name
        }
        return val(record, f.fid)
      })
      upsert.run(...values)
    }
  })()

  // Fetch upcoming Arrivy tasks and attach next task to each project
  try {
    const today = new Date().toISOString().split('T')[0]!
    const taskRes = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'bvbqgs5yc',
        select: [3, 6, 56, 85, 115],
        where: `{'115'.AF.'${today}'}AND{'85'.XEX.'Complete'}AND{'85'.XEX.'Completed'}AND{'85'.XEX.'Cancelled'}`,
        sortBy: [{ fieldId: 115, order: 'ASC' }],
        options: { top: 1000 },
      }),
    })

    if (taskRes.ok) {
      const taskData = await taskRes.json()
      // Group by project, keep earliest per project
      const nextByProject = new Map<number, { type: string; date: string }>()
      for (const t of taskData.data || []) {
        const projId = parseInt(val(t, 6))
        if (!projId || nextByProject.has(projId)) continue
        nextByProject.set(projId, {
          type: val(t, 56),
          date: val(t, 115),
        })
      }

      const updateTask = db.prepare('UPDATE project_cache SET next_task_type = ?, next_task_date = ? WHERE record_id = ?')
      db.transaction(() => {
        for (const [projId, task] of nextByProject) {
          updateTask.run(task.type, task.date, projId)
        }
      })()
    }
  } catch { /* Arrivy task fetch failed — non-critical */ }

  return { total: allRecords.length, duration: Date.now() - start }
}

// ─── API Routes ──────────────────────────────────────────

// Get projects from cache with search + filters
router.get('/', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const q = (req.query['q'] as string || '').trim().toLowerCase()
  const status = req.query['status'] as string | undefined
  const office = req.query['office'] as string | undefined
  const coordinator = req.query['coordinator'] as string | undefined
  const state = req.query['state'] as string | undefined
  const closer = req.query['closer'] as string | undefined
  const epc = req.query['epc'] as string | undefined
  const lender = req.query['lender'] as string | undefined
  const salesFrom = req.query['sales_from'] as string | undefined
  const salesTo = req.query['sales_to'] as string | undefined
  const surveyFrom = req.query['survey_from'] as string | undefined
  const surveyTo = req.query['survey_to'] as string | undefined
  const installFrom = req.query['install_from'] as string | undefined
  const installTo = req.query['install_to'] as string | undefined
  const pipeline = req.query['pipeline'] as string | undefined
  const sort = req.query['sort'] as string | undefined
  const favoritesOnly = req.query['favorites'] === '1'
  const limit = Math.min(parseInt(req.query['limit'] as string) || 100, 500)
  const offset = parseInt(req.query['offset'] as string) || 0

  // Get this user's favorite project IDs
  const favRows = db.prepare(
    'SELECT project_id FROM favorites WHERE user_id = ?'
  ).all(userId) as Array<{ project_id: number }>
  const favSet = new Set(favRows.map(f => f.project_id))

  let where = 'WHERE 1=1'
  const params: unknown[] = []

  if (favoritesOnly) {
    if (favSet.size === 0) {
      res.json({
        projects: [], total: 0, limit, offset,
        filters: { statuses: [], offices: [], coordinators: [] },
        cache: { total: 0, last_refresh: null },
      })
      return
    }
    const placeholders = [...favSet].map(() => '?').join(',')
    where += ` AND record_id IN (${placeholders})`
    params.push(...favSet)
  }

  if (q) {
    where += ` AND (
      LOWER(customer_name) LIKE ? OR
      LOWER(customer_address) LIKE ? OR
      LOWER(email) LIKE ? OR
      REPLACE(REPLACE(phone, '-', ''), ' ', '') LIKE ? OR
      CAST(record_id AS TEXT) LIKE ?
    )`
    const like = `%${q}%`
    const phoneLike = `%${q.replace(/[-\s()]/g, '')}%`
    params.push(like, like, like, phoneLike, like)
  }

  if (status) { where += ' AND status = ?'; params.push(status) }
  if (office) { where += ' AND sales_office = ?'; params.push(office) }
  if (coordinator) { where += ' AND coordinator = ?'; params.push(coordinator) }
  if (state) { where += ' AND state = ?'; params.push(state) }
  if (closer) { where += ' AND closer = ?'; params.push(closer) }
  if (lender) { where += ' AND lender = ?'; params.push(lender) }
  if (epc) { where += ' AND epc = ?'; params.push(epc) }
  if (salesFrom) { where += " AND sales_date >= ?"; params.push(salesFrom) }
  if (salesTo) { where += " AND sales_date <= ?"; params.push(salesTo) }
  if (surveyFrom) { where += " AND survey_scheduled >= ?"; params.push(surveyFrom) }
  if (surveyTo) { where += " AND survey_scheduled <= ?"; params.push(surveyTo) }
  if (installFrom) { where += " AND install_scheduled >= ?"; params.push(installFrom) }
  if (installTo) { where += " AND install_scheduled <= ?"; params.push(installTo) }

  // Pipeline KPI filter — use client's local date if provided, fall back to server UTC
  const clientToday = req.query['today'] as string | undefined
  const today = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) ? clientToday : new Date().toISOString().split('T')[0]!
  const hasV = (col: string) => `(${col} IS NOT NULL AND ${col} != '' AND ${col} != '0')`
  const noV = (col: string) => `(${col} IS NULL OR ${col} = '' OR ${col} = '0')`
  if (pipeline === 'preInstall') {
    where += ` AND (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%') AND ${noV('install_scheduled')} AND ${noV('install_completed')}`
  } else if (pipeline === 'hold') {
    where += ` AND LOWER(status) LIKE '%hold%' AND ${noV('install_scheduled')}`
  } else if (pipeline === 'futureInstall') {
    where += ` AND (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%') AND ${hasV('install_scheduled')} AND install_scheduled >= '${today}' AND ${noV('install_completed')}`
  } else if (pipeline === 'wip') {
    where += ` AND (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%') AND ${hasV('install_scheduled')} AND install_scheduled <= '${today}T23:59:59' AND ${noV('install_completed')}`
  } else if (pipeline === 'needInspx') {
    where += ` AND (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%') AND ${hasV('install_completed')} AND ${noV('inspection_passed')}`
  } else if (pipeline === 'needPto') {
    where += ` AND (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%') AND ${hasV('inspection_passed')} AND ${noV('pto_approved')}`
  }

  // Sort
  let orderBy = 'record_id DESC'
  if (sort === 'sales_asc') orderBy = 'sales_date ASC, record_id DESC'
  else if (sort === 'sales_desc') orderBy = 'sales_date DESC, record_id DESC'

  const items = db.prepare(`
    SELECT * FROM project_cache
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  const countResult = db.prepare(`
    SELECT COUNT(*) as count FROM project_cache ${where}
  `).get(...params) as { count: number }

  // Get filter options with counts
  // "Pipeline" = Active or Hold, not yet PTO approved — the projects Ops cares about
  const pipelineWhere = "status IN ('Active','Hold','On Hold') AND (pto_approved IS NULL OR pto_approved = '' OR pto_approved = '0')"

  const statuses = db.prepare(
    `SELECT status as value, COUNT(*) as count FROM project_cache WHERE status != '' GROUP BY status ORDER BY count DESC`
  ).all() as Array<{ value: string; count: number }>

  const coordinators = db.prepare(
    `SELECT coordinator as value, COUNT(*) as count FROM project_cache WHERE coordinator != '' AND ${pipelineWhere} GROUP BY coordinator ORDER BY count DESC`
  ).all() as Array<{ value: string; count: number }>

  const states = db.prepare(
    `SELECT state as value, COUNT(*) as count FROM project_cache WHERE state != '' AND ${pipelineWhere} GROUP BY state ORDER BY count DESC`
  ).all() as Array<{ value: string; count: number }>

  const offices = db.prepare(
    `SELECT sales_office as value, COUNT(*) as count FROM project_cache WHERE sales_office != '' GROUP BY sales_office ORDER BY count DESC`
  ).all() as Array<{ value: string; count: number }>

  const closers = db.prepare(
    `SELECT closer as value, COUNT(*) as count FROM project_cache WHERE closer != '' GROUP BY closer ORDER BY count DESC`
  ).all() as Array<{ value: string; count: number }>

  const lenders = db.prepare(
    `SELECT lender as value, COUNT(*) as count FROM project_cache WHERE lender != '' GROUP BY lender ORDER BY count DESC`
  ).all() as Array<{ value: string; count: number }>

  const epcs = db.prepare(
    `SELECT epc as value, COUNT(*) as count FROM project_cache WHERE epc != '' GROUP BY epc ORDER BY count DESC`
  ).all() as Array<{ value: string; count: number }>

  const cacheInfo = db.prepare(
    'SELECT COUNT(*) as total, MAX(cached_at) as last_refresh FROM project_cache'
  ).get() as { total: number; last_refresh: string }

  // KPI pipeline categories (computed from the filtered set, excluding status filter so KPIs show across all statuses)
  // Build a base where that includes all filters EXCEPT status
  let kpiWhere = 'WHERE 1=1'
  const kpiParams: unknown[] = []
  if (favoritesOnly && favSet.size > 0) { kpiWhere += ` AND record_id IN (${[...favSet].map(() => '?').join(',')})`; kpiParams.push(...favSet) }
  if (q) { kpiWhere += ` AND (LOWER(customer_name) LIKE ? OR LOWER(customer_address) LIKE ? OR LOWER(email) LIKE ? OR REPLACE(REPLACE(phone,'-',''),' ','') LIKE ? OR CAST(record_id AS TEXT) LIKE ?)`; const like = `%${q}%`; const phoneLike = `%${q.replace(/[-\s()]/g, '')}%`; kpiParams.push(like, like, like, phoneLike, like) }
  if (office) { kpiWhere += ' AND sales_office = ?'; kpiParams.push(office) }
  if (coordinator) { kpiWhere += ' AND coordinator = ?'; kpiParams.push(coordinator) }
  if (state) { kpiWhere += ' AND state = ?'; kpiParams.push(state) }
  if (closer) { kpiWhere += ' AND closer = ?'; kpiParams.push(closer) }
  if (lender) { kpiWhere += ' AND lender = ?'; kpiParams.push(lender) }
  if (epc) { kpiWhere += ' AND epc = ?'; kpiParams.push(epc) }

  // today already declared above for pipeline filter

  const activeHoldBase = `${kpiWhere} AND (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%')`
  const futureOrToday = (col: string) => `${hasV(col)} AND ${col} >= '${today}'`
  const pastOrToday = (col: string) => `${hasV(col)} AND ${col} <= '${today}T23:59:59'`

  function kpiCount(extraWhere: string): { count: number; kw: number } {
    const row = db.prepare(`SELECT COUNT(*) as c, COALESCE(SUM(system_size_kw),0) as kw FROM project_cache ${extraWhere}`).get(...kpiParams) as { c: number; kw: number }
    return { count: row.c, kw: Math.round(row.kw * 10) / 10 }
  }

  // Pre-Install: active/hold, no future install date, not install completed
  const preInstall = kpiCount(`${activeHoldBase} AND ${noV('install_scheduled')} AND ${noV('install_completed')}`)

  // Hold: status contains 'hold', no future install
  const holdBase = `${kpiWhere} AND LOWER(status) LIKE '%hold%'`
  const hold = kpiCount(`${holdBase} AND ${noV('install_scheduled')}`)

  // Total active+hold for hold % calculation
  const totalActiveHold = kpiCount(activeHoldBase)

  // Future Install: install_scheduled in the future
  const futureInstall = kpiCount(`${activeHoldBase} AND ${futureOrToday('install_scheduled')} AND ${noV('install_completed')}`)

  // In Progress (WIP): install date today or past, not install completed
  const wip = kpiCount(`${activeHoldBase} AND ${pastOrToday('install_scheduled')} AND ${noV('install_completed')}`)

  // Need Inspection: install completed, no inspection passed
  const needInspx = kpiCount(`${activeHoldBase} AND ${hasV('install_completed')} AND ${noV('inspection_passed')}`)

  // Need PTO: inspection passed, no PTO approved
  const needPto = kpiCount(`${activeHoldBase} AND ${hasV('inspection_passed')} AND ${noV('pto_approved')}`)

  const kpi = {
    preInstall,
    hold: { ...hold, pct: preInstall.count > 0 ? Math.round((hold.count / preInstall.count) * 100) : 0 },
    futureInstall,
    wip,
    needInspx,
    needPto,
  }

  // Tag favorites
  const enriched = (items as Array<Record<string, unknown>>).map(item => ({
    ...item,
    is_favorite: favSet.has(item.record_id as number),
  }))

  res.json({
    projects: enriched,
    total: countResult.count,
    kpi,
    limit,
    offset,
    filters: {
      statuses,
      coordinators,
      states,
      offices,
      closers,
      lenders,
      epcs,
    },
    cache: cacheInfo,
  })
})

// Refresh the cache (admin)
router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  const { token } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  try {
    const result = await refreshCache()
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Toggle favorite
router.post('/favorites/:projectId', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const projectId = parseInt(req.params['projectId']!, 10)

  const existing = db.prepare(
    'SELECT 1 FROM favorites WHERE user_id = ? AND project_id = ?'
  ).get(userId, projectId)

  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND project_id = ?').run(userId, projectId)
    res.json({ favorited: false })
  } else {
    db.prepare('INSERT INTO favorites (user_id, project_id) VALUES (?, ?)').run(userId, projectId)
    res.json({ favorited: true })
  }
})

// Lookup projects by phone number. Matches across every phone column we
// store (phone, mobile_phone, alt_phone) on the last 10 digits first; if
// no strict match, falls back to the last 7 digits with `probable: true`
// on each row so the UI can mark them tentative.
router.get('/by-phone', (req: Request, res: Response): void => {
  const raw = String(req.query['number'] || '').trim()
  if (!raw) { res.json({ rows: [], digits: '', match_quality: 'none' }); return }
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 7) { res.json({ rows: [], digits, match_quality: 'none' }); return }
  const last10 = digits.slice(-10)
  const last7 = digits.slice(-7)
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] || '5'), 10) || 5, 1), 20)

  // Helper: normalized-digits-ends-with expression across 3 phone columns.
  // We SQL-normalize each column on the fly; cheap at current project scale.
  const normExpr = (col: string) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')`
  const clauseStrict = `(
    ${normExpr('phone')} LIKE '%' || ?
    OR ${normExpr('mobile_phone')} LIKE '%' || ?
    OR ${normExpr('alt_phone')} LIKE '%' || ?
  )`

  interface MatchRow { record_id: number; customer_name: string; phone: string | null; mobile_phone: string | null; alt_phone: string | null; customer_address: string | null; email: string | null; status: string | null; state: string | null; lender: string | null; coordinator: string | null; closer: string | null; system_size_kw: number | null; sales_date: string | null }

  const strict = db.prepare(`
    SELECT record_id, customer_name, phone, mobile_phone, alt_phone,
           customer_address, email, status, state, lender, coordinator, closer,
           system_size_kw, sales_date
    FROM project_cache
    WHERE ${clauseStrict}
    ORDER BY record_id DESC
    LIMIT ?
  `).all(last10, last10, last10, limit) as MatchRow[]

  if (strict.length > 0) {
    res.json({ rows: strict.map(r => ({ ...r, probable: false })), digits: last10, match_quality: 'strict' })
    return
  }

  // Fallback — last 7 digits, flagged probable. Helps when a customer used a
  // neighbouring area-code or the stored number has a typo.
  const loose = db.prepare(`
    SELECT record_id, customer_name, phone, mobile_phone, alt_phone,
           customer_address, email, status, state, lender, coordinator, closer,
           system_size_kw, sales_date
    FROM project_cache
    WHERE ${clauseStrict}
    ORDER BY record_id DESC
    LIMIT ?
  `).all(last7, last7, last7, limit) as MatchRow[]

  res.json({ rows: loose.map(r => ({ ...r, probable: true })), digits: last7, match_quality: loose.length ? 'probable' : 'none' })
})

// Diagnostic: list every phone-type field on the QB projects table. Admin-
// only. Hit once from the browser dev tools (or curl) and paste the output
// back so we can add the right fids to the projects sync fieldMap.
router.get('/phone-fields-probe', async (req: Request, res: Response): Promise<void> => {
  if (!req.user?.roles.includes('admin')) { res.status(403).json({ error: 'Admin only' }); return }
  const realm = process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com'
  const token = process.env['QB_USER_TOKEN'] || ''
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not set' }); return }
  try {
    const r = await fetch(`https://api.quickbase.com/v1/fields?tableId=br9kwm8na`, {
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Accept': 'application/json',
      },
    })
    if (!r.ok) { res.status(r.status).json({ error: await r.text() }); return }
    const all = await r.json() as Array<{ id: number; label: string; fieldType: string }>
    const phoneLike = all
      .filter(f => f.fieldType === 'phone' || /phone|mobile|cell/i.test(f.label))
      .map(f => ({ id: f.id, label: f.label, fieldType: f.fieldType }))
      .sort((a, b) => a.id - b.id)
    res.json({ count: phoneLike.length, fields: phoneLike })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as projectsRouter }
