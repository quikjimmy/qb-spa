import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

// QB Intake Events table: bt4a8ypkq
//
//   1   Date Created
//   2   Date Modified
//   3   Record ID#
//   5   Last Modified By (auditor)
//   36  Related Project (numeric → project.record_id)   ← confirmed
//   40  Install Agreement
//   46  Finance
//   48  Utility Bill
//   55  Consumption Audit
//   58  Site Survey
//   61  Welcome Call
//   67  Adders
//   81  Finance Missing Items
//
// Intake decision (Approved / Rejected / Pending) lives on the PROJECT
// (project_cache.intake_status, fid 347) — not on each intake event —
// so the pill is rendered client-side from project data, not from this row.
const INTAKE_TABLE = 'bt4a8ypkq'
const F = {
  recordId: 3,
  dateCreated: 1,
  dateModified: 2,
  lastModifiedBy: 5,
  relatedProject: 36,
  installAgreement: 40,
  finance: 46,
  financeMissingItems: 81,
  utilityBill: 48,
  consumptionAudit: 55,
  siteSurvey: 58,
  welcomeCall: 61,
  adders: 67,
}
const SELECT_FIDS = [
  F.recordId, F.dateCreated, F.dateModified, F.lastModifiedBy,
  F.relatedProject,
  F.installAgreement, F.finance, F.financeMissingItems,
  F.utilityBill, F.consumptionAudit, F.siteSurvey, F.welcomeCall, F.adders,
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

// ── Cache ──
db.exec(`
  CREATE TABLE IF NOT EXISTS intake_event_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    date_created TEXT,
    date_modified TEXT,
    last_modified_by TEXT,
    install_agreement TEXT,
    finance TEXT,
    finance_missing_items TEXT,
    utility_bill TEXT,
    consumption_audit TEXT,
    site_survey TEXT,
    welcome_call TEXT,
    adders TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_intake_project ON intake_event_cache(project_rid)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_intake_created ON intake_event_cache(date_created DESC)`)

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
      from: INTAKE_TABLE,
      select: SELECT_FIDS,
      where: `{'${F.relatedProject}'.EX.'${projectId}'}`,
      sortBy: [{ fieldId: F.dateCreated, order: 'ASC' }],
      options: { top: 50 },
    }),
  })
  if (!res.ok) {
    throw new Error(`QB intake query failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { data?: Array<Record<string, { value: unknown }>> }
  const records = data.data ?? []

  const tx = db.transaction((rows: typeof records) => {
    db.prepare(`DELETE FROM intake_event_cache WHERE project_rid = ?`).run(projectId)
    const insert = db.prepare(`
      INSERT OR REPLACE INTO intake_event_cache (
        record_id, project_rid, date_created, date_modified, last_modified_by,
        install_agreement, finance, finance_missing_items,
        utility_bill, consumption_audit, site_survey, welcome_call, adders,
        cached_at
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
        userName(r, F.lastModifiedBy) || null,
        val(r, F.installAgreement) || null,
        val(r, F.finance) || null,
        val(r, F.financeMissingItems) || null,
        val(r, F.utilityBill) || null,
        val(r, F.consumptionAudit) || null,
        val(r, F.siteSurvey) || null,
        val(r, F.welcomeCall) || null,
        val(r, F.adders) || null,
      )
    }
  })
  tx(records)

  return { total: records.length }
}

// GET /api/intake?project_id=N
//   ?live=1 (default) refreshes from QB before responding. Same shape as
//   the other per-project caches (notes, adders, attachments).
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
        console.error('[intake] live refresh failed:', e instanceof Error ? e.message : e)
      }
    }
    const items = db.prepare(`
      SELECT record_id, project_rid, date_created, date_modified, last_modified_by,
             install_agreement, finance, finance_missing_items,
             utility_bill, consumption_audit, site_survey, welcome_call, adders
      FROM intake_event_cache
      WHERE project_rid = ?
      ORDER BY date_created ASC, record_id ASC
    `).all(projectId)
    res.json({ items, count: items.length })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as intakeRouter }
