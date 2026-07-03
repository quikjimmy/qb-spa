// TOA material-order integration — "MD" (Material Delivered) stage for
// install tiles.
//
// TOA (the distributor ordering platform) posts webhooks into QB table
// bvf3ydgnq (TOA Order Webhook Storage). Each row is one event:
//   ORDER_CREATED                              → material ordered
//   STATUS_CHANGED  eventInfo.newStatus:
//     CONFIRMED                                → distributor confirmed
//     DELIVERED (+ order.deliveryTimestamp)    → material on site
//   AGREEMENT_CHANGED                          → BOM/pricing churn, no status
//
// We sync incrementally by record-id watermark into toa_order_cache
// (one row per project, latest-event-wins) and expose a per-project
// lookup that the field / PC-dashboard / project-detail endpoints
// attach to their payloads.

import { Router, type Request, type Response } from 'express'
import cron from 'node-cron'
import db from '../db'
import { isAppActive } from '../lib/activity'

const router = Router()

const TOA_TABLE = 'bvf3ydgnq'
const TF = {
  recordId: 3,
  poNumber: 8,
  installationDate: 10,
  distributorName: 12,
  eventType: 13,
  rawWebhook: 14,
  relatedProject: 15,
  createdAt: 1,
} as const

db.exec(`
  CREATE TABLE IF NOT EXISTS toa_order_cache (
    project_rid INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    status_at TEXT,
    delivered_at TEXT,
    po_number TEXT,
    distributor TEXT,
    installation_date TEXT,
    last_event_rid INTEGER NOT NULL DEFAULT 0,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS toa_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    watermark INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT
  )
`)
db.exec(`INSERT OR IGNORE INTO toa_sync_state (id, watermark) VALUES (1, 0)`)

export type ToaStatus = 'ordered' | 'confirmed' | 'delivered'

export interface ToaState {
  status: ToaStatus
  statusAt: string
  deliveredAt: string
  poNumber: string
  distributor: string
  installationDate: string
}

function getQbConfig() {
  return {
    realm: process.env['QB_REALM'] || process.env['QB_REALM_HOSTNAME'] || '',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

interface QbRec { [fid: string]: { value: unknown } }

async function qbQueryAll(body: Record<string, unknown>): Promise<QbRec[]> {
  const { realm, token } = getQbConfig()
  let all: QbRec[] = []
  let skip = 0
  const top = 1000
  while (true) {
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, options: { ...(body['options'] as object || {}), skip, top } }),
    })
    if (!res.ok) throw new Error(`QB TOA query failed (${res.status}): ${await res.text()}`)
    const data = await res.json() as { data?: QbRec[] }
    const rows = data.data || []
    all = all.concat(rows)
    if (rows.length < top) break
    skip += top
  }
  return all
}

function str(r: QbRec, fid: number): string {
  const v = r[String(fid)]?.value
  return v === null || v === undefined ? '' : String(v)
}

// Map one webhook payload to a material status. `order.status` rides on
// every event (quote states, CONFIRMED, DELIVERED); STATUS_CHANGED
// additionally carries eventInfo.newStatus, which wins when present.
// Verified vocabulary (2026-07): WAITING_FOR_QUOTE / Ready to Quote /
// WAITING_FOR_QUOTE_APPROVAL (pre-confirmation) → ordered;
// CONFIRMED → confirmed; DELIVERED → delivered.
function eventStatus(eventType: string, raw: { eventInfo?: { newStatus?: string }; order?: { status?: string } } | null): ToaStatus | null {
  const s = String(raw?.eventInfo?.newStatus || raw?.order?.status || '').toUpperCase()
  if (s === 'DELIVERED') return 'delivered'
  if (s === 'CONFIRMED') return 'confirmed'
  if (s) return 'ordered'                          // any quote/pre-confirmation state
  if (eventType === 'ORDER_CREATED') return 'ordered'
  return null                                       // unparseable payload with no signal
}

// Incremental sync: pull events past the record-id watermark, raw
// payload included (needed on every event — order.status is the primary
// state signal). Backfill is one-time; steady-state pulls are tiny.
export async function syncToaOrders(): Promise<{ events: number; projects: number; watermark: number }> {
  const state = db.prepare(`SELECT watermark FROM toa_sync_state WHERE id = 1`).get() as { watermark: number }
  const since = state.watermark

  const lean = await qbQueryAll({
    from: TOA_TABLE,
    select: [TF.recordId, TF.poNumber, TF.installationDate, TF.distributorName, TF.eventType, TF.relatedProject, TF.createdAt, TF.rawWebhook],
    where: `{'${TF.recordId}'.GT.'${since}'}`,
    sortBy: [{ fieldId: TF.recordId, order: 'ASC' }],
  })
  if (lean.length === 0) {
    db.prepare(`UPDATE toa_sync_state SET last_run_at = datetime('now') WHERE id = 1`).run()
    return { events: 0, projects: 0, watermark: since }
  }

  interface RawPayload { eventInfo?: { newStatus?: string }; order?: { status?: string; deliveryTimestamp?: string } }
  const rawByRid = new Map<string, RawPayload>()
  for (const r of lean) {
    try { rawByRid.set(str(r, TF.recordId), JSON.parse(str(r, TF.rawWebhook)) as RawPayload) } catch { /* malformed — event still advances the watermark */ }
  }

  const upsert = db.prepare(`
    INSERT INTO toa_order_cache (project_rid, status, status_at, delivered_at, po_number, distributor, installation_date, last_event_rid, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_rid) DO UPDATE SET
      status = excluded.status,
      status_at = excluded.status_at,
      delivered_at = CASE WHEN excluded.delivered_at != '' THEN excluded.delivered_at ELSE toa_order_cache.delivered_at END,
      po_number = CASE WHEN excluded.po_number != '' THEN excluded.po_number ELSE toa_order_cache.po_number END,
      distributor = CASE WHEN excluded.distributor != '' THEN excluded.distributor ELSE toa_order_cache.distributor END,
      installation_date = CASE WHEN excluded.installation_date != '' THEN excluded.installation_date ELSE toa_order_cache.installation_date END,
      last_event_rid = excluded.last_event_rid,
      cached_at = datetime('now')
  `)
  // Metadata-only refresh for AGREEMENT_CHANGED etc. — PO/dates may move
  // even when the material status doesn't.
  const touchMeta = db.prepare(`
    UPDATE toa_order_cache SET
      po_number = CASE WHEN ? != '' THEN ? ELSE po_number END,
      installation_date = CASE WHEN ? != '' THEN ? ELSE installation_date END,
      last_event_rid = ?, cached_at = datetime('now')
    WHERE project_rid = ?
  `)

  let watermark = since
  const touched = new Set<number>()
  db.transaction(() => {
    for (const r of lean) {
      const rid = parseInt(str(r, TF.recordId), 10)
      if (rid > watermark) watermark = rid
      const projectRid = parseInt(str(r, TF.relatedProject), 10)
      if (!projectRid) continue
      const raw = rawByRid.get(String(rid)) || null
      const status = eventStatus(str(r, TF.eventType), raw)
      const po = str(r, TF.poNumber)
      const instDate = str(r, TF.installationDate)
      if (status) {
        upsert.run(
          projectRid, status, str(r, TF.createdAt), raw?.order?.deliveryTimestamp || '',
          po, str(r, TF.distributorName), instDate, rid,
        )
        touched.add(projectRid)
      } else {
        touchMeta.run(po, po, instDate, instDate, rid, projectRid)
      }
    }
    db.prepare(`UPDATE toa_sync_state SET watermark = ?, last_run_at = datetime('now') WHERE id = 1`).run(watermark)
  })()

  return { events: lean.length, projects: touched.size, watermark }
}

// Per-project TOA state lookup for endpoint payloads. Accepts numeric or
// string rids; returns a map keyed by the STRING rid so clients can index
// with the same keys they use for Arrivy's relatedProject values.
export function toaForProjects(rids: Array<string | number>): Record<string, ToaState> {
  const unique = [...new Set(rids.map(r => parseInt(String(r), 10)).filter(Boolean))]
  const out: Record<string, ToaState> = {}
  if (unique.length === 0) return out
  const sel = db.prepare(`SELECT * FROM toa_order_cache WHERE project_rid = ?`)
  for (const rid of unique) {
    const row = sel.get(rid) as {
      status: ToaStatus; status_at: string | null; delivered_at: string | null
      po_number: string | null; distributor: string | null; installation_date: string | null
    } | undefined
    if (!row) continue
    out[String(rid)] = {
      status: row.status,
      statusAt: row.status_at || '',
      deliveredAt: row.delivered_at || '',
      poNumber: row.po_number || '',
      distributor: row.distributor || '',
      installationDate: row.installation_date || '',
    }
  }
  return out
}

// ─── Routes ──────────────────────────────────────────────

router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await syncToaOrders()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/status', (req: Request, res: Response): void => {
  const rids = String(req.query['project_rids'] || '').split(',').filter(Boolean)
  res.json({ byProject: toaForProjects(rids) })
})

// ─── Scheduler — same shape as ticket/outreach caches ────

const TOA_ACTIVITY_WINDOW_MS = 30 * 60_000
let toaSchedulerStarted = false

export function startToaScheduler(): void {
  if (toaSchedulerStarted) return
  toaSchedulerStarted = true

  cron.schedule('*/10 * * * *', async () => {
    try {
      if (!getQbConfig().token) return
      if (!isAppActive(TOA_ACTIVITY_WINDOW_MS)) return
      const r = await syncToaOrders()
      if (r.events > 0) console.log(`[toa] sync: ${r.events} events → ${r.projects} projects (watermark ${r.watermark})`)
    } catch (e) {
      console.error('[toa] sync failed:', e instanceof Error ? e.message : e)
    }
  })

  // Ungated daily sweep at 03:50 UTC (offset from tickets 03:30 /
  // outreach 03:40) so a quiet weekend still converges.
  cron.schedule('50 3 * * *', async () => {
    try {
      if (!getQbConfig().token) return
      const r = await syncToaOrders()
      console.log(`[toa] daily sweep: ${r.events} events → ${r.projects} projects`)
    } catch (e) {
      console.error('[toa] daily sweep failed:', e instanceof Error ? e.message : e)
    }
  })

  console.log('[toa] scheduler started: sync=10m (gated on activity), sweep=03:50 UTC daily')
}

export { router as toaRouter }
