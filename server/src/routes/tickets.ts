import { Router, type Request, type Response } from 'express'
import cron from 'node-cron'
import db from '../db'
import { isAppActive } from '../lib/activity'
import { officeTodayIso } from '../lib/officeTime'

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
  );
  CREATE TABLE IF NOT EXISTS ticket_cache_runs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_started_at TEXT,
    last_finished_at TEXT,
    last_status TEXT,
    last_rows_changed INTEGER,
    last_error TEXT,
    last_mode TEXT
  );
  INSERT OR IGNORE INTO ticket_cache_runs (id) VALUES (1);
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

// Pull a batch of QB tickets matching `where` (or all if empty). Returns
// the raw record list — caller is responsible for upserting.
async function fetchTickets(where: string): Promise<Array<Record<string, { value: unknown }>>> {
  const { realm, token } = getQbConfig()
  let all: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000
  while (true) {
    const body: Record<string, unknown> = {
      from: 'bstdqwrkg',
      select: selectFids,
      options: { skip, top: batchSize },
    }
    if (where) body['where'] = where
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`QB query failed (${res.status}): ${await res.text()}`)
    const data = await res.json()
    const records = data.data || []
    all = all.concat(records)
    if (records.length < batchSize) break
    skip += batchSize
  }
  return all
}

function upsertRecords(records: Array<Record<string, { value: unknown }>>): number {
  const cols = fieldMap.map(f => f.col).join(', ')
  const placeholders = fieldMap.map(() => '?').join(', ')
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO ticket_cache (${cols}, cached_at)
    VALUES (${placeholders}, datetime('now'))
  `)
  let rows = 0
  db.transaction(() => {
    for (const record of records) {
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
      rows++
    }
  })()
  return rows
}

type RefreshResult = { total: number; duration: number; mode: 'full' | 'incremental' }

async function refreshFull(): Promise<RefreshResult> {
  const start = Date.now()
  const records = await fetchTickets('')
  const total = upsertRecords(records)
  return { total, duration: Date.now() - start, mode: 'full' }
}

// Incremental refresh — pulls only tickets where date_modified (QB field 2)
// is after the previous run's start time. Falls back to a full refresh
// when the cache is empty (e.g. fresh dev DB) so the first call always
// seeds the table. Stepping back 60s on the lower bound absorbs any clock
// skew between QB and the server and avoids missing edits made in the
// gap between query start and QB's modification timestamp commit.
async function refreshIncremental(): Promise<RefreshResult> {
  const start = Date.now()
  const lastRow = db.prepare('SELECT MAX(cached_at) AS latest FROM ticket_cache').get() as { latest: string | null }
  if (!lastRow.latest) return await refreshFull()
  const lastIso = new Date(lastRow.latest.replace(' ', 'T') + 'Z').getTime() - 60_000
  const sinceIso = new Date(lastIso).toISOString()
  // QB date filter: {<fid>.AF.'<iso>'} = "after". Field 2 = date_modified.
  const where = `{2.AF.'${sinceIso}'}`
  const records = await fetchTickets(where)
  const total = upsertRecords(records)
  return { total, duration: Date.now() - start, mode: 'incremental' }
}

// Wrapper that mirrors what the run-tracker writes around the project tier
// runs — start row, finish row with status/rows/error. Single source of
// truth so the manual /refresh, the tier endpoint, and the scheduler all
// share the same bookkeeping.
async function trackedRefresh(mode: 'full' | 'incremental'): Promise<RefreshResult> {
  db.prepare(`UPDATE ticket_cache_runs SET last_started_at = datetime('now'), last_status = 'running', last_error = NULL, last_mode = ? WHERE id = 1`).run(mode)
  try {
    const result = mode === 'full' ? await refreshFull() : await refreshIncremental()
    db.prepare(`UPDATE ticket_cache_runs SET last_finished_at = datetime('now'), last_status = 'ok', last_rows_changed = ?, last_error = NULL, last_mode = ? WHERE id = 1`)
      .run(result.total, result.mode)
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    db.prepare(`UPDATE ticket_cache_runs SET last_finished_at = datetime('now'), last_status = 'failed', last_error = ? WHERE id = 1`).run(msg)
    throw err
  }
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

  // Day boundaries are classified on the office calendar (issue #29) — the
  // server is authoritative so every viewer sees the same KPI counts.
  const today = officeTodayIso()

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
  // Day boundaries are classified on the office calendar (issue #29) — the
  // server is authoritative so every viewer sees the same KPI counts.
  const today = officeTodayIso()
  let where = "WHERE status NOT IN ('Completed','Closed','Complete')"
  const params: unknown[] = []
  if (userName) { where += ' AND assigned_to = ?'; params.push(userName) }

  const overdue = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${where} AND due_date < ? AND due_date != '' AND due_date != '0'`).get(...params, today) as { c: number }).c
  const dueToday = (db.prepare(`SELECT COUNT(*) as c FROM ticket_cache ${where} AND due_date >= ? AND due_date < ?`).get(...params, today, today + 'T23:59:59') as { c: number }).c

  res.json({ overdue, dueToday })
})

// Per-project open-ticket buckets for the at-a-glance badge on project lists.
// One GROUP BY over the local cache (no QB round-trip), bucketed on the office
// calendar exactly like the single-project KPI above. Returns only projects
// with at least one dated open ticket; rows without urgency are omitted so the
// client map stays small.
router.get('/by-project', (_req: Request, res: Response): void => {
  const today = officeTodayIso()
  const rows = db.prepare(`
    SELECT project_rid,
      SUM(CASE WHEN due_date < ? AND due_date != '' AND due_date != '0' THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN due_date >= ? AND due_date < ? THEN 1 ELSE 0 END) as dueToday,
      SUM(CASE WHEN due_date > ? THEN 1 ELSE 0 END) as futureDue
    FROM ticket_cache
    WHERE status NOT IN ('Completed','Closed','Complete') AND project_rid IS NOT NULL AND project_rid != 0
    GROUP BY project_rid
  `).all(today, today, today + 'T23:59:59', today + 'T23:59:59') as Array<{ project_rid: number; overdue: number; dueToday: number; futureDue: number }>

  const byProject: Record<string, { overdue: number; dueToday: number; futureDue: number }> = {}
  for (const r of rows) {
    if (r.overdue || r.dueToday || r.futureDue) {
      byProject[String(r.project_rid)] = { overdue: r.overdue, dueToday: r.dueToday, futureDue: r.futureDue }
    }
  }
  res.json({ byProject })
})

// Refresh — defaults to incremental (cheap; only modified tickets). Pass
// ?full=1 to force a full rebuild (used by admin diagnostics page).
// Specific paths registered BEFORE the /:id wildcard so Express doesn't
// match `freshness`, `refresh`, etc. as a record_id.
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const { token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }
  const mode: 'full' | 'incremental' = req.query['full'] === '1' ? 'full' : 'incremental'
  try {
    const result = await trackedRefresh(mode)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// /refresh-tier/:tier — matches the URL the shared <DataFreshness>
// component calls. Tickets have no tier system (date_modified is on the
// row itself, so a single incremental sweep covers every freshness
// budget), so :tier is accepted but ignored — every call runs the
// incremental path.
router.post('/refresh-tier/:tier', async (_req: Request, res: Response): Promise<void> => {
  const { token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }
  try {
    const result = await trackedRefresh('incremental')
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// /freshness — same response shape as /api/projects/freshness so the
// shared <DataFreshness resource="tickets"> component can render either
// source. Tickets don't have tiers, so tier_runs/tier_counts are empty
// and the component falls back to overall_latest. The single
// ticket_cache_runs row is exposed under tier='hot' so the shared
// "last status / running" UI still has something to read.
router.get('/freshness', (_req: Request, res: Response): void => {
  const overall = db.prepare(`SELECT MAX(cached_at) AS latest, COUNT(*) AS total FROM ticket_cache`).get() as { latest: string | null; total: number }
  const run = db.prepare(`SELECT last_started_at, last_finished_at, last_status, last_rows_changed, last_error FROM ticket_cache_runs WHERE id = 1`).get() as {
    last_started_at: string | null; last_finished_at: string | null; last_status: string | null; last_rows_changed: number | null; last_error: string | null
  } | undefined
  res.json({
    overall_latest: overall.latest,
    overall_total: overall.total,
    tier_runs: run ? [{ tier: 'hot', ...run }] : [],
    tier_counts: [],
    server_time: new Date().toISOString(),
    cadence: { hot: '5m', warm: '5m', cool: '5m', cold: '5m' },
  })
})

// Single ticket — wildcard last so it doesn't swallow the specific paths
// above (was matching GET /freshness as id='freshness' → "Ticket not
// found" 404, breaking the DataFreshness chip in prod).
router.get('/:id', (req: Request, res: Response): void => {
  const ticket = db.prepare('SELECT * FROM ticket_cache WHERE record_id = ?').get(req.params['id'])
  if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return }
  res.json({ ticket })
})

// ─── Scheduler ───────────────────────────────────────────
// Incremental every 5 min, gated on user activity (same pattern as
// project_cache hot/warm/cool tiers). A daily full refresh catches edge
// cases the incremental path can't see — restored tickets that were
// previously deleted, schema changes that need a re-pull, etc.
const ACTIVITY_WINDOW_MS = 30 * 60_000
let schedulerStarted = false

export function startTicketCacheScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true

  // Incremental every 5 min while users are active.
  cron.schedule('*/5 * * * *', async () => {
    try {
      if (!getQbConfig().token) return
      if (!isAppActive(ACTIVITY_WINDOW_MS)) return
      const result = await trackedRefresh('incremental')
      if (result.total > 0) console.log(`[ticket-cache] incremental: ${result.total} rows in ${result.duration}ms`)
    } catch (e) {
      console.error('[ticket-cache] incremental failed:', e instanceof Error ? e.message : e)
    }
  })

  // Daily full sweep at 03:30 UTC — catches anything the incremental
  // missed (deletions, schema-driven re-pulls).
  cron.schedule('30 3 * * *', async () => {
    try {
      if (!getQbConfig().token) return
      const result = await trackedRefresh('full')
      console.log(`[ticket-cache] full: ${result.total} rows in ${result.duration}ms`)
    } catch (e) {
      console.error('[ticket-cache] full failed:', e instanceof Error ? e.message : e)
    }
  })

  console.log('[ticket-cache] scheduler started: incremental=5m (gated on activity), full=03:30 UTC daily')
}

export { router as ticketsRouter }
