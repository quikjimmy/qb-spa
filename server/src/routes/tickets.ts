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
  CREATE TABLE IF NOT EXISTS ticket_cache (
    record_id INTEGER PRIMARY KEY,
    title TEXT,
    description TEXT,
    date_created TEXT,
    project_name TEXT,
    project_rid INTEGER,
    category TEXT,
    issue TEXT,
    assigned_to TEXT,
    requested_by TEXT,
    status TEXT,
    priority TEXT,
    due_date TEXT,
    coordinator TEXT,
    closer TEXT,
    state TEXT,
    disposition TEXT,
    blocker INTEGER DEFAULT 0,
    project_status TEXT,
    date_modified TEXT,
    last_modified_by TEXT,
    recent_note TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// QB field IDs for tickets table (bstdqwrkg)
const fieldMap: Array<{ fid: number; col: string }> = [
  { fid: 3, col: 'record_id' },
  { fid: 19, col: 'title' },
  { fid: 20, col: 'description' },
  { fid: 1, col: 'date_created' },
  { fid: 27, col: 'project_name' },
  { fid: 26, col: 'project_rid' },
  { fid: 47, col: 'category' },
  { fid: 50, col: 'issue' },
  { fid: 67, col: 'assigned_to' },
  { fid: 4, col: 'requested_by' },
  { fid: 91, col: 'status' },
  { fid: 87, col: 'priority' },
  { fid: 95, col: 'due_date' },
  { fid: 85, col: 'coordinator' },
  { fid: 88, col: 'closer' },
  { fid: 182, col: 'state' },
  { fid: 109, col: 'disposition' },
  { fid: 163, col: 'blocker' },
  { fid: 36, col: 'project_status' },
  { fid: 2, col: 'date_modified' },
  { fid: 5, col: 'last_modified_by' },
  { fid: 105, col: 'recent_note' },
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

  // Pull open tickets — exclude completed/closed
  const where = "{91.CT.'Completed'}AND{91.CT.'Closed'}AND{91.CT.'Complete'}"
  // Actually we want NOT contains — pull everything then filter, or just pull all
  // Simpler: pull all tickets, let the frontend filter
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
        from: 'bstdqwrkg',
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

  const cols = fieldMap.map(f => f.col).join(', ')
  const placeholders = fieldMap.map(() => '?').join(', ')
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO ticket_cache (${cols}, cached_at)
    VALUES (${placeholders}, datetime('now'))
  `)

  db.transaction(() => {
    for (const record of allRecords) {
      const rid = parseInt(val(record, 3))
      if (!rid) continue
      const values = fieldMap.map(f => {
        if (f.col === 'project_rid') return parseInt(val(record, f.fid)) || null
        if (f.col === 'blocker') return val(record, f.fid) === 'true' ? 1 : 0
        // User fields return { name, email, id } — extract name
        if (f.col === 'last_modified_by' || f.col === 'requested_by') {
          const raw = record[String(f.fid)]?.value
          if (raw && typeof raw === 'object' && 'name' in (raw as Record<string, unknown>)) return (raw as { name: string }).name
          return val(record, f.fid)
        }
        return val(record, f.fid)
      })
      upsert.run(...values)
    }
  })()

  return { total: allRecords.length, duration: Date.now() - start }
}

// ─── API Routes ──────────────────────────────────────────

router.get('/', (req: Request, res: Response): void => {
  const q = (req.query['q'] as string || '').trim().toLowerCase()
  const status = req.query['status'] as string | undefined
  const priority = req.query['priority'] as string | undefined
  const assigned = req.query['assigned'] as string | undefined
  const category = req.query['category'] as string | undefined
  const issue = req.query['issue'] as string | undefined
  const coordinator = req.query['coordinator'] as string | undefined
  const dueFilter = req.query['due'] as string | undefined // overdue, today, future
  const projectId = parseInt(String(req.query['project_id'] || ''), 10)
  const excludeClosed = req.query['open'] !== '0'
  const limit = Math.min(parseInt(req.query['limit'] as string) || 100, 500)
  const offset = parseInt(req.query['offset'] as string) || 0

  // Base WHERE — everything except due filter (KPIs need to count across all due buckets)
  let baseWhere = 'WHERE 1=1'
  const baseParams: unknown[] = []

  if (excludeClosed) {
    baseWhere += " AND status NOT IN ('Completed','Closed','Complete')"
  }
  if (q) {
    baseWhere += ` AND (LOWER(title) LIKE ? OR LOWER(project_name) LIKE ? OR LOWER(assigned_to) LIKE ? OR LOWER(description) LIKE ?)`
    const like = `%${q}%`
    baseParams.push(like, like, like, like)
  }
  if (status) { baseWhere += ' AND status = ?'; baseParams.push(status) }
  if (priority) { baseWhere += ' AND priority = ?'; baseParams.push(priority) }
  if (assigned) { baseWhere += ' AND assigned_to = ?'; baseParams.push(assigned) }
  if (category) { baseWhere += ' AND category = ?'; baseParams.push(category) }
  if (issue) { baseWhere += ' AND issue = ?'; baseParams.push(issue) }
  if (coordinator) { baseWhere += ' AND coordinator = ?'; baseParams.push(coordinator) }
  if (Number.isFinite(projectId) && projectId > 0) { baseWhere += ' AND project_rid = ?'; baseParams.push(projectId) }

  const clientToday = req.query['today'] as string | undefined
  const today = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) ? clientToday : new Date().toISOString().split('T')[0]!

  // KPI counts — based on current filters but NOT the due filter
  const allOpen = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${baseWhere}`).get(...baseParams) as { c: number }).c
  const overdue = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${baseWhere} AND due_date < ? AND due_date != '' AND due_date != '0'`).get(...baseParams, today) as { c: number }).c
  const dueToday = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${baseWhere} AND due_date >= ? AND due_date < ?`).get(...baseParams, today, today + 'T23:59:59') as { c: number }).c
  const futureDue = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${baseWhere} AND due_date > ?`).get(...baseParams, today + 'T23:59:59') as { c: number }).c

  // Full WHERE with due filter applied for the list query
  let where = baseWhere
  const params = [...baseParams]
  if (dueFilter === 'overdue') { where += " AND due_date < ? AND due_date != '' AND due_date != '0'"; params.push(today) }
  else if (dueFilter === 'today') { where += " AND due_date >= ? AND due_date < ?"; params.push(today, today + 'T23:59:59') }
  else if (dueFilter === 'future') { where += " AND due_date > ?"; params.push(today + 'T23:59:59') }

  const items = db.prepare(`SELECT * FROM ticket_cache ${where} ORDER BY due_date ASC, record_id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)
  const countResult = db.prepare(`SELECT COUNT(*) as count FROM ticket_cache ${where}`).get(...params) as { count: number }

  // Filter options with counts — use baseWhere so they reflect current scope
  const priorities = db.prepare(`SELECT priority as value, COUNT(*) as count FROM ticket_cache ${baseWhere} AND priority != '' GROUP BY priority ORDER BY count DESC`).all(...baseParams)
  // Assignees use a global open count (not filtered by scope) so the user picker always shows everyone
  const openBase = "WHERE status NOT IN ('Completed','Closed','Complete')"
  const assignees = db.prepare(`SELECT assigned_to as value, COUNT(*) as count FROM ticket_cache ${openBase} AND assigned_to != '' GROUP BY assigned_to ORDER BY count DESC`).all()
  const categories = db.prepare(`SELECT category as value, COUNT(*) as count FROM ticket_cache ${baseWhere} AND category != '' GROUP BY category ORDER BY count DESC`).all(...baseParams)
  const issues = db.prepare(`SELECT issue as value, COUNT(*) as count FROM ticket_cache ${baseWhere} AND issue != '' GROUP BY issue ORDER BY count DESC`).all(...baseParams)
  const coordinators = db.prepare(`SELECT coordinator as value, COUNT(*) as count FROM ticket_cache ${baseWhere} AND coordinator != '' GROUP BY coordinator ORDER BY count DESC`).all(...baseParams)
  const statuses = db.prepare(`SELECT status as value, COUNT(*) as count FROM ticket_cache WHERE status != '' GROUP BY status ORDER BY count DESC`).all()

  // Pivot summaries for multiple dimensions
  const pivotBase = excludeClosed ? "WHERE status NOT IN ('Completed','Closed','Complete')" : 'WHERE 1=1'

  function buildPivot(col: string) {
    return db.prepare(`
      SELECT ${col} as name,
        SUM(CASE WHEN due_date < '${today}' AND due_date != '' AND due_date != '0' THEN 1 ELSE 0 END) as past_due,
        SUM(CASE WHEN due_date >= '${today}' AND due_date < '${today}T23:59:59' THEN 1 ELSE 0 END) as today,
        SUM(CASE WHEN due_date > '${today}T23:59:59' THEN 1 ELSE 0 END) as future,
        COUNT(*) as total
      FROM ticket_cache ${pivotBase} AND ${col} != ''
      GROUP BY ${col} ORDER BY total DESC
    `).all()
  }

  const pivotDimension = (req.query['pivot'] as string) || 'assigned_to'
  const allowedPivots = ['assigned_to', 'requested_by', 'category', 'issue', 'state', 'coordinator']
  const pivotCol = allowedPivots.includes(pivotDimension) ? pivotDimension : 'assigned_to'
  const pivotData = buildPivot(pivotCol)

  res.json({
    tickets: items,
    total: countResult.count,
    kpi: { allOpen, overdue, dueToday, futureDue },
    filters: { priorities, assignees, categories, issues, coordinators, statuses },
    pivot: { dimension: pivotCol, data: pivotData },
    limit, offset,
  })
})

// Lightweight badge counts for sidebar (optionally filtered by user name)
router.get('/badges', (req: Request, res: Response): void => {
  const userName = req.query['user'] as string | undefined
  const clientToday = req.query['today'] as string | undefined
  const today = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) ? clientToday : new Date().toISOString().split('T')[0]!
  let where = "WHERE status NOT IN ('Completed','Closed','Complete')"
  const params: unknown[] = []
  if (userName) { where += ' AND assigned_to = ?'; params.push(userName) }

  const overdue = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${where} AND due_date < ? AND due_date != '' AND due_date != '0'`).get(...params, today) as { c: number }).c
  const dueToday = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${where} AND due_date >= ? AND due_date < ?`).get(...params, today, today + 'T23:59:59') as { c: number }).c

  res.json({ overdue, dueToday })
})

// Single ticket
router.get('/:id', (req: Request, res: Response): void => {
  const ticket = db.prepare('SELECT * FROM ticket_cache WHERE record_id = ?').get(req.params['id'])
  if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return }
  res.json({ ticket })
})

// Refresh cache
router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  const { token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }
  try {
    const result = await refreshCache()
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { router as ticketsRouter }
