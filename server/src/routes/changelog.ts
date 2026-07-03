// What's New changelog — the output side of the feedback loop.
//
// Entries are authored (or auto-drafted from shipped feedback) with a
// publish_date on the office calendar; the client shows one daily
// wrap-up dialog per user for published entries they haven't seen.
// Seen-state lives server-side so dismissing on one device dismisses
// everywhere.
//
//   GET  /api/changelog/unseen   — published, publish_date <= today, newer than user's last-seen
//   POST /api/changelog/seen     — advance the user's last-seen watermark
//   GET  /api/changelog          — published archive (the /whats-new page)
//   GET  /api/changelog/admin    — all entries incl. drafts (admin)
//   POST /api/changelog/admin    — create (admin)
//   PATCH/DELETE /admin/:id      — edit / publish / remove (admin)

import { Router, type Request, type Response } from 'express'
import db from '../db'
import { requireRole } from '../middleware/auth'
import { officeTodayIso, officeDaysAgo, addDaysIso } from '../lib/officeTime'

const router = Router()

db.exec(`
  CREATE TABLE IF NOT EXISTS app_changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publish_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    category TEXT NOT NULL DEFAULT 'improved',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    path TEXT,
    feedback_id INTEGER REFERENCES app_feedback(id),
    requested_by TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_changelog_pub ON app_changelog(status, publish_date)`)
// audience: 'all' | 'admin' | 'dept:<id>' | 'role:<id>' — who the entry is
// for. show_popup: 0 = archive-only (never in the daily wrap-up dialog).
try { db.exec(`ALTER TABLE app_changelog ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'`) } catch { /* exists */ }
try { db.exec(`ALTER TABLE app_changelog ADD COLUMN show_popup INTEGER NOT NULL DEFAULT 1`) } catch { /* exists */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS changelog_seen (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    last_seen_date TEXT NOT NULL DEFAULT ''
  )
`)

const CATEGORIES = ['new', 'improved', 'fixed'] as const
type Category = typeof CATEGORIES[number]

// How far back the wrap-up dialog reaches. A user gone two weeks gets
// the last few days of updates, not a 30-step tour; the /whats-new
// archive has the full history.
const UNSEEN_LOOKBACK_DAYS = 7

interface ChangelogEntry {
  id: number
  publish_date: string
  status: string
  category: string
  title: string
  body: string
  path: string | null
  feedback_id: number | null
  requested_by: string | null
  audience: string
  show_popup: number
  created_at: string
}

// Audience gate. Admins see everything (mirrors requireViewPermission's
// admin bypass); everyone else must match the dept/role the entry targets.
function audienceFilter<T extends { audience: string }>(entries: T[], req: Request): T[] {
  const roles = req.user!.roles || []
  if (roles.includes('admin')) return entries
  const userId = req.user!.userId
  let deptIds: Set<number> | null = null
  let roleIds: Set<number> | null = null
  return entries.filter(e => {
    const a = e.audience || 'all'
    if (a === 'all') return true
    if (a === 'admin') return false
    if (a.startsWith('dept:')) {
      if (!deptIds) {
        const rows = db.prepare(`SELECT department_id AS id FROM user_departments WHERE user_id = ?`).all(userId) as Array<{ id: number }>
        deptIds = new Set(rows.map(r => r.id))
      }
      return deptIds.has(parseInt(a.slice(5), 10))
    }
    if (a.startsWith('role:')) {
      if (!roleIds) {
        const rows = db.prepare(`SELECT role_id AS id FROM user_roles WHERE user_id = ?`).all(userId) as Array<{ id: number }>
        roleIds = new Set(rows.map(r => r.id))
      }
      return roleIds.has(parseInt(a.slice(5), 10))
    }
    return false // unknown audience token — fail closed
  })
}

function isValidAudience(a: unknown): a is string {
  return typeof a === 'string' && (a === 'all' || a === 'admin' || /^(dept|role):\d+$/.test(a))
}

// ─── User-facing ─────────────────────────────────────────

router.get('/unseen', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const today = officeTodayIso()
  const floor = officeDaysAgo(UNSEEN_LOOKBACK_DAYS)
  const seen = db.prepare(`SELECT last_seen_date FROM changelog_seen WHERE user_id = ?`)
    .get(userId) as { last_seen_date: string } | undefined
  const lastSeen = seen?.last_seen_date || ''

  const entries = db.prepare(
    `SELECT id, publish_date, category, title, body, path, requested_by, audience
     FROM app_changelog
     WHERE status = 'published' AND show_popup = 1
       AND publish_date <= ? AND publish_date >= ? AND publish_date > ?
     ORDER BY publish_date DESC, category ASC, id ASC`
  ).all(today, floor, lastSeen) as ChangelogEntry[]

  res.json({ today, entries: audienceFilter(entries, req).map(({ audience, ...e }) => e) })
})

router.post('/seen', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const today = officeTodayIso()
  db.prepare(
    `INSERT INTO changelog_seen (user_id, last_seen_date) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_date = excluded.last_seen_date
     WHERE excluded.last_seen_date > changelog_seen.last_seen_date`
  ).run(userId, today)
  res.json({ ok: true })
})

// Published archive, newest day first. The client groups by publish_date.
// Audience-gated like the popup; archive-only entries DO show here —
// that's the point of the flag.
router.get('/', (req: Request, res: Response): void => {
  const today = officeTodayIso()
  const entries = db.prepare(
    `SELECT id, publish_date, category, title, body, path, requested_by, audience
     FROM app_changelog
     WHERE status = 'published' AND publish_date <= ?
     ORDER BY publish_date DESC, category ASC, id ASC
     LIMIT 300`
  ).all(today) as ChangelogEntry[]
  res.json({ today, entries: audienceFilter(entries, req).map(({ audience, ...e }) => e) })
})

// ─── Admin authoring ─────────────────────────────────────

router.get('/admin', requireRole('admin'), (_req: Request, res: Response): void => {
  const entries = db.prepare(
    `SELECT c.*, u.name AS created_by_name
     FROM app_changelog c LEFT JOIN users u ON u.id = c.created_by
     ORDER BY CASE c.status WHEN 'draft' THEN 0 ELSE 1 END, c.publish_date DESC, c.id DESC
     LIMIT 300`
  ).all()
  res.json({ entries, today: officeTodayIso() })
})

router.post('/admin', requireRole('admin'), (req: Request, res: Response): void => {
  const { title, body, category, path, publish_date, status, requested_by, audience, show_popup } = req.body as Partial<ChangelogEntry>
  if (!title || !title.trim()) { res.status(400).json({ error: 'title is required' }); return }
  const cat: Category = CATEGORIES.includes(category as Category) ? category as Category : 'improved'
  const pub = /^\d{4}-\d{2}-\d{2}$/.test(publish_date || '') ? publish_date! : addDaysIso(officeTodayIso(), 1)
  const st = status === 'published' ? 'published' : 'draft'
  const aud = isValidAudience(audience) ? audience : 'all'
  const result = db.prepare(
    `INSERT INTO app_changelog (publish_date, status, category, title, body, path, requested_by, audience, show_popup, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(pub, st, cat, title.slice(0, 200), (body || '').slice(0, 2000), (path || '').slice(0, 300) || null,
        (requested_by || '').slice(0, 100) || null, aud, show_popup === 0 ? 0 : 1, req.user!.userId)
  res.json({ ok: true, id: Number(result.lastInsertRowid) })
})

router.patch('/admin/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  if (!id) { res.status(400).json({ error: 'invalid id' }); return }
  const { title, body, category, path, publish_date, status, requested_by, audience, show_popup } = req.body as Partial<ChangelogEntry>

  const sets: string[] = []
  const params: unknown[] = []
  if (typeof title === 'string' && title.trim()) { sets.push('title = ?'); params.push(title.slice(0, 200)) }
  if (typeof body === 'string') { sets.push('body = ?'); params.push(body.slice(0, 2000)) }
  if (CATEGORIES.includes(category as Category)) { sets.push('category = ?'); params.push(category) }
  if (typeof path === 'string') { sets.push('path = ?'); params.push(path.slice(0, 300) || null) }
  if (typeof requested_by === 'string') { sets.push('requested_by = ?'); params.push(requested_by.slice(0, 100) || null) }
  if (/^\d{4}-\d{2}-\d{2}$/.test(publish_date || '')) { sets.push('publish_date = ?'); params.push(publish_date) }
  if (status === 'published' || status === 'draft') { sets.push('status = ?'); params.push(status) }
  if (isValidAudience(audience)) { sets.push('audience = ?'); params.push(audience) }
  if (show_popup === 0 || show_popup === 1) { sets.push('show_popup = ?'); params.push(show_popup) }
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }

  params.push(id)
  const result = db.prepare(`UPDATE app_changelog SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  if (result.changes === 0) { res.status(404).json({ error: 'not found' }); return }
  res.json({ ok: true })
})

router.delete('/admin/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  if (!id) { res.status(400).json({ error: 'invalid id' }); return }
  const result = db.prepare(`DELETE FROM app_changelog WHERE id = ?`).run(id)
  if (result.changes === 0) { res.status(404).json({ error: 'not found' }); return }
  res.json({ ok: true })
})

// ─── Auto-draft from shipped feedback ────────────────────
// Called by the feedback PATCH route when an item transitions to
// 'shipped'. Creates a draft (never auto-publishes — an admin reviews
// the wording first) crediting the requester, deep-linking to the page
// the feedback was filed on, publish-dated tomorrow.

export function draftChangelogFromFeedback(feedbackId: number, createdBy: number): void {
  const f = db.prepare(
    `SELECT f.id, f.path, f.category, f.body, u.name AS user_name
     FROM app_feedback f LEFT JOIN users u ON u.id = f.user_id
     WHERE f.id = ?`
  ).get(feedbackId) as { id: number; path: string; category: string | null; body: string; user_name: string | null } | undefined
  if (!f) return

  // One draft per feedback item — re-shipping shouldn't duplicate.
  const existing = db.prepare(`SELECT id FROM app_changelog WHERE feedback_id = ?`).get(f.id)
  if (existing) return

  const category: Category = f.category === 'bug' ? 'fixed' : 'improved'
  const title = f.body.replace(/\s+/g, ' ').trim().slice(0, 120)
  db.prepare(
    `INSERT INTO app_changelog (publish_date, status, category, title, body, path, feedback_id, requested_by, created_by)
     VALUES (?, 'draft', ?, ?, '', ?, ?, ?, ?)`
  ).run(addDaysIso(officeTodayIso(), 1), category, title, f.path || null, f.id, f.user_name, createdBy)
}

export { router as changelogRouter }
