import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

// QB Retention table: bt26x67sf
//
// Drives the optional "Retention" milestone at the end of the project's
// milestone strip — appears whenever a project has ever been in any
// cancel-adjacent state (Pending Cancel, Cancelled, ROR, ARC, Lost).
//
// One project may have multiple retention rows over time (re-cancels). We
// pull all of them; the client picks the most recent for the strip dot
// and shows the full timeline in the detail card.
const RETENTION_TABLE = 'bt26x67sf'
const F = {
  recordId: 3,
  dateCreated: 1,
  // Cancel request — drives the "when was the request made" date on the dot
  cancelRequestedBy: 6,
  cancelRequestSystemDate: 7,
  cancelNote: 8,
  cancelReasonDropdown: 9,
  officialRequestedDate: 18,
  isRorRequest: 26,
  // Pending cancel state
  requestStatus: 32,
  timeSinceRequest: 24,
  recentAttemptNote: 81,
  totalOutreaches: 77,
  successfulContacts: 78,
  attemptedContacts: 25,
  attemptsSinceLastContact: 65,
  lastOutreachTimestamp: 73,
  lastContactTimestamp: 74,
  nextOutreachDue: 64,
  // Closeout (final outcome)
  resolutionType: 27,
  resolvedAt: 76,
  closeoutCancelReason: 89,
  resolutionNote: 42,
  cancelFee: 31,
  cancelFeeAdjustment: 30,
  waiveCancelFee: 28,
  // Project context
  preCancelStatus: 122,
  maxProjectProgress: 116,
  relatedProject: 10,
}
const SELECT_FIDS = [
  F.recordId, F.dateCreated,
  F.cancelRequestedBy, F.cancelRequestSystemDate, F.cancelNote,
  F.cancelReasonDropdown, F.officialRequestedDate, F.isRorRequest,
  F.requestStatus, F.recentAttemptNote,
  F.totalOutreaches, F.successfulContacts, F.attemptedContacts,
  F.attemptsSinceLastContact, F.lastOutreachTimestamp, F.lastContactTimestamp,
  F.nextOutreachDue,
  F.resolutionType, F.resolvedAt, F.closeoutCancelReason, F.resolutionNote,
  F.cancelFee, F.cancelFeeAdjustment, F.waiveCancelFee,
  F.preCancelStatus, F.maxProjectProgress,
  F.relatedProject,
]

function val(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}
function userName(record: Record<string, { value: unknown }>, fid: number): string {
  const raw = record[String(fid)]?.value
  if (raw && typeof raw === 'object' && 'name' in (raw as Record<string, unknown>)) {
    return String((raw as { name: string }).name ?? '')
  }
  return val(record, fid)
}
function multiText(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).join(', ')
  return val(record, fid)
}

// ── Cache ──
db.exec(`
  CREATE TABLE IF NOT EXISTS retention_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    date_created TEXT,
    cancel_requested_by TEXT,
    cancel_request_at TEXT,
    cancel_note TEXT,
    cancel_reason TEXT,
    official_requested_date TEXT,
    is_ror INTEGER,
    request_status TEXT,
    recent_attempt_note TEXT,
    total_outreaches INTEGER,
    successful_contacts INTEGER,
    attempted_contacts INTEGER,
    attempts_since_last_contact INTEGER,
    last_outreach_at TEXT,
    last_contact_at TEXT,
    next_outreach_due TEXT,
    resolution_type TEXT,
    resolved_at TEXT,
    closeout_cancel_reason TEXT,
    resolution_note TEXT,
    cancel_fee REAL,
    cancel_fee_adjustment REAL,
    waive_cancel_fee INTEGER,
    pre_cancel_status TEXT,
    max_project_progress TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_retention_project ON retention_cache(project_rid)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_retention_request ON retention_cache(cancel_request_at DESC)`)

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
      from: RETENTION_TABLE,
      select: SELECT_FIDS,
      where: `{'${F.relatedProject}'.EX.'${projectId}'}`,
      sortBy: [{ fieldId: F.cancelRequestSystemDate, order: 'ASC' }],
      options: { top: 50 },
    }),
  })
  if (!res.ok) {
    throw new Error(`QB retention query failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { data?: Array<Record<string, { value: unknown }>> }
  const records = data.data ?? []

  const tx = db.transaction((rows: typeof records) => {
    db.prepare(`DELETE FROM retention_cache WHERE project_rid = ?`).run(projectId)
    const insert = db.prepare(`
      INSERT OR REPLACE INTO retention_cache (
        record_id, project_rid, date_created,
        cancel_requested_by, cancel_request_at, cancel_note, cancel_reason,
        official_requested_date, is_ror,
        request_status, recent_attempt_note,
        total_outreaches, successful_contacts, attempted_contacts,
        attempts_since_last_contact, last_outreach_at, last_contact_at,
        next_outreach_due,
        resolution_type, resolved_at, closeout_cancel_reason, resolution_note,
        cancel_fee, cancel_fee_adjustment, waive_cancel_fee,
        pre_cancel_status, max_project_progress, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
    const num = (s: string): number | null => {
      const n = parseFloat(s); return Number.isFinite(n) ? n : null
    }
    for (const r of rows) {
      const rid = parseInt(val(r, F.recordId))
      if (!rid) continue
      const projRid = parseInt(val(r, F.relatedProject)) || projectId
      insert.run(
        rid, projRid,
        val(r, F.dateCreated) || null,
        userName(r, F.cancelRequestedBy) || null,
        val(r, F.cancelRequestSystemDate) || null,
        val(r, F.cancelNote) || null,
        multiText(r, F.cancelReasonDropdown) || null,
        val(r, F.officialRequestedDate) || null,
        val(r, F.isRorRequest) === 'true' ? 1 : 0,
        val(r, F.requestStatus) || null,
        val(r, F.recentAttemptNote) || null,
        num(val(r, F.totalOutreaches)),
        num(val(r, F.successfulContacts)),
        num(val(r, F.attemptedContacts)),
        num(val(r, F.attemptsSinceLastContact)),
        val(r, F.lastOutreachTimestamp) || null,
        val(r, F.lastContactTimestamp) || null,
        val(r, F.nextOutreachDue) || null,
        val(r, F.resolutionType) || null,
        val(r, F.resolvedAt) || null,
        multiText(r, F.closeoutCancelReason) || null,
        val(r, F.resolutionNote) || null,
        num(val(r, F.cancelFee)),
        num(val(r, F.cancelFeeAdjustment)),
        val(r, F.waiveCancelFee) === 'true' ? 1 : 0,
        val(r, F.preCancelStatus) || null,
        val(r, F.maxProjectProgress) || null,
      )
    }
  })
  tx(records)

  return { total: records.length }
}

// GET /api/retention?project_id=N
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
        console.error('[retention] live refresh failed:', e instanceof Error ? e.message : e)
      }
    }
    const items = db.prepare(`
      SELECT *
      FROM retention_cache
      WHERE project_rid = ?
      ORDER BY cancel_request_at DESC, record_id DESC
    `).all(projectId)
    res.json({ items, count: items.length })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as retentionRouter }
