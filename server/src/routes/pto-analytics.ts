import { Router, type Request, type Response } from 'express'
import db from '../db'
import { computeDeciles } from '../lib/deciles'

const router = Router()

function mondayWeekExpr(col: string): string {
  return `DATE(${col}, '-' || ((CAST(STRFTIME('%w', ${col}) AS INTEGER) + 6) % 7) || ' days')`
}

router.get('/', (req: Request, res: Response): void => {
  const state = req.query['state'] as string | undefined
  const lender = req.query['lender'] as string | undefined
  const epc = req.query['epc'] as string | undefined
  const nemUser = req.query['nem_user'] as string | undefined
  const clientToday = req.query['today'] as string | undefined
  const today = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) ? clientToday : new Date().toISOString().split('T')[0]!
  const dateFrom = req.query['date_from'] as string | undefined
  const dateTo = req.query['date_to'] as string | undefined
  const useBizDays = req.query['biz_days'] === '1'
  const bizFactor = useBizDays ? 5 / 7 : 1

  let base = "WHERE (LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%' OR LOWER(status) LIKE '%complete%')"
  const bp: unknown[] = []
  if (state) { base += ' AND state = ?'; bp.push(state) }
  if (lender) { base += ' AND lender = ?'; bp.push(lender) }
  if (epc) { base += ' AND epc = ?'; bp.push(epc) }
  if (nemUser) { base += ' AND nem_user = ?'; bp.push(nemUser) }

  const has = (c: string) => `(${c} IS NOT NULL AND ${c} != '' AND ${c} != '0')`
  const noV = (c: string) => `(${c} IS NULL OR ${c} = '' OR ${c} = '0')`

  // Date-scoped wheres
  let subW = `${base} AND ${has('pto_submitted')}`; const subP = [...bp]
  if (dateFrom) { subW += ' AND pto_submitted >= ?'; subP.push(dateFrom) }
  if (dateTo) { subW += ' AND pto_submitted <= ?'; subP.push(dateTo + 'T23:59:59') }

  let apprW = `${base} AND ${has('pto_approved')}`; const apprP = [...bp]
  if (dateFrom) { apprW += ' AND pto_approved >= ?'; apprP.push(dateFrom) }
  if (dateTo) { apprW += ' AND pto_approved <= ?'; apprP.push(dateTo + 'T23:59:59') }

  // KPIs
  const ptoSubCount = db.prepare(`SELECT COUNT(*) as c, COALESCE(SUM(system_size_kw),0) as kw FROM project_cache ${subW}`).get(...subP) as { c: number; kw: number }
  const ptoApprCount = db.prepare(`SELECT COUNT(*) as c, COALESCE(SUM(system_size_kw),0) as kw FROM project_cache ${apprW}`).get(...apprP) as { c: number; kw: number }
  const needPto = db.prepare(`SELECT COUNT(*) as c, COALESCE(SUM(system_size_kw),0) as kw FROM project_cache ${base} AND ${has('inspection_passed')} AND ${noV('pto_approved')}`).get(...bp) as { c: number; kw: number }
  const avgI2P = db.prepare(`SELECT AVG(JULIANDAY(pto_approved) - JULIANDAY(install_completed)) as d FROM project_cache ${apprW} AND ${has('install_completed')}`).get(...apprP) as { d: number | null }
  const avgDSI = db.prepare(`SELECT AVG(JULIANDAY('${today}') - JULIANDAY(install_completed)) as d FROM project_cache ${base} AND ${has('install_completed')} AND ${has('inspection_passed')} AND ${noV('pto_approved')}`).get(...bp) as { d: number | null }

  // Smart grouping
  const useWeeks = dateFrom && dateTo && Math.floor((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000) <= 90
  const subG = useWeeks ? mondayWeekExpr('pto_submitted') : "SUBSTR(pto_submitted, 1, 7)"
  const apprG = useWeeks ? mondayWeekExpr('pto_approved') : "SUBSTR(pto_approved, 1, 7)"

  const ptoSubmitted = db.prepare(`SELECT ${subG} as period, COUNT(*) as count FROM project_cache ${subW} GROUP BY period ORDER BY period`).all(...subP)
  const ptoApproved = db.prepare(`SELECT ${apprG} as period, COUNT(*) as count FROM project_cache ${apprW} GROUP BY period ORDER BY period`).all(...apprP)

  // Box plot data — bucket TWICE so the chart can pivot its x-axis based
  // on which metric is being displayed:
  //   Inst → PTO  → bucket by install_completed month (the actual cohort)
  //   Sale → PTO  → bucket by sales_date month
  // Previously only the sale-month bucketing existed, which meant an
  // install in April with a sale in March showed up under March on both
  // chart modes — masked recent installs.
  const rawTTP = db.prepare(`
    SELECT SUBSTR(sales_date,1,7) as sm,
           SUBSTR(install_completed,1,7) as im,
           CAST(JULIANDAY(pto_approved)-JULIANDAY(install_completed) AS INTEGER) as i2p,
           CAST(JULIANDAY(pto_approved)-JULIANDAY(sales_date) AS INTEGER) as s2p
    FROM project_cache ${base} AND ${has('pto_approved')} AND ${has('install_completed')} AND ${has('sales_date')} ORDER BY sales_date
  `).all(...bp) as Array<{ sm: string; im: string; i2p: number; s2p: number }>

  function pct(a: number[], p: number) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = (p / 100) * (s.length - 1); const l = Math.floor(i); return l === Math.ceil(i) ? s[l]! : Math.round(s[l]! + (s[Math.ceil(i)]! - s[l]!) * (i - l)) }
  function mean(a: number[]) { return a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : 0 }

  type BucketAcc = { inst: number[]; sale: number[] }
  function ensure(map: Map<string, BucketAcc>, key: string): BucketAcc {
    let v = map.get(key)
    if (!v) { v = { inst: [], sale: [] }; map.set(key, v) }
    return v
  }
  const bySale = new Map<string, BucketAcc>()
  const byInstall = new Map<string, BucketAcc>()
  for (const r of rawTTP) {
    const i2p = useBizDays ? Math.round(r.i2p * bizFactor) : r.i2p
    const s2p = useBizDays ? Math.round(r.s2p * bizFactor) : r.s2p
    if (r.sm) {
      const v = ensure(bySale, r.sm)
      if (r.i2p >= 0) v.inst.push(i2p)
      if (r.s2p >= 0) v.sale.push(s2p)
    }
    if (r.im) {
      const v = ensure(byInstall, r.im)
      if (r.i2p >= 0) v.inst.push(i2p)
      if (r.s2p >= 0) v.sale.push(s2p)
    }
  }

  // Cohort-size lookups — one per bucketing. Each is "denominator" for the
  // pctPto rate displayed in tooltip + footer table.
  const totalBySaleMonth = db.prepare(`
    SELECT SUBSTR(sales_date,1,7) as sm, COUNT(*) as total
    FROM project_cache ${base} AND ${has('sales_date')} AND ${has('install_completed')}
    GROUP BY sm
  `).all(...bp) as Array<{ sm: string; total: number }>
  const totalBySale = new Map(totalBySaleMonth.map(r => [r.sm, r.total]))

  const totalByInstallMonth = db.prepare(`
    SELECT SUBSTR(install_completed,1,7) as im, COUNT(*) as total
    FROM project_cache ${base} AND ${has('install_completed')}
    GROUP BY im
  `).all(...bp) as Array<{ im: string; total: number }>
  const totalByInstall = new Map(totalByInstallMonth.map(r => [r.im, r.total]))

  function boxRowsFor(map: Map<string, BucketAcc>, totals: Map<string, number>, monthKey: 'sale_month' | 'install_month') {
    const out: Array<Record<string, unknown>> = []
    const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
    for (const [month, d] of sorted) {
      const totalProj = totals.get(month) || d.inst.length
      out.push({
        [monthKey]: month,
        count: d.inst.length,
        totalProjects: totalProj,
        pctPto: totalProj > 0 ? Math.round((d.inst.length / totalProj) * 100) : 0,
        inst: { p0: pct(d.inst, 0), p25: pct(d.inst, 25), p50: pct(d.inst, 50), p90: pct(d.inst, 90), p100: pct(d.inst, 100), mean: mean(d.inst) },
        sale: { p0: pct(d.sale, 0), p25: pct(d.sale, 25), p50: pct(d.sale, 50), p90: pct(d.sale, 90), p100: pct(d.sale, 100), mean: mean(d.sale) },
      })
    }
    return out
  }
  const boxes = boxRowsFor(bySale, totalBySale, 'sale_month')
  const boxesByInstall = boxRowsFor(byInstall, totalByInstall, 'install_month')

  // Aging
  const agingRows = db.prepare(`
    SELECT record_id, customer_name, system_size_kw, coordinator, nem_user, state,
      CAST(JULIANDAY('${today}') - JULIANDAY(inspection_passed) AS INTEGER) as days,
      CASE WHEN ${has('pto_submitted')} THEN 1 ELSE 0 END as has_sub,
      inspection_passed, pto_submitted
    FROM project_cache ${base} AND ${has('inspection_passed')} AND ${noV('pto_approved')}
  `).all(...bp) as Array<Record<string, unknown>>

  const bkts = [{ label: '0-15', min: 0, max: 15 }, { label: '16-30', min: 16, max: 30 }, { label: '31-60', min: 31, max: 60 }, { label: '61-90', min: 61, max: 90 }, { label: '90+', min: 91, max: 99999 }]
  const aging = bkts.map(b => { const items = agingRows.filter(r => (r.days as number) >= b.min && (r.days as number) <= b.max); return { label: b.label, count: items.length, submitted: items.filter(r => r.has_sub).length, kw: Math.round(items.reduce((s, r) => s + ((r.system_size_kw as number) || 0), 0)) } })

  // Installed accounts
  const installed = db.prepare(`
    SELECT SUBSTR(install_completed,1,7) as im, COUNT(*) as total,
      SUM(CASE WHEN ${has('pto_approved')} THEN 1 ELSE 0 END) as pto_appr,
      SUM(CASE WHEN ${has('pto_submitted')} AND ${noV('pto_approved')} THEN 1 ELSE 0 END) as pto_sub,
      SUM(CASE WHEN ${noV('inspection_passed')} THEN 1 ELSE 0 END) as no_inspx
    FROM project_cache ${base} AND ${has('install_completed')} GROUP BY im ORDER BY im
  `).all(...bp)

  // NEM pivot — Need PTO, Submitted, SLA miss, Stale, Approved
  const nemPivot = db.prepare(`
    SELECT nem_user as name,
      COUNT(*) as need,
      SUM(CASE WHEN ${has('pto_submitted')} AND ${noV('pto_approved')} THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN ${noV('pto_submitted')} AND JULIANDAY('${today}') - JULIANDAY(inspection_passed) >= 1 THEN 1 ELSE 0 END) as sla_miss,
      SUM(CASE WHEN ${has('pto_submitted')} AND ${noV('pto_approved')} AND JULIANDAY('${today}') - JULIANDAY(pto_submitted) >= 30 THEN 1 ELSE 0 END) as stale
    FROM project_cache ${base} AND ${has('inspection_passed')} AND ${noV('pto_approved')} AND nem_user != '' GROUP BY nem_user ORDER BY need DESC
  `).all(...bp) as Array<Record<string, unknown>>

  // Also get approved count per NEM user (within date range if set)
  const nemApproved = db.prepare(`
    SELECT nem_user as name, COUNT(*) as approved
    FROM project_cache ${apprW} AND nem_user != '' GROUP BY nem_user
  `).all(...apprP) as Array<{ name: string; approved: number }>
  const apprMap = new Map(nemApproved.map(r => [r.name, r.approved]))

  const nemPivotEnriched = nemPivot.map(r => ({ ...r, approved: apprMap.get(r.name as string) || 0 }))

  // ── Actionable lists ──

  // Fire list: inspection passed, no PTO submitted, within SLA window (1 biz day = ~2 cal days buffer)
  const fireList = agingRows
    .filter(r => !(r.has_sub as number) && (r.days as number) >= 1)
    .sort((a, b) => (b.days as number) - (a.days as number))
    .slice(0, 50)
    .map(r => ({ record_id: r.record_id, customer_name: r.customer_name, coordinator: r.coordinator, nem_user: r.nem_user, state: r.state, inspection_passed: r.inspection_passed, days: r.days, system_size_kw: r.system_size_kw }))

  // Stale queue: PTO submitted 30+ days ago, not approved
  const staleQueue = db.prepare(`
    SELECT record_id, customer_name, coordinator, nem_user, state, system_size_kw, pto_submitted,
      CAST(JULIANDAY('${today}') - JULIANDAY(pto_submitted) AS INTEGER) as days_since_sub
    FROM project_cache ${base} AND ${has('pto_submitted')} AND ${noV('pto_approved')}
      AND JULIANDAY('${today}') - JULIANDAY(pto_submitted) >= 30
    ORDER BY days_since_sub DESC LIMIT 50
  `).all(...bp)

  // Filter options
  const states = db.prepare("SELECT DISTINCT state as value FROM project_cache WHERE state != '' ORDER BY state").all()
  const lenders = db.prepare("SELECT DISTINCT lender as value FROM project_cache WHERE lender != '' ORDER BY lender").all()
  const epcs = db.prepare("SELECT DISTINCT epc as value FROM project_cache WHERE epc != '' ORDER BY epc").all()
  const nemUsers = db.prepare("SELECT DISTINCT nem_user as value FROM project_cache WHERE nem_user != '' ORDER BY nem_user").all()

  res.json({
    kpi: {
      ptoSub: { count: ptoSubCount.c, kw: Math.round(ptoSubCount.kw) },
      ptoApproved: { count: ptoApprCount.c, kw: Math.round(ptoApprCount.kw) },
      needPto: { count: needPto.c, kw: Math.round(needPto.kw) },
      avgInstToPto: Math.round((avgI2P.d || 0) * bizFactor),
      avgDaysSinceInst: Math.round((avgDSI.d || 0) * bizFactor),
      fireCount: fireList.length,
      staleCount: staleQueue.length,
    },
    charts: { ptoSubmitted, ptoApproved, timeToPtoBoxes: boxes, timeToPtoBoxesByInstall: boxesByInstall, aging, installedByMonth: installed },
    pivot: { nemUser: nemPivotEnriched },
    lists: { fire: fireList, stale: staleQueue },
    filters: { states: (states as Array<{ value: string }>).map(s => s.value), lenders: (lenders as Array<{ value: string }>).map(l => l.value), epcs: (epcs as Array<{ value: string }>).map(e => e.value), nemUsers: (nemUsers as Array<{ value: string }>).map(n => n.value) },
  })
})

// GET /api/analytics/pto/drill?metric=ptoSub|ptoAppr|installComplete
//                              &period=YYYY-MM | YYYY-MM-DD
//                              &state=&lender=&epc=&nem_user=
//
// Returns the projects that contributed to the chart bar the user
// clicked. period 7-char = month, 10-char = Monday-anchored week.
router.get('/drill', (req: Request, res: Response): void => {
  const metric = String(req.query['metric'] || 'ptoSub')
  const period = String(req.query['period'] || '').trim()
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period)) {
    res.status(400).json({ error: 'period must be YYYY-MM or YYYY-MM-DD' })
    return
  }

  let from: string, to: string
  if (period.length === 7) {
    const [y, m] = period.split('-').map(Number)
    const last = new Date(y!, m!, 0).getDate()
    from = `${period}-01`
    to = `${period}-${String(last).padStart(2, '0')}`
  } else {
    from = period
    const d = new Date(`${period}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 6)
    to = d.toISOString().slice(0, 10)
  }

  const dateCol = metric === 'ptoAppr'        ? 'pto_approved'
                : metric === 'installComplete' ? 'install_completed'
                : /* ptoSub */                   'pto_submitted'

  const state   = req.query['state']    as string | undefined
  const lender  = req.query['lender']   as string | undefined
  const epc     = req.query['epc']      as string | undefined
  const nemUser = req.query['nem_user'] as string | undefined
  const limit   = Math.min(500, Math.max(1, parseInt(String(req.query['limit'] || '200'), 10) || 200))

  const where = [
    `${dateCol} IS NOT NULL AND ${dateCol} != ''`,
    `SUBSTR(${dateCol}, 1, 10) >= ?`,
    `SUBSTR(${dateCol}, 1, 10) <= ?`,
  ]
  const params: unknown[] = [from, to]
  if (state)   { where.push('state = ?');     params.push(state) }
  if (lender)  { where.push('lender = ?');    params.push(lender) }
  if (epc)     { where.push('epc = ?');       params.push(epc) }
  if (nemUser) { where.push('nem_user = ?');  params.push(nemUser) }

  const rows = db.prepare(`
    SELECT record_id, customer_name, customer_address, status, state,
           coordinator, closer, lender, epc, nem_user, system_size_kw,
           sales_date, intake_completed,
           survey_scheduled, survey_submitted, survey_approved,
           cad_submitted, design_completed,
           permit_submitted, permit_approved, permit_rejected,
           nem_submitted, nem_approved, nem_rejected,
           install_scheduled, install_completed,
           inspection_scheduled, inspection_passed,
           pto_submitted, pto_approved
    FROM project_cache
    WHERE ${where.join(' AND ')}
    ORDER BY ${dateCol} DESC
    LIMIT ?
  `).all(...params, limit)
  res.json({ projects: rows, total: rows.length, metric, period, from, to })
})

// GET /api/analytics/pto/deciles?metric=...&dimension=...&from=...&to=...&biz_days=1
//
// Same shape as the Inspection deciles endpoint. Metrics:
//   install_to_pto_appr — install_completed → pto_approved
//   sale_to_pto_appr    — sales_date         → pto_approved
//   pass_to_sub         — inspection_passed  → pto_submitted
//   sub_to_appr         — pto_submitted      → pto_approved
router.get('/deciles', (req: Request, res: Response): void => {
  const metric = String(req.query['metric'] || 'install_to_pto_appr')
  const dimension = String(req.query['dimension'] || 'state')
  const dateFrom = req.query['from'] as string | undefined
  const dateTo = req.query['to'] as string | undefined
  const useBizDays = req.query['biz_days'] === '1'
  const bizFactor = useBizDays ? 5 / 7 : 1

  const DIM_COLS: Record<string, string> = {
    state: 'state',
    lender: 'lender',
    epc: 'epc',
    ahj: 'ahj_name',
    utility: 'utility_company',
  }
  const dimCol = DIM_COLS[dimension] || 'state'

  let startCol: string, endCol: string
  if (metric === 'sale_to_pto_appr')        { startCol = 'sales_date';        endCol = 'pto_approved' }
  else if (metric === 'pass_to_sub')        { startCol = 'inspection_passed'; endCol = 'pto_submitted' }
  else if (metric === 'sub_to_appr')        { startCol = 'pto_submitted';     endCol = 'pto_approved' }
  else /* install_to_pto_appr */            { startCol = 'install_completed'; endCol = 'pto_approved' }

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

export { router as ptoAnalyticsRouter }
