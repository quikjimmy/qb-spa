import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

// QB adder table: bsaycczmf
//   3  Record ID#
//   10 Related Project (numeric → project record_id)
//   56 Product Name (formula text)
//   8  Total Cost (currency)
const ADDER_TABLE = 'bsaycczmf'
const fieldMap: Array<{ fid: number; col: string }> = [
  { fid: 3,  col: 'record_id' },
  { fid: 10, col: 'project_rid' },
  { fid: 56, col: 'product_name' },
  { fid: 8,  col: 'total_cost' },
]
const selectFids = fieldMap.map(f => f.fid)

function val(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}

// Local cache so per-project lookups stay snappy and don't hit QB on every page render.
db.exec(`
  CREATE TABLE IF NOT EXISTS adder_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    product_name TEXT,
    total_cost REAL,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_adder_project ON adder_cache(project_rid)`)

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
      from: ADDER_TABLE,
      select: selectFids,
      where: `{'10'.EX.'${projectId}'}`,
      options: { top: 1000 },
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QB adder query failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json() as { data?: Array<Record<string, { value: unknown }>> }
  const records = data.data ?? []

  // Replace this project's rows in cache atomically
  const tx = db.transaction((rows: typeof records) => {
    db.prepare(`DELETE FROM adder_cache WHERE project_rid = ?`).run(projectId)
    const insert = db.prepare(`
      INSERT OR REPLACE INTO adder_cache (record_id, project_rid, product_name, total_cost, cached_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `)
    for (const r of rows) {
      const rid = parseInt(val(r, 3))
      if (!rid) continue
      const projRid = parseInt(val(r, 10)) || projectId
      const cost = parseFloat(val(r, 8))
      insert.run(rid, projRid, val(r, 56), Number.isFinite(cost) ? cost : null)
    }
  })
  tx(records)

  return { total: records.length }
}

// GET /api/adders?project_id=N
//   ?live=1 (default) re-pulls from QB before responding so callers always
//   see fresh adder lists. Adder edits are infrequent; a one-time miss has
//   negligible cost vs. the stale risk on a $-relevant table.
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
        // Don't block the response on a QB miss — fall through to cache.
        console.error('[adders] live refresh failed:', e instanceof Error ? e.message : e)
      }
    }
    const items = db.prepare(`
      SELECT record_id, project_rid, product_name, total_cost
      FROM adder_cache
      WHERE project_rid = ?
      ORDER BY total_cost DESC, record_id ASC
    `).all(projectId)
    const totalCost = (items as Array<{ total_cost: number | null }>).reduce(
      (sum, r) => sum + (r.total_cost ?? 0), 0,
    )
    res.json({ items, count: items.length, total_cost: totalCost })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as addersRouter }
