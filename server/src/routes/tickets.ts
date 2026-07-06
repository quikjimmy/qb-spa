import { Router, type Request, type Response } from 'express'
import cron from 'node-cron'
import db from '../db'
import { isAppActive } from '../lib/activity'
import { officeTodayIso } from '../lib/officeTime'
import { denyReferralAgent } from '../lib/referralAgent'
import { callUserLlm, type ChatMessage } from '../lib/callUserLlm'
import { runTicketManager, runRideAlongPass } from '../agents/ticketManager'
import { requireRole } from '../middleware/auth'
import { qbQuery, QB as FIELD_QB, F as ARRIVY_F } from './field'

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
{
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(ticket_cache)`).all() as Array<{ name: string }>).map(c => c.name)
  )
  const add = (name: string, type: string) => { if (!cols.has(name)) db.exec(`ALTER TABLE ticket_cache ADD COLUMN ${name} ${type}`) }
  add('creator', 'TEXT')            // fid 4 (previously mislabeled requested_by)
  add('custom_issue', 'TEXT')       // fid 88 (previously mislabeled closer)
  add('assigned_email', 'TEXT')     // fid 100 user → email (permission checks)
  add('requested_email', 'TEXT')    // fid 89 user → email
  add('requested_at', 'TEXT')       // fid 90
  add('completed_at', 'TEXT')       // fid 59
  add('completed_by', 'TEXT')       // fid 60
  add('adjusted_due', 'TEXT')       // fid 92
  add('followers_json', 'TEXT')     // fid 117 multiuser → [{name,email}]
  add('category_rid', 'INTEGER')    // fid 46
  add('issue_rid', 'INTEGER')       // fid 49
}

// QB field IDs for tickets table (bstdqwrkg) — live-verified 2026-07-04.
// Three long-standing mislabels fixed then: requested_by read fid 4
// (Ticket Creator), closer read fid 88 (Custom Ticket Issue), disposition
// read fid 109 (View Ticket url). fid 44 = Project - Closer.
const F = {
  recordId: 3,
  title: 19,
  description: 20,
  dateCreated: 1,
  projectName: 27,
  relatedProject: 26,
  relatedCategory: 46,
  category: 47,
  relatedIssue: 49,
  issue: 50,
  customIssue: 88,
  assignedToText: 67,     // "Assigned To (Reportable)" formula text
  assignedTo: 100,        // user — the writable assignment field
  creator: 4,             // user
  requestedBy: 89,        // user
  requestedAt: 90,
  status: 91,
  priority: 87,
  dueDate: 52,            // writable request due date
  officialDue: 95,        // formula: adjusted ?? requested
  adjustedDue: 92,
  adjustedBy: 94,
  coordinator: 85,
  closer: 44,
  state: 182,
  disposition: 108,
  blockerFlag: 163,
  projectStatus: 36,
  dateModified: 2,
  lastModifiedBy: 5,
  recentNote: 105,
  completedAt: 59,
  completedBy: 60,
  followers: 117,         // multiuser
}
const TICKETS_TABLE = 'bstdqwrkg'
const CATEGORIES_TABLE = 'bstg9t4mk'  // _DBID_TICKETS_SUBJECTS (label fid 6, Status 8, Is Blocker 21)
const ISSUES_TABLE = 'bs8n3mr57'      // _DBID_TICKET_ISSUES (label 6, Status 7, Related Category 8)
const PRIORITIES = ['Low', 'Medium', 'High', 'Very Urgent']
const STATUSES = ['On Track', 'Behind Schedule', 'Follow Up Scheduled', 'Ahead of Schedule', 'Complete']
const DISPOSITIONS = ['Task Complete', 'Task Rejected']

const fieldMap: Array<{ fid: number; col: string }> = [
  { fid: F.recordId, col: 'record_id' },
  { fid: F.title, col: 'title' },
  { fid: F.description, col: 'description' },
  { fid: F.dateCreated, col: 'date_created' },
  { fid: F.projectName, col: 'project_name' },
  { fid: F.relatedProject, col: 'project_rid' },
  { fid: F.category, col: 'category' },
  { fid: F.issue, col: 'issue' },
  { fid: F.assignedToText, col: 'assigned_to' },
  { fid: F.requestedBy, col: 'requested_by' },
  { fid: F.status, col: 'status' },
  { fid: F.priority, col: 'priority' },
  { fid: F.officialDue, col: 'due_date' },
  { fid: F.coordinator, col: 'coordinator' },
  { fid: F.closer, col: 'closer' },
  { fid: F.state, col: 'state' },
  { fid: F.disposition, col: 'disposition' },
  { fid: F.blockerFlag, col: 'blocker' },
  { fid: F.projectStatus, col: 'project_status' },
  { fid: F.dateModified, col: 'date_modified' },
  { fid: F.lastModifiedBy, col: 'last_modified_by' },
  { fid: F.recentNote, col: 'recent_note' },
  { fid: F.creator, col: 'creator' },
  { fid: F.customIssue, col: 'custom_issue' },
  { fid: F.requestedAt, col: 'requested_at' },
  { fid: F.completedAt, col: 'completed_at' },
  { fid: F.completedBy, col: 'completed_by' },
  { fid: F.adjustedDue, col: 'adjusted_due' },
  { fid: F.followers, col: 'followers_json' },
  { fid: F.relatedCategory, col: 'category_rid' },
  { fid: F.relatedIssue, col: 'issue_rid' },
  // Same fid can feed two columns (name + email extracted separately).
  { fid: F.assignedTo, col: 'assigned_email' },
  { fid: F.requestedBy, col: 'requested_email' },
]

const selectFids = [...new Set(fieldMap.map(f => f.fid))]

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
        if (f.col === 'project_rid' || f.col === 'category_rid' || f.col === 'issue_rid') {
          return parseInt(val(record, f.fid)) || null
        }
        if (f.col === 'blocker') return val(record, f.fid) === 'true' ? 1 : 0
        // User fields return { name, email, id } — extract name or email.
        if (['last_modified_by', 'requested_by', 'creator', 'completed_by'].includes(f.col)) {
          const raw = record[String(f.fid)]?.value
          if (raw && typeof raw === 'object' && 'name' in (raw as Record<string, unknown>)) return (raw as { name: string }).name
          return val(record, f.fid)
        }
        if (f.col === 'assigned_email' || f.col === 'requested_email') {
          const raw = record[String(f.fid)]?.value
          if (raw && typeof raw === 'object' && 'email' in (raw as Record<string, unknown>)) {
            return String((raw as { email?: string }).email ?? '').toLowerCase()
          }
          return ''
        }
        // Multiuser → JSON [{name,email}]
        if (f.col === 'followers_json') {
          const raw = record[String(f.fid)]?.value
          if (Array.isArray(raw)) {
            return JSON.stringify(raw.map(u => ({
              name: String((u as Record<string, unknown>)['name'] ?? ''),
              email: String((u as Record<string, unknown>)['email'] ?? '').toLowerCase(),
            })))
          }
          return '[]'
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

// ─── Write layer ─────────────────────────────────────────
// First QB write path for tickets. Same conventions as notes.ts: service
// token writes, user fields set by email, single-record refresh after.

function qbHeaders() {
  const { realm, token } = getQbConfig()
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

async function qbWriteTicket(fields: Record<string, { value: unknown }>, mergeRid?: number): Promise<{ ok: boolean; status: number; recordId?: number; json: unknown }> {
  const body: Record<string, unknown> = { to: TICKETS_TABLE, data: [fields], fieldsToReturn: [F.recordId] }
  if (mergeRid) {
    body['mergeFieldId'] = F.recordId
    ;(body['data'] as Array<Record<string, unknown>>)[0]![String(F.recordId)] = { value: mergeRid }
  }
  const res = await fetch('https://api.quickbase.com/v1/records', {
    method: 'POST', headers: qbHeaders(), body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({})) as {
    metadata?: { createdRecordIds?: number[]; updatedRecordIds?: number[]; lineErrors?: Record<string, string[]> }
  }
  const lineErrors = json.metadata?.lineErrors
  const recordId = json.metadata?.createdRecordIds?.[0] ?? json.metadata?.updatedRecordIds?.[0] ?? mergeRid
  const ok = res.ok && (!lineErrors || Object.keys(lineErrors).length === 0)
  return { ok, status: res.status, recordId, json }
}

async function refreshOneTicket(rid: number): Promise<void> {
  try {
    const records = await fetchTickets(`{${F.recordId}.EX.'${rid}'}`)
    upsertRecords(records)
  } catch (e) {
    console.error('[tickets] single refresh failed:', e instanceof Error ? e.message : e)
  }
}

interface CachedTicket {
  record_id: number; title: string | null; project_rid: number | null; project_name: string | null
  assigned_to: string | null; assigned_email: string | null
  requested_by: string | null; requested_email: string | null
  followers_json: string | null; status: string | null; category: string | null
  due_date: string | null
}
function getCachedTicket(rid: number): CachedTicket | undefined {
  return db.prepare(`SELECT record_id, title, project_rid, project_name, assigned_to, assigned_email,
    requested_by, requested_email, followers_json, status, category, due_date FROM ticket_cache WHERE record_id = ?`)
    .get(rid) as CachedTicket | undefined
}

function me(req: Request): { id: number; name: string; email: string } | null {
  const row = db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(req.user?.userId) as
    { id: number; name: string | null; email: string } | undefined
  return row ? { id: row.id, name: row.name ?? '', email: row.email.toLowerCase() } : null
}

function isUnscopedAdmin(req: Request): boolean {
  return req.user?.actAsDepartmentId == null && req.user?.roles.includes('admin') === true
}

// Update permission: assignee, requester, or (unscoped) admin. Email match
// first (exact), name match as fallback for older cache rows.
function canUpdateTicket(req: Request, t: CachedTicket): boolean {
  if (isUnscopedAdmin(req)) return true
  const u = me(req)
  if (!u) return false
  const name = u.name.trim().toLowerCase()
  if (u.email && (t.assigned_email === u.email || t.requested_email === u.email)) return true
  return !!name && (
    (t.assigned_to ?? '').trim().toLowerCase() === name ||
    (t.requested_by ?? '').trim().toLowerCase() === name
  )
}

// Bell notification to a portal user resolved by email (fallback name).
function notifyByIdentity(opts: { email?: string | null; name?: string | null; skipUserId?: number; type: string; title: string; body?: string | null; link: string }): void {
  try {
    let user: { id: number } | undefined
    if (opts.email) {
      user = db.prepare(`SELECT id FROM users WHERE LOWER(email) = ? AND is_active = 1`).get(opts.email.toLowerCase()) as { id: number } | undefined
    }
    if (!user && opts.name) {
      user = db.prepare(`SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND is_active = 1`).get(opts.name) as { id: number } | undefined
    }
    if (!user || user.id === opts.skipUserId) return
    db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(user.id, opts.type, opts.title, opts.body ?? null, opts.link)
  } catch (e) {
    console.error('[tickets] notification failed:', e instanceof Error ? e.message : e)
  }
}

function ticketLink(t: { record_id: number; project_rid?: number | null }): string {
  return t.project_rid ? `/projects/${t.project_rid}#tickets` : `/tickets?focus=${t.record_id}`
}
function ticketLabel(t: CachedTicket): string {
  return t.title || `Ticket #${t.record_id}`
}
function notifyFollowers(t: CachedTicket, skipUserId: number | undefined, type: string, title: string, body: string | null): void {
  let followers: Array<{ name?: string; email?: string }> = []
  try { followers = JSON.parse(t.followers_json || '[]') } catch { /* legacy */ }
  for (const f of followers) {
    notifyByIdentity({ email: f.email, name: f.name, skipUserId, type, title, body, link: ticketLink(t) })
  }
}

// ─── Lookups (categories, issues, assignable users) ──────
interface LookupCategory { id: number; label: string; status: string; blocker: boolean }
interface LookupIssue { id: number; label: string; status: string; category_id: number | null; blocker: boolean }
interface LookupsData {
  categories: LookupCategory[]
  issues: LookupIssue[]
  users: Array<{ id: number; name: string }>
  priorities: string[]
  statuses: string[]
  dispositions: string[]
}
let lookupsCache: { at: number; data: LookupsData } | null = null

async function getLookupsData(): Promise<LookupsData> {
  if (lookupsCache && Date.now() - lookupsCache.at < 10 * 60_000) return lookupsCache.data
  async function pull(table: string, select: number[]) {
    const r = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST', headers: qbHeaders(),
      body: JSON.stringify({ from: table, select, options: { top: 1000 } }),
    })
    if (!r.ok) throw new Error(`lookup query failed (${r.status})`)
    return ((await r.json()).data ?? []) as Array<Record<string, { value: unknown }>>
  }
  const [cats, issues] = await Promise.all([
    pull(CATEGORIES_TABLE, [3, 6, 8, 21]),
    pull(ISSUES_TABLE, [3, 6, 7, 8, 14]),
  ])
  const users = db.prepare(`
    SELECT id, name FROM users WHERE is_active = 1 AND name IS NOT NULL AND name != '' ORDER BY name
  `).all() as Array<{ id: number; name: string }>
  const data: LookupsData = {
    categories: cats.map(c => ({
      id: parseInt(String(c['3']?.value)) || 0,
      label: String(c['6']?.value ?? ''),
      status: String(c['8']?.value ?? ''),
      blocker: String(c['21']?.value) === 'true',
    })).filter(c => c.id && c.label),
    issues: issues.map(i => ({
      id: parseInt(String(i['3']?.value)) || 0,
      label: String(i['6']?.value ?? ''),
      status: String(i['7']?.value ?? ''),
      category_id: parseInt(String(i['8']?.value)) || null,
      blocker: String(i['14']?.value) === 'true',
    })).filter(i => i.id && i.label),
    users,
    priorities: PRIORITIES,
    statuses: STATUSES,
    dispositions: DISPOSITIONS,
  }
  lookupsCache = { at: Date.now(), data }
  return data
}

router.get('/lookups', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await getLookupsData())
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ─── AI triage ────────────────────────────────────────────
// POST /api/tickets/triage — reads a rough description and suggests
// category, issue, priority, and a cleaned-up description via the user's
// connected LLM (callUserLlm — nothing hardcoded). Assignee suggestions
// are rules-based: who has actually handled this issue/category lately.
// Everything returned is a SUGGESTION — the client applies pickers but
// never replaces the user's text without an explicit click.
const TRIAGE_SYSTEM = `You triage support tickets for Kin Home's residential solar operations portal. Given a rough ticket description (and project context when provided), pick the best-fitting category and issue from the catalog, judge priority, suggest a due date, and rewrite the description professionally.

Rules:
- category_id MUST be one of the catalog ids. issue_id MUST be an issue listed under that category, or null if none fits (then propose a short custom_issue).
- priority: "Low", "Medium", "High", or "Very Urgent" — judge from urgency/impact language; default "Medium" when unclear.
- suggested_due_date: YYYY-MM-DD, today or later. Anchor to reality: if the work should happen before/at an upcoming field visit in the context, use that visit's date (or the day before); otherwise judge from priority (Very Urgent ~1-2 days, High ~3-5, Medium ~7, Low ~14).
- field_doable: true only if the work is physical/on-site (electrical, hardware, photos, labels, measurements) that a field crew could complete during a site visit. If true AND an upcoming visit exists, write onsite_note: one short instruction for the crew (this helps bundle work and avoid extra truck rolls).
- cleaned_description: the same facts rewritten clearly and professionally. Never invent facts, dates, or names. Keep it concise.
Respond with ONLY JSON: {"category_id": <n>, "issue_id": <n|null>, "custom_issue": <string|null>, "priority": "<p>", "suggested_due_date": "<YYYY-MM-DD|null>", "field_doable": <bool>, "onsite_note": <string|null>, "cleaned_description": "<text>"}`

router.post('/triage', denyReferralAgent, async (req: Request, res: Response): Promise<void> => {
  const description = String((req.body ?? {})['description'] ?? '').trim()
  const projectId = parseInt(String((req.body ?? {})['project_id'] ?? ''), 10) || 0
  const userId = req.user?.userId
  if (!description) { res.status(400).json({ error: 'description is required' }); return }
  if (!userId) { res.status(401).json({ error: 'not authenticated' }); return }

  try {
    const lookups = await getLookupsData()
    const activeCats = lookups.categories.filter(c => c.status === 'Active')
    const catalog = activeCats.map(c => {
      const catIssues = lookups.issues.filter(i => i.category_id === c.id && i.status === 'Active')
      return `${c.id}: ${c.label}\n${catIssues.map(i => `  ${i.id}: ${i.label}`).join('\n')}`
    }).join('\n')

    // Project context — status + upcoming field visits, so due dates anchor
    // to reality and on-site work can ride along with a scheduled crew.
    let projectContext = ''
    let upcomingVisits: Array<{ when: string; what: string }> = []
    if (projectId) {
      const proj = db.prepare(`SELECT customer_name, status, install_scheduled, survey_scheduled FROM project_cache WHERE record_id = ? LIMIT 1`)
        .get(projectId) as Record<string, string | null> | undefined
      try {
        const horizon = new Date(Date.now() + 30 * 86_400_000)
        const visits = await qbQuery(FIELD_QB.arrivyTable,
          `{${ARRIVY_F.relatedProject}.EX.'${projectId}'}AND{${ARRIVY_F.scheduledDateTime}.OAF.'${new Date().toISOString()}'}AND{${ARRIVY_F.scheduledDateTime}.OBF.'${horizon.toISOString()}'}`,
          [3, ARRIVY_F.scheduledDateTime, ARRIVY_F.templateName, ARRIVY_F.taskStatus],
          { options: { top: 20 } },
        )
        upcomingVisits = visits
          .filter(v => !/CANCEL|COMPLETE|EXCEPTION/.test(String(v[String(ARRIVY_F.taskStatus)]?.value || '').toUpperCase()))
          .map(v => ({
            when: String(v[String(ARRIVY_F.scheduledDateTime)]?.value || ''),
            what: String(v[String(ARRIVY_F.templateName)]?.value || 'Field visit'),
          }))
          .filter(v => v.when)
          .sort((a, b) => a.when.localeCompare(b.when))
      } catch { /* visits stay empty — triage still works */ }
      projectContext = [
        proj ? `Project: ${proj['customer_name'] ?? ''} · status ${proj['status'] ?? '?'}` : '',
        upcomingVisits.length
          ? 'Upcoming field visits:\n' + upcomingVisits.map(v => `- ${v.what} on ${v.when.slice(0, 10)}`).join('\n')
          : 'No field visits scheduled in the next 30 days.',
        `Today: ${officeTodayIso()}`,
      ].filter(Boolean).join('\n')
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: TRIAGE_SYSTEM },
      { role: 'user', content: `CATALOG (category_id: label, indented issue_id: label):\n${catalog}\n${projectContext ? `\nPROJECT CONTEXT:\n${projectContext}\n` : ''}\nTICKET DESCRIPTION:\n${description}` },
    ]
    const llm = await callUserLlm({
      userId, feature: 'ticket-triage', messages,
      maxOutputTokens: 2000, temperature: 0.2, timeoutMs: 60_000,
    })
    if (!llm.ok) { res.status(503).json({ error: llm.error, reason: llm.reason }); return }

    const cleaned = llm.output.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json/gi, '```').replace(/```/g, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    let suggestion: {
      category_id?: number; issue_id?: number | null; custom_issue?: string | null; priority?: string
      suggested_due_date?: string | null; field_doable?: boolean; onsite_note?: string | null; cleaned_description?: string
    } = {}
    if (jsonMatch) { try { suggestion = JSON.parse(jsonMatch[0]) } catch { /* fall through */ } }

    // Validate against the catalog — a hallucinated id is worse than none.
    const categoryId = activeCats.some(c => c.id === suggestion.category_id) ? suggestion.category_id! : null
    let issueId = suggestion.issue_id ?? null
    if (issueId && !lookups.issues.some(i => i.id === issueId && i.category_id === categoryId)) issueId = null
    const priority = PRIORITIES.includes(String(suggestion.priority)) ? String(suggestion.priority) : 'Medium'
    const cleanedDescription = String(suggestion.cleaned_description ?? '').trim() || null
    // Due date must be a real date, today or later — else drop it.
    let suggestedDue: string | null = null
    if (typeof suggestion.suggested_due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(suggestion.suggested_due_date)) {
      if (suggestion.suggested_due_date >= officeTodayIso()) suggestedDue = suggestion.suggested_due_date
    }
    const fieldDoable = suggestion.field_doable === true
    const onsiteNote = fieldDoable && suggestion.onsite_note ? String(suggestion.onsite_note).slice(0, 200) : null
    const nextVisit = upcomingVisits[0] ?? null

    // Assignee suggestions — rules, not LLM: who completed/handled the most
    // of this issue (falling back to category) in the last 180 days, matched
    // to portal users so the client can one-tap apply.
    let suggestedAssignees: Array<{ user_id: number; name: string; count: number }> = []
    const issueLabel = issueId ? lookups.issues.find(i => i.id === issueId)?.label : null
    const catLabel = categoryId ? activeCats.find(c => c.id === categoryId)?.label : null
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)
    for (const [col, valText] of [['issue', issueLabel], ['category', catLabel]] as Array<[string, string | null]>) {
      if (!valText || suggestedAssignees.length) continue
      const rows = db.prepare(`
        SELECT assigned_to AS name, COUNT(*) AS count FROM ticket_cache
        WHERE ${col} = ? AND assigned_to != '' AND date_created >= ?
        GROUP BY assigned_to ORDER BY count DESC LIMIT 5
      `).all(valText, since) as Array<{ name: string; count: number }>
      suggestedAssignees = rows
        .map(r => {
          const u = db.prepare(`SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND is_active = 1`).get(r.name) as { id: number } | undefined
          return u ? { user_id: u.id, name: r.name, count: r.count } : null
        })
        .filter((x): x is { user_id: number; name: string; count: number } => !!x)
        .slice(0, 3)
    }

    res.json({
      ok: true,
      category_id: categoryId,
      issue_id: issueId,
      custom_issue: (!issueId && suggestion.custom_issue) ? String(suggestion.custom_issue).slice(0, 200) : null,
      priority,
      suggested_due_date: suggestedDue,
      field_doable: fieldDoable,
      onsite_note: onsiteNote,
      next_visit: nextVisit ? { when: nextVisit.when, what: nextVisit.what } : null,
      cleaned_description: cleanedDescription,
      suggested_assignees: suggestedAssignees,
      provider: llm.provider,
      model: llm.model,
    })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ─── Create ───────────────────────────────────────────────
// POST /api/tickets — mirrors the QB "Ticket Request" form. Requested By
// + Timestamp stamped from the logged-in user; status starts On Track.
router.post('/', denyReferralAgent, async (req: Request, res: Response): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const u = me(req)
  if (!u) { res.status(401).json({ error: 'not authenticated' }); return }

  const categoryId = parseInt(String(b['category_id'] ?? ''), 10) || 0
  const issueId = parseInt(String(b['issue_id'] ?? ''), 10) || 0
  const customIssue = String(b['custom_issue'] ?? '').trim().slice(0, 200)
  const priority = String(b['priority'] ?? 'Medium')
  const dueDate = String(b['due_date'] ?? '').trim()
  const description = String(b['description'] ?? '').trim()
  const projectId = parseInt(String(b['project_id'] ?? ''), 10) || 0
  const assignedUserId = parseInt(String(b['assigned_user_id'] ?? ''), 10) || 0
  const followerIdsRaw = Array.isArray(b['follower_user_ids']) ? (b['follower_user_ids'] as unknown[]) : []

  if (!categoryId) { res.status(400).json({ error: 'category is required' }); return }
  if (!issueId && !customIssue) { res.status(400).json({ error: 'pick a ticket issue or describe a custom one' }); return }
  if (!PRIORITIES.includes(priority)) { res.status(400).json({ error: `priority must be one of: ${PRIORITIES.join(', ')}` }); return }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) { res.status(400).json({ error: 'due_date must be YYYY-MM-DD' }); return }
  if (!description) { res.status(400).json({ error: 'description is required' }); return }
  if (!assignedUserId) { res.status(400).json({ error: 'assigned_to is required' }); return }

  const assignee = db.prepare(`SELECT id, name, email FROM users WHERE id = ? AND is_active = 1`).get(assignedUserId) as
    { id: number; name: string | null; email: string } | undefined
  if (!assignee) { res.status(400).json({ error: 'assignee not found' }); return }
  const followers = followerIdsRaw
    .map(x => parseInt(String(x), 10) || 0).filter(Boolean).slice(0, 20)
    .map(id => db.prepare(`SELECT email FROM users WHERE id = ? AND is_active = 1`).get(id) as { email: string } | undefined)
    .filter((r): r is { email: string } => !!r)

  const fields: Record<string, { value: unknown }> = {
    [String(F.relatedCategory)]: { value: categoryId },
    [String(F.priority)]: { value: priority },
    [String(F.dueDate)]: { value: dueDate },
    [String(F.description)]: { value: description },
    [String(F.status)]: { value: 'On Track' },
    [String(F.assignedTo)]: { value: assignee.email },
    [String(F.requestedBy)]: { value: u.email },
    [String(F.requestedAt)]: { value: new Date().toISOString() },
  }
  if (issueId) fields[String(F.relatedIssue)] = { value: issueId }
  if (customIssue) fields[String(F.customIssue)] = { value: customIssue }
  if (projectId) fields[String(F.relatedProject)] = { value: projectId }
  if (followers.length) fields[String(F.followers)] = { value: followers.map(f => f.email) }

  try {
    const result = await qbWriteTicket(fields)
    if (!result.ok || !result.recordId) {
      res.status(result.status >= 400 && result.status < 500 ? result.status : 502)
        .json({ error: 'QB ticket create failed', details: result.json })
      return
    }
    await refreshOneTicket(result.recordId)
    const cached = getCachedTicket(result.recordId)
    if (cached) {
      notifyByIdentity({
        email: assignee.email, name: assignee.name, skipUserId: u.id,
        type: 'ticket_assigned',
        title: `New ticket assigned to you: ${ticketLabel(cached)}`,
        body: description.length > 140 ? description.slice(0, 139) + '…' : description,
        link: ticketLink(cached),
      })
    }
    res.json({ ok: true, record_id: result.recordId, ticket: cached ?? null })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ─── Update ───────────────────────────────────────────────
// PATCH /api/tickets/:id — assignee, requester, or admin. Supported ops
// (any subset): status, disposition, due_date (writes Adjusted Due +
// Adjusted By), assigned_user_id (reassign), complete, follow.
router.patch('/:id', denyReferralAgent, async (req: Request, res: Response): Promise<void> => {
  const rid = parseInt(String(req.params['id'] ?? ''), 10)
  if (!Number.isFinite(rid) || rid <= 0) { res.status(400).json({ error: 'ticket id required' }); return }
  const t = getCachedTicket(rid)
  if (!t) { res.status(404).json({ error: 'ticket not found' }); return }
  const u = me(req)
  if (!u) { res.status(401).json({ error: 'not authenticated' }); return }

  const b = (req.body ?? {}) as Record<string, unknown>
  const wantsFollow = typeof b['follow'] === 'boolean'
  // Following is self-service for anyone; every other op needs the
  // assignee/requester/admin gate.
  const opsBeyondFollow = ['status', 'disposition', 'due_date', 'assigned_user_id', 'complete'].some(k => b[k] !== undefined)
  if (opsBeyondFollow && !canUpdateTicket(req, t)) {
    res.status(403).json({ error: 'only the assignee, requester, or an admin can update this ticket' }); return
  }

  const fields: Record<string, { value: unknown }> = {}
  const changes: string[] = []
  let newAssignee: { id: number; name: string | null; email: string } | undefined

  if (typeof b['status'] === 'string' && b['status']) {
    if (!STATUSES.includes(b['status'])) { res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` }); return }
    fields[String(F.status)] = { value: b['status'] }
    changes.push(`status → ${b['status']}`)
  }
  if (typeof b['disposition'] === 'string' && b['disposition']) {
    if (!DISPOSITIONS.includes(b['disposition'])) { res.status(400).json({ error: `disposition must be one of: ${DISPOSITIONS.join(', ')}` }); return }
    fields[String(F.disposition)] = { value: b['disposition'] }
    changes.push(`disposition → ${b['disposition']}`)
  }
  if (typeof b['due_date'] === 'string' && b['due_date']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b['due_date'])) { res.status(400).json({ error: 'due_date must be YYYY-MM-DD' }); return }
    fields[String(F.adjustedDue)] = { value: b['due_date'] }
    fields[String(F.adjustedBy)] = { value: u.email }
    changes.push(`due date → ${b['due_date']}`)
  }
  if (b['assigned_user_id'] !== undefined) {
    const aid = parseInt(String(b['assigned_user_id']), 10) || 0
    newAssignee = db.prepare(`SELECT id, name, email FROM users WHERE id = ? AND is_active = 1`).get(aid) as typeof newAssignee
    if (!newAssignee) { res.status(400).json({ error: 'assignee not found' }); return }
    fields[String(F.assignedTo)] = { value: newAssignee.email }
    changes.push(`reassigned → ${newAssignee.name || newAssignee.email}`)
  }
  if (b['complete'] === true) {
    fields[String(F.status)] = { value: 'Complete' }
    fields[String(F.completedAt)] = { value: new Date().toISOString() }
    fields[String(F.completedBy)] = { value: u.email }
    if (!fields[String(F.disposition)]) fields[String(F.disposition)] = { value: 'Task Complete' }
    changes.push('completed')
  }
  if (wantsFollow) {
    let followers: Array<{ name?: string; email?: string }> = []
    try { followers = JSON.parse(t.followers_json || '[]') } catch { /* legacy */ }
    const already = followers.some(f => (f.email ?? '').toLowerCase() === u.email)
    if (b['follow'] === true && !already) followers.push({ name: u.name, email: u.email })
    if (b['follow'] === false) followers = followers.filter(f => (f.email ?? '').toLowerCase() !== u.email)
    fields[String(F.followers)] = { value: followers.filter(f => f.email).map(f => f.email) }
    changes.push(b['follow'] ? 'followed' : 'unfollowed')
  }
  if (Object.keys(fields).length === 0) { res.status(400).json({ error: 'no supported changes in request' }); return }

  try {
    const result = await qbWriteTicket(fields, rid)
    if (!result.ok) {
      res.status(result.status >= 400 && result.status < 500 ? result.status : 502)
        .json({ error: 'QB ticket update failed', details: result.json })
      return
    }

    // History stamps — mirrors the QB form's convention ("Ticket
    // reassigned to X on <date>"), which form rules would have written
    // had this change happened in QB. One combined note per update.
    const stamps: string[] = []
    if (newAssignee) {
      stamps.push(`Ticket reassigned to ${newAssignee.name || newAssignee.email}${t.assigned_to ? ` (was ${t.assigned_to})` : ''} on ${stampDate()}.`)
    }
    if (typeof b['due_date'] === 'string' && b['due_date']) {
      stamps.push(`Due date adjusted to ${b['due_date']}${t.due_date ? ` (was ${t.due_date.slice(0, 10)})` : ''} on ${stampDate()}.`)
    }
    if (b['complete'] === true) {
      const disp = typeof b['disposition'] === 'string' && b['disposition'] ? b['disposition'] : 'Task Complete'
      stamps.push(`Ticket completed (${disp}) on ${stampDate()}.`)
    } else if (typeof b['status'] === 'string' && b['status']) {
      stamps.push(`Status changed to ${b['status']} on ${stampDate()}.`)
    }
    if (stamps.length) {
      await writeTicketChatNote({ record_id: rid, project_rid: t.project_rid }, stamps.join(' '), { name: u.name, email: u.email })
        .catch(e => console.error('[tickets] stamp note failed:', e instanceof Error ? e.message : e))
    }

    await refreshOneTicket(rid)
    const updated = getCachedTicket(rid) ?? t

    const label = ticketLabel(updated)
    const changeText = changes.join(', ')
    if (newAssignee) {
      notifyByIdentity({
        email: newAssignee.email, name: newAssignee.name, skipUserId: u.id,
        type: 'ticket_assigned',
        title: `Ticket assigned to you: ${label}`,
        body: updated ? `by ${u.name || u.email}` : null,
        link: ticketLink(updated),
      })
    }
    if (b['complete'] === true) {
      notifyByIdentity({
        email: updated.requested_email, name: updated.requested_by, skipUserId: u.id,
        type: 'ticket_completed',
        title: `Ticket completed: ${label}`,
        body: `by ${u.name || u.email}`,
        link: ticketLink(updated),
      })
      notifyFollowers(updated, u.id, 'ticket_completed', `Ticket completed: ${label}`, `by ${u.name || u.email}`)
    } else if (changes.length && !(wantsFollow && changes.length === 1)) {
      // Plain updates ping requester + followers (not for follow/unfollow).
      notifyByIdentity({
        email: updated.requested_email, name: updated.requested_by, skipUserId: u.id,
        type: 'ticket_updated',
        title: `Ticket updated: ${label}`,
        body: changeText,
        link: ticketLink(updated),
      })
      notifyFollowers(updated, u.id, 'ticket_updated', `Ticket updated: ${label}`, changeText)
    }
    res.json({ ok: true, record_id: rid, changes, ticket: updated })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ─── Agent passes — manual triggers (admin, for testing/tuning) ──
// ?dry=1 previews what would happen (no chat posts, no bells, no state).
router.post('/manager/run', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ ok: true, ...(await runTicketManager('manual', req.query['dry'] === '1')) })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})
router.post('/ride-along/run', requireRole('admin'), async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ ok: true, ...(await runRideAlongPass('manual')) })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ─── Ticket chat (notes with Related Ticket, fid 159 on bsb6bqt3b) ──
const NOTES_TABLE = 'bsb6bqt3b'
const NOTE_F = { recordId: 3, dateCreated: 1, note: 6, category: 7, date: 8, noteBy: 9, relatedProject: 13, visibleToRep: 141, relatedTicket: 159 }

// Write a note into a ticket's chat log with best-effort user attribution
// (same fallback as notes.ts: if QB can't resolve the email, the author
// is appended to the text instead). Used for chat messages AND the
// update stamps that mirror the QB form's convention — the form stamps
// "Ticket reassigned to X on <date>" via form rules, which never fire
// for API writes, so the portal writes its own.
async function writeTicketChatNote(
  t: { record_id: number; project_rid: number | null },
  text: string,
  author?: { name: string; email: string },
): Promise<number | null> {
  const base: Record<string, { value: unknown }> = {
    [String(NOTE_F.relatedTicket)]: { value: t.record_id },
    [String(NOTE_F.note)]: { value: text },
    [String(NOTE_F.category)]: { value: 'Tickets' },
    [String(NOTE_F.visibleToRep)]: { value: 'Internal Only' },
    [String(NOTE_F.date)]: { value: new Date().toISOString() },
  }
  if (t.project_rid) base[String(NOTE_F.relatedProject)] = { value: t.project_rid }

  async function attempt(fields: Record<string, { value: unknown }>): Promise<number | null> {
    const r = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST', headers: qbHeaders(),
      body: JSON.stringify({ to: NOTES_TABLE, data: [fields], fieldsToReturn: [NOTE_F.recordId] }),
    })
    const json = await r.json().catch(() => ({})) as { metadata?: { createdRecordIds?: number[]; lineErrors?: Record<string, string[]> } }
    const created = json.metadata?.createdRecordIds?.[0]
    const ok = r.ok && created !== undefined && (!json.metadata?.lineErrors || Object.keys(json.metadata.lineErrors).length === 0)
    return ok ? created! : null
  }

  if (author?.email) {
    const withUser = await attempt({ ...base, [String(NOTE_F.noteBy)]: { value: author.email } })
    if (withUser !== null) return withUser
    return attempt({ ...base, [String(NOTE_F.note)]: { value: `${text}\n\n— ${author.name || author.email} (via portal)` } })
  }
  return attempt(base)
}

function stampDate(): string {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

router.get('/:id/chat', denyReferralAgent, async (req: Request, res: Response): Promise<void> => {
  const rid = parseInt(String(req.params['id'] ?? ''), 10)
  if (!Number.isFinite(rid) || rid <= 0) { res.status(400).json({ error: 'ticket id required' }); return }
  try {
    const r = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST', headers: qbHeaders(),
      body: JSON.stringify({
        from: NOTES_TABLE,
        select: [NOTE_F.recordId, NOTE_F.dateCreated, NOTE_F.note, NOTE_F.noteBy],
        where: `{'${NOTE_F.relatedTicket}'.EX.'${rid}'}`,
        sortBy: [{ fieldId: NOTE_F.dateCreated, order: 'ASC' }],
        options: { top: 300 },
      }),
    })
    if (!r.ok) throw new Error(`QB chat query failed (${r.status})`)
    const data = await r.json() as { data?: Array<Record<string, { value: unknown }>> }
    const items = (data.data ?? []).map(rec => {
      const by = rec[String(NOTE_F.noteBy)]?.value
      return {
        record_id: parseInt(String(rec[String(NOTE_F.recordId)]?.value)) || 0,
        date_created: String(rec[String(NOTE_F.dateCreated)]?.value ?? ''),
        note: String(rec[String(NOTE_F.note)]?.value ?? ''),
        author: by && typeof by === 'object' && 'name' in (by as Record<string, unknown>)
          ? String((by as { name: string }).name ?? '') : '',
      }
    })
    res.json({ items, count: items.length })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

router.post('/:id/chat', denyReferralAgent, async (req: Request, res: Response): Promise<void> => {
  const rid = parseInt(String(req.params['id'] ?? ''), 10)
  if (!Number.isFinite(rid) || rid <= 0) { res.status(400).json({ error: 'ticket id required' }); return }
  const noteText = String((req.body ?? {})['note'] ?? '').trim()
  if (!noteText) { res.status(400).json({ error: 'note text is required' }); return }
  const t = getCachedTicket(rid)
  if (!t) { res.status(404).json({ error: 'ticket not found' }); return }
  const u = me(req)
  if (!u) { res.status(401).json({ error: 'not authenticated' }); return }

  const base: Record<string, { value: unknown }> = {
    [String(NOTE_F.relatedTicket)]: { value: rid },
    [String(NOTE_F.note)]: { value: noteText },
    [String(NOTE_F.category)]: { value: 'Tickets' },
    [String(NOTE_F.visibleToRep)]: { value: 'Internal Only' },
    [String(NOTE_F.date)]: { value: new Date().toISOString() },
  }
  if (t.project_rid) base[String(NOTE_F.relatedProject)] = { value: t.project_rid }

  async function createChatNote(fields: Record<string, { value: unknown }>) {
    const r = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST', headers: qbHeaders(),
      body: JSON.stringify({ to: NOTES_TABLE, data: [fields], fieldsToReturn: [NOTE_F.recordId] }),
    })
    const json = await r.json().catch(() => ({})) as { metadata?: { createdRecordIds?: number[]; lineErrors?: Record<string, string[]> } }
    const created = json.metadata?.createdRecordIds?.[0]
    const ok = r.ok && created !== undefined && (!json.metadata?.lineErrors || Object.keys(json.metadata.lineErrors).length === 0)
    return { ok, status: r.status, created, json }
  }

  try {
    // Attribution mirrors notes.ts: try Note by = my email, fall back to a
    // text suffix if QB can't resolve the user.
    let attempt = await createChatNote({ ...base, [String(NOTE_F.noteBy)]: { value: u.email } })
    if (!attempt.ok) {
      attempt = await createChatNote({ ...base, [String(NOTE_F.note)]: { value: `${noteText}\n\n— ${u.name || u.email} (via portal)` } })
    }
    if (!attempt.ok) {
      res.status(attempt.status >= 400 && attempt.status < 500 ? attempt.status : 502)
        .json({ error: 'QB chat note create failed', details: attempt.json })
      return
    }
    await refreshOneTicket(rid)  // recent_note rollup updates

    const label = ticketLabel(t)
    const preview = noteText.length > 140 ? noteText.slice(0, 139) + '…' : noteText
    // Ping the other side of the conversation + followers.
    notifyByIdentity({ email: t.assigned_email, name: t.assigned_to, skipUserId: u.id, type: 'ticket_chat', title: `New message on ${label}`, body: preview, link: ticketLink(t) })
    notifyByIdentity({ email: t.requested_email, name: t.requested_by, skipUserId: u.id, type: 'ticket_chat', title: `New message on ${label}`, body: preview, link: ticketLink(t) })
    notifyFollowers(t, u.id, 'ticket_chat', `New message on ${label}`, preview)
    res.json({ ok: true, record_id: attempt.created })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
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

  // Ticket manager — weekday mornings ~7:30/8:30 Denver (14:30 UTC).
  // Runs AFTER a fresh incremental so it judges current data.
  cron.schedule('30 14 * * 1-5', async () => {
    try {
      if (!getQbConfig().token) return
      await trackedRefresh('incremental').catch(() => { /* judge cached data */ })
      const r = await runTicketManager('cron')
      console.log(`[ticket-manager] flagged=${r.flagged} checkins=${r.checkins} nudges=${r.nudges} escalations=${r.escalations}`)
    } catch (e) {
      console.error('[ticket-manager] run failed:', e instanceof Error ? e.message : e)
    }
  })

  // Ride-along pass — weekday mornings shortly after the manager, so
  // coordinators see bundling opportunities before dispatch settles.
  cron.schedule('45 14 * * 1-5', async () => {
    try {
      if (!getQbConfig().token) return
      const r = await runRideAlongPass('cron')
      console.log(`[ride-along] visits=${r.upcomingVisits} matched=${r.projectsMatched} notices=${r.noticesSent}`)
    } catch (e) {
      console.error('[ride-along] run failed:', e instanceof Error ? e.message : e)
    }
  })

  console.log('[ticket-cache] scheduler started: incremental=5m (gated), full=03:30 UTC, manager=14:30 UTC weekdays, ride-along=14:45 UTC weekdays')
}

export { router as ticketsRouter }
