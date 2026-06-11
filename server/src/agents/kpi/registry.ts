// ─── Agent KPI Registry ───────────────────────────────────────────────
// A single, read-only source of truth for the operational KPIs that
// internal agents reason over. Every metric is computed against the
// local `project_cache` table — the same tier-refreshed mirror of
// QuickBase that the dashboards read — so agents query fresh data
// without a QB round-trip and without re-implementing each filter.
//
// WHY THIS EXISTS (vs. inlining queries in each agent):
//   - The seeded PC worker roles (pc-risk-hold-worker, pc-inspection-
//     pto-worker, pc-permit-intelligence-worker, …) all need the same
//     funnel-gap / aging signals. Defining them once here stops every
//     agent re-deriving "what counts as stuck".
//   - KPIs change in QuickBase. Each metric records its `qbSource` —
//     the authoritative QB report / filter it mirrors — so when the
//     definition moves in QB you reconcile ONE line here, and both the
//     agents and any future dashboard binding follow.
//
// This is deliberately parallel to daily-goals.ts's DataSource registry
// (which answers "how many hit milestone X on day Y"). This registry
// answers "how many are stuck in gap X right now, and which ones" —
// the snapshot/backlog shape agents need for escalation work. The two
// can be consolidated later; for now they stay separate because their
// fetch shapes differ.

import db from '../../db'

// Statuses that mean the project is no longer in the active pipeline.
// Mirrors the DEAD_PROJECT_STATUSES set in daily-goals.ts — kept in
// sync by hand for now (a shared constant is the obvious next step).
const DEAD_STATUSES = [
  'Rejected', 'ROR', 'Cancelled', 'ARC', 'Pending Cancel',
  'Lost', 'Complete', 'Completed',
] as const

// SQL fragment: status is NOT one of the dead statuses (NULL-safe).
const NOT_DEAD = `(status IS NULL OR status NOT IN (${DEAD_STATUSES.map(s => `'${s}'`).join(',')}))`

// SQL fragment helpers for date TEXT columns (YYYY-MM-DD; '' = not yet).
const isSet = (col: string) => `(${col} IS NOT NULL AND ${col} != '')`
const notSet = (col: string) => `(${col} IS NULL OR ${col} = '')`

export interface MetricDef {
  slug: string
  label: string
  description: string
  unit: string
  // Authoritative QuickBase lineage. When a KPI definition changes in
  // QB, update the `where` clause to match and refresh this note.
  qbSource: string
  // WHERE-clause body over project_cache. Dead statuses are excluded
  // automatically unless `includeInactive` is true.
  where: string
  includeInactive?: boolean
  // Date column to age the backlog by (days since). Drives the `days`
  // field on samples and the avg-age summary. Omit for non-aging counts.
  agingColumn?: string
  // Recency guard: ignore rows whose `agingColumn` is older than this many
  // days. The install-funnel KPIs otherwise drown in legacy projects whose
  // later milestone dates were never backfilled (avg age >1,000 days). A
  // bound keeps the backlog to what's actually actionable. Requires
  // agingColumn. Omit to count the full history.
  recencyDays?: number
}

export interface MetricSample {
  record_id: number
  customer_name: string | null
  status: string | null
  coordinator: string | null
  state: string | null
  // Days since `agingColumn` (rounded). Null when the metric has no aging column.
  days_in_stage: number | null
}

export interface MetricResult {
  slug: string
  label: string
  description: string
  qbSource: string
  unit: string
  value: number
  // Average days-in-stage across the backlog (null for non-aging metrics).
  avg_days_in_stage: number | null
  // If set, rows older than this many days were excluded as legacy noise.
  recency_days: number | null
  // Oldest-first example projects, capped at `sample_limit`.
  sample: MetricSample[]
  sample_truncated: boolean
  as_of: string
}

// ─── The metrics ───────────────────────────────────────────────────────
// Each maps to a real funnel gap an agent acts on. The `qbSource` is the
// human's reconciliation anchor against QuickBase.

export const METRICS: MetricDef[] = [
  {
    slug: 'sold_not_installed',
    label: 'Sold, not installed',
    description: 'Contract signed (sales_date set) but install not yet completed. The top-of-funnel backlog. SLA per Booked & Boarded spec: 14d warn / 30d red.',
    unit: 'projects',
    qbSource: 'QB Projects (br9kwm8na): Sale Date set AND Install Completed empty, active statuses. Booked & Boarded "Sold-Not-Installed" gap KPI.',
    where: `${isSet('sales_date')} AND ${notSet('install_completed')}`,
    agingColumn: 'sales_date',
    recencyDays: 180,
  },
  {
    slug: 'installed_not_m1_funded',
    label: 'Installed, not M1 funded',
    description: 'Install complete but Milestone-1 funding not yet approved. SLA per B&B spec: 7d warn / 14d red. Owned by funding follow-up.',
    unit: 'projects',
    qbSource: 'QB Projects: Install Completed set AND M1 Approved Date empty. B&B "Installed-Not-M1-Funded" gap KPI.',
    where: `${isSet('install_completed')} AND ${notSet('m1_approved_date')}`,
    agingColumn: 'install_completed',
    recencyDays: 180,
  },
  {
    slug: 'installed_not_inspection_passed',
    label: 'Installed, inspection not passed',
    description: 'Install complete but inspection not yet passed. Post-install field-ops stall.',
    unit: 'projects',
    qbSource: 'QB Projects: Install Completed set AND Inspection Passed empty. Mirrors INSPX dashboard "Need Inspection".',
    where: `${isSet('install_completed')} AND ${notSet('inspection_passed')}`,
    agingColumn: 'install_completed',
    recencyDays: 180,
  },
  {
    slug: 'inspection_passed_not_pto',
    label: 'Inspection passed, no PTO',
    description: 'Inspection passed but PTO not yet approved — the final activation gap. Owned by pc-inspection-pto-worker.',
    unit: 'projects',
    qbSource: 'QB Projects: Inspection Passed set AND PTO Approved empty. Mirrors PTO dashboard "Inspection Passed No PTO".',
    where: `${isSet('inspection_passed')} AND ${notSet('pto_approved')}`,
    agingColumn: 'inspection_passed',
  },
  {
    slug: 'permit_submitted_not_approved',
    label: 'Permit submitted, awaiting approval',
    description: 'Permit submitted to the AHJ, not yet approved and not rejected. Owned by pc-permit-intelligence-worker for AHJ follow-up.',
    unit: 'projects',
    qbSource: 'QB Permitting (bscs3z866): Permit Submitted set AND Permit Approved empty AND Permit Rejected empty.',
    where: `${isSet('permit_submitted')} AND ${notSet('permit_approved')} AND ${notSet('permit_rejected')}`,
    agingColumn: 'permit_submitted',
  },
  {
    slug: 'on_hold',
    label: 'On hold',
    description: 'Projects in any hold status (Finance / HOA / Roof / generic On Hold). The input set for pc-risk-hold-worker classification.',
    unit: 'projects',
    qbSource: "QB Projects: Project Status LIKE '%Hold%'. Feeds the hold classifier.",
    where: `status LIKE '%Hold%'`,
    includeInactive: true, // hold statuses are themselves "inactive" — don't double-filter them out
  },
]

const metricBySlug = new Map(METRICS.map(m => [m.slug, m]))

export function listMetrics(): Array<Pick<MetricDef, 'slug' | 'label' | 'description' | 'unit' | 'qbSource'>> {
  return METRICS.map(({ slug, label, description, unit, qbSource }) => ({ slug, label, description, unit, qbSource }))
}

export function getMetricDef(slug: string): MetricDef | undefined {
  return metricBySlug.get(slug)
}

// Guard: project_cache is created lazily by the projects route on import.
// A bare script that only touches the registry might run before that, so
// surface a clear error instead of a cryptic "no such table".
function assertCacheTable(): void {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_cache'`)
    .get() as { name: string } | undefined
  if (!row) {
    throw new Error(
      'project_cache table not found. Import the projects route (or run the server once) so the cache is created and populated before computing KPIs.',
    )
  }
}

const DEFAULT_SAMPLE_LIMIT = 10

export function computeMetric(slug: string, opts?: { sampleLimit?: number }): MetricResult {
  const def = getMetricDef(slug)
  if (!def) throw new Error(`Unknown KPI slug: ${slug}`)
  assertCacheTable()

  const sampleLimit = Math.max(0, Math.min(opts?.sampleLimit ?? DEFAULT_SAMPLE_LIMIT, 100))
  const conditions = [def.where]
  if (!def.includeInactive) conditions.push(NOT_DEAD)
  // Recency guard — only meaningful with an aging column to bound on.
  if (def.recencyDays != null && def.agingColumn) {
    conditions.push(`${isSet(def.agingColumn)} AND ${def.agingColumn} >= date('now', '-${def.recencyDays} days')`)
  }
  const whereSql = conditions.map(c => `(${c})`).join(' AND ')

  const countRow = db
    .prepare(`SELECT COUNT(*) AS c FROM project_cache WHERE ${whereSql}`)
    .get() as { c: number }

  // Age expression: whole days since the aging column (NULL when absent).
  const ageExpr = def.agingColumn
    ? `CAST(julianday('now') - julianday(${def.agingColumn}) AS INTEGER)`
    : `NULL`
  const orderBy = def.agingColumn ? `days_in_stage DESC` : `record_id DESC`

  const sample = sampleLimit > 0
    ? (db
        .prepare(
          `SELECT record_id, customer_name, status, coordinator, state,
                  ${ageExpr} AS days_in_stage
           FROM project_cache
           WHERE ${whereSql}
           ORDER BY ${orderBy}
           LIMIT ?`,
        )
        .all(sampleLimit) as MetricSample[])
    : []

  let avgDays: number | null = null
  if (def.agingColumn) {
    const avgRow = db
      .prepare(
        `SELECT AVG(julianday('now') - julianday(${def.agingColumn})) AS avg_days
         FROM project_cache WHERE ${whereSql} AND ${isSet(def.agingColumn)}`,
      )
      .get() as { avg_days: number | null }
    avgDays = avgRow.avg_days == null ? null : Math.round(avgRow.avg_days)
  }

  return {
    slug: def.slug,
    label: def.label,
    description: def.description,
    qbSource: def.qbSource,
    unit: def.unit,
    value: countRow.c,
    avg_days_in_stage: avgDays,
    recency_days: def.recencyDays ?? null,
    sample,
    sample_truncated: countRow.c > sample.length,
    as_of: new Date().toISOString(),
  }
}
