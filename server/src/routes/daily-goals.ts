import { Router, type Request, type Response } from 'express'
import db from '../db'
import { requireRole } from '../middleware/auth'

const router = Router()

// ─── Schema ──────────────────────────────────────────────
// Goals: 19 daily targets across nine departments. Targets are
// date-indexed in a separate table so historical days "lock in" the
// target that was active that day — admins can change tomorrow's
// number without rewriting yesterday's signal.
//
// `kind = 'empty_bucket'` is a binary pass/fail (e.g. "permit ready-
// to-submit bucket empty") — 0 = met, anything > 0 = critical.

db.exec(`
  -- One-time cleanup of the prior weekly tables (mock data only,
  -- safe to drop). Idempotent — if you're on a fresh DB these are
  -- already absent.
  DROP TABLE IF EXISTS weekly_goal_actuals;
  DROP TABLE IF EXISTS weekly_goals;

  CREATE TABLE IF NOT EXISTS daily_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    department TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'count',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_goal_targets (
    goal_id INTEGER NOT NULL REFERENCES daily_goals(id) ON DELETE CASCADE,
    date_iso TEXT NOT NULL,
    target INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (goal_id, date_iso)
  );

  CREATE TABLE IF NOT EXISTS daily_goal_actuals (
    goal_id INTEGER NOT NULL REFERENCES daily_goals(id) ON DELETE CASCADE,
    date_iso TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (goal_id, date_iso)
  );
`)

// Idempotent additive migration: link daily_goals to the canonical
// `departments` table by FK. The `department` string column stays as
// a denormalized convenience for the scoreboard payload, but the FK
// is the source of truth — admins reassign goals via department_id.
{
  const cols = db.prepare(`PRAGMA table_info(daily_goals)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('department_id')) {
    db.exec(`ALTER TABLE daily_goals ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL`)
  }
  // `data_source` (NULL = mock data, otherwise = a key from the
  // DATA_SOURCES registry below) tells /summary where today's actual
  // value comes from.
  if (!names.has('data_source')) {
    db.exec(`ALTER TABLE daily_goals ADD COLUMN data_source TEXT`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_goals_dept ON daily_goals(department_id)`)
}

// ─── Seed (idempotent) ──────────────────────────────────────
// Order = department-ordered render sequence. Default targets seed
// the first day a goal exists — admins can edit going forward.

interface SeedGoal {
  slug: string
  department: string
  label: string
  defaultTarget: number
  kind?: 'count' | 'empty_bucket'
}

// Canonical department list — every goal slug below maps to one of
// these. Admins can add more from the UI; this list is just the
// starting state for a fresh DB.
const CANONICAL_DEPARTMENTS = [
  'Sales',
  'Intake',
  'Site Survey',
  'Design',
  'NEM',
  'Field',
  'Inspections',
  'PTO',
  'Customer Support',
  'Project Coordinators',
  'Scheduling',
]

const seedGoals: SeedGoal[] = [
  { slug: 'retention-casey-aid',   department: 'Customer Support',     label: 'Casey aid on rejects',           defaultTarget: 3 },
  { slug: 'retention-saves',       department: 'Customer Support',     label: 'Saves completed',                defaultTarget: 2 },
  { slug: 'retention-sales-aid',   department: 'Sales',                label: 'Sales aid completed',            defaultTarget: 2 },
  { slug: 'field-site-surveys',    department: 'Site Survey',          label: 'Site surveys completed',         defaultTarget: 9 },
  { slug: 'field-service-appts',   department: 'Field',                label: 'Service appts completed',        defaultTarget: 5 },
  { slug: 'design-cad-started',    department: 'Design',               label: 'Initial designs started (CAD)',  defaultTarget: 7 },
  { slug: 'design-completed',      department: 'Design',               label: 'Initial designs completed',      defaultTarget: 6 },
  { slug: 'permit-submitted',      department: 'Design',               label: 'Permits submitted',              defaultTarget: 6 },
  { slug: 'permit-bucket-empty',   department: 'Design',               label: 'Permit-ready bucket empty',      defaultTarget: 0, kind: 'empty_bucket' },
  { slug: 'permit-ahj-started',    department: 'Design',               label: 'New AHJ registrations started',  defaultTarget: 1 },
  { slug: 'permit-ahj-completed',  department: 'Design',               label: 'New AHJ registrations completed', defaultTarget: 1 },
  { slug: 'nem-submitted',         department: 'NEM',                  label: 'NEM submitted',                  defaultTarget: 5 },
  { slug: 'pto-submitted',         department: 'PTO',                  label: 'PTO submitted',                  defaultTarget: 4 },
  { slug: 'pto-activated',         department: 'PTO',                  label: 'Projects activated after PTO',   defaultTarget: 4 },
  { slug: 'install-completed',     department: 'Scheduling',           label: 'Installs to be completed',       defaultTarget: 4 },
  { slug: 'install-scheduled',     department: 'Scheduling',           label: 'New installs scheduled',         defaultTarget: 5 },
  { slug: 'inspections-scheduled', department: 'Inspections',          label: 'Inspections scheduled',          defaultTarget: 3 },
  { slug: 'pc-outreaches',         department: 'Project Coordinators', label: 'Initial outreaches completed',   defaultTarget: 12 },
  { slug: 'tickets-completed',     department: 'Customer Support',     label: 'Support tickets completed',      defaultTarget: 7 },
]

// Lookup-or-insert a department by name (case-sensitive against the
// existing canonical list). Auto-seeds any names the goal list needs
// that admins haven't created yet — keeps the FK valid without forcing
// manual setup.
function ensureDepartmentId(name: string): number {
  const existing = db.prepare(`SELECT id FROM departments WHERE name = ?`).get(name) as
    { id: number } | undefined
  if (existing) return existing.id
  const info = db.prepare(
    `INSERT INTO departments (name, description) VALUES (?, ?)`
  ).run(name, 'Auto-created by daily-goals seed')
  return info.lastInsertRowid as number
}

const insertGoal = db.prepare(`
  INSERT INTO daily_goals (slug, department, department_id, label, kind, sort_order, active)
  VALUES (@slug, @department, @department_id, @label, @kind, @sort_order, 1)
  ON CONFLICT(slug) DO NOTHING
`)

db.transaction(() => {
  seedGoals.forEach((g, i) => {
    const deptId = ensureDepartmentId(g.department)
    insertGoal.run({
      slug: g.slug,
      department: g.department,
      department_id: deptId,
      label: g.label,
      kind: g.kind ?? 'count',
      sort_order: i,
    })
  })
})()

// Backfill department_id for any rows that pre-date the migration
// (table existed before the FK column was added).
{
  const rows = db.prepare(
    `SELECT id, department FROM daily_goals WHERE department_id IS NULL`
  ).all() as Array<{ id: number; department: string }>
  if (rows.length > 0) {
    const link = db.prepare(`UPDATE daily_goals SET department_id = ? WHERE id = ?`)
    db.transaction(() => {
      for (const r of rows) {
        link.run(ensureDepartmentId(r.department), r.id)
      }
    })()
  }
}

// ─── One-time normalization to the canonical department set ───
// Older names that map cleanly forward get renamed in place (id stays,
// so user_departments + department_permissions FKs survive). Anything
// that would collide with an already-existing canonical name is left
// for an admin to merge via /admin → Departments.
{
  const RENAMES: Array<[from: string, to: string]> = [
    ['PC', 'Project Coordinators'],
    ['Inspection', 'Inspections'],
  ]
  for (const [from, to] of RENAMES) {
    const src = db.prepare(`SELECT id FROM departments WHERE name = ?`).get(from) as { id: number } | undefined
    const dst = db.prepare(`SELECT id FROM departments WHERE name = ?`).get(to) as { id: number } | undefined
    if (src && !dst) {
      db.prepare(`UPDATE departments SET name = ? WHERE id = ?`).run(to, src.id)
    }
  }

  // Ensure every canonical name has a row.
  const ensureCanonical = db.prepare(
    `INSERT OR IGNORE INTO departments (name, description) VALUES (?, 'Canonical')`
  )
  for (const name of CANONICAL_DEPARTMENTS) ensureCanonical.run(name)

  // Pin each existing goal slug to the canonical department it
  // belongs in. The seed list above is the source of truth; we apply
  // the same mapping to rows already in the table so old assignments
  // (e.g. "Retention", "Permit", "NEM / PTO") snap into the new
  // taxonomy on first boot after this change.
  const lookup = db.prepare(`SELECT id FROM departments WHERE name = ?`)
  const remapGoal = db.prepare(
    `UPDATE daily_goals SET department_id = ?, department = ? WHERE slug = ?`
  )
  db.transaction(() => {
    for (const g of seedGoals) {
      const dept = lookup.get(g.department) as { id: number } | undefined
      if (!dept) continue
      remapGoal.run(dept.id, g.department, g.slug)
    }
  })()

  // Garbage-collect the auto-seed artifact departments from earlier
  // iterations — but only if nothing references them. Existing system
  // departments (Operations, Engineering, Funding, Field Ops, INSPX,
  // etc.) stay even when not in CANONICAL_DEPARTMENTS, because
  // user_departments / department_permissions may depend on them.
  const ARTIFACT_NAMES = ['Retention', 'Permit', 'NEM / PTO', 'Install', 'Tickets']
  const cleanup = db.prepare(`
    DELETE FROM departments
    WHERE name = ?
      AND id NOT IN (SELECT DISTINCT department_id FROM user_departments WHERE department_id IS NOT NULL)
      AND id NOT IN (SELECT DISTINCT department_id FROM department_permissions WHERE department_id IS NOT NULL)
      AND id NOT IN (SELECT DISTINCT department_id FROM daily_goals WHERE department_id IS NOT NULL)
  `)
  for (const name of ARTIFACT_NAMES) cleanup.run(name)
}

// ─── Date helpers ─────────────────────────────────────────
// All dates are local ISO YYYY-MM-DD in the *office* timezone — not
// the host's timezone. Railway runs in UTC, so on a Mountain-Time
// office at 6pm the host has already rolled to "tomorrow". Anchoring
// every date derivation here means /summary, target lock-in, and
// live-source queries all agree on what "today" is.
//
// Override via SCOREBOARD_TZ env var (any IANA zone). Defaults to
// America/Denver to match the existing agent-scheduler cron config.
const OFFICE_TZ = process.env['SCOREBOARD_TZ'] || 'America/Denver'

function isoDate(d: Date): string {
  // en-CA renders as YYYY-MM-DD by spec — the cheapest way to format
  // a date in a specific timezone without pulling in a tz library.
  return d.toLocaleDateString('en-CA', { timeZone: OFFICE_TZ })
}

// Calendar-day addition on an ISO string. We compute via UTC midnight
// math so DST transitions don't accidentally shift the result back or
// forward by a day at 2am.
function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const t = Date.UTC(y!, (m ?? 1) - 1, d ?? 1) + n * 86_400_000
  const out = new Date(t)
  const yy = out.getUTCFullYear()
  const mm = String(out.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(out.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

// Office-TZ-aware version of getDay() — returns the long weekday name.
function dayNameOf(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_TZ, weekday: 'long' }).format(d)
}

// Workday progress: 0..1 across 8am → 6pm in the office timezone.
// Before 8am we return 0 (day hasn't started, no one's behind); after
// 6pm we return 1 (remaining shortfall is now a miss).
const WORKDAY_START_HOUR = 8
const WORKDAY_END_HOUR = 18

function workdayProgress(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OFFICE_TZ,
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  // Intl returns 24 for midnight in en-US/hour12=false — normalize.
  const hours = (h === 24 ? 0 : h) + m / 60
  if (hours <= WORKDAY_START_HOUR) return 0
  if (hours >= WORKDAY_END_HOUR) return 1
  return (hours - WORKDAY_START_HOUR) / (WORKDAY_END_HOUR - WORKDAY_START_HOUR)
}

// ─── Live data sources ────────────────────────────────────
// Each source has a stable `key` (stored on the goal as data_source)
// and a `fetch(date)` that returns today's (or a historical day's)
// real count from the local analytics caches. Most sources just count
// rows of project_cache where the relevant milestone date column ==
// the requested date — that's why every QB pipeline date column
// gives us a goal source for free.

interface DataSource {
  key: string
  label: string
  // Synchronous fetcher — runs against local SQLite caches kept fresh
  // by the existing analytics schedulers. No network call in the
  // scoreboard's hot path.
  fetch: (dateIso: string) => number
}

function countProjects(column: string, dateIso: string): number {
  // Single source of truth for "how many projects hit milestone X on
  // day Y". Date columns in project_cache are TEXT in YYYY-MM-DD;
  // empty string means the milestone hasn't happened yet for that row.
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM project_cache WHERE ${column} = ?`
  ).get(dateIso) as { c: number }
  return row.c
}

const DATA_SOURCES: DataSource[] = [
  { key: 'permit.submitted',    label: 'Permits submitted (project_cache.permit_submitted)',  fetch: d => countProjects('permit_submitted',  d) },
  { key: 'permit.approved',     label: 'Permits approved',    fetch: d => countProjects('permit_approved',   d) },
  { key: 'permit.bucket_empty', label: 'Permit-ready bucket count (snapshot)', fetch: _d => {
    // "Bucket empty?" is a snapshot question, not a per-day flow. We
    // return today's bucket count regardless of the requested date so
    // the binary 0/non-zero signal still works on the scoreboard.
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM project_cache WHERE survey_approved != '' AND permit_submitted = ''`
    ).get() as { c: number }
    return row.c
  } },
  { key: 'design.cad_started',  label: 'Designs started (CAD submitted)',     fetch: d => countProjects('cad_submitted',     d) },
  { key: 'design.completed',    label: 'Designs completed',   fetch: d => countProjects('design_completed',  d) },
  { key: 'nem.submitted',       label: 'NEM submitted',       fetch: d => countProjects('nem_submitted',     d) },
  { key: 'nem.approved',        label: 'NEM approved',        fetch: d => countProjects('nem_approved',      d) },
  { key: 'pto.submitted',       label: 'PTO submitted',       fetch: d => countProjects('pto_submitted',     d) },
  { key: 'pto.approved',        label: 'PTO approved (activated)', fetch: d => countProjects('pto_approved', d) },
  { key: 'install.scheduled',   label: 'Installs scheduled',  fetch: d => countProjects('install_scheduled', d) },
  { key: 'install.completed',   label: 'Installs completed',  fetch: d => countProjects('install_completed', d) },
  { key: 'survey.scheduled',    label: 'Site surveys scheduled', fetch: d => countProjects('survey_scheduled', d) },
  { key: 'survey.submitted',    label: 'Site surveys submitted', fetch: d => countProjects('survey_submitted', d) },
  { key: 'inspection.scheduled', label: 'Inspections scheduled', fetch: d => countProjects('inspection_scheduled', d) },
  { key: 'inspection.passed',   label: 'Inspections passed',  fetch: d => countProjects('inspection_passed', d) },
  { key: 'tickets.completed',   label: 'Support tickets completed', fetch: d => {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM ticket_cache
       WHERE status IN ('Completed','Closed','Complete')
         AND date_modified LIKE ?`
    ).get(`${d}%`) as { c: number }
    return row.c
  } },
]

const sourcesByKey = new Map(DATA_SOURCES.map(s => [s.key, s]))

function valueForGoalDate(
  goal: { id: number; slug: string; data_source: string | null },
  dateIso: string,
  mockFallback: () => number,
): number {
  if (goal.data_source) {
    const src = sourcesByKey.get(goal.data_source)
    if (src) {
      try { return src.fetch(dateIso) } catch { /* fall through to mock */ }
    }
  }
  return mockFallback()
}

// ─── Target lookup ────────────────────────────────────────
// "Today's target" = the most recent daily_goal_targets row with
// date_iso <= today. If none exist, fall back to the goal's
// defaultTarget (from the seed list above).

const defaultTargetBySlug = new Map(seedGoals.map(g => [g.slug, g.defaultTarget]))

function targetForDate(goalId: number, slug: string, dateIso: string): number {
  const row = db.prepare(`
    SELECT target FROM daily_goal_targets
    WHERE goal_id = ? AND date_iso <= ?
    ORDER BY date_iso DESC LIMIT 1
  `).get(goalId, dateIso) as { target: number } | undefined
  if (row) return row.target
  return defaultTargetBySlug.get(slug) ?? 0
}

// ─── Mock data seeder ─────────────────────────────────────
// Deterministic per-goal pseudo-random walks so the sparkline stays
// stable between page loads. Replace with real analytics wiring later.

function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HISTORY_DAYS = 6

function ensureMockActuals(goalId: number, slug: string, kind: string): void {
  const todayIso = isoDate(new Date())
  const days: string[] = []
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    days.push(addDaysIso(todayIso, -i))
  }

  const existing = db.prepare(
    `SELECT date_iso FROM daily_goal_actuals WHERE goal_id = ? AND date_iso IN (${days.map(() => '?').join(',')})`
  ).all(goalId, ...days) as Array<{ date_iso: string }>
  const have = new Set(existing.map(r => r.date_iso))

  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0
  const rng = seededRandom(Math.abs(h))

  const now = new Date()
  const progress = workdayProgress(now)

  const insertActual = db.prepare(
    `INSERT OR IGNORE INTO daily_goal_actuals (goal_id, date_iso, value) VALUES (?, ?, ?)`
  )

  days.forEach((day, idx) => {
    if (have.has(day)) return
    const isCurrent = idx === days.length - 1
    const dayTarget = targetForDate(goalId, slug, day)
    let value: number
    if (kind === 'empty_bucket') {
      const roll = rng()
      if (isCurrent) value = roll < 0.55 ? 0 : Math.floor(roll * 4)
      else value = roll < 0.8 ? 0 : Math.floor(roll * 3) + 1
    } else {
      const swing = (rng() * 0.5) - 0.25 // ±25%
      const fullDayValue = Math.max(0, Math.round(dayTarget * (1 + swing)))
      value = isCurrent
        ? Math.round(fullDayValue * progress * (0.85 + rng() * 0.3))
        : fullDayValue
    }
    insertActual.run(goalId, day, value)
  })
}

function seedAllMockActuals(): void {
  const goals = db.prepare(`SELECT id, slug, kind FROM daily_goals`).all() as Array<{
    id: number
    slug: string
    kind: string
  }>
  goals.forEach(g => ensureMockActuals(g.id, g.slug, g.kind))
}

seedAllMockActuals()

// ─── Read endpoints ───────────────────────────────────────

interface ScoreboardGoal {
  id: number
  slug: string
  department: string
  label: string
  target: number
  kind: 'count' | 'empty_bucket'
  current: number
  history: Array<{ date: string; value: number; target: number }>
  dayOverDayDelta: number | null
}

interface ScoreboardSummary {
  date: string
  dayProgress: number
  dayName: string
  generatedAt: string
  goals: ScoreboardGoal[]
}

router.get('/summary', (_req: Request, res: Response): void => {
  // Refresh current-day mock value so a TV that's been running since
  // 8am ramps as the workday progresses. Historical days stay stable.
  seedAllMockActuals()

  const now = new Date()
  const todayIso = isoDate(now)

  // Join departments so the displayed group name is always the
  // canonical one — admins can rename a department globally and the
  // scoreboard follows. Falls back to the denormalized string column
  // if FK is null (only possible if departments was wiped externally).
  const goals = db.prepare(
    `SELECT g.id, g.slug, COALESCE(d.name, g.department) AS department,
            g.label, g.kind, g.sort_order, g.data_source
     FROM daily_goals g
     LEFT JOIN departments d ON d.id = g.department_id
     WHERE g.active = 1
     ORDER BY g.sort_order ASC, g.id ASC`
  ).all() as Array<{
    id: number
    slug: string
    department: string
    label: string
    kind: 'count' | 'empty_bucket'
    sort_order: number
    data_source: string | null
  }>

  const historyStmt = db.prepare(
    `SELECT date_iso AS date, value FROM daily_goal_actuals
     WHERE goal_id = ? AND date_iso >= ? ORDER BY date_iso ASC`
  )

  const sixDaysAgo = addDaysIso(todayIso, -(HISTORY_DAYS - 1))

  // Per-day window of dates (oldest → today) — used to build the
  // history array whether the goal has a live source or not.
  const windowDates: string[] = []
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    windowDates.push(addDaysIso(todayIso, -i))
  }

  const out: ScoreboardGoal[] = goals.map(g => {
    const rawHistory = historyStmt.all(g.id, sixDaysAgo) as Array<{ date: string; value: number }>
    const mockByDate = new Map(rawHistory.map(h => [h.date, h.value]))

    const history = windowDates.map(d => ({
      date: d,
      value: valueForGoalDate(g, d, () => mockByDate.get(d) ?? 0),
      target: targetForDate(g.id, g.slug, d),
    }))
    const current = history.find(h => h.date === todayIso)?.value ?? 0
    const currentIdx = history.findIndex(h => h.date === todayIso)
    const prev = currentIdx > 0 ? history[currentIdx - 1]?.value ?? null : null
    const dod = prev == null || prev === 0
      ? null
      : Math.round(((current - prev) / prev) * 100)
    return {
      id: g.id,
      slug: g.slug,
      department: g.department,
      label: g.label,
      target: targetForDate(g.id, g.slug, todayIso),
      kind: g.kind,
      current,
      history,
      dayOverDayDelta: dod,
    }
  })

  const payload: ScoreboardSummary = {
    date: todayIso,
    dayProgress: workdayProgress(now),
    dayName: dayNameOf(now),
    generatedAt: now.toISOString(),
    goals: out,
  }
  res.json(payload)
})

// ─── Admin endpoints ──────────────────────────────────────

// 15-day target window per goal: 7 days back, today, 7 days forward.
// Past days are read-only (locked in); today + future are editable.
const TARGET_WINDOW_BACK = 7
const TARGET_WINDOW_FORWARD = 7

interface AdminGoalRow {
  id: number
  slug: string
  department_id: number | null
  department: string
  label: string
  kind: 'count' | 'empty_bucket'
  sort_order: number
  active: number
  data_source: string | null
}

interface TargetWindowEntry {
  date: string
  target: number
  editable: boolean
}

function targetWindowFor(goalId: number, slug: string, now: Date): TargetWindowEntry[] {
  const todayIso = isoDate(now)
  const out: TargetWindowEntry[] = []
  for (let offset = -TARGET_WINDOW_BACK; offset <= TARGET_WINDOW_FORWARD; offset++) {
    const date = addDaysIso(isoDate(now), offset)
    out.push({
      date,
      target: targetForDate(goalId, slug, date),
      editable: date >= todayIso,
    })
  }
  return out
}

router.get('/', requireRole('admin'), (_req: Request, res: Response): void => {
  const now = new Date()
  const today = isoDate(now)
  const yesterday = addDaysIso(isoDate(now), -1)

  const rows = db.prepare(
    `SELECT g.id, g.slug, g.department_id, COALESCE(d.name, g.department) AS department,
            g.label, g.kind, g.sort_order, g.active, g.data_source
     FROM daily_goals g
     LEFT JOIN departments d ON d.id = g.department_id
     ORDER BY g.sort_order ASC, g.id ASC`
  ).all() as AdminGoalRow[]

  const goals = rows.map(r => ({
    ...r,
    today_target: targetForDate(r.id, r.slug, today),
    yesterday_target: targetForDate(r.id, r.slug, yesterday),
    target_window: targetWindowFor(r.id, r.slug, now),
  }))

  const departments = db.prepare(
    `SELECT id, name FROM departments ORDER BY name ASC`
  ).all() as Array<{ id: number; name: string }>

  const sources = DATA_SOURCES.map(s => ({ key: s.key, label: s.label }))

  res.json({ goals, departments, sources })
})

// Standalone sources endpoint for any UI that just needs the picker
// list without the full goals payload.
router.get('/sources', requireRole('admin'), (_req: Request, res: Response): void => {
  res.json({ sources: DATA_SOURCES.map(s => ({ key: s.key, label: s.label })) })
})

router.put('/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = Number(req.params['id'])
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid id' }); return
  }
  const body = req.body ?? {}
  const goalRow = db.prepare(`SELECT id, slug, kind FROM daily_goals WHERE id = ?`).get(id) as
    { id: number; slug: string; kind: string } | undefined
  if (!goalRow) { res.status(404).json({ error: 'Not found' }); return }

  // ── Column edits on daily_goals ─────────────────────────
  const fields: Array<{ col: string; val: unknown }> = []
  if (typeof body.label === 'string' && body.label.trim().length > 0) {
    fields.push({ col: 'label', val: body.label.trim() })
  }
  if (typeof body.active === 'boolean') {
    fields.push({ col: 'active', val: body.active ? 1 : 0 })
  }
  if (typeof body.sort_order === 'number') {
    fields.push({ col: 'sort_order', val: Math.round(body.sort_order) })
  }
  if (typeof body.department_id === 'number') {
    const deptId = Math.round(body.department_id)
    const exists = db.prepare(`SELECT id, name FROM departments WHERE id = ?`).get(deptId) as
      { id: number; name: string } | undefined
    if (!exists) { res.status(400).json({ error: 'Invalid department_id' }); return }
    fields.push({ col: 'department_id', val: deptId })
    // Keep the denormalized name in sync so anything that still reads
    // the string column (older callers, debug queries) sees the truth.
    fields.push({ col: 'department', val: exists.name })
  }
  // data_source: empty string OR null means "back to mock". A
  // non-empty key must exist in the registry — typo'd keys would
  // silently fall back to mock anyway, but rejecting them here gives
  // the admin a real error to fix.
  if ('data_source' in body) {
    const ds = body.data_source
    if (ds === null || ds === '') {
      fields.push({ col: 'data_source', val: null })
    } else if (typeof ds === 'string' && sourcesByKey.has(ds)) {
      fields.push({ col: 'data_source', val: ds })
    } else {
      res.status(400).json({ error: `Unknown data_source: ${ds}` }); return
    }
  }

  // ── Per-day target edits ────────────────────────────────
  // Past dates are immutable (lock-in semantic). Empty-bucket goals
  // ignore targets entirely (always 0). Single `today_target` is kept
  // for backward compat with the older PUT shape.
  const targetEdits: Array<{ date: string; target: number }> = []
  const todayIso = isoDate(new Date())
  const isEmpty = goalRow.kind === 'empty_bucket'

  if (!isEmpty) {
    if (Array.isArray(body.targets)) {
      for (const t of body.targets) {
        if (!t || typeof t.date !== 'string' || typeof t.target !== 'number') continue
        if (t.target < 0) continue
        if (t.date < todayIso) {
          res.status(400).json({ error: `Cannot edit past target for ${t.date}` })
          return
        }
        targetEdits.push({ date: t.date, target: Math.round(t.target) })
      }
    }
    if (typeof body.today_target === 'number' && body.today_target >= 0) {
      targetEdits.push({ date: todayIso, target: Math.round(body.today_target) })
    }
  }

  if (fields.length === 0 && targetEdits.length === 0) {
    res.status(400).json({ error: 'No editable fields supplied' }); return
  }

  const tx = db.transaction(() => {
    if (fields.length > 0) {
      const setSql = fields.map(f => `${f.col} = ?`).join(', ')
      db.prepare(`UPDATE daily_goals SET ${setSql}, updated_at = datetime('now') WHERE id = ?`)
        .run(...fields.map(f => f.val), id)
    }
    if (targetEdits.length > 0) {
      const upsert = db.prepare(
        `INSERT INTO daily_goal_targets (goal_id, date_iso, target, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(goal_id, date_iso) DO UPDATE SET target = excluded.target, updated_at = datetime('now')`
      )
      for (const t of targetEdits) upsert.run(id, t.date, t.target)
    }
  })
  tx()

  const now = new Date()
  const today = isoDate(now)
  const yesterday = addDaysIso(isoDate(now), -1)
  const updated = db.prepare(
    `SELECT g.id, g.slug, g.department_id, COALESCE(d.name, g.department) AS department,
            g.label, g.kind, g.sort_order, g.active, g.data_source
     FROM daily_goals g
     LEFT JOIN departments d ON d.id = g.department_id
     WHERE g.id = ?`
  ).get(id) as AdminGoalRow | undefined
  if (!updated) { res.status(404).json({ error: 'Not found' }); return }
  res.json({
    goal: {
      ...updated,
      today_target: targetForDate(id, goalRow.slug, today),
      yesterday_target: targetForDate(id, goalRow.slug, yesterday),
      target_window: targetWindowFor(id, goalRow.slug, now),
    },
  })
})

// ─── Create / delete goals ────────────────────────────────

function kebabSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function uniqueSlug(base: string): string {
  // Append -2, -3, ... if needed to dodge the UNIQUE constraint.
  let candidate = base || 'goal'
  let i = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const exists = db.prepare(`SELECT 1 FROM daily_goals WHERE slug = ?`).get(candidate)
    if (!exists) return candidate
    candidate = `${base}-${i++}`
    if (i > 999) return `${base}-${Date.now()}` // pathological fallback
  }
}

router.post('/', requireRole('admin'), (req: Request, res: Response): void => {
  const body = req.body ?? {}

  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (label.length === 0) {
    res.status(400).json({ error: 'Label required' }); return
  }

  const departmentId = typeof body.department_id === 'number' ? Math.round(body.department_id) : null
  if (departmentId == null) {
    res.status(400).json({ error: 'department_id required' }); return
  }
  const dept = db.prepare(`SELECT id, name FROM departments WHERE id = ?`).get(departmentId) as
    { id: number; name: string } | undefined
  if (!dept) { res.status(400).json({ error: 'Invalid department_id' }); return }

  const kind: 'count' | 'empty_bucket' = body.kind === 'empty_bucket' ? 'empty_bucket' : 'count'
  const initialTarget = typeof body.initial_target === 'number' && body.initial_target >= 0
    ? Math.round(body.initial_target)
    : 0

  let dataSource: string | null = null
  if (typeof body.data_source === 'string' && body.data_source.length > 0) {
    if (!sourcesByKey.has(body.data_source)) {
      res.status(400).json({ error: `Unknown data_source: ${body.data_source}` }); return
    }
    dataSource = body.data_source
  }

  const slugBase = typeof body.slug === 'string' && body.slug.length > 0
    ? kebabSlug(body.slug)
    : kebabSlug(label)
  const slug = uniqueSlug(slugBase)

  // Place new goals at the end of the sort order.
  const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM daily_goals`).get() as
    { next: number }

  const todayIso = isoDate(new Date())

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO daily_goals (slug, department, department_id, label, kind, sort_order, active, data_source)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(slug, dept.name, dept.id, label, kind, maxRow.next, dataSource)
    const newId = info.lastInsertRowid as number
    if (kind !== 'empty_bucket' && initialTarget > 0) {
      db.prepare(
        `INSERT INTO daily_goal_targets (goal_id, date_iso, target) VALUES (?, ?, ?)`
      ).run(newId, todayIso, initialTarget)
    }
    return newId
  })
  const newId = tx()

  // Seed mock history so the sparkline isn't blank on first render —
  // unless the goal has a live source, in which case real data flows.
  if (!dataSource) {
    ensureMockActuals(newId, slug, kind)
  }

  const now = new Date()
  const today = isoDate(now)
  const yesterday = addDaysIso(isoDate(now), -1)
  const created = db.prepare(
    `SELECT g.id, g.slug, g.department_id, COALESCE(d.name, g.department) AS department,
            g.label, g.kind, g.sort_order, g.active, g.data_source
     FROM daily_goals g
     LEFT JOIN departments d ON d.id = g.department_id
     WHERE g.id = ?`
  ).get(newId) as AdminGoalRow | undefined
  if (!created) { res.status(500).json({ error: 'Created goal not found' }); return }

  res.json({
    goal: {
      ...created,
      today_target: targetForDate(newId, slug, today),
      yesterday_target: targetForDate(newId, slug, yesterday),
      target_window: targetWindowFor(newId, slug, now),
    },
  })
})

router.delete('/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = Number(req.params['id'])
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid id' }); return
  }
  // ON DELETE CASCADE on daily_goal_targets + daily_goal_actuals
  // would handle children automatically if FKs were enforced, but
  // since the DB connection doesn't have foreign_keys=ON we clean up
  // explicitly inside a transaction.
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM daily_goal_targets WHERE goal_id = ?`).run(id)
    db.prepare(`DELETE FROM daily_goal_actuals WHERE goal_id = ?`).run(id)
    return db.prepare(`DELETE FROM daily_goals WHERE id = ?`).run(id)
  })
  const info = tx()
  if (info.changes === 0) { res.status(404).json({ error: 'Not found' }); return }
  res.json({ ok: true })
})

export { router as dailyGoalsRouter }
