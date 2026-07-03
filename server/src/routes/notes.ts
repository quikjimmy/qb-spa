import { Router, type Request, type Response } from 'express'
import db from '../db'
import { denyReferralAgent } from '../lib/referralAgent'
import { resolveMentionInputs } from './feed'

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
//   8   Date (timestamp — the QB form defaults it to "now"; that default is
//       form-level, so API writes must set it explicitly)
//   9   Note by (user)
//   10  Notify PM (checkbox)
//   11  Notify Rep (checkbox)
//   13  Related Project (numeric → project record_id)
//   45  Additional (Multi) (multiuser — the "Select up to 20 people" picker)
//   141 Visible to Rep ('Rep Visible' | 'Internal Only')
//   149 Thread ID (text — verified unused by any QB form/report/pipeline as
//       of 2026-07-03; the portal claims it for reply threading: a reply
//       carries the ROOT note's record id here, roots leave it empty)
const NOTES_TABLE = 'bsb6bqt3b'
const F = {
  recordId: 3,
  dateCreated: 1,
  dateModified: 2,
  recordOwner: 4,
  lastModifiedBy: 5,
  note: 6,
  category: 7,
  date: 8,
  noteBy: 9,
  notifyPm: 10,
  notifyRep: 11,
  relatedProject: 13,
  additional: 45,
  visibleToRep: 141,
  threadId: 149,
}
const SELECT_FIDS = [
  F.recordId, F.dateCreated, F.dateModified, F.recordOwner, F.lastModifiedBy,
  F.note, F.category, F.noteBy, F.notifyPm, F.notifyRep, F.relatedProject,
  F.visibleToRep, F.threadId,
]

// Choice list fetched live from QB 2026-07-03 (25 choices, allowNewChoices=false).
// 'Status Update' is deliberately EXCLUDED: that category drives a QB webhook
// workflow that changes the project's status via New Status (FID 96) — portal
// notes must never trigger it. Never write FID 96 from here either.
const CATEGORIES = [
  'Intake', 'Finance', 'Survey', 'Design', 'MSP Change', 'NEM', 'Permitting',
  'HOA', 'Installation', 'Install Completion', 'Inspection', 'PTO',
  'Commissioning', 'Extra charges', 'Tickets', 'Issues', 'Loose Ends', 'Sales',
  'Cancellation', 'Retention', 'PC Outreach', 'Sales Aid', 'Funding',
  'Licensing & Registration',
]
const VISIBILITIES = ['Internal Only', 'Rep Visible']

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
{
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(note_cache)`).all() as Array<{ name: string }>).map(c => c.name)
  )
  if (!cols.has('note_by')) db.exec(`ALTER TABLE note_cache ADD COLUMN note_by TEXT`)
  if (!cols.has('visible_to_rep')) db.exec(`ALTER TABLE note_cache ADD COLUMN visible_to_rep TEXT`)
  if (!cols.has('thread_id')) db.exec(`ALTER TABLE note_cache ADD COLUMN thread_id INTEGER`)
}

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
        notify_pm, notify_rep, note_by, visible_to_rep, thread_id, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        userName(r, F.noteBy) || null,
        val(r, F.visibleToRep) || null,
        parseInt(val(r, F.threadId)) || null,
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
             notify_pm, notify_rep, note_by, visible_to_rep, thread_id
      FROM note_cache
      WHERE project_rid = ?
      ORDER BY date_created DESC, record_id DESC
    `).all(projectId)
    res.json({ items, count: items.length })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// In-app notifications for @mentions in a note body. Mentions arrive as
// structured {type:'user'|'department', id} pairs (validated against the
// DB by resolveMentionInputs — department mentions fan out to members).
// Runs after the QB create succeeds; failures only log, never fail the post.
function notifyNoteMentions(opts: {
  mentionsRaw: unknown
  authorUserId: number | undefined
  authorName: string
  projectId: number
  noteText: string
}): number {
  const { notifyUserIds } = resolveMentionInputs(opts.mentionsRaw)
  if (notifyUserIds.size === 0) return 0
  const proj = db.prepare(`SELECT customer_name FROM project_cache WHERE record_id = ? LIMIT 1`)
    .get(opts.projectId) as { customer_name: string | null } | undefined
  const where = proj?.customer_name ? ` on ${proj.customer_name}` : ''
  const preview = opts.noteText.length > 140 ? opts.noteText.slice(0, 139) + '…' : opts.noteText
  const insert = db.prepare(`
    INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
    VALUES (?, 'note_mention', ?, ?, ?, 0, datetime('now'))
  `)
  let sent = 0
  for (const uid of notifyUserIds) {
    if (uid === opts.authorUserId) continue  // don't ping yourself
    try {
      insert.run(uid, `${opts.authorName} mentioned you in a note${where}`, preview, `/projects/${opts.projectId}#notes`)
      sent++
    } catch (e) {
      console.error('[notes] mention notification failed:', e instanceof Error ? e.message : e)
    }
  }
  return sent
}

// POST /api/notes — create a note on the QB Notes table.
// Body: { project_id, note, category, visible_to_rep?, notify_pm?,
//         notify_rep?, mentions?: Array<{type:'user'|'department', id:number}> }
// (QB's "Additional" email picker was dropped from the portal — @mentions
// in the note body cover targeted notification via the in-app bell.)
//
// Attribution: Note by (fid 9) is set to the portal user's email. QB user
// fields only resolve emails that belong to QB users — if QB rejects the
// record for that reason, we retry once without the user fields and fold
// the author's name into the note text so attribution isn't lost.
router.post('/', denyReferralAgent, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.userId
  const body = (req.body ?? {}) as Record<string, unknown>

  const projectId = parseInt(String(body['project_id'] ?? ''), 10)
  const noteText = String(body['note'] ?? '').trim()
  const replyTo = parseInt(String(body['reply_to'] ?? ''), 10) || null
  let category = String(body['category'] ?? '')
  let visibleToRep = String(body['visible_to_rep'] ?? 'Internal Only')
  let notifyPm = body['notify_pm'] === true
  let notifyRep = body['notify_rep'] === true

  if (!Number.isFinite(projectId) || projectId <= 0) {
    res.status(400).json({ error: 'project_id is required' }); return
  }
  if (!noteText) { res.status(400).json({ error: 'note text is required' }); return }

  // Replies inherit the ROOT note's category + visibility (a thread can
  // never widen its audience) and never fire the QB email notifications.
  // Thread key = root record id in FID 149; replying to a reply flattens
  // onto the same root.
  interface CachedNote {
    record_id: number; thread_id: number | null; category: string | null
    visible_to_rep: string | null; note_by: string | null; record_owner: string | null
  }
  const noteRow = db.prepare(`
    SELECT record_id, thread_id, category, visible_to_rep, note_by, record_owner
    FROM note_cache WHERE record_id = ? AND project_rid = ?
  `)
  let threadRootId: number | null = null
  let rootNote: CachedNote | null = null
  if (replyTo) {
    let parent = noteRow.get(replyTo, projectId) as CachedNote | undefined
    if (!parent) {
      try { await refreshForProject(projectId) } catch { /* fall through to 404 */ }
      parent = noteRow.get(replyTo, projectId) as CachedNote | undefined
    }
    if (!parent) {
      res.status(404).json({ error: 'note to reply to was not found on this project' }); return
    }
    threadRootId = parent.thread_id || parent.record_id
    rootNote = threadRootId === parent.record_id
      ? parent
      : ((noteRow.get(threadRootId, projectId) as CachedNote | undefined) ?? parent)
    if (rootNote.category === 'Status Update') {
      // Reserved for the QB status-change workflow — keep threads out of it.
      res.status(400).json({ error: 'replies to status-change notes are not supported' }); return
    }
    category = rootNote.category || 'Issues'
    visibleToRep = VISIBILITIES.includes(rootNote.visible_to_rep ?? '') ? rootNote.visible_to_rep! : 'Internal Only'
    notifyPm = false
    notifyRep = false
  } else {
    if (!CATEGORIES.includes(category)) {
      res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }); return
    }
    if (!VISIBILITIES.includes(visibleToRep)) {
      res.status(400).json({ error: `visible_to_rep must be one of: ${VISIBILITIES.join(', ')}` }); return
    }
  }

  const { realm, token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }

  const author = db.prepare(`SELECT name, email FROM users WHERE id = ?`).get(userId) as
    { name: string | null; email: string } | undefined

  const baseFields: Record<string, { value: unknown }> = {
    [String(F.relatedProject)]: { value: projectId },
    [String(F.note)]: { value: noteText },
    [String(F.category)]: { value: category },
    [String(F.visibleToRep)]: { value: visibleToRep },
    [String(F.notifyPm)]: { value: notifyPm },
    [String(F.notifyRep)]: { value: notifyRep },
    [String(F.date)]: { value: new Date().toISOString() },
  }
  if (threadRootId) baseFields[String(F.threadId)] = { value: String(threadRootId) }
  const userFields: Record<string, { value: unknown }> = {}
  if (author?.email) userFields[String(F.noteBy)] = { value: { email: author.email } }

  async function createNote(fields: Record<string, { value: unknown }>) {
    const response = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: NOTES_TABLE,
        data: [fields],
        fieldsToReturn: [F.recordId],
      }),
    })
    const json = await response.json().catch(() => ({})) as {
      metadata?: { createdRecordIds?: number[]; lineErrors?: Record<string, string[]> }
    }
    const lineErrors = json.metadata?.lineErrors
    const createdId = json.metadata?.createdRecordIds?.[0]
    const ok = response.ok && createdId !== undefined && (!lineErrors || Object.keys(lineErrors).length === 0)
    return { ok, status: response.status, createdId, json }
  }

  try {
    let attempt = await createNote({ ...baseFields, ...userFields })
    let attributionFallback = false

    // Retry without the user fields only when they were the likely culprit.
    if (!attempt.ok && Object.keys(userFields).length > 0) {
      attributionFallback = true
      const fallbackNote = author?.name || author?.email
        ? `${noteText}\n\n— ${author.name || author.email} (via portal)`
        : noteText
      attempt = await createNote({ ...baseFields, [String(F.note)]: { value: fallbackNote } })
    }

    if (!attempt.ok) {
      res.status(attempt.status >= 400 && attempt.status < 500 ? attempt.status : 502)
        .json({ error: 'QB note create failed', details: attempt.json })
      return
    }

    try { await refreshForProject(projectId) }
    catch (e) {
      console.error('[notes] post-create refresh failed:', e instanceof Error ? e.message : e)
    }

    const mentionsNotified = notifyNoteMentions({
      mentionsRaw: body['mentions'],
      authorUserId: userId,
      authorName: author?.name || author?.email || 'Someone',
      projectId,
      noteText,
    })

    // Replies also ping the root note's author (best-effort: QB gives us
    // the author's display name, matched against portal users by name).
    if (rootNote) {
      try {
        const rootAuthorName = rootNote.note_by || rootNote.record_owner
        if (rootAuthorName) {
          const rootUser = db.prepare(
            `SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND is_active = 1 LIMIT 1`
          ).get(rootAuthorName) as { id: number } | undefined
          if (rootUser && rootUser.id !== userId) {
            const proj = db.prepare(`SELECT customer_name FROM project_cache WHERE record_id = ? LIMIT 1`)
              .get(projectId) as { customer_name: string | null } | undefined
            const where = proj?.customer_name ? ` on ${proj.customer_name}` : ''
            const preview = noteText.length > 140 ? noteText.slice(0, 139) + '…' : noteText
            db.prepare(`
              INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
              VALUES (?, 'note_reply', ?, ?, ?, 0, datetime('now'))
            `).run(rootUser.id, `${author?.name || 'Someone'} replied to your note${where}`, preview, `/projects/${projectId}#notes`)
          }
        }
      } catch (e) {
        console.error('[notes] reply notification failed:', e instanceof Error ? e.message : e)
      }
    }

    res.json({ ok: true, record_id: attempt.createdId, attribution_fallback: attributionFallback, mentions_notified: mentionsNotified })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// PATCH /api/notes/:id — edit a note's text. Author or admin only.
// Body: { note: string, mentions?: [{type,id}] } — mentions here are only
// the ones PICKED during the edit session (client tracks them), so people
// already @'d in the original text aren't re-pinged on every edit.
// Text is the only editable field: category and
// visibility stay fixed after posting (replies inherited them from the
// root at creation, so changing them later would desync threads).
// Authorship is matched by name (QB gives us the author's display name;
// the service token owns the record, so Record Owner can't be used).
router.patch('/:id', denyReferralAgent, async (req: Request, res: Response): Promise<void> => {
  const noteId = parseInt(String(req.params['id'] ?? ''), 10)
  const noteText = String((req.body ?? {})['note'] ?? '').trim()
  if (!Number.isFinite(noteId) || noteId <= 0) {
    res.status(400).json({ error: 'note id is required' }); return
  }
  if (!noteText) { res.status(400).json({ error: 'note text is required' }); return }

  const cached = db.prepare(`
    SELECT record_id, project_rid, note_by, record_owner FROM note_cache WHERE record_id = ?
  `).get(noteId) as { record_id: number; project_rid: number; note_by: string | null; record_owner: string | null } | undefined
  if (!cached) { res.status(404).json({ error: 'note not found' }); return }

  // Match requireRole semantics: a department-scoped admin (View-as mode)
  // loses the admin bypass and edits only their own notes.
  const scoped = req.user?.actAsDepartmentId != null
  const isAdmin = !scoped && req.user?.roles.includes('admin') === true
  if (!isAdmin) {
    const me = db.prepare(`SELECT name FROM users WHERE id = ?`).get(req.user?.userId) as { name: string | null } | undefined
    const authorName = (cached.note_by || cached.record_owner || '').trim().toLowerCase()
    const myName = (me?.name || '').trim().toLowerCase()
    if (!authorName || !myName || authorName !== myName) {
      res.status(403).json({ error: 'only the note author or an admin can edit a note' }); return
    }
  }

  const { realm, token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }

  try {
    const response = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: NOTES_TABLE,
        mergeFieldId: F.recordId,
        data: [{
          [String(F.recordId)]: { value: noteId },
          [String(F.note)]: { value: noteText },
        }],
        fieldsToReturn: [F.recordId, F.dateModified],
      }),
    })
    const json = await response.json().catch(() => ({})) as {
      metadata?: { lineErrors?: Record<string, string[]> }
    }
    const lineErrors = json.metadata?.lineErrors
    if (!response.ok || (lineErrors && Object.keys(lineErrors).length > 0)) {
      res.status(response.ok ? 502 : response.status).json({ error: 'QB note update failed', details: json })
      return
    }

    try { await refreshForProject(cached.project_rid) }
    catch (e) {
      console.error('[notes] post-edit refresh failed:', e instanceof Error ? e.message : e)
    }

    const editor = db.prepare(`SELECT name, email FROM users WHERE id = ?`).get(req.user?.userId) as
      { name: string | null; email: string } | undefined
    const mentionsNotified = notifyNoteMentions({
      mentionsRaw: (req.body ?? {})['mentions'],
      authorUserId: req.user?.userId,
      authorName: editor?.name || editor?.email || 'Someone',
      projectId: cached.project_rid,
      noteText,
    })

    res.json({ ok: true, record_id: noteId, mentions_notified: mentionsNotified })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as notesRouter }
