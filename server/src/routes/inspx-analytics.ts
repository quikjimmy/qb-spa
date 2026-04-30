import { Router, type Request, type Response } from 'express'
import db from '../db'
import { computeDeciles } from '../lib/deciles'

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
  const ahj = req.query['ahj'] as string | undefined
  const utility = req.query['utility'] as string | undefined
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
  if (state)   { pBase += ' AND state = ?';           pP.push(state) }
  if (epc)     { pBase += ' AND epc = ?';             pP.push(epc) }
  if (lender)  { pBase += ' AND lender = ?';          pP.push(lender) }
  if (ahj)     { pBase += ' AND ahj_name = ?';        pP.push(ahj) }
  if (utility) { pBase += ' AND utility_company = ?'; pP.push(utility) }

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
  function meanI(a: number[]) { return a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length) : 0 }

  // Per-install-month: how many installs in month X have an inspection
  // passed yet? Drives the % row under the box plot ("% installs from
  // this month that have passed inspection").
  const installsByMonth = db.prepare(`
    SELECT SUBSTR(install_completed,1,7) as month,
      COUNT(*) as total,
      SUM(CASE WHEN ${has('inspection_passed')} THEN 1 ELSE 0 END) as passed
    FROM project_cache ${pBase} AND ${has('install_completed')}
    GROUP BY month
  `).all(...pP) as Array<{ month: string; total: number; passed: number }>
  const installsMap = new Map(installsByMonth.map(r => [r.month, r]))

  const instToInspxBoxes = [...monthMap.entries()].map(([month, days]) => {
    const adjusted = useBizDays ? days.map(d => Math.round(d * bizFactor)) : days
    const installs = installsMap.get(month)
    const total = installs?.total ?? days.length
    const passedM = installs?.passed ?? days.length
    return {
      month,
      count: days.length,
      p0: pct(adjusted, 0), p25: pct(adjusted, 25), p50: pct(adjusted, 50), p90: pct(adjusted, 90), p100: pct(adjusted, 100),
      mean: meanI(adjusted),
      installsTotal: total,
      installsPassed: passedM,
      pctPassed: total > 0 ? Math.round((passedM / total) * 100) : 0,
    }
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

  // Chart 6: Inspections Scheduled (by *scheduled-for* date) — bucket
  // by inspection_scheduled date, broken into 4 categories per bar so
  // the user sees outcome-by-scheduled-period at a glance:
  //   passed         (green)
  //   failed         (red)        — has inspx_fail_date, not yet passed
  //   past_pending   (purple)     — scheduled <= today, no decision yet
  //   future_pending (blue)       — scheduled  > today, no decision yet
  //
  // Uses schedW (not pBase) so the dashboard's date range filters the
  // x-axis to inspection_scheduled within [from, to]. Same smart-
  // grouping as #Passed so the two charts share an x-axis.
  const schedForGroup = useWeeks ? mondayExpr('inspection_scheduled') : "SUBSTR(inspection_scheduled, 1, 7)"
  const scheduledFor = db.prepare(`
    SELECT ${schedForGroup} as period,
      SUM(CASE WHEN ${has('inspection_passed')} THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN ${has('inspx_fail_date')} AND ${noV('inspection_passed')} THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN ${noV('inspection_passed')} AND ${noV('inspx_fail_date')}
                AND SUBSTR(inspection_scheduled, 1, 10) <= '${today}'
               THEN 1 ELSE 0 END) as past_pending,
      SUM(CASE WHEN ${noV('inspection_passed')} AND ${noV('inspx_fail_date')}
                AND SUBSTR(inspection_scheduled, 1, 10) >  '${today}'
               THEN 1 ELSE 0 END) as future_pending,
      COUNT(*) as total
    FROM project_cache ${schedW}
    GROUP BY period ORDER BY period
  `).all(...schedP)

  // Filters — canonical milestone filter set (EPC, Lender, State, AHJ,
  // Utility). Each milestone analytics endpoint should return the same
  // shape so MilestoneFilterBar reads consistently across pages.
  const states  = db.prepare("SELECT DISTINCT state as value FROM project_cache WHERE state != '' ORDER BY state").all()  as Array<{ value: string }>
  const lenders = db.prepare("SELECT DISTINCT lender as value FROM project_cache WHERE lender != '' ORDER BY lender").all() as Array<{ value: string }>
  const epcs    = db.prepare("SELECT DISTINCT epc as value FROM project_cache WHERE epc != '' ORDER BY epc").all() as Array<{ value: string }>
  const ahjs    = db.prepare("SELECT DISTINCT ahj_name as value FROM project_cache WHERE ahj_name IS NOT NULL AND ahj_name != '' ORDER BY ahj_name").all() as Array<{ value: string }>
  const utils   = db.prepare("SELECT DISTINCT utility_company as value FROM project_cache WHERE utility_company IS NOT NULL AND utility_company != '' ORDER BY utility_company").all() as Array<{ value: string }>

  res.json({
    kpi: { scheduled, passed, pctPassed, firstTime, pctFirstTime, needInspx, avgDaysSinceInst: Math.round((avgDaysSinceInstRaw.d || 0) * bizFactor), overallMedian },
    charts: { passedByMonth, instToInspxBoxes, byState, aging, agingTotal, activeFails, outcomesByMonth, scheduledFor },
    filters: {
      states:    states.map(s => s.value),
      lenders:   lenders.map(l => l.value),
      epcs:      epcs.map(e => e.value),
      ahjs:      ahjs.map(a => a.value),
      utilities: utils.map(u => u.value),
    },
  })
})

// GET /api/analytics/inspx/drill?metric=passed|scheduled_for|booking
//                               &period=YYYY-MM | YYYY-MM-DD
//                               &state=&lender=&epc=&ahj=&utility=
//
// Returns the exact set of projects that contributed to the chart bar
// the user clicked. `period` = bucket key as the chart series carries
// it (7-char YYYY-MM for month buckets, 10-char YYYY-MM-DD for week
// buckets — the Monday). The endpoint expands `period` into a date
// range, picks the right column for the metric, applies the
// dashboard's current filter context, and returns project rows.
//
// Metric → column:
//   passed         → inspection_passed     (project_cache)
//   scheduled_for  → inspection_scheduled  (project_cache; filters by
//                    when the inspection is *scheduled to take place*)
//   booking        → inspx_arrivy_scheduled.created_date (Arrivy log;
//                    filters by *when the booking happened*)
router.get('/drill', (req: Request, res: Response): void => {
  const metric = String(req.query['metric'] || 'passed')
  const period = String(req.query['period'] || '').trim()

  // Period is required for date-bucket metrics; aging uses ?bucket
  // instead, outcome uses ?period (month) + ?outcome.
  const needsPeriod = metric !== 'aging'
  if (needsPeriod && !/^\d{4}-\d{2}(-\d{2})?$/.test(period)) {
    res.status(400).json({ error: 'period must be YYYY-MM or YYYY-MM-DD' })
    return
  }

  // Expand period → [from, to]. Month-format → calendar month range.
  // Day-format → 7-day Monday-anchored week (matches the server's
  // mondayExpr bucketing for charts). For aging this is unused.
  let from: string, to: string
  if (period.length === 7) {
    const [y, m] = period.split('-').map(Number)
    const last = new Date(y!, m!, 0).getDate()
    from = `${period}-01`
    to = `${period}-${String(last).padStart(2, '0')}`
  } else if (period.length === 10) {
    from = period
    const d = new Date(`${period}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 6)
    to = d.toISOString().slice(0, 10)
  } else {
    from = ''; to = ''
  }

  const state    = req.query['state'] as string | undefined
  const epc      = req.query['epc'] as string | undefined
  const lender   = req.query['lender'] as string | undefined
  const ahj      = req.query['ahj'] as string | undefined
  const utility  = req.query['utility'] as string | undefined
  const limit    = Math.min(500, Math.max(1, parseInt(String(req.query['limit'] || '200'), 10) || 200))

  const projColumns = `
    record_id, customer_name, customer_address, status, state,
    coordinator, closer, lender, epc, system_size_kw,
    sales_date, intake_completed,
    survey_scheduled, survey_submitted, survey_approved,
    cad_submitted, design_completed,
    permit_submitted, permit_approved, permit_rejected,
    nem_submitted, nem_approved, nem_rejected,
    install_scheduled, install_completed,
    inspection_scheduled, inspection_passed,
    pto_submitted, pto_approved
  `

  const dashFilters: string[] = []
  const dashParams: unknown[] = []
  if (state)   { dashFilters.push('state = ?');           dashParams.push(state) }
  if (epc)     { dashFilters.push('epc = ?');             dashParams.push(epc) }
  if (lender)  { dashFilters.push('lender = ?');          dashParams.push(lender) }
  if (ahj)     { dashFilters.push('ahj_name = ?');        dashParams.push(ahj) }
  if (utility) { dashFilters.push('utility_company = ?'); dashParams.push(utility) }

  // Aging bucket drill — projects whose install_completed is N days old
  // and inspection isn't passed yet. Bucket comes off the chart label.
  if (metric === 'aging') {
    const bucket = String(req.query['bucket'] || '').trim()
    const ranges: Record<string, [number, number]> = {
      '0-5': [0, 5], '6-30': [6, 30], '31-60': [31, 60], '61-90': [61, 90], '90+': [91, 99999],
    }
    const r = ranges[bucket]
    if (!r) { res.status(400).json({ error: 'unknown aging bucket' }); return }
    const todayClient = req.query['today'] as string | undefined
    const today = (todayClient && /^\d{4}-\d{2}-\d{2}$/.test(todayClient))
      ? todayClient : new Date().toISOString().slice(0, 10)
    const where = [
      `install_completed IS NOT NULL AND install_completed != ''`,
      `(inspection_passed IS NULL OR inspection_passed = '')`,
      `CAST(JULIANDAY('${today}') - JULIANDAY(install_completed) AS INTEGER) BETWEEN ? AND ?`,
      ...dashFilters,
    ]
    const params: unknown[] = [r[0], r[1], ...dashParams]
    const rows = db.prepare(`
      SELECT ${projColumns}
      FROM project_cache
      WHERE ${where.join(' AND ')}
      ORDER BY install_completed ASC
      LIMIT ?
    `).all(...params, limit)
    res.json({ projects: rows, total: rows.length, metric, bucket, from: null, to: null })
    return
  }

  // Outcomes-by-install-month drill — pick projects whose
  // install_completed lives in `period`, additionally filtered to the
  // chosen outcome segment of the stacked bar (pass_first, fail_pass,
  // scheduled, fail, na). Mirrors the WHERE clauses used in the
  // outcomesByMonth aggregation so a `15` bar returns 15 projects.
  if (metric === 'outcome') {
    const outcome = String(req.query['outcome'] || '').trim()
    const has  = (c: string) => `(${c} IS NOT NULL AND ${c} != '' AND ${c} != '0')`
    const noV  = (c: string) => `(${c} IS NULL OR ${c} = '' OR ${c} = '0')`
    const seg: Record<string, string> = {
      pass_first: `${has('inspection_passed')} AND inspx_count <= 1`,
      fail_pass:  `${has('inspection_passed')} AND inspx_count > 1`,
      scheduled:  `${has('inspection_scheduled')} AND ${noV('inspection_passed')} AND ${noV('inspx_fail_date')}`,
      fail:       `${has('inspx_fail_date')} AND ${noV('inspection_passed')}`,
      na:         `${noV('inspection_scheduled')} AND ${noV('inspection_passed')}`,
    }
    const segWhere = seg[outcome]
    if (!segWhere) { res.status(400).json({ error: 'unknown outcome' }); return }
    const where = [
      has('install_completed'),
      `SUBSTR(install_completed, 1, 7) = ?`,
      segWhere,
      ...dashFilters,
    ]
    const monthKey = period.length === 7 ? period : period.slice(0, 7)
    const params: unknown[] = [monthKey, ...dashParams]
    const rows = db.prepare(`
      SELECT ${projColumns}
      FROM project_cache
      WHERE ${where.join(' AND ')}
      ORDER BY install_completed DESC
      LIMIT ?
    `).all(...params, limit)
    res.json({ projects: rows, total: rows.length, metric, period: monthKey, outcome, from: `${monthKey}-01`, to: `${monthKey}-31` })
    return
  }

  if (metric === 'booking') {
    // Booking-date drill — join inspx_arrivy_scheduled to project_cache
    // by project_rid. created_date is the booking timestamp.
    const where = [
      "template_name LIKE '%inspect%'",
      'a.created_date >= ?',
      'a.created_date <= ?',
    ]
    const params: unknown[] = [from, `${to}T23:59:59`]
    if (dashFilters.length) {
      for (const f of dashFilters) where.push(`p.${f}`)
      params.push(...dashParams)
    }
    const rows = db.prepare(`
      SELECT DISTINCT ${projColumns.split(',').map(c => `p.${c.trim()}`).join(', ')}
      FROM inspx_arrivy_scheduled a
      JOIN project_cache p ON p.record_id = a.project_rid
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_date DESC
      LIMIT ?
    `).all(...params, limit)
    res.json({ projects: rows, total: rows.length, metric, period, from, to })
    return
  }

  // project_cache-only drills (passed, scheduled_for).
  const dateCol = metric === 'scheduled_for' ? 'inspection_scheduled' : 'inspection_passed'
  const where = [
    `${dateCol} IS NOT NULL AND ${dateCol} != ''`,
    `SUBSTR(${dateCol}, 1, 10) >= ?`,
    `SUBSTR(${dateCol}, 1, 10) <= ?`,
    ...dashFilters,
  ]
  const params: unknown[] = [from, to, ...dashParams]

  // Optional segment filter for the new scheduled-for chart's stacked
  // bar (passed / failed / past_pending / future_pending). Mirrors the
  // CASE expressions in the chart aggregation so the click count
  // matches the bar segment count.
  const segment = String(req.query['segment'] || '').trim()
  if (metric === 'scheduled_for' && segment) {
    const todayClient = req.query['today'] as string | undefined
    const today = (todayClient && /^\d{4}-\d{2}-\d{2}$/.test(todayClient))
      ? todayClient : new Date().toISOString().slice(0, 10)
    const has2 = (c: string) => `(${c} IS NOT NULL AND ${c} != '' AND ${c} != '0')`
    const noV2 = (c: string) => `(${c} IS NULL OR ${c} = '' OR ${c} = '0')`
    if (segment === 'passed')              where.push(has2('inspection_passed'))
    else if (segment === 'failed')         where.push(`${has2('inspx_fail_date')} AND ${noV2('inspection_passed')}`)
    else if (segment === 'past_pending')   where.push(`${noV2('inspection_passed')} AND ${noV2('inspx_fail_date')} AND SUBSTR(inspection_scheduled, 1, 10) <= '${today}'`)
    else if (segment === 'future_pending') where.push(`${noV2('inspection_passed')} AND ${noV2('inspx_fail_date')} AND SUBSTR(inspection_scheduled, 1, 10) >  '${today}'`)
  }

  const rows = db.prepare(`
    SELECT ${projColumns}
    FROM project_cache
    WHERE ${where.join(' AND ')}
    ORDER BY ${dateCol} DESC
    LIMIT ?
  `).all(...params, limit)
  res.json({ projects: rows, total: rows.length, metric, segment: segment || null, period, from, to })
})

// GET /api/analytics/inspx/deciles?metric=...&dimension=...&from=...&to=...&biz_days=1
//
// Returns the canonical decile shape ({ rows: DecileRow[], total: DecileRow })
// for the chosen Inspection metric, grouped by the chosen dimension. The
// shared MilestoneDecileTable client component renders this directly.
//
// Metrics:
//   install_to_pass        — install_completed → inspection_passed
//   install_to_first_sched — install_completed → inspection_scheduled (first)
router.get('/deciles', (req: Request, res: Response): void => {
  const metric = String(req.query['metric'] || 'install_to_pass')
  const dimension = String(req.query['dimension'] || 'state')
  const dateFrom = req.query['from'] as string | undefined
  const dateTo = req.query['to'] as string | undefined
  const useBizDays = req.query['biz_days'] === '1'
  const bizFactor = useBizDays ? 5 / 7 : 1

  // Allowed dimension columns — keep in sync with the milestone-wide
  // canonical filter set.
  const DIM_COLS: Record<string, string> = {
    state: 'state',
    lender: 'lender',
    epc: 'epc',
    ahj: 'ahj_name',
    utility: 'utility_company',
  }
  const dimCol = DIM_COLS[dimension] || 'state'

  // Map metric → (start_col, end_col, where_filter). Date-window filter
  // always applies to the *end* column so the chosen range bounds when
  // the milestone landed.
  let startCol: string, endCol: string
  if (metric === 'install_to_first_sched') {
    startCol = 'install_completed'; endCol = 'inspection_scheduled'
  } else { // install_to_pass (default)
    startCol = 'install_completed'; endCol = 'inspection_passed'
  }

  const wParts = [
    `${startCol} IS NOT NULL AND ${startCol} != ''`,
    `${endCol} IS NOT NULL AND ${endCol} != ''`,
    `JULIANDAY(${endCol}) - JULIANDAY(${startCol}) >= 0`,
    `${dimCol} IS NOT NULL AND ${dimCol} != ''`,
  ]
  const params: unknown[] = []
  if (dateFrom) { wParts.push(`SUBSTR(${endCol},1,10) >= ?`); params.push(dateFrom) }
  if (dateTo)   { wParts.push(`SUBSTR(${endCol},1,10) <= ?`); params.push(dateTo) }

  interface Row { dim: string; days: number; kw: number }
  const rows = db.prepare(`
    SELECT ${dimCol} as dim,
           CAST(JULIANDAY(${endCol}) - JULIANDAY(${startCol}) AS REAL) as days,
           COALESCE(system_size_kw, 0) as kw
    FROM project_cache
    WHERE ${wParts.join(' AND ')}
  `).all(...params) as Row[]

  const out = computeDeciles(rows, bizFactor)
  res.json({ metric, dimension, day_unit: useBizDays ? 'biz' : 'cal', ...out })
})

export { router as inspxAnalyticsRouter }
