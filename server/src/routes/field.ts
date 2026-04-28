// Field operations dashboard — proxies the QuickBase Arrivy tables so the
// Vue dashboard never has to hold a QB token client-side. Two tables back
// this view:
//   bvbqgs5yc — Arrivy tasks (scheduled + status)
//   bvbbznmdb — Arrivy task log (LATE / NO_SHOW / PREDICTED_LATE events)
//
// The Performance tab aggregates from the local project_cache (synced
// from the QB projects table separately) — no QB round-trip per render.
import { Router, type Request, type Response } from 'express'
import db from '../db'

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

// ─── Performance tab — aggregates from project_cache ─────
// Returns headline counts, time-series buckets, pivot rows by a chosen
// dimension, and decile distribution of install duration. All data
// flows from the local project_cache so this endpoint is fast and
// doesn't burn QB API rate.

type Dimension =
  | 'sales_office' | 'state' | 'sales_company' | 'lender'
  | 'closer' | 'setter' | 'area_director'
  | 'ahj_name' | 'utility_company' | 'mpu_callout'

const DIMENSION_COLS: Record<Dimension, string> = {
  sales_office: 'sales_office',
  state: 'state',
  sales_company: 'sales_company',
  lender: 'lender',
  closer: 'closer',
  setter: 'setter',
  area_director: 'area_director',
  ahj_name: 'ahj_name',
  utility_company: 'utility_company',
  mpu_callout: 'mpu_callout',
}

interface PerfRow {
  install_scheduled: string | null
  install_completed: string | null
  sales_date: string | null
  system_size_kw: number | null
  sales_office: string | null
  state: string | null
  sales_company: string | null
  lender: string | null
  closer: string | null
  setter: string | null
  area_director: string | null
  ahj_name: string | null
  utility_company: string | null
  mpu_callout: string | null
}

// Mon–Fri business-day diff. Weekends excluded; holidays NOT excluded
// (could be added later from a holiday table). Returns 0 for null/
// invalid inputs so the caller can decide whether to skip.
function bizDaysBetween(startStr: string | null, endStr: string | null): number {
  if (!startStr || !endStr) return 0
  const start = new Date(startStr)
  const end = new Date(endStr)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0
  let count = 0
  const cur = new Date(start)
  cur.setHours(0, 0, 0, 0)
  const last = new Date(end)
  last.setHours(0, 0, 0, 0)
  while (cur <= last) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) count++
    cur.setDate(cur.getDate() + 1)
  }
  // The convention people care about is "elapsed business days" — start
  // and end on the same day = 0 days, not 1. Subtract one.
  return Math.max(0, count - 1)
}

function calDaysBetween(startStr: string | null, endStr: string | null): number {
  if (!startStr || !endStr) return 0
  const start = new Date(startStr)
  const end = new Date(endStr)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0
  return Math.floor((end.getTime() - start.getTime()) / 86400000)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, n) => s + n, 0) / arr.length
}

function bucketKey(d: Date, granularity: 'day' | 'week' | 'month'): string {
  if (granularity === 'day') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  if (granularity === 'week') {
    // ISO-week-ish: snap to Monday of the week
    const day = d.getDay()
    const monday = new Date(d)
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function pickGranularity(fromIso: string, toIso: string): 'day' | 'week' | 'month' {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return 'day'
  const days = Math.ceil((to.getTime() - from.getTime()) / 86400000)
  if (days <= 35) return 'day'
  if (days <= 180) return 'week'
  return 'month'
}

router.get('/performance', (req: Request, res: Response): void => {
  if (!req.user) { res.status(401).end(); return }

  const dateBasis = (String(req.query['date_basis'] || 'completed') === 'scheduled') ? 'scheduled' : 'completed'
  const dim: Dimension = (Object.keys(DIMENSION_COLS) as Dimension[]).includes(req.query['dimension'] as Dimension)
    ? req.query['dimension'] as Dimension
    : 'sales_office'
  const dayUnit = (String(req.query['day_unit'] || 'biz') === 'cal') ? 'cal' : 'biz'

  // Default window: last 90 days
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const defaultFrom = new Date(today); defaultFrom.setDate(defaultFrom.getDate() - 90)
  const fromStr = String(req.query['from'] || defaultFrom.toISOString().slice(0, 10))
  const toStr = String(req.query['to'] || todayStr)

  const dateCol = dateBasis === 'scheduled' ? 'install_scheduled' : 'install_completed'

  try {
    const rows = db.prepare(`
      SELECT install_scheduled, install_completed, sales_date, system_size_kw,
             sales_office, state, sales_company, lender, closer, setter, area_director,
             ahj_name, utility_company, mpu_callout
      FROM project_cache
      WHERE ${dateCol} IS NOT NULL
        AND substr(${dateCol}, 1, 10) >= ?
        AND substr(${dateCol}, 1, 10) <= ?
    `).all(fromStr, toStr) as PerfRow[]

    // Only count rows that have BOTH start and complete dates for
    // duration math; the headline count and time-series use whichever
    // basis was selected.
    const completedRows = rows.filter(r => !!r.install_scheduled && !!r.install_completed)

    // ── Headline ──
    const totalCount = rows.length
    const totalKw = rows.reduce((s, r) => s + (Number(r.system_size_kw) || 0), 0)
    const completedCount = completedRows.length
    const completedKw = completedRows.reduce((s, r) => s + (Number(r.system_size_kw) || 0), 0)

    // ── Time series ──
    const granularity = pickGranularity(fromStr, toStr)
    const seriesMap = new Map<string, { count: number; kw: number }>()
    for (const r of rows) {
      const dateStr = (dateBasis === 'scheduled' ? r.install_scheduled : r.install_completed) || ''
      const d = new Date(dateStr)
      if (isNaN(d.getTime())) continue
      const key = bucketKey(d, granularity)
      const cur = seriesMap.get(key) || { count: 0, kw: 0 }
      cur.count += 1
      cur.kw += Number(r.system_size_kw) || 0
      seriesMap.set(key, cur)
    }
    const series = [...seriesMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, v]) => ({ bucket, count: v.count, kw: Math.round(v.kw * 10) / 10 }))

    // ── Pivot table (group by selected dimension) ──
    const dimCol = DIMENSION_COLS[dim]
    interface BucketAgg {
      key: string
      count: number
      kw: number
      installDurations: number[]
      saleToInstall: number[]
    }
    const buckets = new Map<string, BucketAgg>()
    function durFn(start: string | null, end: string | null): number {
      return dayUnit === 'biz' ? bizDaysBetween(start, end) : calDaysBetween(start, end)
    }
    for (const r of rows) {
      const key = String((r as unknown as Record<string, unknown>)[dimCol] || '— Unknown') || '— Unknown'
      let agg = buckets.get(key)
      if (!agg) {
        agg = { key, count: 0, kw: 0, installDurations: [], saleToInstall: [] }
        buckets.set(key, agg)
      }
      agg.count += 1
      agg.kw += Number(r.system_size_kw) || 0
      if (r.install_scheduled && r.install_completed) {
        const dur = durFn(r.install_scheduled, r.install_completed)
        if (dur >= 0) agg.installDurations.push(dur)
      }
      if (r.sales_date && r.install_scheduled) {
        const sti = durFn(r.sales_date, r.install_scheduled)
        if (sti >= 0) agg.saleToInstall.push(sti)
      }
    }
    const pivot = [...buckets.values()].map(b => {
      const dSorted = [...b.installDurations].sort((x, y) => x - y)
      const sSorted = [...b.saleToInstall].sort((x, y) => x - y)
      return {
        dimension_value: b.key,
        count: b.count,
        kw: Math.round(b.kw * 10) / 10,
        install_dur_mean: Math.round(mean(b.installDurations) * 10) / 10,
        install_dur_p90: Math.round(percentile(dSorted, 90) * 10) / 10,
        sale_to_install_mean: Math.round(mean(b.saleToInstall) * 10) / 10,
        sale_to_install_p90: Math.round(percentile(sSorted, 90) * 10) / 10,
      }
    }).sort((a, b) => b.count - a.count)

    // ── Deciles of install duration, broken down by selected dimension ──
    // The new shape: one row per dimension value with D10..D100 (D100 = max),
    // mean, and count. Plus a Total row across the whole window. The
    // client renders this as a flat numeric table; mobile shows D20 /
    // mean / D90 / max only.
    interface DecileRow {
      dimension_value: string
      count: number
      kw: number
      d10: number; d20: number; d30: number; d40: number; d50: number
      d60: number; d70: number; d80: number; d90: number; d100: number
      mean: number
    }
    function decilesFor(rows: PerfRow[]): Pick<DecileRow, 'count' | 'kw' | 'd10' | 'd20' | 'd30' | 'd40' | 'd50' | 'd60' | 'd70' | 'd80' | 'd90' | 'd100' | 'mean'> {
      const durs = rows
        .map(r => durFn(r.install_scheduled, r.install_completed))
        .filter(n => n >= 0)
        .sort((a, b) => a - b)
      const round = (n: number) => Math.round(n * 10) / 10
      return {
        count: rows.length,
        kw: round(rows.reduce((s, r) => s + (Number(r.system_size_kw) || 0), 0)),
        d10: round(percentile(durs, 10)),
        d20: round(percentile(durs, 20)),
        d30: round(percentile(durs, 30)),
        d40: round(percentile(durs, 40)),
        d50: round(percentile(durs, 50)),
        d60: round(percentile(durs, 60)),
        d70: round(percentile(durs, 70)),
        d80: round(percentile(durs, 80)),
        d90: round(percentile(durs, 90)),
        d100: durs.length ? round(durs[durs.length - 1]!) : 0,
        mean: round(mean(durs)),
      }
    }
    // Group completed rows by dimension value for per-row decile math.
    const completedByDim = new Map<string, PerfRow[]>()
    for (const r of completedRows) {
      const key = String((r as unknown as Record<string, unknown>)[dimCol] || '— Unknown') || '— Unknown'
      let arr = completedByDim.get(key)
      if (!arr) { arr = []; completedByDim.set(key, arr) }
      arr.push(r)
    }
    const decileRows: DecileRow[] = [...completedByDim.entries()]
      .map(([key, rows]) => ({ dimension_value: key, ...decilesFor(rows) }))
      .sort((a, b) => b.count - a.count)
    const decileTotal: DecileRow = { dimension_value: '— Total', ...decilesFor(completedRows) }

    // Pivot total row — sums + global mean / p90 across all completed rows.
    const allInstallDur = completedRows
      .map(r => durFn(r.install_scheduled, r.install_completed))
      .filter(n => n >= 0)
      .sort((a, b) => a - b)
    const allSaleToInstall = rows
      .filter(r => r.sales_date && r.install_scheduled)
      .map(r => durFn(r.sales_date, r.install_scheduled))
      .filter(n => n >= 0)
      .sort((a, b) => a - b)
    const pivotTotal = {
      dimension_value: '— Total',
      count: rows.length,
      kw: Math.round(rows.reduce((s, r) => s + (Number(r.system_size_kw) || 0), 0) * 10) / 10,
      install_dur_mean: Math.round(mean(allInstallDur) * 10) / 10,
      install_dur_p90: Math.round(percentile(allInstallDur, 90) * 10) / 10,
      sale_to_install_mean: Math.round(mean(allSaleToInstall) * 10) / 10,
      sale_to_install_p90: Math.round(percentile(allSaleToInstall, 90) * 10) / 10,
    }

    res.json({
      window: { from: fromStr, to: toStr, days: calDaysBetween(fromStr, toStr) + 1 },
      date_basis: dateBasis,
      dimension: dim,
      day_unit: dayUnit,
      granularity,
      headline: {
        total_count: totalCount,
        total_kw: Math.round(totalKw * 10) / 10,
        completed_count: completedCount,
        completed_kw: Math.round(completedKw * 10) / 10,
      },
      series,
      pivot,
      pivot_total: pivotTotal,
      deciles: {
        rows: decileRows,
        total: decileTotal,
      },
    })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as fieldRouter }
