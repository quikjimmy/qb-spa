import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

// QB Notes table: bsb6bqt3b
//   1   Date Created
//   2   Date Modified
//   3   Record ID#
//   4   Record Owner (user)
//   5   Last Modified By (user)
//   6   Note (multi-line text)
//   7   Category (one of the predefined choices: Intake, Finance, Survey, …)
//   10  Notify PM (checkbox)
//   11  Notify Rep (checkbox)
//   13  Related Project (numeric → project record_id)
const NOTES_TABLE = 'bsb6bqt3b'
const F = {
  recordId: 3,
  dateCreated: 1,
  dateModified: 2,
  recordOwner: 4,
  lastModifiedBy: 5,
  note: 6,
  category: 7,
  notifyPm: 10,
  notifyRep: 11,
  relatedProject: 13,
}
const SELECT_FIDS = [
  F.recordId, F.dateCreated, F.dateModified, F.recordOwner, F.lastModifiedBy,
  F.note, F.category, F.notifyPm, F.notifyRep, F.relatedProject,
]

function val(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}
// QB user fields come back as { name, email, id } — extract `name`.
function userName(record: Record<string, { value: unknown }>, fid: number): string {
  const raw = record[String(fid)]?.value
  if (raw && typeof raw === 'object' && 'name' in (raw as Record<string, unknown>)) {
    return String((raw as { name: string }).name ?? '')
  }
  return val(record, fid)
}

// Local cache so per-project lookups stay snappy.
db.exec(`
  CREATE TABLE IF NOT EXISTS note_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    date_created TEXT,
    date_modified TEXT,
    record_owner TEXT,
    last_modified_by TEXT,
    note TEXT,
    category TEXT,
    notify_pm INTEGER,
    notify_rep INTEGER,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_note_project ON note_cache(project_rid)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_note_created ON note_cache(date_created DESC)`)

async function refreshForProject(projectId: number): Promise<{ total: number }> {
  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const res = await fetch('https://api.quickbase.com/v1/records/query', {
    method: 'POST',
    headers: {
      'QB-Realm-Hostname': realm,
      'Authorization': `QB-USER-TOKEN ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: NOTES_TABLE,
      select: SELECT_FIDS,
      where: `{'${F.relatedProject}'.EX.'${projectId}'}`,
      sortBy: [{ fieldId: F.dateCreated, order: 'DESC' }],
      options: { top: 500 },
    }),
  })
  if (!res.ok) {
    throw new Error(`QB notes query failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { data?: Array<Record<string, { value: unknown }>> }
  const records = data.data ?? []

  const tx = db.transaction((rows: typeof records) => {
    db.prepare(`DELETE FROM note_cache WHERE project_rid = ?`).run(projectId)
    const insert = db.prepare(`
      INSERT OR REPLACE INTO note_cache (
        record_id, project_rid, date_created, date_modified,
        record_owner, last_modified_by, note, category,
        notify_pm, notify_rep, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
    for (const r of rows) {
      const rid = parseInt(val(r, F.recordId))
      if (!rid) continue
      const projRid = parseInt(val(r, F.relatedProject)) || projectId
      insert.run(
        rid, projRid,
        val(r, F.dateCreated) || null,
        val(r, F.dateModified) || null,
        userName(r, F.recordOwner) || null,
        userName(r, F.lastModifiedBy) || null,
        val(r, F.note) || null,
        val(r, F.category) || null,
        val(r, F.notifyPm) === 'true' ? 1 : 0,
        val(r, F.notifyRep) === 'true' ? 1 : 0,
      )
    }
  })
  tx(records)

  return { total: records.length }
}

// GET /api/notes?project_id=N
//   ?live=1 (default) refreshes from QB before responding.
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const projectId = parseInt(String(req.query['project_id'] || ''), 10)
  if (!Number.isFinite(projectId) || projectId <= 0) {
    res.status(400).json({ error: 'project_id is required' })
    return
  }
  const live = req.query['live'] !== '0'
  try {
    if (live) {
      try { await refreshForProject(projectId) }
      catch (e) {
        console.error('[notes] live refresh failed:', e instanceof Error ? e.message : e)
      }
    }
    const items = db.prepare(`
      SELECT record_id, project_rid, date_created, date_modified,
             record_owner, last_modified_by, note, category,
             notify_pm, notify_rep
      FROM note_cache
      WHERE project_rid = ?
      ORDER BY date_created DESC, record_id DESC
    `).all(projectId)
    res.json({ items, count: items.length })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as notesRouter }
