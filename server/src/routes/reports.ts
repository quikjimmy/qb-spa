// Booked & Boarded executive flash report — admin-only.
//
// Reads project_cache directly (kept fresh by the project tier scheduler).
// Two endpoints:
//   GET /booked-and-boarded             — full report payload
//   GET /booked-and-boarded/drill       — per-dimension breakdown for one gap
//
// Stage definitions:
//   Booked → Installed → PTO Approved → M1 (informational) → M2 Funded → M3 Funded
//   M1 doesn't anchor any gap or cycle transition — it's just a checkpoint
//   in the flash table. The meaningful funding gap is Install → M2.
//
// Pre-install / WIP semantics (matches ProjectsView preInstall):
//   status IN ('Active','Hold') AND install_completed not set
//   This excludes Cancelled / Pending Cancel by construction so the
//   gap counts tie out to the rest of the app.

import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

// ─── Constants ───────────────────────────────────────────

// Active pipeline = "Active" or anything matching "%hold%" (covers
// "Hold", "On Hold", and minor case variants). Matches the LOWER+LIKE
// pattern ProjectsView uses for its preInstall / WIP / futureInstall
// KPIs so this report's gap counts tie out to that view exactly.
const ACTIVE_STATUS_FRAGMENT = `(LOWER(status) = 'active' OR LOWER(status) LIKE '%hold%')`

// Default EPC scope. ProjectsView defaults the same way; without it
// the report includes non-Kin-Home projects and counts blow up. Caller
// can pass ?epc= to override.
const DEFAULT_EPC = 'Kin Home'

const SLA = {
  bookedToInstalled: { warn: 14, red: 30 },
  installedToM2: { warn: 14, red: 30 },
  m2ToM3: { warn: 30, red: 60 },
  m3ToDca: { warn: 30, red: 60 },
  pendingCancel: { warn: 3, red: 7 },
} as const

// ─── Date helpers ────────────────────────────────────────

function parseDate(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00:00Z`)
  return new Date(s)
}
function fmtDate(d: Date): string { return d.toISOString().slice(0, 10) }
function shiftDays(d: Date, days: number): Date { const o = new Date(d); o.setUTCDate(o.getUTCDate() + days); return o }
function shiftYears(d: Date, years: number): Date { const o = new Date(d); o.setUTCFullYear(o.getUTCFullYear() + years); return o }
function startOfMonth(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12)) }
function endOfMonth(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)) }
function startOfYear(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 12)) }

// Selling days = Mon–Sat (skip Sunday). Used for Booked stage pace —
// the sales team works through Saturday.
function sellingDaysBetween(from: Date, to: Date): number {
  let count = 0
  for (let d = new Date(from); d <= to; d = shiftDays(d, 1)) {
    if (d.getUTCDay() !== 0) count++
  }
  return count
}
// Operating days = Mon–Fri. Used for Installed / PTO / M-funded pace —
// install crews and the funding back-office don't work weekends.
function operatingDaysBetween(from: Date, to: Date): number {
  let count = 0
  for (let d = new Date(from); d <= to; d = shiftDays(d, 1)) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) count++
  }
  return count
}

// ─── Filters ─────────────────────────────────────────────

interface Filters { state?: string; closer?: string; lender?: string; epc?: string }

function applyFilters(where: string, params: unknown[], f: Filters): { where: string; params: unknown[] } {
  let w = where
  const p = [...params]
  // App-wide invariant: never count test projects. Belt-and-suspenders
  // — QB ingest already filters {622.EX.'false'}, but a defensive
  // read-time check keeps stale cache rows out of report numbers.
  w += ` AND (test_project IS NULL OR test_project = 0)`
  // EPC defaults to Kin Home unless the caller passes the explicit
  // sentinel '*' to disable.
  const epc = f.epc === undefined ? DEFAULT_EPC : f.epc
  if (epc && epc !== '*') { w += ' AND epc = ?'; p.push(epc) }
  if (f.state) { w += ' AND state = ?'; p.push(f.state) }
  if (f.closer) { w += ' AND closer = ?'; p.push(f.closer) }
  if (f.lender) { w += ' AND lender = ?'; p.push(f.lender) }
  return { where: w, params: p }
}

// Active pre-install / WIP base. Used for Sold-Not-Installed and any
// pipeline drill that should naturally exclude cancels.
function activeWhere(f: Filters): { where: string; params: unknown[] } {
  return applyFilters(`WHERE ${ACTIVE_STATUS_FRAGMENT}`, [], f)
}

// Stage existence base — no status filter. Used for flash counts where a
// project that booked-then-cancelled still counts toward "Booked last
// year" historical totals.
function stageWhere(dateCol: string, f: Filters): { where: string; params: unknown[] } {
  return applyFilters(
    `WHERE ${dateCol} IS NOT NULL AND ${dateCol} != '' AND ${dateCol} != '0'`,
    [],
    f,
  )
}

// ─── Stage / metric primitives ───────────────────────────

interface Metric { count: number; kw: number; rev: number }

// Scale a metric by a multiplier — used for projecting trailing-window
// counts to a full-month pace across all three units (count + kW + $).
function scaleMetric(m: Metric, mul: number): Metric {
  return {
    count: Math.round(m.count * mul),
    kw: Math.round(m.kw * mul * 10) / 10,
    rev: Math.round(m.rev * mul),
  }
}

function rangeMetric(dateCol: string, valueCol: string | null, from: string, to: string, f: Filters): Metric {
  const base = stageWhere(dateCol, f)
  // For non-funded stages (Booked / Installed / PTO) revenue = system_price
  // sum across deals that hit the stage. For M1/M2/M3 stages we use the
  // funded-amount column when available. Caller passes the right column.
  const valueExpr = valueCol ? `COALESCE(SUM(${valueCol}),0)` : '0'
  const sql = `SELECT COUNT(*) AS c, COALESCE(SUM(system_size_kw),0) AS kw, ${valueExpr} AS rev
    FROM project_cache ${base.where}
      AND substr(${dateCol},1,10) >= ? AND substr(${dateCol},1,10) <= ?`
  const row = db.prepare(sql).get(...base.params, from, to) as { c: number; kw: number; rev: number }
  return {
    count: row.c,
    kw: Math.round(row.kw * 10) / 10,
    rev: Math.round(row.rev),
  }
}

// ─── Flash table ─────────────────────────────────────────

interface FlashStage {
  key: string; label: string
  dayBasis: 'sales' | 'operating'  // which calendar drives this stage's pace
  yesterday: Metric
  last7d: Metric           // trailing 7-day count/kW/$ — drives the 7d pill
  mtd: Metric
  mtdPace: Metric          // MTD projection to month-end (count + kW + $)
  pace30: Metric
  pace30Monthly: Metric    // 30d rate projected to a full month
  pace60: Metric
  pace60Monthly: Metric    // 60d rate projected to a full month
  lastMtd: Metric
  ytd: Metric
  lastYtd: Metric
  isTotal?: boolean
}

// Stages drive the daily flash table. M1 was removed per spec — it's a
// minor pre-PTO funding event and clutters the headline view. Total
// Funded is synthesized below by summing M2 + M3 + DCA per window.
const STAGES: Array<{ key: string; label: string; col: string; valueCol: string | null; dayBasis: 'sales' | 'operating' }> = [
  // Booked uses sales days (M–Sa) — the sales floor works Saturday.
  { key: 'booked',     label: 'Booked',       col: 'sales_date',        valueCol: 'system_price',     dayBasis: 'sales' },
  // Everything downstream of contract uses operating days (M–F) —
  // install crews + funding back-office don't run weekends.
  { key: 'installed',  label: 'Installed',    col: 'install_completed', valueCol: 'system_price',     dayBasis: 'operating' },
  { key: 'ptoApproved',label: 'PTO Approved', col: 'pto_approved',      valueCol: 'system_price',     dayBasis: 'operating' },
  { key: 'm2Funded',   label: 'M2 Funded',    col: 'm2_deposit_date',   valueCol: 'm2_net_received',  dayBasis: 'operating' },
  { key: 'm3Funded',   label: 'M3 Funded',    col: 'm3_deposit_date',   valueCol: 'm3_net_received',  dayBasis: 'operating' },
  // DCA — Dealer Cancellation Advance / Receivables: Actual DCA Deposit
  // is the date the DCA hit the books; dca_total_received is cumulative
  // funded $ used for the dollar metric.
  { key: 'dcaFunded',  label: 'DCA Funded',   col: 'dca_actual_deposit', valueCol: 'dca_total_received', dayBasis: 'operating' },
]

// Synthetic Total Funded row — sum of M2 + M3 + DCA across a window.
// This is what leadership cares about ("total cash collected") so it
// gets a row of its own at the bottom of the flash table.
const TOTAL_FUNDED_KEYS = ['m2Funded', 'm3Funded', 'dcaFunded'] as const

function buildFlash(asOf: Date, f: Filters): {
  stages: FlashStage[]
  sellingDaysElapsed: number
  sellingDaysTotal: number
  operatingDaysElapsed: number
  operatingDaysTotal: number
} {
  const yday = fmtDate(shiftDays(asOf, -1))
  const last7Start = fmtDate(shiftDays(asOf, -7))
  const monthStart = fmtDate(startOfMonth(asOf))
  const yearStart = fmtDate(startOfYear(asOf))
  const asOfStr = fmtDate(asOf)
  const last30Start = fmtDate(shiftDays(asOf, -30))
  const last60Start = fmtDate(shiftDays(asOf, -60))
  const lyAsOf = shiftYears(asOf, -1)
  const lyMonthStart = fmtDate(startOfMonth(lyAsOf))
  const lyYearStart = fmtDate(startOfYear(lyAsOf))
  const lyAsOfStr = fmtDate(lyAsOf)

  // Two day-basis counts so each stage uses its own calendar for pace.
  const sellingDaysElapsed = sellingDaysBetween(startOfMonth(asOf), shiftDays(asOf, -1))
  const sellingDaysTotal = sellingDaysBetween(startOfMonth(asOf), endOfMonth(asOf))
  const operatingDaysElapsed = operatingDaysBetween(startOfMonth(asOf), shiftDays(asOf, -1))
  const operatingDaysTotal = operatingDaysBetween(startOfMonth(asOf), endOfMonth(asOf))

  // 30d / 60d window day counts, used to project a per-month pace from
  // the trailing-window count.
  const sellingDays30 = sellingDaysBetween(shiftDays(asOf, -30), shiftDays(asOf, -1)) || 1
  const operatingDays30 = operatingDaysBetween(shiftDays(asOf, -30), shiftDays(asOf, -1)) || 1
  const sellingDays60 = sellingDaysBetween(shiftDays(asOf, -60), shiftDays(asOf, -1)) || 1
  const operatingDays60 = operatingDaysBetween(shiftDays(asOf, -60), shiftDays(asOf, -1)) || 1

  const stages = STAGES.map(s => {
    const ydayM = rangeMetric(s.col, s.valueCol, yday, yday, f)
    const last7d = rangeMetric(s.col, s.valueCol, last7Start, asOfStr, f)
    const mtd = rangeMetric(s.col, s.valueCol, monthStart, asOfStr, f)
    const lastMtd = rangeMetric(s.col, s.valueCol, lyMonthStart, lyAsOfStr, f)
    const ytd = rangeMetric(s.col, s.valueCol, yearStart, asOfStr, f)
    const lastYtd = rangeMetric(s.col, s.valueCol, lyYearStart, lyAsOfStr, f)
    const pace30 = rangeMetric(s.col, s.valueCol, last30Start, asOfStr, f)
    const pace60 = rangeMetric(s.col, s.valueCol, last60Start, asOfStr, f)

    // MTD pace: project the rest of the month at the current MTD rate,
    // using the right calendar for the stage.
    const elapsed = s.dayBasis === 'sales' ? sellingDaysElapsed : operatingDaysElapsed
    const totalDays = s.dayBasis === 'sales' ? sellingDaysTotal : operatingDaysTotal
    const mtdPaceMul = elapsed > 0 ? totalDays / elapsed : 0

    // 30d/60d monthly pace: take the trailing-window rate per active
    // day and scale to a full month.
    const win30Days = s.dayBasis === 'sales' ? sellingDays30 : operatingDays30
    const win60Days = s.dayBasis === 'sales' ? sellingDays60 : operatingDays60
    const pace30Mul = win30Days > 0 ? totalDays / win30Days : 0
    const pace60Mul = win60Days > 0 ? totalDays / win60Days : 0

    return {
      key: s.key, label: s.label, dayBasis: s.dayBasis,
      yesterday: ydayM, last7d, mtd,
      mtdPace: scaleMetric(mtd, mtdPaceMul),
      pace30, pace30Monthly: scaleMetric(pace30, pace30Mul),
      pace60, pace60Monthly: scaleMetric(pace60, pace60Mul),
      lastMtd, ytd, lastYtd,
    }
  })

  // Synthesize the Total Funded row (M2 + M3 + DCA). Sums all three
  // metric units across the three milestones so a project hitting both
  // M2 and DCA in the same window contributes to both.
  const fundedRows = stages.filter(s => (TOTAL_FUNDED_KEYS as readonly string[]).includes(s.key))
  const sumMetric = (sel: (s: FlashStage) => Metric): Metric => ({
    count: fundedRows.reduce((a, s) => a + sel(s).count, 0),
    kw:    Math.round(fundedRows.reduce((a, s) => a + sel(s).kw, 0) * 10) / 10,
    rev:   Math.round(fundedRows.reduce((a, s) => a + sel(s).rev, 0)),
  })
  const totalRow: FlashStage = {
    key: 'totalFunded', label: 'Total Funded (M2+M3+DCA)', dayBasis: 'operating', isTotal: true,
    yesterday: sumMetric(s => s.yesterday),
    last7d: sumMetric(s => s.last7d),
    mtd: sumMetric(s => s.mtd),
    mtdPace: sumMetric(s => s.mtdPace),
    pace30: sumMetric(s => s.pace30),
    pace30Monthly: sumMetric(s => s.pace30Monthly),
    pace60: sumMetric(s => s.pace60),
    pace60Monthly: sumMetric(s => s.pace60Monthly),
    lastMtd: sumMetric(s => s.lastMtd),
    ytd: sumMetric(s => s.ytd),
    lastYtd: sumMetric(s => s.lastYtd),
  }
  stages.push(totalRow)

  return { stages, sellingDaysElapsed, sellingDaysTotal, operatingDaysElapsed, operatingDaysTotal }
}

// ─── KPIs ────────────────────────────────────────────────
// Point-in-time KPI widgets the report tracks. Each is a count of
// projects in a particular state — not windowed by timeframe.
//
//   soldNotInstalled : status IN (Active,Hold) AND no install_completed
//   installedNotM2   : install_completed AND no m2_deposit_date
//   m2NotM3          : m2_deposit_date AND no m3_deposit_date
//   m3NotDca         : DCA-eligible + m3_deposit_date AND no DCA deposit

interface GapMetric {
  count: number
  kw: number
  rev: number
  avgAgeDays: number
  p90AgeDays: number
  oldestDays: number
  daysSupply: number     // count / (installs_last_30d / 30) — for inventory gaps only
  pctOfRevenue?: number  // 0..1 — cancelled $ / booked $ in same window. Cancelled gap only.
}

const GAP_KEYS = ['soldNotInstalled', 'installedNotM2', 'm2NotM3', 'm3NotDca'] as const
type GapKey = typeof GAP_KEYS[number]

const DCA_ELIGIBLE_FRAGMENT = `(
  dca_status IS NOT NULL
  AND dca_status != ''
  AND TRIM(LOWER(dca_status)) NOT IN ('not eligible', 'create dca event')
)`

interface GapBase {
  where: string
  params: unknown[]
  ageColumn: string
  revColumn: string
  sla: { warn: number; red: number }
}

function gapBase(gap: GapKey, f: Filters): GapBase {
  switch (gap) {
    case 'soldNotInstalled': {
      const a = activeWhere(f)
      return {
        where: a.where + ` AND (install_completed IS NULL OR install_completed = '' OR install_completed = '0')`,
        params: a.params,
        ageColumn: 'sales_date',
        revColumn: 'system_price',
        sla: SLA.bookedToInstalled,
      }
    }
    case 'installedNotM2': {
      const a = activeWhere(f)
      return {
        where: a.where +
          ` AND install_completed IS NOT NULL AND install_completed != '' AND install_completed != '0'` +
          ` AND (m2_deposit_date IS NULL OR m2_deposit_date = '' OR m2_deposit_date = '0' OR COALESCE(m2_net_received, 0) <= 0)`,
        params: a.params,
        ageColumn: 'install_completed',
        revColumn: 'system_price',
        sla: SLA.installedToM2,
      }
    }
    case 'm2NotM3': {
      const a = activeWhere(f)
      return {
        where: a.where +
          ` AND m2_deposit_date IS NOT NULL AND m2_deposit_date != '' AND m2_deposit_date != '0'` +
          ` AND COALESCE(m2_net_received, 0) > 0` +
          ` AND (m3_deposit_date IS NULL OR m3_deposit_date = '' OR m3_deposit_date = '0' OR COALESCE(m3_net_received, 0) <= 0)`,
        params: a.params,
        ageColumn: 'm2_deposit_date',
        revColumn: 'system_price',
        sla: SLA.m2ToM3,
      }
    }
    case 'm3NotDca': {
      const a = applyFilters(`WHERE 1=1`, [], f)
      return {
        where: a.where +
          ` AND ${DCA_ELIGIBLE_FRAGMENT}` +
          ` AND m3_deposit_date IS NOT NULL AND m3_deposit_date != '' AND m3_deposit_date != '0'` +
          ` AND COALESCE(m3_net_received, 0) > 0` +
          ` AND (dca_actual_deposit IS NULL OR dca_actual_deposit = '' OR dca_actual_deposit = '0' OR COALESCE(dca_total_received, 0) <= 0)`,
        params: a.params,
        ageColumn: 'm3_deposit_date',
        revColumn: 'system_price',
        sla: SLA.m3ToDca,
      }
    }
  }
}

// Installs/day over last 30 days — used to compute "days supply" of
// pre-install inventory. Filter-aware so a state-specific view shows
// that state's days-of-supply, not the global one.
function installsPerDay30(asOf: Date, f: Filters): number {
  const start = fmtDate(shiftDays(asOf, -30))
  const end = fmtDate(asOf)
  const base = stageWhere('install_completed', f)
  const sql = `SELECT COUNT(*) AS c FROM project_cache ${base.where}
    AND substr(install_completed,1,10) >= ? AND substr(install_completed,1,10) <= ?`
  const row = db.prepare(sql).get(...base.params, start, end) as { c: number }
  return row.c / 30
}

function buildGap(opts: {
  asOf: Date
  f: Filters
  baseWhere: { where: string; params: unknown[] }
  ageColumn: string | null   // column to compute age from (null = no age)
  revColumn: string          // column to sum for $ — typically system_price
  installsPerDay: number     // for days-supply calc; 0 = don't compute
}): GapMetric {
  const { asOf, baseWhere, ageColumn, revColumn, installsPerDay } = opts
  const asOfStr = fmtDate(asOf)

  // Aggregate sums in one query.
  const sumSql = `SELECT
      COUNT(*) AS count,
      COALESCE(SUM(system_size_kw),0) AS kw,
      COALESCE(SUM(${revColumn}),0) AS rev
    FROM project_cache ${baseWhere.where}`
  const sumRow = db.prepare(sumSql).get(...baseWhere.params) as { count: number; kw: number; rev: number }

  // Pull individual ages for mean / p90 / max — accurate stats with
  // straightforward percentile math instead of trying to do it in SQL.
  let avgAge = 0, p90 = 0, oldest = 0
  if (ageColumn && sumRow.count > 0) {
    const ageSql = `SELECT julianday(?) - julianday(substr(${ageColumn},1,10)) AS age
      FROM project_cache ${baseWhere.where}
        AND ${ageColumn} IS NOT NULL AND ${ageColumn} != '' AND ${ageColumn} != '0'`
    const rows = db.prepare(ageSql).all(asOfStr, ...baseWhere.params) as Array<{ age: number }>
    const ages = rows.map(r => r.age).filter(a => a >= 0 && a <= 365 * 5)
    if (ages.length > 0) {
      avgAge = ages.reduce((a, b) => a + b, 0) / ages.length
      const sorted = [...ages].sort((a, b) => a - b)
      p90 = percentile(sorted, 0.9)
      oldest = sorted[sorted.length - 1]!
    }
  }

  const daysSupply = installsPerDay > 0 ? Math.round(sumRow.count / installsPerDay) : 0
  return {
    count: sumRow.count,
    kw: Math.round(sumRow.kw * 10) / 10,
    rev: Math.round(sumRow.rev),
    avgAgeDays: Math.round(avgAge),
    p90AgeDays: Math.round(p90),
    oldestDays: Math.round(oldest),
    daysSupply,
  }
}

interface Gaps {
  soldNotInstalled: GapMetric
  installedNotM2: GapMetric
  m2NotM3: GapMetric
  m3NotDca: GapMetric
}

function buildGaps(asOf: Date, timeframe: { from: string; to: string }, f: Filters): Gaps {
  const installsRate = installsPerDay30(asOf, f)

  // Sold-Not-Installed: pre-install / WIP (status active|hold, no install).
  const sniBase = gapBase('soldNotInstalled', f)
  const soldNotInstalled = buildGap({
    asOf, f, baseWhere: sniBase, ageColumn: sniBase.ageColumn, revColumn: sniBase.revColumn, installsPerDay: installsRate,
  })

  // Installed-Not-M2: install set AND (no M2 deposit OR M2 net received
  // is non-positive — i.e. clawed back). Captures projects that lost
  // their M2 funding and need it re-funded.
  const inm2Base = gapBase('installedNotM2', f)
  const installedNotM2 = buildGap({
    asOf, f, baseWhere: inm2Base, ageColumn: inm2Base.ageColumn, revColumn: inm2Base.revColumn, installsPerDay: 0,
  })

  // M2-Not-M3: M2 deposited (and not clawed back), M3 still pending or
  // clawed back. Same clawback logic on M3 — a clawback re-opens the
  // funding gap.
  const m2m3Base = gapBase('m2NotM3', f)
  const m2NotM3 = buildGap({
    asOf, f, baseWhere: m2m3Base, ageColumn: m2m3Base.ageColumn, revColumn: m2m3Base.revColumn, installsPerDay: 0,
  })

  // M3-Not-DCA: DCA-eligible projects where final M3 cash has landed,
  // but the DCA / funding true-up has not landed yet. Uses broad status
  // scope because these projects are commonly Complete by this point.
  const m3DcaBase = gapBase('m3NotDca', f)
  const m3NotDca = buildGap({
    asOf, f, baseWhere: m3DcaBase, ageColumn: m3DcaBase.ageColumn, revColumn: m3DcaBase.revColumn, installsPerDay: 0,
  })

  void timeframe  // unused — cancel widget removed; reserved for future windowed gaps
  return { soldNotInstalled, installedNotM2, m2NotM3, m3NotDca }
}

// ─── Aging / SLA action list ─────────────────────────────
// Bucket each gap by days in its current stage, then name the records
// that have crossed the warning threshold. This turns the KPI strip into
// an accountability list without requiring the user to expand the full
// audit table.

interface AgeBucketDef { key: string; label: string; min: number; max: number | null }

const AGE_BUCKETS: readonly AgeBucketDef[] = [
  { key: '0_7', label: '0-7', min: 0, max: 7 },
  { key: '8_14', label: '8-14', min: 8, max: 14 },
  { key: '15_30', label: '15-30', min: 15, max: 30 },
  { key: '31_60', label: '31-60', min: 31, max: 60 },
  { key: '60_plus', label: '60+', min: 61, max: null },
] as const

const M2_NOT_M3_AGE_BUCKETS: readonly AgeBucketDef[] = [
  { key: '0_15', label: '0-15', min: 0, max: 15 },
  { key: '16_30', label: '16-30', min: 16, max: 30 },
  { key: '31_45', label: '31-45', min: 31, max: 45 },
  { key: '46_60', label: '46-60', min: 46, max: 60 },
  { key: '60_plus', label: '60+', min: 61, max: null },
] as const

function ageBucketsForGap(gap: GapKey): readonly AgeBucketDef[] {
  return gap === 'm2NotM3' ? M2_NOT_M3_AGE_BUCKETS : AGE_BUCKETS
}

interface AgingBucket {
  key: string
  label: string
  min: number
  max: number | null
  count: number
  kw: number
  rev: number
}

interface StuckDeal {
  gap: GapKey
  recordId: number
  customerName: string
  state: string
  closer: string
  coordinator: string
  lender: string
  anchorDate: string
  days: number
  slaDays: number
  severity: 'warn' | 'red'
  blocker: string
  systemPrice: number
  systemSizeKw: number
}

interface AgingGap {
  buckets: AgingBucket[]
  warnCount: number
  redCount: number
  stuck: StuckDeal[]
}

type Aging = Record<GapKey, AgingGap>

interface AgingRow {
  recordId: number
  customerName: string
  state: string
  closer: string
  coordinator: string
  lender: string
  status: string
  anchorDate: string
  days: number
  systemPrice: number
  systemSizeKw: number
  urgentBannerText: string
  nextTaskType: string
  installScheduled: string
  surveyScheduled: string
  surveySubmitted: string
  surveyApproved: string
  cadSubmitted: string
  designCompleted: string
  permitSubmitted: string
  permitApproved: string
  permitRejected: string
  inspectionPassed: string
  ptoSubmitted: string
  ptoApproved: string
  permitMissingItems: string
  nemMissingItems: string
  ptoMissingItems: string
  m2Status: string
  m3Status: string
  dcaStatus: string
  dcaExpectedDeposit: string
}

function compactLabel(s: string): string {
  return (s || '').replace(/;/g, ', ').replace(/\s+/g, ' ').trim()
}
function shortDateLabel(s: string): string {
  const v = compactLabel(s)
  return v ? v.slice(0, 10) : ''
}
function hasDate(s: string): boolean {
  const v = compactLabel(s)
  return !!v && v !== '0'
}

function deriveBlocker(gap: GapKey, r: AgingRow): string {
  const banner = compactLabel(r.urgentBannerText)
  if (banner) return banner

  if (gap === 'soldNotInstalled') {
    if (hasDate(r.installScheduled)) return `Install scheduled ${shortDateLabel(r.installScheduled)}`
    if (!hasDate(r.permitApproved)) {
      if (hasDate(r.permitRejected)) return `Permit rejected ${shortDateLabel(r.permitRejected)}`
      if (hasDate(r.permitSubmitted)) return `Permit pending since ${shortDateLabel(r.permitSubmitted)}`
      return 'Permit not submitted'
    }
    if (!hasDate(r.designCompleted)) {
      if (hasDate(r.cadSubmitted)) return `Design pending since ${shortDateLabel(r.cadSubmitted)}`
      return 'Design not complete'
    }
    if (!hasDate(r.surveyApproved)) {
      if (hasDate(r.surveySubmitted)) return `Survey approval pending since ${shortDateLabel(r.surveySubmitted)}`
      if (hasDate(r.surveyScheduled)) return `Survey scheduled ${shortDateLabel(r.surveyScheduled)}`
      return 'Survey not approved'
    }
    return compactLabel(r.nextTaskType) ||
      compactLabel(r.permitMissingItems) ||
      compactLabel(r.nemMissingItems) ||
      'Ready to schedule install'
  }

  if (gap === 'installedNotM2') {
    if (!hasDate(r.ptoApproved)) {
      if (hasDate(r.ptoSubmitted)) return `PTO pending since ${shortDateLabel(r.ptoSubmitted)}`
      if (!hasDate(r.inspectionPassed)) return 'Inspection not passed'
      return 'PTO not submitted'
    }
    return compactLabel(r.ptoMissingItems) ||
      compactLabel(r.m2Status) ||
      compactLabel(r.nextTaskType) ||
      'M2 funding review'
  }

  if (gap === 'm2NotM3') {
    return compactLabel(r.m3Status) ||
      compactLabel(r.nextTaskType) ||
      'Final funding review'
  }

  return compactLabel(r.dcaStatus) ||
    (hasDate(r.dcaExpectedDeposit) ? `DCA expected ${shortDateLabel(r.dcaExpectedDeposit)}` : '') ||
    compactLabel(r.nextTaskType) ||
    'DCA funding review'
}

function buildAgingGap(gap: GapKey, asOf: Date, f: Filters): AgingGap {
  const base = gapBase(gap, f)
  const asOfStr = fmtDate(asOf)
  const sql = `SELECT
      record_id AS recordId,
      customer_name AS customerName,
      COALESCE(state, '') AS state,
      COALESCE(closer, '') AS closer,
      COALESCE(coordinator, '') AS coordinator,
      COALESCE(lender, '') AS lender,
      COALESCE(status, '') AS status,
      COALESCE(${base.ageColumn}, '') AS anchorDate,
      CAST(julianday(?) - julianday(substr(${base.ageColumn},1,10)) AS INTEGER) AS days,
      COALESCE(system_price, 0) AS systemPrice,
      COALESCE(system_size_kw, 0) AS systemSizeKw,
      COALESCE(urgent_banner_text, '') AS urgentBannerText,
      COALESCE(next_task_type, '') AS nextTaskType,
      COALESCE(install_scheduled, '') AS installScheduled,
      COALESCE(survey_scheduled, '') AS surveyScheduled,
      COALESCE(survey_submitted, '') AS surveySubmitted,
      COALESCE(survey_approved, '') AS surveyApproved,
      COALESCE(cad_submitted, '') AS cadSubmitted,
      COALESCE(design_completed, '') AS designCompleted,
      COALESCE(permit_submitted, '') AS permitSubmitted,
      COALESCE(permit_approved, '') AS permitApproved,
      COALESCE(permit_rejected, '') AS permitRejected,
      COALESCE(inspection_passed, '') AS inspectionPassed,
      COALESCE(pto_submitted, '') AS ptoSubmitted,
      COALESCE(pto_approved, '') AS ptoApproved,
      COALESCE(permit_missing_items, '') AS permitMissingItems,
      COALESCE(nem_missing_items, '') AS nemMissingItems,
      COALESCE(pto_missing_items, '') AS ptoMissingItems,
      COALESCE(m2_status, '') AS m2Status,
      COALESCE(m3_status, '') AS m3Status,
      COALESCE(dca_status, '') AS dcaStatus,
      COALESCE(dca_expected_deposit, '') AS dcaExpectedDeposit
    FROM project_cache ${base.where}
      AND ${base.ageColumn} IS NOT NULL AND ${base.ageColumn} != '' AND ${base.ageColumn} != '0'`
  const rows = db.prepare(sql).all(asOfStr, ...base.params) as AgingRow[]
  const cleanRows = rows.filter(r => r.days >= 0 && r.days <= 365 * 5)

  const buckets = ageBucketsForGap(gap).map(b => {
    const rowsInBucket = cleanRows.filter(r => r.days >= b.min && (b.max === null || r.days <= b.max))
    return {
      key: b.key,
      label: b.label,
      min: b.min,
      max: b.max,
      count: rowsInBucket.length,
      kw: Math.round(rowsInBucket.reduce((sum, r) => sum + r.systemSizeKw, 0) * 10) / 10,
      rev: Math.round(rowsInBucket.reduce((sum, r) => sum + r.systemPrice, 0)),
    }
  })

  const stuck = cleanRows
    .filter(r => r.days >= base.sla.warn)
    .sort((a, b) => {
      const aRed = a.days >= base.sla.red ? 1 : 0
      const bRed = b.days >= base.sla.red ? 1 : 0
      return bRed - aRed || b.days - a.days || b.systemPrice - a.systemPrice
    })
    .slice(0, 100)
    .map((r): StuckDeal => ({
      gap,
      recordId: r.recordId,
      customerName: r.customerName,
      state: r.state,
      closer: r.closer,
      coordinator: r.coordinator,
      lender: r.lender,
      anchorDate: r.anchorDate,
      days: r.days,
      slaDays: r.days >= base.sla.red ? base.sla.red : base.sla.warn,
      severity: r.days >= base.sla.red ? 'red' : 'warn',
      blocker: deriveBlocker(gap, r),
      systemPrice: Math.round(r.systemPrice),
      systemSizeKw: Math.round(r.systemSizeKw * 10) / 10,
    }))

  return {
    buckets,
    warnCount: cleanRows.filter(r => r.days >= base.sla.warn && r.days < base.sla.red).length,
    redCount: cleanRows.filter(r => r.days >= base.sla.red).length,
    stuck,
  }
}

function buildAging(asOf: Date, f: Filters): Aging {
  return {
    soldNotInstalled: buildAgingGap('soldNotInstalled', asOf, f),
    installedNotM2: buildAgingGap('installedNotM2', asOf, f),
    m2NotM3: buildAgingGap('m2NotM3', asOf, f),
    m3NotDca: buildAgingGap('m3NotDca', asOf, f),
  }
}

// ─── Drill — per-dimension breakdown for one KPI ─────────
// Returns rows of {dimension_value, count, kw, rev, daysSupply, age stats}
// for the selected KPI broken down by the requested dimension. Powers
// the inline drill panel under the KPI strip.

const DRILL_GAPS = GAP_KEYS
type DrillGap = GapKey

const DIMENSIONS: Record<string, string> = {
  state: 'state',
  closer: 'closer',
  setter: 'setter',
  sales_office: 'sales_office',
  lender: 'lender',
  utility: 'utility_company',
  ahj: 'ahj_name',
  area_director: 'area_director',
  coordinator: 'coordinator',
}

interface DrillAgeStats { p25: number; p50: number; p75: number; p90: number; max: number }
interface DrillRow extends DrillAgeStats { name: string; count: number; kw: number; rev: number; daysSupply: number }
interface DrillResult { rows: DrillRow[]; total: DrillRow }

function buildDrillAgeStats(days: number[]): DrillAgeStats {
  if (days.length === 0) return { p25: 0, p50: 0, p75: 0, p90: 0, max: 0 }
  const sorted = [...days].sort((a, b) => a - b)
  return {
    p25: Math.round(percentile(sorted, 0.25)),
    p50: Math.round(percentile(sorted, 0.5)),
    p75: Math.round(percentile(sorted, 0.75)),
    p90: Math.round(percentile(sorted, 0.9)),
    max: Math.round(sorted[sorted.length - 1]!),
  }
}

function buildDrill(gap: DrillGap, dimension: string, asOf: Date, timeframe: { from: string; to: string }, f: Filters): DrillResult {
  const dimCol = DIMENSIONS[dimension]
  if (!dimCol) return { rows: [], total: { name: 'Total', count: 0, kw: 0, rev: 0, daysSupply: 0, p25: 0, p50: 0, p75: 0, p90: 0, max: 0 } }

  const base = gapBase(gap, f)
  void timeframe  // unused after cancel widget removal

  const installsRate = gap === 'soldNotInstalled' ? installsPerDay30(asOf, f) : 0
  const asOfStr = fmtDate(asOf)

  // Roll up null/empty dimension values into "(unknown)" so the drill
  // total exactly matches the widget count — projects with missing
  // dimension data still appear in a clearly-labeled bucket instead of
  // silently dropping out of the breakdown.
  const sql = `SELECT
      CASE WHEN ${dimCol} IS NULL OR ${dimCol} = '' THEN '(unknown)' ELSE ${dimCol} END AS name,
      COALESCE(system_size_kw,0) AS kw,
      COALESCE(system_price,0) AS rev,
      CAST(julianday(?) - julianday(substr(${base.ageColumn},1,10)) AS INTEGER) AS days
    FROM project_cache ${base.where}`
  const records = db.prepare(sql).all(asOfStr, ...base.params) as Array<{ name: string; kw: number; rev: number; days: number }>
  const groups = new Map<string, { count: number; kw: number; rev: number; days: number[] }>()
  const total = { count: 0, kw: 0, rev: 0, days: [] as number[] }
  for (const r of records) {
    const name = r.name || '(unknown)'
    const g = groups.get(name) || { count: 0, kw: 0, rev: 0, days: [] }
    g.count++
    g.kw += Number(r.kw || 0)
    g.rev += Number(r.rev || 0)
    total.count++
    total.kw += Number(r.kw || 0)
    total.rev += Number(r.rev || 0)
    const d = Number(r.days)
    if (Number.isFinite(d) && d >= 0 && d <= 365 * 5) {
      g.days.push(d)
      total.days.push(d)
    }
    groups.set(name, g)
  }

  // Days supply rolls up with the same denominator (global 30d install rate
  // when no state filter is present — for state-specific rows we'd need a
  // per-state rate which is out of scope for v1; the row-level number is
  // a useful approximation).
  const rows = [...groups.entries()]
    .map(([name, g]): DrillRow => ({
      name,
      count: g.count,
      kw: Math.round(g.kw * 10) / 10,
      rev: Math.round(g.rev),
      daysSupply: installsRate > 0 ? Math.round(g.count / installsRate) : 0,
      ...buildDrillAgeStats(g.days),
    }))
    .sort((a, b) => b.count - a.count || b.rev - a.rev)
    .slice(0, 100)

  return {
    rows,
    total: {
      name: 'Total',
      count: total.count,
      kw: Math.round(total.kw * 10) / 10,
      rev: Math.round(total.rev),
      daysSupply: installsRate > 0 ? Math.round(total.count / installsRate) : 0,
      ...buildDrillAgeStats(total.days),
    },
  }
}

// ─── Cycle time medians ──────────────────────────────────
// Five transitions × three windows (30d / 60d / 90d) × five percentiles
// (min / p25 / median / p75 / max) + sample size. Plus prior-year same
// window for delta. PTO → M1 was wrong (M1 deposits before PTO in the
// Kin lifecycle). The meaningful funding gap is Install → M2.

const TRANSITIONS: Array<{ stage: string; from: string; to: string }> = [
  { stage: 'Booked → Installed',  from: 'sales_date',        to: 'install_completed' },
  { stage: 'Installed → PTO',     from: 'install_completed', to: 'pto_approved' },
  { stage: 'Install → M2 Funded', from: 'install_completed', to: 'm2_deposit_date' },
  { stage: 'M2 → M3 Funded',      from: 'm2_deposit_date',   to: 'm3_deposit_date' },
  { stage: 'Booked → M3 (full)',  from: 'sales_date',        to: 'm3_deposit_date' },
  { stage: 'Booked → DCA',        from: 'sales_date',        to: 'dca_actual_deposit' },
]

interface CycleStats { n: number; min: number; p25: number; median: number; p75: number; max: number }
interface CycleWindow { window: '30d' | '60d' | '90d'; current: CycleStats; prior: CycleStats }
interface CycleTransition { stage: string; windows: CycleWindow[] }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo)
}

function buildStats(values: number[]): CycleStats {
  if (values.length === 0) return { n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0 }
  const s = [...values].sort((a, b) => a - b)
  return {
    n: s.length,
    min: Math.round(s[0]!),
    p25: Math.round(percentile(s, 0.25)),
    median: Math.round(percentile(s, 0.5)),
    p75: Math.round(percentile(s, 0.75)),
    max: Math.round(s[s.length - 1]!),
  }
}

function gapDays(fromCol: string, toCol: string, start: string, end: string, f: Filters): number[] {
  const base = applyFilters('WHERE 1=1', [], f)
  const sql = `SELECT julianday(substr(${toCol},1,10)) - julianday(substr(${fromCol},1,10)) AS days
    FROM project_cache ${base.where}
      AND ${fromCol} IS NOT NULL AND ${fromCol} != '' AND ${fromCol} != '0'
      AND ${toCol} IS NOT NULL AND ${toCol} != '' AND ${toCol} != '0'
      AND substr(${toCol},1,10) BETWEEN ? AND ?`
  const rows = db.prepare(sql).all(...base.params, start, end) as Array<{ days: number }>
  // Sanity-clip 3yr+ outliers and negatives — bad data shouldn't blow up
  // p75/max for the chart.
  return rows.map(r => r.days).filter(d => d >= 0 && d <= 365 * 3)
}

function buildCycleTime(asOf: Date, f: Filters): { transitions: CycleTransition[] } {
  const lyAsOf = shiftYears(asOf, -1)
  const winSizes: Array<'30d' | '60d' | '90d'> = ['30d', '60d', '90d']
  const transitions = TRANSITIONS.map(t => {
    const windows = winSizes.map(w => {
      const days = parseInt(w, 10)
      const curStart = fmtDate(shiftDays(asOf, -days))
      const curEnd = fmtDate(asOf)
      const lyStart = fmtDate(shiftDays(lyAsOf, -days))
      const lyEnd = fmtDate(lyAsOf)
      return {
        window: w,
        current: buildStats(gapDays(t.from, t.to, curStart, curEnd, f)),
        prior: buildStats(gapDays(t.from, t.to, lyStart, lyEnd, f)),
      }
    })
    return { stage: t.stage, windows }
  })
  return { transitions }
}

// ─── MACD-style daily series ─────────────────────────────
// 180-day daily count of <subject> events, with 30-day MA, 60-day MA,
// MACD-style histogram (30d - 60d), and 9-day EMA signal line on the
// MACD spread. Five subjects: booked, installed, m2, m3, m2m3.
//
// m2m3 = combined funded events — counted twice if both m2 and m3
// fired on different days inside the window, since each is a real
// funding moment with its own dollars hitting the books.

interface MacdPoint { date: string; count: number; ma30: number; ma60: number; macd: number; signal: number; histogram: number }
interface MacdSeries { points: MacdPoint[]; high52w: { date: string; count: number } | null }

function buildMacd(subject: string, asOf: Date, f: Filters): MacdSeries {
  const days = 180         // visible window
  const lookback = 60      // pre-padding so 60d SMA + 9d EMA(MACD) are warm at the start of the visible window
  const highWindow = 364   // 52-week high lookback
  const queryDays = Math.max(days + lookback, highWindow)
  const start = shiftDays(asOf, -queryDays + 1)
  const startStr = fmtDate(start)
  const endStr = fmtDate(asOf)
  const base = applyFilters('WHERE 1=1', [], f)

  // Map subject → date column(s) we count events from.
  const cols: string[] =
    subject === 'booked'    ? ['sales_date'] :
    subject === 'installed' ? ['install_completed'] :
    subject === 'm2'        ? ['m2_deposit_date'] :
    subject === 'm3'        ? ['m3_deposit_date'] :
    subject === 'm2m3'      ? ['m2_deposit_date', 'm3_deposit_date'] :
                              ['sales_date']

  // One row per (date, count) — UNION ALL so an m2 and m3 on the same
  // day count as 2 events (matches the "every funding moment counts"
  // intent for the m2m3 view).
  const unionParts = cols.map(c => `
    SELECT substr(${c},1,10) AS d, COUNT(*) AS c
    FROM project_cache ${base.where}
      AND ${c} IS NOT NULL AND ${c} != '' AND ${c} != '0'
      AND substr(${c},1,10) >= ? AND substr(${c},1,10) <= ?
    GROUP BY substr(${c},1,10)
  `)
  const sql = `SELECT d, SUM(c) AS c FROM (${unionParts.join(' UNION ALL ')}) GROUP BY d ORDER BY d`
  const params: unknown[] = []
  for (const _ of cols) params.push(...base.params, startStr, endStr)
  const rows = db.prepare(sql).all(...params) as Array<{ d: string; c: number }>

  // Dense fill — make sure every day in the query window has a row, even if 0.
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.d, r.c)
  const denseAll: Array<{ date: string; count: number }> = []
  for (let i = 0; i < queryDays; i++) {
    const d = fmtDate(shiftDays(start, i))
    denseAll.push({ date: d, count: map.get(d) || 0 })
  }

  // 52-week high — scan the trailing 364d of the dense series. On ties
  // we keep the most recent date (>=) since "the latest peak" is more
  // useful than the earliest one for trend reading.
  const hiStart = Math.max(0, queryDays - highWindow)
  let high52w: { date: string; count: number } | null = null
  for (let i = hiStart; i < queryDays; i++) {
    const p = denseAll[i]!
    if (!high52w || p.count >= high52w.count) high52w = { date: p.date, count: p.count }
  }
  if (high52w && high52w.count === 0) high52w = null  // empty subject — don't annotate

  // MA helpers
  function sma(arr: number[], window: number, idx: number): number {
    const lo = Math.max(0, idx - window + 1)
    const slice = arr.slice(lo, idx + 1)
    return slice.reduce((a, b) => a + b, 0) / slice.length
  }
  function ema(values: number[], window: number): number[] {
    const out: number[] = []
    const k = 2 / (window + 1)
    let prev = values[0] ?? 0
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!
      const cur = i === 0 ? v : v * k + prev * (1 - k)
      out.push(cur)
      prev = cur
    }
    return out
  }

  // Compute MAs over the (lookback + visible) span so the visible window
  // starts with fully-warm averages. Trim to the visible window at the end.
  const maSpanStart = queryDays - (days + lookback)
  const denseMa = denseAll.slice(maSpanStart)
  const counts = denseMa.map(p => p.count)
  const ma30 = counts.map((_, i) => sma(counts, 30, i))
  const ma60 = counts.map((_, i) => sma(counts, 60, i))
  const macdLine = ma30.map((v, i) => v - (ma60[i] ?? 0))
  const signal = ema(macdLine, 9)

  const visibleStart = lookback  // first index inside denseMa that's part of the visible window
  const points: MacdPoint[] = []
  for (let j = 0; j < days; j++) {
    const i = visibleStart + j
    const p = denseMa[i]!
    points.push({
      date: p.date,
      count: p.count,
      ma30: Math.round((ma30[i] ?? 0) * 100) / 100,
      ma60: Math.round((ma60[i] ?? 0) * 100) / 100,
      macd: Math.round((macdLine[i] ?? 0) * 100) / 100,
      signal: Math.round((signal[i] ?? 0) * 100) / 100,
      histogram: Math.round(((macdLine[i] ?? 0) - (signal[i] ?? 0)) * 100) / 100,
    })
  }

  return { points, high52w }
}

// ─── Audit / cheat-table ─────────────────────────────────
// Full list of the underlying records in each gap KPI so the user can
// reconcile the widget count against actual rows. No LIMIT — if the
// gap has 800 projects, all 800 come back. Cap is loose (5000) just
// to defend against pathological filter combinations.

interface AuditRow {
  recordId: number
  customerName: string
  state: string
  status: string
  closer: string
  lender: string
  salesDate: string
  installCompleted: string
  m2Date: string
  m3Date: string
  dcaDate: string
  dcaStatus: string
  m1RequestedDate: string
  m2RequestedDate: string
  m2RejectedDate: string
  m2ApprovedDate: string
  m2NetReceived: number
  systemPrice: number
  systemSizeKw: number
  cancelDate: string
}

function buildAudit(asOf: Date, timeframe: { from: string; to: string }, f: Filters): Record<DrillGap, AuditRow[]> {
  void asOf; void timeframe  // unused after cancel widget removal
  const out: Record<DrillGap, AuditRow[]> = {
    soldNotInstalled: [], installedNotM2: [], m2NotM3: [], m3NotDca: [],
  }

  function fetchSample(where: { where: string; params: unknown[] }, orderBy: string): AuditRow[] {
    const sql = `SELECT
        record_id AS recordId,
        customer_name AS customerName,
        COALESCE(state, '') AS state,
        COALESCE(status, '') AS status,
        COALESCE(closer, '') AS closer,
        COALESCE(lender, '') AS lender,
        COALESCE(sales_date, '') AS salesDate,
        COALESCE(install_completed, '') AS installCompleted,
        COALESCE(m2_deposit_date, '') AS m2Date,
        COALESCE(m3_deposit_date, '') AS m3Date,
        COALESCE(dca_actual_deposit, '') AS dcaDate,
        COALESCE(dca_status, '') AS dcaStatus,
        COALESCE(m1_requested_date, '') AS m1RequestedDate,
        COALESCE(m2_requested_date, '') AS m2RequestedDate,
        COALESCE(m2_rejected_date, '') AS m2RejectedDate,
        COALESCE(m2_approved_date, '') AS m2ApprovedDate,
        COALESCE(m2_net_received, 0) AS m2NetReceived,
        COALESCE(system_price, 0) AS systemPrice,
        COALESCE(system_size_kw, 0) AS systemSizeKw,
        COALESCE(cancel_date, '') AS cancelDate
      FROM project_cache ${where.where}
      ORDER BY ${orderBy}
      LIMIT 5000`
    return db.prepare(sql).all(...where.params) as AuditRow[]
  }

  out.soldNotInstalled = fetchSample(
    gapBase('soldNotInstalled', f),
    `sales_date DESC`,
  )
  out.installedNotM2 = fetchSample(
    gapBase('installedNotM2', f),
    `install_completed ASC`,
  )
  out.m2NotM3 = fetchSample(
    gapBase('m2NotM3', f),
    `m2_deposit_date DESC`,
  )
  out.m3NotDca = fetchSample(
    gapBase('m3NotDca', f),
    `m3_deposit_date DESC`,
  )
  return out
}

// ─── Filter option lists ─────────────────────────────────

interface FilterOptions { states: string[]; closers: string[]; lenders: string[] }

function buildFilterOptions(): FilterOptions {
  // Filter options are scoped to the active pipeline of the default EPC
  // so the dropdowns don't show reps/states from non-Kin projects we're
  // never going to look at in this report.
  const w = `WHERE ${ACTIVE_STATUS_FRAGMENT} AND epc = ?`
  const states = db.prepare(`SELECT DISTINCT state FROM project_cache ${w} AND state IS NOT NULL AND state != '' ORDER BY state`).all(DEFAULT_EPC) as Array<{ state: string }>
  const closers = db.prepare(`SELECT DISTINCT closer FROM project_cache ${w} AND closer IS NOT NULL AND closer != '' ORDER BY closer`).all(DEFAULT_EPC) as Array<{ closer: string }>
  const lenders = db.prepare(`SELECT DISTINCT lender FROM project_cache ${w} AND lender IS NOT NULL AND lender != '' ORDER BY lender`).all(DEFAULT_EPC) as Array<{ lender: string }>
  return {
    states: states.map(r => r.state),
    closers: closers.map(r => r.closer),
    lenders: lenders.map(r => r.lender),
  }
}

// ─── Timeframe resolution ────────────────────────────────
// Quick-pill timeframes resolve to a {from, to} window that drives the
// cancelled-lost-revenue calc. Anything else (gap counts, MACD) is
// either point-in-time or fixed-lookback so timeframe doesn't apply.

function resolveTimeframe(tf: string, asOf: Date, customFrom?: string, customTo?: string): { from: string; to: string; key: string } {
  const asOfStr = fmtDate(asOf)
  switch (tf) {
    case 'yesterday': {
      const y = fmtDate(shiftDays(asOf, -1))
      return { from: y, to: y, key: 'yesterday' }
    }
    case '7d':  return { from: fmtDate(shiftDays(asOf, -7)),  to: asOfStr, key: '7d' }
    case '30d': return { from: fmtDate(shiftDays(asOf, -30)), to: asOfStr, key: '30d' }
    case '60d': return { from: fmtDate(shiftDays(asOf, -60)), to: asOfStr, key: '60d' }
    case 'ytd': return { from: fmtDate(startOfYear(asOf)),    to: asOfStr, key: 'ytd' }
    case 'custom':
      if (customFrom && customTo) return { from: customFrom, to: customTo, key: 'custom' }
      // fall through to MTD if custom is malformed
      return { from: fmtDate(startOfMonth(asOf)), to: asOfStr, key: 'mtd' }
    case 'mtd':
    default:
      return { from: fmtDate(startOfMonth(asOf)), to: asOfStr, key: 'mtd' }
  }
}

// ─── Routes ──────────────────────────────────────────────

router.get('/booked-and-boarded', (req: Request, res: Response): void => {
  const asOfRaw = (req.query['asOf'] as string) || ''
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? parseDate(asOfRaw) : new Date()
  const filters: Filters = {
    state: (req.query['state'] as string) || undefined,
    closer: (req.query['closer'] as string) || undefined,
    lender: (req.query['lender'] as string) || undefined,
    epc: (req.query['epc'] as string) || undefined,
  }
  const tf = (req.query['timeframe'] as string) || 'mtd'
  const customFrom = req.query['from'] as string | undefined
  const customTo = req.query['to'] as string | undefined
  const macdSubject = (req.query['macd'] as string) || 'booked'

  try {
    const timeframe = resolveTimeframe(tf, asOf, customFrom, customTo)
    const flash = buildFlash(asOf, filters)
    const gaps = buildGaps(asOf, timeframe, filters)
    const aging = buildAging(asOf, filters)
    const cycleTime = buildCycleTime(asOf, filters)
    const macd = buildMacd(macdSubject, asOf, filters)
    const audit = buildAudit(asOf, timeframe, filters)
    const filterOptions = buildFilterOptions()

    res.json({
      asOf: fmtDate(asOf),
      timeframe,
      sla: SLA,
      flash,
      gaps,
      aging,
      cycleTime,
      macd: { subject: macdSubject, points: macd.points, high52w: macd.high52w },
      audit,
      filterOptions,
      appliedFilters: filters,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// M1 · Not M2 — standalone audit. Same row shape as the B&B audit, but
// the filter is broader than installedNotM2: any project where M1 has
// been requested and M2 hasn't been received yet (or was clawed back).
// Active/Hold only; test_project + EPC defaults apply via applyFilters.
// Exported so the funding router (mounted with its own permission gate)
// can serve this without duplicating the SQL.
export function buildM1NotM2(filters: Filters) {
  const base = applyFilters(`WHERE ${ACTIVE_STATUS_FRAGMENT}`, [], filters)
  const where = base.where +
    ` AND m1_requested_date IS NOT NULL AND m1_requested_date != '' AND m1_requested_date != '0'` +
    ` AND (m2_deposit_date IS NULL OR m2_deposit_date = '' OR m2_deposit_date = '0' OR COALESCE(m2_net_received, 0) <= 0)`
  const sql = `SELECT
      record_id AS recordId,
      customer_name AS customerName,
      COALESCE(state, '') AS state,
      COALESCE(status, '') AS status,
      COALESCE(closer, '') AS closer,
      COALESCE(lender, '') AS lender,
      COALESCE(sales_date, '') AS salesDate,
      COALESCE(install_completed, '') AS installCompleted,
      COALESCE(install_scheduled, '') AS installScheduled,
      COALESCE(m2_deposit_date, '') AS m2Date,
      COALESCE(m1_requested_date, '') AS m1RequestedDate,
      COALESCE(m2_requested_date, '') AS m2RequestedDate,
      COALESCE(m2_rejected_date, '') AS m2RejectedDate,
      COALESCE(m2_approved_date, '') AS m2ApprovedDate,
      COALESCE(m2_net_received, 0) AS m2NetReceived,
      COALESCE(m2_status, '') AS m2Status,
      COALESCE(m2_not_ready_note, '') AS m2NotReadyNote,
      COALESCE(m2_funding_note, '') AS m2FundingNote,
      COALESCE(m2_expected_amount, 0) AS m2ExpectedAmount,
      COALESCE(system_price, 0) AS systemPrice,
      COALESCE(system_size_kw, 0) AS systemSizeKw
    FROM project_cache ${where}
    ORDER BY install_completed ASC
    LIMIT 5000`
  const rows = db.prepare(sql).all(...base.params)
  return { asOf: fmtDate(new Date()), rows, filterOptions: buildFilterOptions(), appliedFilters: filters }
}
export type { Filters }

router.get('/booked-and-boarded/drill', (req: Request, res: Response): void => {
  const gap = (req.query['gap'] as string) as DrillGap
  const dimension = (req.query['dimension'] as string) || 'state'
  if (!DRILL_GAPS.includes(gap)) { res.status(400).json({ error: 'invalid gap' }); return }
  if (!DIMENSIONS[dimension]) { res.status(400).json({ error: 'invalid dimension' }); return }

  const asOfRaw = (req.query['asOf'] as string) || ''
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? parseDate(asOfRaw) : new Date()
  const tf = (req.query['timeframe'] as string) || 'mtd'
  const customFrom = req.query['from'] as string | undefined
  const customTo = req.query['to'] as string | undefined
  const filters: Filters = {
    state: (req.query['state'] as string) || undefined,
    closer: (req.query['closer'] as string) || undefined,
    lender: (req.query['lender'] as string) || undefined,
    epc: (req.query['epc'] as string) || undefined,
  }

  try {
    const timeframe = resolveTimeframe(tf, asOf, customFrom, customTo)
    const drill = buildDrill(gap, dimension, asOf, timeframe, filters)
    res.json({ gap, dimension, rows: drill.rows, total: drill.total })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Cycle-time drill — per-dimension breakdown of median cycle days for
// one transition (e.g. "Booked → Installed" by state). Fueled by the
// same gapDays() / percentile() primitives the main cycle-time builder
// uses. Returns n + min/p25/median/p75/max so the client can render the
// same stats grid dimensionally.
const CYCLE_COLS = new Set([
  'sales_date', 'install_completed', 'pto_approved',
  'm1_deposit_date', 'm2_deposit_date', 'm3_deposit_date',
  'dca_actual_deposit',
])
const CYCLE_WINDOWS: Record<string, number> = { '30d': 30, '60d': 60, '90d': 90 }

router.get('/booked-and-boarded/cycle-drill', (req: Request, res: Response): void => {
  const fromCol = String(req.query['from'] || '')
  const toCol = String(req.query['to'] || '')
  const dimension = (req.query['dimension'] as string) || 'state'
  const win = String(req.query['window'] || '90d')
  if (!CYCLE_COLS.has(fromCol) || !CYCLE_COLS.has(toCol)) {
    res.status(400).json({ error: 'invalid from/to column' }); return
  }
  if (!DIMENSIONS[dimension]) { res.status(400).json({ error: 'invalid dimension' }); return }
  const days = CYCLE_WINDOWS[win] || 90

  const asOfRaw = (req.query['asOf'] as string) || ''
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? parseDate(asOfRaw) : new Date()
  const filters: Filters = {
    state: (req.query['state'] as string) || undefined,
    closer: (req.query['closer'] as string) || undefined,
    lender: (req.query['lender'] as string) || undefined,
    epc: (req.query['epc'] as string) || undefined,
  }
  const winStart = fmtDate(shiftDays(asOf, -days))
  const winEnd = fmtDate(asOf)
  const dimCol = DIMENSIONS[dimension]!
  const base = applyFilters('WHERE 1=1', [], filters)

  try {
    // Pull individual cycle-time samples joined to the dimension column,
    // then bucket by dimension in JS and compute percentiles. SQL would
    // need a window function for percentiles; the JS path mirrors the
    // existing buildCycleTime() approach exactly so numbers tie out.
    const sql = `SELECT
        CASE WHEN ${dimCol} IS NULL OR ${dimCol} = '' THEN '(unknown)' ELSE ${dimCol} END AS dim,
        julianday(substr(${toCol},1,10)) - julianday(substr(${fromCol},1,10)) AS days
      FROM project_cache ${base.where}
        AND ${fromCol} IS NOT NULL AND ${fromCol} != '' AND ${fromCol} != '0'
        AND ${toCol} IS NOT NULL AND ${toCol} != '' AND ${toCol} != '0'
        AND substr(${toCol},1,10) BETWEEN ? AND ?`
    const rows = db.prepare(sql).all(...base.params, winStart, winEnd) as Array<{ dim: string; days: number }>
    const buckets = new Map<string, number[]>()
    for (const r of rows) {
      if (r.days < 0 || r.days > 365 * 3) continue
      const arr = buckets.get(r.dim) || []
      arr.push(r.days)
      buckets.set(r.dim, arr)
    }
    const out = [...buckets.entries()].map(([name, samples]) => ({
      name,
      ...buildStats(samples),
    })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    res.json({ from: fromCol, to: toCol, window: win, dimension, rows: out })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

export { router as reportsRouter }
