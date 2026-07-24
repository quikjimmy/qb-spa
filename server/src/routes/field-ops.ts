import { Router, type Request, type Response } from 'express'
import db from '../db'
import { qbQuery, QB, F, fieldValue, chunk, type QbRecord } from './field'
import { officeTodayIso } from '../lib/officeTime'
import { bucketSummary, bucketRows } from './funding'
import { callUserLlm } from '../lib/callUserLlm'

// Field Ops — Crew Lifecycle scorecard. A date-range INSTALL COHORT (installs
// completed in [from,to], matching the standard filters), enriched with Arrivy
// crew + post-install-task data. Mirrors context-files/Field/*crew-scorecard*.
// Uses KNOWN data only: project_cache milestone columns + the Arrivy F field-ids
// field.ts already uses. The Installations table is NOT used — its crew (#74),
// subcontractor (#26) and roll-count (#2407) fields are unpopulated in practice.

const router = Router()

// Only W2 crews currently are Ukaia (Panhandle FL) and Humberto (Central FL);
// everything else is a subcontractor. Edit this as the roster changes.
function crewType(name: string): 'W2' | 'Sub' | 'Unassigned' {
  const n = name.trim().toLowerCase()
  if (!n || n === 'unassigned') return 'Unassigned'
  if (/ukaia|panhandle|humberto|central fl/.test(n)) return 'W2'
  return 'Sub'
}
// Arrivy crew fields come back as arrays (e.g. ["Central FL Crew - Humberto"]).
function arrStr(v: unknown): string {
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean).join(', ')
  return v == null ? '' : String(v)
}
function daysBetween(a: string, b: string): number | null {
  const da = new Date(`${a.slice(0, 10)}T12:00:00Z`).getTime()
  const dbv = new Date(`${b.slice(0, 10)}T12:00:00Z`).getTime()
  if (!Number.isFinite(da) || !Number.isFinite(dbv)) return null
  return Math.round((dbv - da) / 86_400_000)
}
// Business days (Mon–Fri) between two ISO dates, weekends excluded. No holiday
// calendar — weekends only. Same day = 0; negative if b precedes a.
function businessDaysBetween(a: string, b: string): number | null {
  const start = new Date(`${a.slice(0, 10)}T12:00:00Z`)
  const end = new Date(`${b.slice(0, 10)}T12:00:00Z`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null
  const dir = end >= start ? 1 : -1
  let days = 0
  const cur = new Date(start)
  while (cur.getTime() !== end.getTime()) {
    cur.setUTCDate(cur.getUTCDate() + dir)
    const dow = cur.getUTCDay()
    if (dow !== 0 && dow !== 6) days += dir
  }
  return days
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function isoWeekStart(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
  return d.toISOString().slice(0, 10)
}

interface OpsFilter { state?: string; office?: string; coordinator?: string; closer?: string; lender?: string; epc?: string; batteryOnly?: boolean }
function filterClause(f: OpsFilter): { sql: string; params: unknown[] } {
  const parts: string[] = []; const params: unknown[] = []
  const eq = (col: string, v?: string) => { if (v && v.trim() && v !== '__all__') { parts.push(`${col} = ?`); params.push(v.trim()) } }
  eq('state', f.state); eq('sales_office', f.office); eq('coordinator', f.coordinator)
  eq('closer', f.closer); eq('lender', f.lender); eq('epc', f.epc)
  // Battery-Only = placeholder system size (< 1 kW) AND a battery adder — same
  // rule the projects page uses (battery_project set).
  if (f.batteryOnly) parts.push(`system_size_kw < 1 AND record_id IN (SELECT project_rid FROM battery_project)`)
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params }
}
function parseFilter(req: Request): OpsFilter {
  const s = (k: string) => { const v = req.query[k]; return typeof v === 'string' ? v : undefined }
  return { state: s('state'), office: s('office'), coordinator: s('coordinator'), closer: s('closer'), lender: s('lender'), epc: s('epc'), batteryOnly: req.query['battery_only'] === '1' }
}

interface CohortRow {
  record_id: number; customer_name: string | null; state: string | null; system_size_kw: number | null; install_completed: string
  sales_office: string | null; coordinator: string | null; closer: string | null; lender: string | null; epc: string | null
  inspection_passed: string | null; inspx_count: string | null; inspx_fail_date: string | null
  permit_approved: string | null
  pto_submitted: string | null; pto_approved: string | null
  m2_status: string | null; m2_requested_date: string | null
  m3_status: string | null; m3_requested_date: string | null
  battery_only: number // 1 = kW<1 with a battery adder (legit Battery-Only project, not a data error)
}
// groupBy key → project_cache column, for the trend split-by-dimension.
const GROUP_COLS: Record<string, keyof CohortRow> = {
  state: 'state', office: 'sales_office', coordinator: 'coordinator', closer: 'closer', lender: 'lender', epc: 'epc',
}

// W2 install capacity assumptions (analyst inputs, editable). Utilization =
// scheduled W2 kW / (W2_CREW_COUNT × W2_KW_PER_CREW_WEEK × weeks in period).
// Only 2 W2 crews currently (Ukaia + Humberto), so the count is pinned rather
// than derived from crew-name variants.
const W2_KW_PER_CREW_WEEK = 50
const W2_CREW_COUNT = 2

const pct = (n: number, d: number) => d ? Math.round((n / d) * 100) : 0
const avg = (nums: number[]) => nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0

// "Not Ready" reuses the Funding Dashboard's OWN bucket function (funding.ts
// bucketSummary) so the two can never drift — same BASE_WHERE, same status
// clause, same filter handling. It's a live whole-pipeline snapshot (all
// install dates), scoped only by the funding-dashboard filters (state / closer
// / lender), exactly like that dashboard.

// ── Shared cohort/Arrivy/project building (used by /overview and /trend) ──
const COHORT_COLS = `record_id, customer_name, state, sales_office, coordinator, closer, lender, epc, system_size_kw, install_completed, inspection_passed, inspx_count, inspx_fail_date, permit_approved, pto_submitted, pto_approved, m2_status, m2_requested_date, m3_status, m3_requested_date, (system_size_kw < 1 AND record_id IN (SELECT project_rid FROM battery_project)) AS battery_only`
function loadCohort(from: string, to: string, fc: { sql: string; params: unknown[] }): CohortRow[] {
  return db.prepare(`
    SELECT ${COHORT_COLS} FROM project_cache
    WHERE install_completed IS NOT NULL AND install_completed != ''
      AND substr(install_completed,1,10) BETWEEN ? AND ?${fc.sql}
    ORDER BY install_completed ASC
  `).all(from, to, ...fc.params) as CohortRow[]
}

interface AT { crew: string; post: string[]; onRoute: boolean; onSite: boolean; submitted: boolean; techComplete: boolean; rtr: '' | 'Pass' | 'Fail' | 'Coach' }
async function fetchArrivyFor(ridSet: Set<string>): Promise<Map<string, AT>> {
  const arrivy = new Map<string, AT>()
  for (const batch of chunk([...ridSet], 80)) {
    const orClause = batch.map(rid => `{'${F.relatedProject}'.EX.'${rid}'}`).join('OR')
    const rows = await qbQuery(QB.arrivyTable, `(${orClause})`,
      [F.relatedProject, F.templateName, F.crew, F.assignedCrew, F.enrouteName, F.enrouteStatus, F.startedStatus, F.submittedDateTime, F.techCompleteDateTime, F.rtrStatus],
      { options: { top: 3000 } }).catch(() => [] as QbRecord[])
    for (const r of rows) {
      const rid = String(fieldValue(r, F.relatedProject) || '')
      if (!ridSet.has(rid)) continue
      const tmpl = String(fieldValue(r, F.templateName) || '')
      let e = arrivy.get(rid); if (!e) { e = { crew: '', post: [], onRoute: false, onSite: false, submitted: false, techComplete: false, rtr: '' }; arrivy.set(rid, e) }
      if (/install/i.test(tmpl) && !/reinstall/i.test(tmpl)) {
        if (!e.crew) e.crew = arrStr(fieldValue(r, F.crew)) || arrStr(fieldValue(r, F.assignedCrew)) || arrStr(fieldValue(r, F.enrouteName))
        if (fieldValue(r, F.enrouteStatus)) e.onRoute = true
        if (fieldValue(r, F.startedStatus)) e.onSite = true // Arrivy STARTED = crew on site
        if (fieldValue(r, F.submittedDateTime)) e.submitted = true
        if (fieldValue(r, F.techCompleteDateTime)) e.techComplete = true
        if (!e.rtr) { const s = String(fieldValue(r, F.rtrStatus) || ''); e.rtr = /pass/i.test(s) ? 'Pass' : /fail/i.test(s) ? 'Fail' : /coach/i.test(s) ? 'Coach' : '' }
      } else if (!/survey|site visit/i.test(tmpl)) {
        e.post.push(tmpl) // post-install visit (excl. pre-install survey)
      }
    }
  }
  return arrivy
}

interface P { crew: string; customer: string; installDate: string; kw: number; batteryOnly: boolean; passed: boolean; failedOpen: boolean; firstTime: boolean; daysI2I: number | null; permitAtInstall: boolean; ptoApproved: boolean; ptoStatus: string; rolls: number; oneTouch: boolean; onRoute: boolean; onSite: boolean; submitted: boolean; techComplete: boolean; rtr: '' | 'Pass' | 'Fail' | 'Coach' }
function toProject(r: CohortRow, a: AT | undefined): P {
  const crew = (a?.crew || '').trim() || 'Unassigned'
  const post = a?.post ?? []
  const passed = !!(r.inspection_passed && r.inspection_passed.trim())
  const failedOpen = !passed && !!(r.inspx_fail_date && r.inspx_fail_date.trim()) // inspected, not yet passing
  const cnt = Number(String(r.inspx_count ?? '').trim())
  const firstTime = passed && Number.isFinite(cnt) && cnt <= 1
  const daysI2I = passed ? daysBetween(r.install_completed, r.inspection_passed!) : null
  // Permit approved on/before install day. When it isn't, the wait for the
  // permit inflates install→inspection days (inspection can't happen first).
  const permit = (r.permit_approved || '').slice(0, 10)
  const permitAtInstall = !!permit && permit <= r.install_completed.slice(0, 10)
  const oneTouch = post.filter(t => !/inspection/i.test(t)).length === 0 // only inspections (or nothing) = 1-touch
  const ptoApproved = !!(r.pto_approved && r.pto_approved.trim())
  const ptoStatus = ptoApproved ? 'Approved' : (r.pto_submitted && r.pto_submitted.trim()) ? 'Submitted' : 'None'
  return { crew, customer: r.customer_name || '', installDate: r.install_completed.slice(0, 10), kw: Number(r.system_size_kw) || 0, batteryOnly: !!r.battery_only, passed, failedOpen, firstTime, daysI2I, permitAtInstall, ptoApproved, ptoStatus, rolls: post.length, oneTouch, onRoute: !!a?.onRoute, onSite: !!a?.onSite, submitted: !!a?.submitted, techComplete: !!a?.techComplete, rtr: a?.rtr ?? '' }
}

// Cohort-wide headline metrics (also computed per weekly bucket by /trend).
function headlineMetrics(ps: P[]) {
  const passedCount = ps.filter(p => p.passed).length
  const firstTimeCount = ps.filter(p => p.firstTime).length
  const daysList = ps.map(p => p.daysI2I).filter((d): d is number => d != null && d >= 0)
  // Install→inspection days over only the installs that HAD a permit on install
  // day — removes the permit-wait inflation from the field-time signal.
  const daysListPermitted = ps.filter(p => p.permitAtInstall).map(p => p.daysI2I).filter((d): d is number => d != null && d >= 0)
  const inspectedN = ps.filter(p => p.passed || p.failedOpen).length
  return {
    installs: ps.length,
    kw: Math.round(ps.reduce((s, p) => s + p.kw, 0) * 10) / 10,
    passed: passedCount,
    inspPassRate: pct(passedCount, ps.length), // % of the whole cohort that has passed
    awaitingInspx: ps.length - inspectedN,
    firstTimeRate: pct(firstTimeCount, passedCount),
    avgDaysI2I: Math.round(avg(daysList) * 10) / 10,
    avgDaysI2IPermitted: Math.round(avg(daysListPermitted) * 10) / 10, // I2I excluding no-permit-at-install
    noPermitAtInstall: ps.filter(p => !p.permitAtInstall).length, // installs lacking a permit on install day
    batteryOnly: ps.filter(p => p.batteryOnly).length, // legit near-zero-kW Battery-Only projects (not data errors)
    avgRolls: Math.round(avg(ps.map(p => p.rolls)) * 100) / 100,
    oneTouchRate: pct(ps.filter(p => p.oneTouch).length, ps.length),
    ptoRate: pct(ps.filter(p => p.ptoApproved).length, ps.length),
  }
}

router.get('/overview', async (req: Request, res: Response): Promise<void> => {
  try {
    const today = officeTodayIso()
    const from = (typeof req.query['from'] === 'string' && req.query['from']) || `${today.slice(0, 7)}-01`
    const to = (typeof req.query['to'] === 'string' && req.query['to']) || today
    const f = parseFilter(req)
    const fc = filterClause(f)

    // Filter dropdown options (full distinct project_cache lists).
    const distinct = (col: string): string[] =>
      (db.prepare(`SELECT DISTINCT ${col} v FROM project_cache WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY ${col}`).all() as Array<{ v: string }>).map(r => r.v)
    const filters = {
      states: distinct('state'), offices: distinct('sales_office'), coordinators: distinct('coordinator'),
      closers: distinct('closer'), lenders: distinct('lender'), epcs: distinct('epc'),
    }

    // ── Install cohort: completed in [from,to], matching filters ──
    const cohort = loadCohort(from, to, fc)

    // Utilization is a capacity view, so it keys off the SCHEDULED date (installs
    // often complete a day+ after their scheduled day), NOT install_completed.
    // Extend the upper bound to the SUNDAY of the week containing `to` so an
    // in-progress current week counts its full Mon–Sun scheduled load (jobs
    // scheduled later this week aren't dropped just because they haven't happened).
    const schedTo = addDays(isoWeekStart(to), 6)
    const scheduledCohort = db.prepare(`
      SELECT record_id, system_size_kw, install_scheduled FROM project_cache
      WHERE install_scheduled IS NOT NULL AND install_scheduled != ''
        AND substr(install_scheduled,1,10) BETWEEN ? AND ?${fc.sql}
    `).all(from, schedTo, ...fc.params) as Array<{ record_id: number; system_size_kw: number | null; install_scheduled: string }>

    const emptyHead = { installs: 0, kw: 0, passed: 0, inspPassRate: 0, awaitingInspx: 0, firstTimeRate: 0, avgDaysI2I: 0, avgRolls: 0, oneTouchRate: 0, ptoRate: 0 }
    if (cohort.length === 0 && scheduledCohort.length === 0) {
      res.json({ from, to, applied: f, headline: emptyHead, crews: [], crewTotals: null, byType: [], batteryMix: null, utilization: null, utilizationMatrix: null, funding: null, projects: [], throughput: [], filters }); return
    }

    // ── Arrivy: crew + post-install tasks for both cohorts' projects ──
    const ridSet = new Set([...cohort.map(r => String(r.record_id)), ...scheduledCohort.map(r => String(r.record_id))])
    const arrivy = await fetchArrivyFor(ridSet)

    // ── Per-project metrics + headline ──
    const projects: P[] = cohort.map(r => toProject(r, arrivy.get(String(r.record_id))))
    const headline = headlineMetrics(projects)

    // ── Per-crew leaderboard (sorted by first-time pass, like the scorecard) ──
    const byCrew = new Map<string, P[]>()
    for (const p of projects) { const arr = byCrew.get(p.crew) || []; arr.push(p); byCrew.set(p.crew, arr) }
    const crews = [...byCrew.entries()].map(([crew, ps]) => {
      const n = ps.length
      const first = ps.filter(p => p.firstTime).length
      const ptoN = ps.filter(p => p.ptoApproved).length
      const dl = ps.map(p => p.daysI2I).filter((d): d is number => d != null && d >= 0)
      const rtrN = ps.filter(p => p.rtr).length
      return {
        crew, type: crewType(crew),
        installs: n,
        kw: Math.round(ps.reduce((s, p) => s + p.kw, 0) * 10) / 10,
        firstTimeCount: first, firstTimeRate: pct(first, n),        // 1st-Time Pass = first-time / installs (scorecard def)
        avgDaysI2I: Math.round(avg(dl) * 10) / 10,
        avgRolls: Math.round(avg(ps.map(p => p.rolls)) * 100) / 100,
        ptoCount: ptoN, ptoRate: pct(ptoN, n),
        onRoutePct: pct(ps.filter(p => p.onRoute).length, n),
        onSitePct: pct(ps.filter(p => p.onSite).length, n),
        submittedPct: pct(ps.filter(p => p.submitted).length, n),
        techCompletePct: pct(ps.filter(p => p.techComplete).length, n),
        rtrPassPct: pct(ps.filter(p => p.rtr === 'Pass').length, rtrN || n),
        rtrFailPct: pct(ps.filter(p => p.rtr === 'Fail').length, rtrN || n),
        rtrCoachPct: pct(ps.filter(p => p.rtr === 'Coach').length, rtrN || n),
        oneTouchRate: pct(ps.filter(p => p.oneTouch).length, n),
      }
    }).sort((a, b) => b.firstTimeRate - a.firstTimeRate || b.installs - a.installs)

    // Cohort-wide totals row for the leaderboard (rates recomputed over all installs).
    const nAll = projects.length
    const daysAll = projects.map(p => p.daysI2I).filter((d): d is number => d != null && d >= 0)
    const crewTotals = {
      installs: nAll,
      kw: Math.round(projects.reduce((s, p) => s + p.kw, 0) * 10) / 10,
      firstTimeCount: projects.filter(p => p.firstTime).length, firstTimeRate: pct(projects.filter(p => p.firstTime).length, nAll),
      avgDaysI2I: Math.round(avg(daysAll) * 10) / 10,
      avgRolls: Math.round(avg(projects.map(p => p.rolls)) * 100) / 100,
      ptoCount: projects.filter(p => p.ptoApproved).length, ptoRate: pct(projects.filter(p => p.ptoApproved).length, nAll),
      onRoutePct: pct(projects.filter(p => p.onRoute).length, nAll),
      onSitePct: pct(projects.filter(p => p.onSite).length, nAll),
      submittedPct: pct(projects.filter(p => p.submitted).length, nAll),
    }

    // ── W2 vs Sub rollup ──
    const byType = (['W2', 'Sub', 'Unassigned'] as const).map(t => {
      const ps = projects.filter(p => crewType(p.crew) === t)
      return { type: t, installs: ps.length, kw: Math.round(ps.reduce((s, p) => s + p.kw, 0) * 10) / 10 }
    }).filter(x => x.installs > 0)

    // ── Battery-Only vs PV split (for the breakout when it's material). Battery
    // -only installs carry ~0 kW, so they lift install count but not kW — key
    // metrics (first-time, rolls, I2I) are shown per segment for comparison. ──
    const segMetrics = (ps: P[]) => {
      const passed = ps.filter(p => p.passed).length
      const dl = ps.map(p => p.daysI2I).filter((d): d is number => d != null && d >= 0)
      return {
        installs: ps.length,
        kw: Math.round(ps.reduce((s, p) => s + p.kw, 0) * 10) / 10,
        firstTimeRate: pct(ps.filter(p => p.firstTime).length, passed),
        avgRolls: Math.round(avg(ps.map(p => p.rolls)) * 100) / 100,
        avgDaysI2I: Math.round(avg(dl) * 10) / 10,
        ptoRate: pct(ps.filter(p => p.ptoApproved).length, ps.length),
      }
    }
    const batteryMix = { battery: segMetrics(projects.filter(p => p.batteryOnly)), pv: segMetrics(projects.filter(p => !p.batteryOnly)) }

    // ── W2 utilization + kW mix — from the SCHEDULED cohort (capacity view) ──
    const schedCrew = (rid: number) => (arrivy.get(String(rid))?.crew || '').trim() || 'Unassigned'
    const schedRows = scheduledCohort.map(r => { const crew = schedCrew(r.record_id); return { kw: Number(r.system_size_kw) || 0, type: crewType(crew), crew } })
    const sTotalKw = schedRows.reduce((s, r) => s + r.kw, 0)
    const w2Rows = schedRows.filter(r => r.type === 'W2')
    const subRows = schedRows.filter(r => r.type === 'Sub')
    const w2SchedKw = w2Rows.reduce((s, r) => s + r.kw, 0)
    const subSchedKw = subRows.reduce((s, r) => s + r.kw, 0)
    const weeks = Math.max(1, ((daysBetween(from, to) ?? 0) + 1) / 7)
    const w2CapacityKw = W2_CREW_COUNT * W2_KW_PER_CREW_WEEK * weeks
    const utilization = {
      basis: 'scheduled',
      totalKw: Math.round(sTotalKw * 10) / 10, w2Kw: Math.round(w2SchedKw * 10) / 10, subKw: Math.round(subSchedKw * 10) / 10,
      w2Installs: w2Rows.length, subInstalls: subRows.length,
      w2Pct: pct(w2SchedKw, sTotalKw), subPct: pct(subSchedKw, sTotalKw),
      w2CrewCount: W2_CREW_COUNT, weeks: Math.round(weeks * 10) / 10, kwPerCrewWeek: W2_KW_PER_CREW_WEEK,
      w2CapacityKw: Math.round(w2CapacityKw), w2UtilPct: w2CapacityKw ? Math.round((w2SchedKw / w2CapacityKw) * 100) : 0,
    }

    // ── Week-by-week crew utilization matrix (scheduled date; Mon–Sun weeks) ──
    // Utilization per cell = max(installs/5, kW/50) × 100 (whichever is higher).
    const weekStarts: string[] = []
    { let w = isoWeekStart(from); const end = isoWeekStart(to); let guard = 0; while (w <= end && guard++ < 60) { weekStarts.push(w); w = addDays(w, 7) } }
    const utilPct = (installs: number, kw: number) => Math.round(Math.max(installs / 5, kw / W2_KW_PER_CREW_WEEK) * 100)
    interface Cell { installs: number; kw: number }
    const mtx = new Map<string, { type: string; weeks: Map<string, Cell>; total: Cell }>()
    for (const r of scheduledCohort) {
      const crew = schedCrew(r.record_id)
      const wk = isoWeekStart(r.install_scheduled)
      let m = mtx.get(crew); if (!m) { m = { type: crewType(crew), weeks: new Map(), total: { installs: 0, kw: 0 } }; mtx.set(crew, m) }
      let c = m.weeks.get(wk); if (!c) { c = { installs: 0, kw: 0 }; m.weeks.set(wk, c) }
      const kw = Number(r.system_size_kw) || 0
      c.installs++; c.kw += kw; m.total.installs++; m.total.kw += kw
    }
    const round1 = (n: number) => Math.round(n * 10) / 10
    const utilizationMatrix = {
      weeks: weekStarts,
      crews: [...mtx.entries()].map(([crew, m]) => ({
        crew, type: m.type,
        cells: weekStarts.map(w => { const c = m.weeks.get(w); return c ? { installs: c.installs, kw: round1(c.kw), util: utilPct(c.installs, c.kw) } : null }),
        total: { installs: m.total.installs, kw: round1(m.total.kw) },
      })).sort((a, b) => {
        const rank = (t: string) => (t === 'W2' ? 0 : t === 'Sub' ? 1 : 2) // W2 crews pinned to the top
        return rank(a.type) - rank(b.type) || b.total.installs - a.total.installs || b.total.kw - a.total.kw
      }),
      // Weekly totals = total installs/kW, with W2 utilization (W2-only) and the
      // Sub/Total kW mix as sub-metrics for the week.
      weeklyTotals: weekStarts.map(w => {
        let installs = 0, kw = 0, w2Installs = 0, w2Kw = 0, subKw = 0
        for (const m of mtx.values()) {
          const c = m.weeks.get(w); if (!c) continue
          installs += c.installs; kw += c.kw
          if (m.type === 'W2') { w2Installs += c.installs; w2Kw += c.kw }
          else if (m.type === 'Sub') subKw += c.kw
        }
        const w2Util = Math.round(Math.max(w2Installs / (W2_CREW_COUNT * 5), w2Kw / (W2_CREW_COUNT * W2_KW_PER_CREW_WEEK)) * 100)
        return { installs, kw: round1(kw), w2Kw: round1(w2Kw), subKw: round1(subKw), w2Util, subMix: pct(subKw, kw) }
      }),
      grandTotal: { installs: scheduledCohort.length, kw: round1(sTotalKw), installsPerWeek: 5, kwPerWeek: W2_KW_PER_CREW_WEEK },
    }

    // ── Field-related funding delays ──
    // M2 is requestable once INSTALL is complete; M3 once PTO is approved. The
    // gap is measured in BUSINESS DAYS from that field milestone to the funding
    // request. A project is "delayed" if it was ever unable to request funds on
    // time: the request took longer than the SLA (even if now approved), or it
    // still can't submit — status "Not Ready" (the Funding Dashboard's combined
    // Not-Ready bucket incl. stale follow-ups), or it's past the milestone and
    // still un-requested beyond the SLA. delayRate is over the whole install
    // cohort. "Can't submit" is a live snapshot (matches the funding report) so
    // it is NOT gated on PTO — a Not-Ready-for-M3 install counts even pre-PTO.
    const SLA_BIZ_DAYS = 5 // a full work week to file the request after the milestone
    const fundingDelay = (
      milestoneDate: (r: CohortRow) => string | null, // gap start; also the "field reached" date
      requestedDate: (r: CohortRow) => string | null,
      status: (r: CohortRow) => string | null,
      cantSubmit: RegExp, // "Not Ready" status → currently unable to request
    ) => {
      const gaps: number[] = []
      let fieldReached = 0, requested = 0, openCount = 0, cantSubmitCount = 0, delayedCount = 0
      type Row = { customer: string; state: string; installDate: string; days: number; status: string; resolved: boolean }
      const delayed: Row[] = []
      const open: Row[] = [] // milestone reached, not yet requested, not formally Not-Ready
      for (const r of cohort) {
        const st = String(status(r) || '')
        const isCant = cantSubmit.test(st)
        if (isCant) cantSubmitCount++
        const mDate = (milestoneDate(r) || '').slice(0, 10)
        const reached = !!mDate
        if (reached) fieldReached++
        const req = (requestedDate(r) || '').trim()
        const base = { customer: r.customer_name || '', state: (r.state || '').trim(), installDate: r.install_completed.slice(0, 10) }
        let isDelayed = false, days = 0, resolved = false
        if (req) {
          requested++
          const g = reached ? businessDaysBetween(mDate, req.slice(0, 10)) : null
          if (g != null && g >= 0) { gaps.push(g); if (g > SLA_BIZ_DAYS) { isDelayed = true; days = g; resolved = true } }
        } else if (isCant) {
          isDelayed = true; days = reached ? (businessDaysBetween(mDate, today) ?? 0) : 0
        } else if (reached) {
          openCount++
          const openDays = businessDaysBetween(mDate, today) ?? 0
          open.push({ ...base, days: openDays, status: st || '—', resolved: false })
          if (openDays > SLA_BIZ_DAYS) { isDelayed = true; days = openDays }
        }
        if (isDelayed) { delayedCount++; delayed.push({ ...base, days, status: st || '—', resolved }) }
      }
      delayed.sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.days - a.days)
      open.sort((a, b) => b.days - a.days)
      return {
        cohortSize: cohort.length, fieldReached, requested,
        avgGapDays: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : 0,
        openCount, cantSubmitCount,
        delayRate: cohort.length ? Math.round((delayedCount / cohort.length) * 100) : 0,
        delayedCount, delayed: delayed.slice(0, 50), open: open.slice(0, 100),
      }
    }
    // Delay/gap/open stay cohort-scoped; cantSubmitCount is the Funding
    // Dashboard's own Not-Ready bucket count (state/closer/lender filters only,
    // matching that dashboard's filter set).
    const dashFilters = { state: f.state, closer: f.closer, lender: f.lender }
    const funding = {
      m2: { ...fundingDelay(r => r.install_completed, r => r.m2_requested_date, r => r.m2_status, /not ready for m2/i), cantSubmitCount: bucketSummary('M2:notReady', dashFilters).count, notReady: bucketRows('M2:notReady', 'm2_status', dashFilters) },
      m3: { ...fundingDelay(r => r.pto_approved, r => r.m3_requested_date, r => r.m3_status, /not ready for m3/i), cantSubmitCount: bucketSummary('M3:notReady', dashFilters).count, notReady: bucketRows('M3:notReady', 'm3_status', dashFilters) },
    }

    // ── Per-project rows for the crew drill-down ──
    const projectsOut = projects.map(p => ({
      crew: p.crew, type: crewType(p.crew), customer: p.customer, installDate: p.installDate, kw: p.kw,
      passed: p.passed, firstTime: p.firstTime, daysI2I: p.daysI2I, permitAtInstall: p.permitAtInstall, batteryOnly: p.batteryOnly, rolls: p.rolls, oneTouch: p.oneTouch, pto: p.ptoStatus,
    }))

    // ── Weekly install throughput (count + summed kW) across the range ──
    const wk = new Map<string, { count: number; kw: number }>()
    for (const p of projects) { const w = isoWeekStart(p.installDate); const e = wk.get(w) || { count: 0, kw: 0 }; e.count++; e.kw += p.kw; wk.set(w, e) }
    const throughput = [...wk.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, v]) => ({ week, count: v.count, kw: Math.round(v.kw) }))

    res.json({ from, to, applied: f, headline, crews, crewTotals, byType, batteryMix, utilization, utilizationMatrix, funding, projects: projectsOut, throughput, filters })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ── Weekly KPI trend: N full Mon–Sun weekly install-cohorts ending with the
// week containing `to`. Each week carries the same headline metrics as
// /overview so any KPI tile can chart its trajectory. Optional `groupBy`
// (state/office/coordinator/closer/lender/epc) splits the cohort into one
// series per dimension value (top MAX_GROUPS by installs). ──
const MAX_TREND_GROUPS = 8
router.get('/trend', async (req: Request, res: Response): Promise<void> => {
  try {
    const today = officeTodayIso()
    const to = (typeof req.query['to'] === 'string' && req.query['to']) || today
    const weeksN = Math.min(52, Math.max(4, Math.round(Number(req.query['weeks']) || 12)))
    const fc = filterClause(parseFilter(req))
    const groupByKey = typeof req.query['groupBy'] === 'string' ? req.query['groupBy'] : ''
    const groupCol = GROUP_COLS[groupByKey]

    const lastWeek = isoWeekStart(to)
    const firstWeek = addDays(lastWeek, -7 * (weeksN - 1))
    const winTo = addDays(lastWeek, 6) // Sunday of the last week
    const weekStarts: string[] = []
    for (let i = 0; i < weeksN; i++) weekStarts.push(addDays(firstWeek, i * 7))

    const cohort = loadCohort(firstWeek, winTo, fc)
    const arrivy = await fetchArrivyFor(new Set(cohort.map(r => String(r.record_id))))
    // Bucket projects by group value → week.
    const groups = new Map<string, Map<string, P[]>>()
    for (const r of cohort) {
      const g = groupCol ? (String(r[groupCol] ?? '').trim() || '—') : 'All'
      const w = isoWeekStart(r.install_completed)
      let gm = groups.get(g); if (!gm) { gm = new Map(); groups.set(g, gm) }
      const arr = gm.get(w) || []; arr.push(toProject(r, arrivy.get(String(r.record_id)))); gm.set(w, arr)
    }
    // Rank groups by total installs; cap to the top MAX to stay legible.
    const ranked = [...groups.entries()]
      .map(([group, gm]) => ({ group, total: [...gm.values()].reduce((s, ps) => s + ps.length, 0), gm }))
      .sort((a, b) => b.total - a.total)
    const shown = groupCol ? ranked.slice(0, MAX_TREND_GROUPS) : ranked
    const out = shown.map(({ group, gm }) => ({
      group,
      points: weekStarts.map(w => ({ week: w, ...headlineMetrics(gm.get(w) || []) })),
    }))
    res.json({ from: firstWeek, to: winTo, weeks: weeksN, groupBy: groupByKey || null, groupsTotal: ranked.length, groupsShown: out.length, groups: out })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// Condense an overview payload into a compact, model-friendly facts brief.
function buildFacts(d: Record<string, unknown>): string {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
  const h = (d['headline'] || {}) as Record<string, unknown>
  const u = (d['utilization'] || {}) as Record<string, unknown>
  const fund = (d['funding'] || {}) as Record<string, Record<string, unknown>>
  const crews = Array.isArray(d['crews']) ? d['crews'] as Array<Record<string, unknown>> : []
  const thru = Array.isArray(d['throughput']) ? d['throughput'] as Array<Record<string, unknown>> : []
  const L: string[] = []
  L.push(`Field Ops crew scorecard — install cohort ${d['from']} to ${d['to']}${d['applied'] && Object.values(d['applied'] as object).some(Boolean) ? ` (filters: ${JSON.stringify(d['applied'])})` : ''}.`)
  L.push(`Headline: ${num(h['installs'])} installs / ${num(h['kw'])} kW; inspection pass ${num(h['inspPassRate'])}% (${num(h['passed'])} passed, ${num(h['awaitingInspx'])} awaiting); first-time pass ${num(h['firstTimeRate'])}%; avg install→inspection ${num(h['avgDaysI2I'])} days; avg truck rolls ${num(h['avgRolls'])}; 1-touch ${num(h['oneTouchRate'])}%; PTO approved ${num(h['ptoRate'])}%.`)
  if (u && Object.keys(u).length) L.push(`W-2 utilization ${num(u['w2UtilPct'])}% (${num(u['w2Kw'])} of ${num(u['w2CapacityKw'])} kW over ${num(u['weeks'])} wks); kW mix W-2 ${num(u['w2Pct'])}% / Sub ${num(u['subPct'])}%.`)
  if (crews.length) {
    L.push('Crew leaderboard (name · type · installs · kW · 1st-time% · daysI→I · avgRolls · PTO% · onRoute% · onSite% · submitted%):')
    for (const c of crews) L.push(`  - ${c['crew']} · ${c['type']} · ${num(c['installs'])} · ${num(c['kw'])} · ${num(c['firstTimeRate'])}% · ${num(c['avgDaysI2I'])} · ${num(c['avgRolls'])} · ${num(c['ptoRate'])}% · ${num(c['onRoutePct'])}% · ${num(c['onSitePct'])}% · ${num(c['submittedPct'])}%`)
  }
  for (const m of ['m2', 'm3'] as const) {
    const fm = fund[m]; if (!fm) continue
    L.push(`Funding ${m.toUpperCase()}: delay rate ${num(fm['delayRate'])}% (${num(fm['delayedCount'])} delayed), avg gap ${num(fm['avgGapDays'])} business days, ${num(fm['openCount'])} open, ${num(fm['cantSubmitCount'])} Not Ready (whole-pipeline).`)
  }
  if (thru.length) L.push(`Weekly throughput: ${thru.map(w => `${w['week']}:${num(w['count'])}(${num(w['kw'])}kW)`).join(', ')}.`)
  return L.join('\n')
}

// Original prompt (paired with the condensed buildFacts brief). Kept so we can
// switch back by flipping USE_STRUCTURED_PROMPT to false.
const SYSTEM_PROMPT_ANALYST = 'You are a solar field-operations analyst. From the crew scorecard facts, write a concise executive brief in Markdown for an ops manager. Structure: a one-line headline takeaway; "Wins" (2-4 bullets); "Risks & bottlenecks" (2-4 bullets, cite the specific crew/metric/number); "Funding" (M2/M3 delay + Not-Ready implications); "Recommended actions" (2-3 concrete next steps). Ground every claim in the numbers provided. Note when a metric is provisional because little of the cohort has matured (low inspection/PTO share). No preamble, no restating raw tables.'

// Structured prompt (under test) — expects the raw view JSON in context.
const SYSTEM_PROMPT_STRUCTURED = `You are the AI summary for the Field Ops dashboard. The JSON in context is exactly what the user's current view and filters show — nothing else exists. Write a brief an ops manager can read in 60 seconds.

## GLOSSARY (use these exact meanings; never guess)
- I2I / avgDaysI2I / daysI2I = days from install completion to PASSING inspection ("install → inspection").
- avgDaysI2IPermitted = the same, but counting only installs that had a permit approved on/before install day.
- noPermitAtInstall = installs that did NOT have a permit approved on install day; their permit wait inflates I2I.
- First-time pass = passed on ≤1 inspection attempt. One-touch = only post-install visit was routine inspection. Truck rolls = post-install Arrivy site visits. These accrue over time.
- inspPassRate = share of the cohort already inspected-passed; ptoRate = share at PTO. Together these measure cohort MATURITY.
- batteryOnly (headline count) / project field \`batteryOnly:true\` = a legitimate Battery-Only project: system size < 1 kW because there is NO solar array, only a battery adder. Its kw ≈ 0 (e.g. 0.0001) is CORRECT — never treat these as missing/bad data.
- A \`targets\` object, when present, holds the only sanctioned targets (e.g., one-touch).

## OUTPUT
Markdown, ≤250 words, no preamble, no tables, no restating raw data. Output only the brief itself — no reasoning or process commentary. Sections, in order (a cut-off response must still lead with what matters):

- **Maturity** (ALWAYS FIRST, 1–2 sentences) — how mature the cohort is: X% inspected, Y% at PTO. Explicitly warn that first-time pass, one-touch, truck rolls, and I2I are provisional and will move as more installs mature — the lower those percentages, the more provisional. This warning comes before any performance claim.
- **Headline** — one sentence: scale of the view + the single most decision-relevant number.
- **What's improving** (2–3 bullets) — only claims backed by a within-window trend from the weekly series (cite the weeks) or a top-of-fleet absolute number (cite n/denominator).
- **Opportunity areas** (2–4 bullets) — the biggest gaps, each citing crew/metric with numerator÷denominator.
- **Funding watch** (1–2 bullets) — M2/M3 delay rates, Not-Ready counts, lender concentration if one lender is >50% of Not-Ready.
- **Do next** (2–3 bullets) — each action points at specific records visible in this view (named projects, crews, lists), phrased as review / verify / pull notes for / schedule. Never invent staffing, budget, teams, or process changes the data doesn't reference.
- **Data note** — REQUIRED whenever noPermitAtInstall > 0: state that install→inspection is inflated by the N installs without a permit approved on install day, and give the permit-adjusted figure (avgDaysI2IPermitted). Add any other genuine data-quality distortion (name the metric, cause, rough magnitude). Do NOT flag batteryOnly kw≈0 rows — they are correct. Do not repeat maturity caveats. Omit the section only if noPermitAtInstall is 0 and nothing else qualifies.

If a section has no supportable content, print its header and "insufficient data in this view" — do not fill it.

## RULES
1. Every rate shows numerator÷denominator from the data. First-time pass has two valid denominators (÷inspected, ÷all installs) — pick one, label it, never mix them.
2. No benchmarks, targets, or industry norms unless the \`targets\` object is present in the payload — then compare against those exact values and name the target (e.g., "one-touch 61% vs 90% target"). Otherwise the only allowed comparisons are crew vs fleet average and week vs period average. No evaluative words ("strong," "solid," "threatens") without one of those comparisons stated in the same bullet.
3. When \`projects[]\` rows are present, recompute every rate from rows before using it. If a pre-aggregated field disagrees, use the row-level value and append "(headline shows X)".
4. Mark "(provisional — X% of cohort not yet matured)" on any metric whose denominator excludes unfinished projects: inspection pass, first-time, PTO, one-touch, daysI2I.
5. No rates for any group with n<15 — counts only.
6. Never state or imply a cause — this view has no reason codes — EXCEPT the permit-at-install signal: whenever noPermitAtInstall is nonzero you MUST attribute part of the install→inspection delay to permits not being approved on install day and cite avgDaysI2IPermitted as the permit-adjusted figure (at minimum in the Data note). For anything else, write "not recorded in this view."
7. Use crew \`type\` labels (W2/Sub) exactly as the data has them.
8. Each fact appears in exactly one section.
9. Sentinel values (rolls = 0 on uninspected projects, 0%/100% fields on tiny n) are data-quality flags, not performance — route them to Data note, never into a rate silently. EXCEPTION: kw ≈ 0 on a batteryOnly project is a legitimate Battery-Only install, NOT a data issue — never call it missing/bad kW; if you mention battery-only installs, do so as a normal project type.
10. Named individuals appear only with their recorded field values — no characterization.`

const USE_STRUCTURED_PROMPT = true // flip to false to restore the original analyst prompt + buildFacts brief

router.post('/summarize', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId
    if (!userId) { res.status(401).json({ ok: false, error: 'unauthorized' }); return }
    const data = (req.body as { data?: unknown })?.data
    if (!data || typeof data !== 'object') { res.status(400).json({ ok: false, error: 'missing data' }); return }
    // Structured prompt reads the raw view JSON (with sanctioned targets injected);
    // analyst prompt reads the condensed brief.
    const system = USE_STRUCTURED_PROMPT ? SYSTEM_PROMPT_STRUCTURED : SYSTEM_PROMPT_ANALYST
    const withTargets = { ...(data as Record<string, unknown>), targets: { oneTouchRate: 90 } }
    const userContent = USE_STRUCTURED_PROMPT
      ? `Current view JSON:\n${JSON.stringify(withTargets)}`
      : buildFacts(data as Record<string, unknown>)
    const llm = await callUserLlm({
      userId,
      feature: 'field-ops-summary',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      maxOutputTokens: 4000, // reasoning models burn tokens thinking; this stricter prompt + full JSON needs headroom to still emit the brief
      temperature: 0.3,
      timeoutMs: 90_000,
    })
    if (!llm.ok) { res.json({ ok: false, error: llm.error || 'LLM unavailable' }); return }
    res.json({ ok: true, summary: (llm.output || '').trim(), facts: userContent })
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as fieldOpsRouter }
