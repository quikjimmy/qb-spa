// ─── Intake / performance breakdown domain ────────────────────────────
// Groups the booked population by a dimension (state, lender, closer,
// coordinator) and reports the intake-performance metric set the
// state/lender dashboards show: projects sold, kW sold, KCA'd count, KCA
// rate, and first-time inspection-pass rate. All from project_cache.
//
// Definitions (mirroring QB):
//   sold        = sales_date is set
//   kW sold     = SUM(system_size_kw) over sold rows
//   KCA'd       = intake_completed is set (KCA = intake cleared)
//   KCA rate    = KCA'd / sold
//   FTP rate    = of rows with an inspection result, the share that
//                 passed first time. Derived from inspx_pass_fail
//                 ('Pass' = first-time pass; 'Fail, Pass' = passed after a
//                 fail; 'Fail' = failed). NOTE: the inspx_first_time_pass
//                 integer column exists but is 0 for every cached row, so
//                 inspx_pass_fail is the real source.

import db from '../../../db'

const ALLOWED_DIMENSIONS = new Set(['state', 'lender', 'closer', 'coordinator'])

export interface BreakdownRow {
  group: string
  projects_sold: number
  kw_sold: number
  kca_count: number
  kca_rate_pct: number | null
  first_time_pass_rate_pct: number | null
}

function pct(n: number, d: number): number | null {
  if (!d) return null
  return Math.round((n / d) * 1000) / 10
}

export function getBreakdown(input: { dimension: string; top?: number }): {
  dimension: string
  rows: BreakdownRow[]
} {
  const dim = input.dimension
  if (!ALLOWED_DIMENSIONS.has(dim)) {
    throw new Error(`dimension must be one of: ${[...ALLOWED_DIMENSIONS].join(', ')}`)
  }
  const groupExpr = `COALESCE(NULLIF(${dim}, ''), '— Unassigned')`

  const raw = db.prepare(`
    SELECT
      ${groupExpr} AS grp,
      SUM(CASE WHEN sales_date IS NOT NULL AND sales_date != '' THEN 1 ELSE 0 END) AS projects_sold,
      COALESCE(SUM(CASE WHEN sales_date IS NOT NULL AND sales_date != '' THEN system_size_kw ELSE 0 END), 0) AS kw_sold,
      SUM(CASE WHEN sales_date IS NOT NULL AND sales_date != '' AND intake_completed IS NOT NULL AND intake_completed != '' THEN 1 ELSE 0 END) AS kca_count,
      SUM(CASE WHEN inspx_pass_fail IS NOT NULL AND inspx_pass_fail != '' THEN 1 ELSE 0 END) AS inspected,
      SUM(CASE WHEN inspx_pass_fail = 'Pass' THEN 1 ELSE 0 END) AS first_time_pass
    FROM project_cache
    GROUP BY ${groupExpr}
    HAVING projects_sold > 0
    ORDER BY projects_sold DESC
  `).all() as Array<{
    grp: string; projects_sold: number; kw_sold: number; kca_count: number; inspected: number; first_time_pass: number
  }>

  const rows: BreakdownRow[] = raw.map(r => ({
    group: r.grp,
    projects_sold: r.projects_sold,
    kw_sold: Math.round(r.kw_sold * 10) / 10,
    kca_count: r.kca_count,
    kca_rate_pct: pct(r.kca_count, r.projects_sold),
    first_time_pass_rate_pct: pct(r.first_time_pass, r.inspected),
  }))

  // Top-N + "Other" fold for high-cardinality dimensions (e.g. lender).
  const top = input.top
  if (top && rows.length > top) {
    const head = rows.slice(0, top)
    const tail = rows.slice(top)
    const other = tail.reduce(
      (acc, r) => ({
        projects_sold: acc.projects_sold + r.projects_sold,
        kw_sold: acc.kw_sold + r.kw_sold,
        kca_count: acc.kca_count + r.kca_count,
      }),
      { projects_sold: 0, kw_sold: 0, kca_count: 0 },
    )
    head.push({
      group: 'Other',
      projects_sold: other.projects_sold,
      kw_sold: Math.round(other.kw_sold * 10) / 10,
      kca_count: other.kca_count,
      kca_rate_pct: pct(other.kca_count, other.projects_sold),
      first_time_pass_rate_pct: null, // not meaningful for a fold
    })
    return { dimension: dim, rows: head }
  }
  return { dimension: dim, rows }
}
