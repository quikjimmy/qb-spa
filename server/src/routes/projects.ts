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
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_status ON project_cache(status)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_name ON project_cache(customer_name COLLATE NOCASE)`)

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
  { fid: 189, col: 'state' },
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

  // Write to cache in a transaction — columns must match fieldMap order
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
        return val(record, f.fid)
      })
      upsert.run(...values)
    }
  })()

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
  const lender = req.query['lender'] as string | undefined
  const salesFrom = req.query['sales_from'] as string | undefined
  const salesTo = req.query['sales_to'] as string | undefined
  const surveyFrom = req.query['survey_from'] as string | undefined
  const surveyTo = req.query['survey_to'] as string | undefined
  const installFrom = req.query['install_from'] as string | undefined
  const installTo = req.query['install_to'] as string | undefined
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
  if (salesFrom) { where += " AND sales_date >= ?"; params.push(salesFrom) }
  if (salesTo) { where += " AND sales_date <= ?"; params.push(salesTo) }
  if (surveyFrom) { where += " AND survey_scheduled >= ?"; params.push(surveyFrom) }
  if (surveyTo) { where += " AND survey_scheduled <= ?"; params.push(surveyTo) }
  if (installFrom) { where += " AND install_scheduled >= ?"; params.push(installFrom) }
  if (installTo) { where += " AND install_scheduled <= ?"; params.push(installTo) }

  const items = db.prepare(`
    SELECT * FROM project_cache
    ${where}
    ORDER BY record_id DESC
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

  const cacheInfo = db.prepare(
    'SELECT COUNT(*) as total, MAX(cached_at) as last_refresh FROM project_cache'
  ).get() as { total: number; last_refresh: string }

  // Tag favorites
  const enriched = (items as Array<Record<string, unknown>>).map(item => ({
    ...item,
    is_favorite: favSet.has(item.record_id as number),
  }))

  res.json({
    projects: enriched,
    total: countResult.count,
    limit,
    offset,
    filters: {
      statuses,
      coordinators,
      states,
      offices,
      closers,
      lenders,
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

export { router as projectsRouter }
