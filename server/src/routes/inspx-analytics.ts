import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() { return { realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com', token: process.env['QB_USER_TOKEN'] || '' } }

// ── INSPX Cache ──
db.exec(`
  CREATE TABLE IF NOT EXISTS inspx_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    project_name TEXT,
    state TEXT,
    epc TEXT,
    inspection_type TEXT,
    inspection_scheduled TEXT,
    inspection_completed TEXT,
    pass_fail TEXT,
    official_pass_fail TEXT,
    fail_reason TEXT,
    age_bucket TEXT,
    install_completed TEXT,
    todo TEXT,
    date_created TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

const fMap: Array<{ fid: number; col: string }> = [
  { fid: 3, col: 'record_id' }, { fid: 12, col: 'project_rid' }, { fid: 14, col: 'project_name' },
  { fid: 100, col: 'inspection_type' }, { fid: 19, col: 'inspection_scheduled' },
  { fid: 7, col: 'inspection_completed' }, { fid: 8, col: 'pass_fail' },
  { fid: 166, col: 'official_pass_fail' }, { fid: 92, col: 'fail_reason' },
  { fid: 179, col: 'age_bucket' }, { fid: 47, col: 'install_completed' },
  { fid: 140, col: 'todo' }, { fid: 1, col: 'date_created' }, { fid: 59, col: 'epc' },
]

function val(r: Record<string, { value: unknown }>, fid: number): string {
  const v = r[String(fid)]?.value; if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(', '); return String(v)
}

// Refresh
router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }
  const start = Date.now()
  let all: Array<Record<string, { value: unknown }>> = []; let skip = 0
  while (true) {
    const r = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST', headers: { 'QB-Realm-Hostname': realm, 'Authorization': `QB-USER-TOKEN ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'bsc3v7tdg', select: fMap.map(f => f.fid), options: { skip, top: 1000 } }),
    })
    if (!r.ok) throw new Error(`QB ${r.status}`)
    const d = await r.json(); all = all.concat(d.data || [])
    if ((d.data || []).length < 1000) break; skip += 1000
  }

  db.prepare('DELETE FROM inspx_cache').run()
  const cols = fMap.map(f => f.col).join(', ')
  const ph = fMap.map(() => '?').join(', ')
  const ins = db.prepare(`INSERT OR REPLACE INTO inspx_cache (${cols}, state, cached_at) VALUES (${ph}, '', datetime('now'))`)

  db.transaction(() => {
    for (const rec of all) {
      const rid = parseInt(val(rec, 3)); if (!rid) continue
      const values = fMap.map(f => {
        if (f.col === 'project_rid') return parseInt(val(rec, f.fid)) || null
        return val(rec, f.fid)
      })
      ins.run(...values)
    }
  })()

  // Backfill state from project_cache
  db.prepare(`UPDATE inspx_cache SET state = (SELECT state FROM project_cache WHERE project_cache.record_id = inspx_cache.project_rid) WHERE project_rid IS NOT NULL`).run()

  res.json({ success: true, total: all.length, duration: Date.now() - start })
})

// Also pull Arrivy inspection task creation dates for "scheduled on a day" chart
router.post('/refresh-arrivy', async (_req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  if (!token) { res.status(500).json({ error: 'QB_USER_TOKEN not configured' }); return }

  // Create a simple table for arrivy inspection scheduling events
  db.exec(`CREATE TABLE IF NOT EXISTS inspx_arrivy_scheduled (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    arrivy_record_id INTEGER,
    project_rid INTEGER,
    template_name TEXT,
    created_date TEXT,
    scheduled_date TEXT
  )`)

  const start = Date.now()
  let all: Array<Record<string, { value: unknown }>> = []; let skip = 0
  while (true) {
    const r = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST', headers: { 'QB-Realm-Hostname': realm, 'Authorization': `QB-USER-TOKEN ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'bvbqgs5yc', select: [3, 6, 56, 1, 115],
        where: "{'56'.CT.'inspect'}", options: { skip, top: 1000 },
      }),
    })
    if (!r.ok) throw new Error(`QB ${r.status}`)
    const d = await r.json(); all = all.concat(d.data || [])
    if ((d.data || []).length < 1000) break; skip += 1000
  }

  db.prepare('DELETE FROM inspx_arrivy_scheduled').run()
  const ins = db.prepare('INSERT INTO inspx_arrivy_scheduled (arrivy_record_id, project_rid, template_name, created_date, scheduled_date) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (const rec of all) {
      ins.run(parseInt(val(rec, 3)) || null, parseInt(val(rec, 6)) || null, val(rec, 56), val(rec, 1), val(rec, 115))
    }
  })()

  res.json({ success: true, total: all.length, duration: Date.now() - start })
})

// ── Analytics ──
router.get('/', (req: Request, res: Response): void => {
  const state = req.query['state'] as string | undefined
  const epc = req.query['epc'] as string | undefined
  const lender = req.query['lender'] as string | undefined
  const clientToday = req.query['today'] as string | undefined
  const today = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) ? clientToday : new Date().toISOString().split('T')[0]!
  const dateFrom = req.query['date_from'] as string | undefined
  const dateTo = req.query['date_to'] as string | undefined
  const useBizDays = req.query['biz_days'] === '1'
  const bizFactor = useBizDays ? 5 / 7 : 1

  const has = (c: string) => `(${c} IS NOT NULL AND ${c} != '' AND ${c} != '0')`
  const noV = (c: string) => `(${c} IS NULL OR ${c} = '' OR ${c} = '0')`

  // Project-based metrics
  let pBase = "WHERE (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%' OR LOWER(status) LIKE '%complete%')"
  const pP: unknown[] = []
  if (state) { pBase += ' AND state = ?'; pP.push(state) }
  if (epc) { pBase += ' AND epc = ?'; pP.push(epc) }
  if (lender) { pBase += ' AND lender = ?'; pP.push(lender) }

  // Date-scoped for scheduled/passed counts
  let schedW = `${pBase} AND ${has('inspection_scheduled')}`; const schedP = [...pP]
  if (dateFrom) { schedW += ' AND inspection_scheduled >= ?'; schedP.push(dateFrom) }
  if (dateTo) { schedW += ' AND inspection_scheduled <= ?'; schedP.push(dateTo + 'T23:59:59') }

  let passW = `${pBase} AND ${has('inspection_passed')}`; const passP = [...pP]
  if (dateFrom) { passW += ' AND inspection_passed >= ?'; passP.push(dateFrom) }
  if (dateTo) { passW += ' AND inspection_passed <= ?'; passP.push(dateTo + 'T23:59:59') }

  // KPIs
  const scheduled = (db.prepare(`SELECT COUNT(*) as c FROM project_cache ${schedW}`).get(...schedP) as { c: number }).c
  const passed = (db.prepare(`SELECT COUNT(*) as c FROM project_cache ${passW}`).get(...passP) as { c: number }).c
  const pctPassed = scheduled > 0 ? Math.round((passed / scheduled) * 100) : 0
  const firstTime = (db.prepare(`SELECT COUNT(*) as c FROM project_cache ${passW} AND inspx_count <= 1`).get(...passP) as { c: number }).c
  const pctFirstTime = passed > 0 ? Math.round((firstTime / passed) * 100) : 0

  const needInspx = (db.prepare(`SELECT COUNT(*) as c FROM project_cache ${pBase} AND ${has('install_completed')} AND ${noV('inspection_passed')}`).get(...pP) as { c: number }).c
  const avgDaysSinceInstRaw = (db.prepare(`SELECT AVG(JULIANDAY('${today}') - JULIANDAY(install_completed)) as d FROM project_cache ${pBase} AND ${has('install_completed')} AND ${noV('inspection_passed')}`).get(...pP) as { d: number | null })

  // Smart grouping for passed chart
  const useWeeks = dateFrom && dateTo && Math.floor((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000) <= 90
  const mondayExpr = (col: string) => `DATE(${col}, '-' || ((CAST(STRFTIME('%w', ${col}) AS INTEGER) + 6) % 7) || ' days')`
  const passGroup = useWeeks ? mondayExpr('inspection_passed') : "SUBSTR(inspection_passed, 1, 7)"

  const passedByMonth = db.prepare(`SELECT ${passGroup} as period, COUNT(*) as count FROM project_cache ${passW} GROUP BY period ORDER BY period`).all(...passP)

  // Chart 2: Install→Inspection days (box plot data)
  const instToInspx = db.prepare(`
    SELECT SUBSTR(install_completed,1,7) as month, CAST(JULIANDAY(inspection_passed) - JULIANDAY(install_completed) AS INTEGER) as days
    FROM project_cache ${passW} AND ${has('install_completed')}
  `).all(...passP) as Array<{ month: string; days: number }>

  // Build box plots by install month
  const monthMap = new Map<string, number[]>()
  for (const r of instToInspx) { if (r.days >= 0) { if (!monthMap.has(r.month)) monthMap.set(r.month, []); monthMap.get(r.month)!.push(r.days) } }
  function pct(a: number[], p: number) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = (p / 100) * (s.length - 1); const l = Math.floor(i); return l === Math.ceil(i) ? s[l]! : Math.round(s[l]! + (s[Math.ceil(i)]! - s[l]!) * (i - l)) }
  const instToInspxBoxes = [...monthMap.entries()].map(([month, days]) => {
    const adjusted = useBizDays ? days.map(d => Math.round(d * bizFactor)) : days
    return { month, count: days.length, p0: pct(adjusted, 0), p25: pct(adjusted, 25), p50: pct(adjusted, 50), p90: pct(adjusted, 90), p100: pct(adjusted, 100) }
  }).sort((a, b) => a.month.localeCompare(b.month))

  const allDays = instToInspx.map(r => r.days).filter(d => d >= 0)
  const adjustedAll = useBizDays ? allDays.map(d => Math.round(d * bizFactor)) : allDays
  const overallMedian = pct(adjustedAll, 50)

  // Chart 3: State breakdown
  const byState = db.prepare(`
    SELECT state, COUNT(*) as sched,
      SUM(CASE WHEN ${has('inspection_passed')} THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN inspx_count <= 1 AND ${has('inspection_passed')} THEN 1 ELSE 0 END) as first_time,
      AVG(CASE WHEN ${has('inspection_passed')} AND ${has('install_completed')} THEN JULIANDAY(inspection_passed) - JULIANDAY(install_completed) END) as avg_days
    FROM project_cache ${schedW} AND state != ''
    GROUP BY state ORDER BY sched DESC
  `).all(...schedP)

  // Chart 4: Aging buckets (need inspection) — include scheduled count
  const agingRows = db.prepare(`
    SELECT CAST(JULIANDAY('${today}') - JULIANDAY(install_completed) AS INTEGER) as days,
      CASE WHEN ${has('inspection_scheduled')} THEN 1 ELSE 0 END as has_sched
    FROM project_cache ${pBase} AND ${has('install_completed')} AND ${noV('inspection_passed')}
  `).all(...pP) as Array<{ days: number; has_sched: number }>

  const bkts = [{ label: '0-5', min: 0, max: 5 }, { label: '6-30', min: 6, max: 30 }, { label: '31-60', min: 31, max: 60 }, { label: '61-90', min: 61, max: 90 }, { label: '90+', min: 91, max: 99999 }]
  const aging = bkts.map(b => {
    const items = agingRows.filter(r => r.days >= b.min && r.days <= b.max)
    return { label: b.label, count: items.length, scheduled: items.filter(r => r.has_sched).length }
  })
  const agingTotal = agingRows.length

  // Active fails
  const activeFails = (db.prepare(`SELECT COUNT(*) as c FROM project_cache ${pBase} AND ${has('inspx_fail_date')} AND ${noV('inspection_passed')}`).get(...pP) as { c: number }).c

  // Chart 5: Outcomes by install month
  const outcomesByMonth = db.prepare(`
    SELECT SUBSTR(install_completed,1,7) as month, COUNT(*) as total,
      SUM(CASE WHEN ${has('inspection_passed')} AND inspx_count <= 1 THEN 1 ELSE 0 END) as pass_first,
      SUM(CASE WHEN ${has('inspection_passed')} AND inspx_count > 1 THEN 1 ELSE 0 END) as fail_pass,
      SUM(CASE WHEN ${has('inspection_scheduled')} AND ${noV('inspection_passed')} AND ${noV('inspx_fail_date')} THEN 1 ELSE 0 END) as scheduled,
      SUM(CASE WHEN ${has('inspx_fail_date')} AND ${noV('inspection_passed')} THEN 1 ELSE 0 END) as fail,
      SUM(CASE WHEN ${noV('inspection_scheduled')} AND ${noV('inspection_passed')} THEN 1 ELSE 0 END) as na
    FROM project_cache ${pBase} AND ${has('install_completed')}
    GROUP BY month ORDER BY month
  `).all(...pP)

  // Chart 6: Scheduled on a day (from Arrivy)
  let arrivyW = "WHERE template_name LIKE '%inspect%'"
  const arrivyP: unknown[] = []
  if (dateFrom) { arrivyW += ' AND created_date >= ?'; arrivyP.push(dateFrom) }
  if (dateTo) { arrivyW += ' AND created_date <= ?'; arrivyP.push(dateTo + 'T23:59:59') }

  const scheduledOnDay = db.prepare(`
    SELECT SUBSTR(created_date, 1, 10) as day, COUNT(*) as count
    FROM inspx_arrivy_scheduled ${arrivyW}
    GROUP BY day ORDER BY day
  `).all(...arrivyP)

  // Filters
  const states = db.prepare("SELECT DISTINCT state as value FROM project_cache WHERE state != '' ORDER BY state").all() as Array<{ value: string }>
  const lenders = db.prepare("SELECT DISTINCT lender as value FROM project_cache WHERE lender != '' ORDER BY lender").all() as Array<{ value: string }>
  const epcs = db.prepare("SELECT DISTINCT epc as value FROM project_cache WHERE epc != '' ORDER BY epc").all() as Array<{ value: string }>

  res.json({
    kpi: { scheduled, passed, pctPassed, firstTime, pctFirstTime, needInspx, avgDaysSinceInst: Math.round((avgDaysSinceInstRaw.d || 0) * bizFactor), overallMedian },
    charts: { passedByMonth, instToInspxBoxes, byState, aging, agingTotal, activeFails, outcomesByMonth, scheduledOnDay },
    filters: { states: states.map(s => s.value), lenders: lenders.map(l => l.value), epcs: epcs.map(e => e.value) },
  })
})

export { router as inspxAnalyticsRouter }
