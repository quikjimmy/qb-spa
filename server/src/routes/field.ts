// Field operations dashboard — proxies the QuickBase Arrivy tables so the
// Vue dashboard never has to hold a QB token client-side. Two tables back
// this view:
//   bvbqgs5yc — Arrivy tasks (scheduled + status)
//   bvbbznmdb — Arrivy task log (LATE / NO_SHOW / PREDICTED_LATE events)
import { Router, type Request, type Response } from 'express'

const router = Router()

const QB = {
  realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
  token: process.env['QB_USER_TOKEN'] || '',
  arrivyTable: 'bvbqgs5yc',
  arrivyTaskLogTable: 'bvbbznmdb',
}

// Field IDs lifted from context-files/Field/example view. Naming matches
// the example's `F` constant for grep parity.
const F = {
  scheduledDateTime: 115,
  customerFirstName: 47,
  customerLastName: 48,
  taskStatus: 85,
  templateName: 56,
  taskUrl: 107,
  enrouteStatus: 116,
  startedStatus: 117,
  submittedDateTime: 97,
  techCompleteDateTime: 137,
  enrouteName: 145,
  crew: 268,
  assignedCrew: 197,
  installComplete: 270,
  kw: 198,
  relatedProject: 6,
  rtrStatus: 218,
  rtrReadyCount: 217,
}
const SELECT_FIELDS = [3, F.scheduledDateTime, F.customerFirstName, F.customerLastName, F.taskStatus, F.templateName, F.taskUrl, F.enrouteStatus, F.startedStatus, F.submittedDateTime, F.techCompleteDateTime, F.enrouteName, F.crew, F.assignedCrew, F.installComplete, F.kw, F.relatedProject, F.rtrStatus, F.rtrReadyCount]

const LOG_F = {
  relatedProject: 193,
  relatedTask: 94,
  eventType: 76,
  timestamp: 79,
  scheduled: 17,
  reporterName: 14,
}
const LOG_SELECT = [3, LOG_F.relatedTask, LOG_F.eventType, LOG_F.timestamp, LOG_F.scheduled, LOG_F.reporterName, LOG_F.relatedProject]

interface QbValue { value: unknown }
type QbRecord = Record<string, QbValue>

async function qbQuery(tableId: string, where: string, select: number[], extra: Record<string, unknown> = {}): Promise<QbRecord[]> {
  if (!QB.token) throw new Error('QB_USER_TOKEN not set')
  const res = await fetch('https://api.quickbase.com/v1/records/query', {
    method: 'POST',
    headers: {
      'QB-Realm-Hostname': QB.realm,
      'Authorization': `QB-USER-TOKEN ${QB.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: tableId, where, select, options: { top: 1000 }, ...extra }),
  })
  if (!res.ok) throw new Error(`QB ${tableId} query failed (${res.status}): ${(await res.text()).slice(0, 400)}`)
  const json = await res.json() as { data?: QbRecord[] }
  return json.data || []
}

// Date helpers
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dateRange(preset: string): { from: Date; to: Date } {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const from = new Date(today)
  const to = new Date(today)
  to.setHours(23, 59, 59, 999)
  switch (preset) {
    case 'yesterday': {
      from.setDate(from.getDate() - 1)
      const t = new Date(from); t.setHours(23, 59, 59, 999)
      return { from, to: t }
    }
    case 'week': {
      const day = from.getDay()
      from.setDate(from.getDate() - (day === 0 ? 6 : day - 1))
      return { from, to }
    }
    case 'month':
      from.setDate(1)
      return { from, to }
    case '30days':
      from.setDate(from.getDate() - 30)
      return { from, to }
    default:
      return { from, to }
  }
}

// GET /api/field/tasks?preset=today — returns raw Arrivy records so the
// client can run all the same status logic the standalone HTML does.
// Echoing the QB record shape (field-id-keyed objects) means the frontend
// classifier port stays a 1:1 translation of the original.
router.get('/tasks', async (req: Request, res: Response): Promise<void> => {
  const preset = String(req.query['preset'] || 'today')
  const { from, to } = dateRange(preset)
  const fromStr = `${fmtDate(from)}T00:00:00Z`
  const toStr = `${fmtDate(to)}T23:59:59Z`
  const where = `{'${F.scheduledDateTime}'.OAF.'${fromStr}'}AND{'${F.scheduledDateTime}'.OBF.'${toStr}'}`
  try {
    const records = await qbQuery(QB.arrivyTable, where, SELECT_FIELDS, {
      sortBy: [{ fieldId: F.scheduledDateTime, order: 'ASC' }],
    })
    res.json({ preset, from: fmtDate(from), to: fmtDate(to), records, fields: F })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// GET /api/field/late?project_rids=1,2,3 — fetches LATE/NO_SHOW/PREDICTED_LATE
// events for the given projects and returns the highest-priority one per task.
router.get('/late', async (req: Request, res: Response): Promise<void> => {
  const csv = String(req.query['project_rids'] || '').trim()
  if (!csv) { res.json({ lateByTask: {} }); return }
  const projRids = csv.split(',').map(s => s.trim()).filter(Boolean)
  if (projRids.length === 0) { res.json({ lateByTask: {} }); return }
  // Cap to 100 projects per call to avoid hammering QB.
  const capped = projRids.slice(0, 100)
  try {
    const lateByTask: Record<string, { type: string; timestamp: string; scheduled: string; crew: string }> = {}
    const priority: Record<string, number> = { NO_SHOW: 3, NOSHOW: 3, LATE: 2, PREDICTED_LATE: 1 }
    // Run in parallel — QB tolerates a handful of concurrent reads fine.
    const results = await Promise.allSettled(capped.map(rid =>
      qbQuery(QB.arrivyTaskLogTable, `{'${LOG_F.relatedProject}'.EX.'${rid}'}`, LOG_SELECT, { options: { top: 300 } })
    ))
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const log of r.value) {
        const et = String((log[String(LOG_F.eventType)]?.value || '')).toUpperCase()
        const p = priority[et]
        if (!p) continue
        const taskRid = String(log[String(LOG_F.relatedTask)]?.value || '')
        if (!taskRid) continue
        const existing = lateByTask[taskRid]
        if (existing && (priority[existing.type] || 0) >= p) continue
        const type = et === 'NO_SHOW' ? 'NOSHOW' : et
        lateByTask[taskRid] = {
          type,
          timestamp: String(log[String(LOG_F.timestamp)]?.value || ''),
          scheduled: String(log[String(LOG_F.scheduled)]?.value || ''),
          crew: String(log[String(LOG_F.reporterName)]?.value || ''),
        }
      }
    }
    res.json({ lateByTask })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// GET /api/field/project-tasks?project_rid=X — Arrivy task list for one
// project (powers the per-card field activity drawer).
router.get('/project-tasks', async (req: Request, res: Response): Promise<void> => {
  const projRid = String(req.query['project_rid'] || '').trim()
  if (!projRid) { res.json({ records: [] }); return }
  try {
    const records = await qbQuery(QB.arrivyTable, `{'${F.relatedProject}'.EX.'${projRid}'}`, SELECT_FIELDS, {
      sortBy: [{ fieldId: F.scheduledDateTime, order: 'ASC' }],
      options: { top: 200 },
    })
    res.json({ records, fields: F })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as fieldRouter }
