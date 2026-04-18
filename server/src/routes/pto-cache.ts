import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return { realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com', token: process.env['QB_USER_TOKEN'] || '' }
}

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS pto_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    project_name TEXT,
    project_status TEXT,
    state TEXT,
    pto_status TEXT,
    pto_todo TEXT,
    blockers TEXT,
    blocker_tickets TEXT,
    open_tickets INTEGER DEFAULT 0,
    items_missing TEXT,
    pto_submitted TEXT,
    pto_approved TEXT,
    inspection_passed TEXT,
    install_completed TEXT,
    assigned_user TEXT,
    sla_start TEXT,
    sla_biz_days REAL,
    sla_met INTEGER,
    rejection_count INTEGER DEFAULT 0,
    rejection_date TEXT,
    rejection_reason TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

const fieldMap: Array<{ fid: number; col: string }> = [
  { fid: 3, col: 'record_id' },
  { fid: 28, col: 'project_rid' },
  { fid: 30, col: 'project_name' },
  { fid: 66, col: 'project_status' },
  { fid: 67, col: 'state' },
  { fid: 91, col: 'pto_status' },
  { fid: 111, col: 'pto_todo' },
  { fid: 154, col: 'blockers' },
  { fid: 146, col: 'blocker_tickets' },
  { fid: 145, col: 'open_tickets' },
  { fid: 109, col: 'items_missing' },
  { fid: 17, col: 'pto_submitted' },
  { fid: 23, col: 'pto_approved' },
  { fid: 64, col: 'inspection_passed' },
  { fid: 65, col: 'install_completed' },
  { fid: 116, col: 'assigned_user' },
  { fid: 137, col: 'sla_start' },
  { fid: 141, col: 'sla_biz_days' },
  { fid: 157, col: 'sla_met' },
  { fid: 160, col: 'rejection_count' },
  { fid: 161, col: 'rejection_date' },
  { fid: 162, col: 'rejection_reason' },
]

const selectFids = fieldMap.map(f => f.fid)

function val(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'object' && 'name' in (v as Record<string, unknown>)) return (v as { name: string }).name
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

async function refreshCache(): Promise<{ total: number; duration: number }> {
  const start = Date.now()
  const { realm, token } = getQbConfig()

  let allRecords: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000

  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: { 'QB-Realm-Hostname': realm, 'Authorization': `QB-USER-TOKEN ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'bsc9kt8n5', select: selectFids, options: { skip, top: batchSize } }),
    })
    if (!res.ok) throw new Error(`QB query failed (${res.status})`)
    const data = await res.json()
    allRecords = allRecords.concat(data.data || [])
    if ((data.data || []).length < batchSize) break
    skip += batchSize
  }

  db.prepare('DELETE FROM pto_cache').run()

  const cols = fieldMap.map(f => f.col).join(', ')
  const placeholders = fieldMap.map(() => '?').join(', ')
  const upsert = db.prepare(`INSERT OR REPLACE INTO pto_cache (${cols}, cached_at) VALUES (${placeholders}, datetime('now'))`)

  db.transaction(() => {
    for (const record of allRecords) {
      const rid = parseInt(val(record, 3))
      if (!rid) continue
      const values = fieldMap.map(f => {
        if (f.col === 'project_rid') return parseInt(val(record, f.fid)) || null
        if (f.col === 'open_tickets' || f.col === 'rejection_count') return parseInt(val(record, f.fid)) || 0
        if (f.col === 'sla_biz_days') return parseFloat(val(record, f.fid)) || null
        if (f.col === 'sla_met') return val(record, f.fid) === 'true' || val(record, f.fid) === '1' ? 1 : 0
        return val(record, f.fid)
      })
      upsert.run(...values)
    }
  })()

  return { total: allRecords.length, duration: Date.now() - start }
}

// Refresh
router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  const { token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }
  try { const result = await refreshCache(); res.json({ success: true, ...result }) }
  catch (err) { res.status(500).json({ error: String(err) }) }
})

// Get PTO records with blockers
router.get('/', (req: Request, res: Response): void => {
  const state = req.query['state'] as string | undefined
  const assignedUser = req.query['assigned_user'] as string | undefined
  const epc = req.query['epc'] as string | undefined
  const lender = req.query['lender'] as string | undefined
  const hasBlockers = req.query['has_blockers'] === '1'
  const needsSub = req.query['needs_sub'] === '1'
  const stale = req.query['stale'] === '1'
  const limit = Math.min(parseInt(req.query['limit'] as string) || 100, 500)

  const has = (c: string) => `(${c} IS NOT NULL AND ${c} != '' AND ${c} != '0' AND ${c} != '[]')`
  const noV = (c: string) => `(${c} IS NULL OR ${c} = '' OR ${c} = '0')`

  // Base where applies to both items and stats
  let baseWhere = "WHERE (LOWER(p.project_status) = 'active' OR LOWER(p.project_status) LIKE '%hold%')"
  const baseParams: unknown[] = []

  if (state) { baseWhere += ' AND p.state = ?'; baseParams.push(state) }
  if (assignedUser) { baseWhere += ' AND p.assigned_user = ?'; baseParams.push(assignedUser) }
  // Join to project_cache for EPC and lender filters
  if (epc || lender) {
    baseWhere = baseWhere.replace('WHERE', 'LEFT JOIN project_cache pc ON pc.record_id = p.project_rid WHERE')
    if (epc) { baseWhere += ' AND pc.epc = ?'; baseParams.push(epc) }
    if (lender) { baseWhere += ' AND pc.lender = ?'; baseParams.push(lender) }
  }

  // Item-specific filters
  let itemWhere = baseWhere
  const itemParams = [...baseParams]
  if (hasBlockers) { itemWhere += ` AND ${has('p.blockers')}` }
  if (needsSub) { itemWhere += ` AND ${has('p.inspection_passed')} AND ${noV('p.pto_submitted')}` }
  if (stale) { itemWhere += ` AND ${has('p.pto_submitted')} AND ${noV('p.pto_approved')}` }

  const items = db.prepare(`SELECT p.* FROM pto_cache p ${itemWhere} ORDER BY p.record_id DESC LIMIT ?`).all(...itemParams, limit)
  const total = (db.prepare(`SELECT COUNT(*) as c FROM pto_cache p ${itemWhere}`).get(...itemParams) as { c: number }).c

  // Stats use same base filters (state, user, epc, lender) but not the blocker/needs_sub/stale filter
  const blocked = (db.prepare(`SELECT COUNT(*) as c FROM pto_cache p ${baseWhere} AND ${has('p.blockers')}`).get(...baseParams) as { c: number }).c
  const slaMissed = (db.prepare(`SELECT COUNT(*) as c FROM pto_cache p ${baseWhere} AND p.sla_met = 0 AND ${has('p.inspection_passed')} AND ${has('p.pto_submitted')}`).get(...baseParams) as { c: number }).c
  const rejected = (db.prepare(`SELECT COUNT(*) as c FROM pto_cache p ${baseWhere} AND p.rejection_count > 0 AND ${noV('p.pto_approved')}`).get(...baseParams) as { c: number }).c
  const withOpenTickets = (db.prepare(`SELECT COUNT(*) as c FROM pto_cache p ${baseWhere} AND p.open_tickets > 0 AND ${noV('p.pto_approved')}`).get(...baseParams) as { c: number }).c

  const assignedUsers = db.prepare("SELECT DISTINCT assigned_user as value FROM pto_cache WHERE assigned_user != '' ORDER BY assigned_user").all() as Array<{ value: string }>

  res.json({
    items, total,
    stats: { blocked, slaMissed, rejected, withOpenTickets },
    filters: { assignedUsers: assignedUsers.map(u => u.value) },
  })
})

export { router as ptoCacheRouter }
