import { Router, type Request, type Response } from 'express'
import db from '../db'
import { requireRole } from '../middleware/auth'
import { fetchPermitRows, permitFieldValue, permitIsSet, type QbRecord } from './permit-analytics'
import { fetchDesignRows } from './design-analytics'
// permitFieldValue / permitIsSet aren't really permit-specific — they
// just unpack QB record shapes. Aliased here for clarity when used
// against the design and events tables.
const qbVal = permitFieldValue
const qbIsSet = permitIsSet

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

  -- Persistent banner items shown in the scoreboard's scrolling ticker.
  -- Goal-hit celebrations are ephemeral and merged in client-side; this
  -- table holds the admin-curated announcements that stay up across
  -- multiple goal cycles.
  CREATE TABLE IF NOT EXISTS scoreboard_banner (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- "First time today the goal hit its target". The summary handler
  -- writes here when a goal flips from non-met to met. The client uses
  -- the recorded timestamp to decide whether to celebrate — meaning
  -- celebrations no longer depend on a particular scoreboard tab
  -- happening to witness the edge in real time.
  CREATE TABLE IF NOT EXISTS daily_goal_hits (
    goal_id INTEGER NOT NULL REFERENCES daily_goals(id) ON DELETE CASCADE,
    date_iso TEXT NOT NULL,
    first_hit_at TEXT NOT NULL DEFAULT (datetime('now')),
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

// ─── Canonical-department safety net ──────────────────────
// Only the idempotent half of the original normalization. We make
// sure the 11 canonical department names exist as rows, but we DO NOT
// touch goal department assignments on boot — that was a one-time
// fix already applied in production, and re-running it would
// repeatedly overwrite any admin edits made in /admin/daily-goals.
//
// Admin-driven reassignments are authoritative. If a future schema
// change needs another bulk migration, gate it behind a flag in a
// dedicated migrations table; don't unconditionally UPDATE on boot.
{
  const ensureCanonical = db.prepare(
    `INSERT OR IGNORE INTO departments (name, description) VALUES (?, 'Canonical')`
  )
  for (const name of CANONICAL_DEPARTMENTS) ensureCanonical.run(name)
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

// ─── "Need to Submit" — canonical QB report 65 ──────────────
// Mirrors the filter on the Permitting Dashboard's "Need to Submit"
// gauge (table bscs3z866, report id 65). Applied in JS against the
// rows that fetchPermitRows() already pulls + caches for the Permit
// dashboard, so this doesn't add a second QB round-trip.
//
// Filter (all must be true):
//   - Permitting To-Do (175) HAS one of:
//       Submit Building Permit / Submit Zoning Permit /
//       Submit Electrical Permit / Submit Revision
//   - Project Status NOT in: Rejected, ROR, Cancelled, ARC,
//       Pending Cancel, Lost, Finance Hold, Hoa Hold, On Hold,
//       Complete, Completed, Roof Hold
//   - Project - Design Completed (67) is NOT empty
//   - Permit Missing Items (168) IS empty
//   - Permit Approved (20) IS empty
//   - Test Project (214) is NOT 1

const DEAD_PROJECT_STATUSES = new Set([
  'Rejected', 'ROR', 'Cancelled', 'ARC', 'Pending Cancel',
  'Lost', 'Finance Hold', 'Hoa Hold', 'On Hold', 'Complete',
  'Completed', 'Roof Hold',
])

const NEED_TO_SUBMIT_TODO_PATTERN =
  /Submit (?:Building|Zoning|Electrical) Permit|Submit Revision/i

function rowMatchesNeedToSubmit(record: QbRecord): boolean {
  const todo = permitFieldValue(record, 175)
  if (!NEED_TO_SUBMIT_TODO_PATTERN.test(todo)) return false

  const projectStatus = permitFieldValue(record, 68) || permitFieldValue(record, 134)
  if (DEAD_PROJECT_STATUSES.has(projectStatus.trim())) return false

  const designCompleted = permitFieldValue(record, 67)
  if (!permitIsSet(designCompleted)) return false

  const missingItems = permitFieldValue(record, 168)
  if (permitIsSet(missingItems)) return false

  const permitApproved = permitFieldValue(record, 20)
  if (permitIsSet(permitApproved)) return false

  const testProject = permitFieldValue(record, 214)
  if (testProject.trim() === '1' || /^true$/i.test(testProject.trim())) return false

  return true
}

// Self-refreshing sync cache so the synchronous DataSource.fetch
// signature still works. Background refresh keeps the cached count
// within ~60s of QB; per-poll reads of the count are cheap.
const NEED_TO_SUBMIT_TTL_MS = 60_000
let needToSubmitCache: { count: number; refreshedAt: number } = { count: 0, refreshedAt: 0 }
let needToSubmitInFlight: Promise<void> | null = null

async function refreshNeedToSubmit(): Promise<void> {
  if (needToSubmitInFlight) return needToSubmitInFlight
  needToSubmitInFlight = (async () => {
    try {
      const rows = await fetchPermitRows()
      const count = rows.filter(rowMatchesNeedToSubmit).length
      needToSubmitCache = { count, refreshedAt: Date.now() }
    } catch (e) {
      // Soft fail — keep the last good number so the scoreboard doesn't
      // flicker to zero on a transient QB blip.
      console.warn('[daily-goals] need-to-submit refresh failed:', e)
    } finally {
      needToSubmitInFlight = null
    }
  })()
  return needToSubmitInFlight
}

function needToSubmitCount(): number {
  if (Date.now() - needToSubmitCache.refreshedAt > NEED_TO_SUBMIT_TTL_MS) {
    refreshNeedToSubmit().catch(() => { /* logged in refreshNeedToSubmit */ })
  }
  return needToSubmitCache.count
}

// Warm the cache on boot so the first /summary poll doesn't see 0.
refreshNeedToSubmit().catch(() => { /* logged inside */ })

// ─── "Initial CAD Designs Completed" — per-day count ──────
// Designs from table bsbhp6zhm where Design Type (field 8) is
// "Initial Design" and CAD Completed (field 50) falls on a given
// date. Piggy-backs on the same design-row cache the design
// dashboard already maintains (60s TTL).

const DESIGN_INITIAL_TTL_MS = 60_000
let designInitialCache: { byDate: Map<string, number>; refreshedAt: number } =
  { byDate: new Map(), refreshedAt: 0 }
let designInitialInFlight: Promise<void> | null = null

async function refreshDesignInitialCompleted(): Promise<void> {
  if (designInitialInFlight) return designInitialInFlight
  designInitialInFlight = (async () => {
    try {
      const rows = await fetchDesignRows()
      const byDate = new Map<string, number>()
      for (const r of rows) {
        if (qbVal(r, 8) !== 'Initial Design') continue
        const completed = qbVal(r, 50)
        if (!qbIsSet(completed)) continue
        const date = completed.slice(0, 10)
        byDate.set(date, (byDate.get(date) ?? 0) + 1)
      }
      designInitialCache = { byDate, refreshedAt: Date.now() }
    } catch (e) {
      console.warn('[daily-goals] initial-CAD-completed refresh failed:', e)
    } finally {
      designInitialInFlight = null
    }
  })()
  return designInitialInFlight
}

function designInitialCompletedCount(dateIso: string): number {
  if (Date.now() - designInitialCache.refreshedAt > DESIGN_INITIAL_TTL_MS) {
    refreshDesignInitialCompleted().catch(() => { /* logged inside */ })
  }
  return designInitialCache.byDate.get(dateIso) ?? 0
}

refreshDesignInitialCompleted().catch(() => { /* logged inside */ })

// ─── "Install First Scheduled" — per-day count ────────────
// Mirrors QB report 123 (table bsbguxz4i — the Events table). Each
// row in this table is a scheduling event; a row with event type
// (field 6) = 'Installation' and a Date Created (field 1) = X
// means an install was scheduled on day X — which is the date the
// user asked about, distinct from the install's appointment date.

const EVENTS_TABLE = 'bsbguxz4i'
const INSTALL_SCHEDULED_TTL_MS = 60_000
let installScheduledCache: { byDate: Map<string, number>; refreshedAt: number } =
  { byDate: new Map(), refreshedAt: 0 }
let installScheduledInFlight: Promise<void> | null = null

async function refreshInstallScheduled(): Promise<void> {
  if (installScheduledInFlight) return installScheduledInFlight
  installScheduledInFlight = (async () => {
    try {
      const realm = process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com'
      const token = process.env['QB_USER_TOKEN'] || ''
      if (!token) {
        console.warn('[daily-goals] QB_USER_TOKEN missing — install.first_scheduled disabled')
        return
      }
      const byDate = new Map<string, number>()
      let skip = 0
      const top = 1000
      // Pull every Installation event sorted newest first. Bail after
      // ~20k rows or when a page returns short — same pattern as
      // fetchPermitRows / fetchDesignRows.
      while (true) {
        const res = await fetch('https://api.quickbase.com/v1/records/query', {
          method: 'POST',
          headers: {
            'QB-Realm-Hostname': realm,
            'Authorization': `QB-USER-TOKEN ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: EVENTS_TABLE,
            select: [1, 6],
            where: `{'6'.EX.'Installation'}`,
            sortBy: [{ fieldId: 1, order: 'DESC' }],
            options: { skip, top },
          }),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(`QB events query failed (${res.status}): ${text.slice(0, 200)}`)
        }
        const data = await res.json() as { data?: QbRecord[] }
        const records = data.data || []
        for (const rec of records) {
          const dateRaw = qbVal(rec, 1)
          if (!dateRaw) continue
          const date = dateRaw.slice(0, 10)
          byDate.set(date, (byDate.get(date) ?? 0) + 1)
        }
        if (records.length < top || skip > 20_000) break
        skip += top
      }
      installScheduledCache = { byDate, refreshedAt: Date.now() }
    } catch (e) {
      console.warn('[daily-goals] install-scheduled refresh failed:', e)
    } finally {
      installScheduledInFlight = null
    }
  })()
  return installScheduledInFlight
}

function installScheduledCount(dateIso: string): number {
  if (Date.now() - installScheduledCache.refreshedAt > INSTALL_SCHEDULED_TTL_MS) {
    refreshInstallScheduled().catch(() => { /* logged inside */ })
  }
  return installScheduledCache.byDate.get(dateIso) ?? 0
}

refreshInstallScheduled().catch(() => { /* logged inside */ })

// ─── "KCA Cleared" — per-day count ────────────────────────
// Mirrors QB report 24 (table bsiripd8r, "Prior Status is Rejected").
// Report filter: field 9 (Prior Status) = 'Rejected' AND field 56
// is set. Per the goal definition, field 56 represents the intake
// completion date — so today's KCA-cleared count is the rows that
// match the report filter AND have field 56 falling on today.
// Verify against the QB report locally before relying on the number;
// if field 56 turns out to be a different date column we'll adjust.

const KCA_TABLE = 'bsiripd8r'
const KCA_TTL_MS = 60_000
let kcaClearedCache: { byDate: Map<string, number>; refreshedAt: number } =
  { byDate: new Map(), refreshedAt: 0 }
let kcaClearedInFlight: Promise<void> | null = null

async function refreshKcaCleared(): Promise<void> {
  if (kcaClearedInFlight) return kcaClearedInFlight
  kcaClearedInFlight = (async () => {
    try {
      const realm = process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com'
      const token = process.env['QB_USER_TOKEN'] || ''
      if (!token) {
        console.warn('[daily-goals] QB_USER_TOKEN missing — intake.kca_cleared disabled')
        return
      }
      const byDate = new Map<string, number>()
      let skip = 0
      const top = 1000
      while (true) {
        const res = await fetch('https://api.quickbase.com/v1/records/query', {
          method: 'POST',
          headers: {
            'QB-Realm-Hostname': realm,
            'Authorization': `QB-USER-TOKEN ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: KCA_TABLE,
            select: [9, 56],
            where: `{'9'.EX.'Rejected'}AND{'56'.XEX.''}`,
            sortBy: [{ fieldId: 56, order: 'DESC' }],
            options: { skip, top },
          }),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(`QB KCA query failed (${res.status}): ${text.slice(0, 200)}`)
        }
        const data = await res.json() as { data?: QbRecord[] }
        const records = data.data || []
        for (const rec of records) {
          const dateRaw = qbVal(rec, 56)
          if (!dateRaw) continue
          const date = dateRaw.slice(0, 10)
          byDate.set(date, (byDate.get(date) ?? 0) + 1)
        }
        if (records.length < top || skip > 20_000) break
        skip += top
      }
      kcaClearedCache = { byDate, refreshedAt: Date.now() }
    } catch (e) {
      console.warn('[daily-goals] kca-cleared refresh failed:', e)
    } finally {
      kcaClearedInFlight = null
    }
  })()
  return kcaClearedInFlight
}

function kcaClearedCount(dateIso: string): number {
  if (Date.now() - kcaClearedCache.refreshedAt > KCA_TTL_MS) {
    refreshKcaCleared().catch(() => { /* logged inside */ })
  }
  return kcaClearedCache.byDate.get(dateIso) ?? 0
}

refreshKcaCleared().catch(() => { /* logged inside */ })

const DATA_SOURCES: DataSource[] = [
  { key: 'permit.submitted',    label: 'Permits submitted (project_cache.permit_submitted)',  fetch: d => countProjects('permit_submitted',  d) },
  { key: 'permit.approved',     label: 'Permits approved',    fetch: d => countProjects('permit_approved',   d) },
  { key: 'permit.bucket_empty', label: 'Need to Submit (QB report 65, table bscs3z866)', fetch: _d => {
    // Snapshot — returns today's count regardless of the requested date
    // so the binary "0 = bucket empty / clear" semantic works for the
    // empty-bucket goal kind on the scoreboard.
    return needToSubmitCount()
  } },
  { key: 'design.cad_completed_initial', label: 'Initial CAD Designs Completed (Design Type = Initial Design)', fetch: designInitialCompletedCount },
  { key: 'install.first_scheduled', label: 'Installs First Scheduled (QB report 123, Events table)', fetch: installScheduledCount },
  { key: 'intake.kca_cleared', label: 'KCA Cleared (prior status Rejected, intake completed) — QB report 24', fetch: kcaClearedCount },
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
// "Target for date X" = the most recent daily_goal_targets row with
// date_iso <= X. If none exists, return 0 — which means "no goal was
// set for this day" and the scoreboard renders the cell as gray.
//
// The seed list's defaultTarget is intentionally NOT used as a
// fallback here: in production, admins set targets explicitly and we
// don't want phantom grading against a seed default that the team
// never agreed to. The mock-data seeder still uses defaultTarget for
// dev visuals — see `mockTargetForDate` below.

const defaultTargetBySlug = new Map(seedGoals.map(g => [g.slug, g.defaultTarget]))

function targetForDate(goalId: number, _slug: string, dateIso: string): number {
  const row = db.prepare(`
    SELECT target FROM daily_goal_targets
    WHERE goal_id = ? AND date_iso <= ?
    ORDER BY date_iso DESC LIMIT 1
  `).get(goalId, dateIso) as { target: number } | undefined
  return row?.target ?? 0
}

function mockTargetForDate(goalId: number, slug: string, dateIso: string): number {
  // Dev-only: fall through to the seed default so the mock generator
  // can still create plausible historical values when admins haven't
  // set targets yet. NOT used in any grading code path.
  const explicit = targetForDate(goalId, slug, dateIso)
  if (explicit > 0) return explicit
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

// 7-day history: today + 6 prior. Drives the sparkline AND the
// sports-style win/loss strip on each goal card.
const HISTORY_DAYS = 7

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
    const dayTarget = mockTargetForDate(goalId, slug, day)
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

// ─── One-shot pre-prod data cleanup ───────────────────────
// Before the first real-data deploy, the dev DB accumulated 7+ days
// of mock actuals and any test targets the admin set while iterating.
// This migration wipes that history exactly once per environment so
// the scoreboard launches with a clean slate — gray cells for dates
// no goal was set, real numbers as admins start setting targets.
//
// Adds a new entry in daily_goals_migrations to gate re-runs. Past
// targets are wiped because they were placeholder values; today's and
// future targets are kept since the admin may have already pre-loaded
// the right numbers.
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_goals_migrations (
      key TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  const MIG_KEY = 'clear_pre_prod_history_v1'
  const alreadyRan = db.prepare(
    `SELECT 1 FROM daily_goals_migrations WHERE key = ?`
  ).get(MIG_KEY)
  if (!alreadyRan) {
    const todayIso = isoDate(new Date())
    const tx = db.transaction(() => {
      const actuals = db.prepare(`DELETE FROM daily_goal_actuals`).run()
      const priorTargets = db.prepare(
        `DELETE FROM daily_goal_targets WHERE date_iso < ?`
      ).run(todayIso)
      const hits = db.prepare(`DELETE FROM daily_goal_hits`).run()
      db.prepare(`INSERT INTO daily_goals_migrations (key) VALUES (?)`).run(MIG_KEY)
      return { actuals: actuals.changes, priorTargets: priorTargets.changes, hits: hits.changes }
    })
    const res = tx()
    console.log(
      `[daily-goals] one-shot cleanup ran: actuals=${res.actuals}, prior_targets=${res.priorTargets}, hits=${res.hits}`,
    )
  }
}

if (process.env['NODE_ENV'] !== 'production') seedAllMockActuals()

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
  // ISO timestamp of the first moment the server saw this goal hit
  // 'met' status today, or null if it hasn't hit yet. The scoreboard
  // celebrates when this value is recent enough — meaning a TV that
  // wasn't open at the moment of the hit still catches it on the next
  // poll within the celebration window.
  firstHitAt: string | null
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
  if (process.env['NODE_ENV'] !== 'production') seedAllMockActuals()

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

  // Statements for the first-hit tracking pass.
  const getHit = db.prepare(
    `SELECT first_hit_at FROM daily_goal_hits WHERE goal_id = ? AND date_iso = ?`
  )
  const insertHit = db.prepare(
    `INSERT OR IGNORE INTO daily_goal_hits (goal_id, date_iso, first_hit_at)
     VALUES (?, ?, datetime('now'))`
  )

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

    // First-hit detection — count-style goals are 'met' when current
    // is at or past target (and target > 0 so we don't trivially-met
    // every goal when the admin types 0); empty-bucket goals are met
    // when current is 0. We mirror paceFor()'s shape so the server
    // and the client agree on what "met" means.
    const target = targetForDate(g.id, g.slug, todayIso)
    const isMet = g.kind === 'empty_bucket' ? current === 0 : (target > 0 && current >= target)
    let firstHitAt: string | null = null
    if (isMet) {
      insertHit.run(g.id, todayIso)
      const row = getHit.get(g.id, todayIso) as { first_hit_at: string } | undefined
      // SQLite stamps look like "2026-05-20 23:11:42" (UTC). Format as
      // a real ISO so Date.parse on the client works cleanly.
      if (row?.first_hit_at) {
        firstHitAt = row.first_hit_at.replace(' ', 'T') + 'Z'
      }
    }

    return {
      id: g.id,
      slug: g.slug,
      department: g.department,
      label: g.label,
      target,
      kind: g.kind,
      current,
      history,
      dayOverDayDelta: dod,
      firstHitAt,
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

// Wipe today's first-hit timestamps so the next /summary poll re-
// detects met-status goals as "newly hit" and re-fires the
// celebration takeover. Useful for testing the celebration look and
// for re-celebrating after admin tweaks during the day.
router.delete('/hits', requireRole('admin'), (_req: Request, res: Response): void => {
  const todayIso = isoDate(new Date())
  const info = db.prepare(`DELETE FROM daily_goal_hits WHERE date_iso = ?`).run(todayIso)
  res.json({ ok: true, cleared: info.changes, date: todayIso })
})

// Diagnostic: shows what a live source is actually returning per day,
// what's in project_cache for the relevant column on each day, and
// when the cache was last refreshed. Use when a bound source returns
// numbers that don't match your expectation — usually either the cache
// is stale (forces a refresh) or the cached date doesn't match the
// office TZ (rare, but visible here).
//
//   GET /api/daily-goals/debug?source=nem.submitted
router.get('/debug', requireRole('admin'), (req: Request, res: Response): void => {
  const sourceKey = String(req.query['source'] || '')
  const src = sourcesByKey.get(sourceKey)
  if (!src) {
    res.status(400).json({
      error: `Unknown source key: ${sourceKey}`,
      available: DATA_SOURCES.map(s => s.key),
    })
    return
  }

  const todayIso = isoDate(new Date())
  const dates: string[] = []
  for (let i = 6; i >= 0; i--) dates.push(addDaysIso(todayIso, -i))
  const counts = dates.map(d => ({ date: d, count: src.fetch(d) }))

  // Surface the project_cache freshness so the user can tell at a
  // glance whether they're looking at a lagged snapshot.
  const freshness = db.prepare(
    `SELECT MAX(cached_at) AS latest, COUNT(*) AS rows FROM project_cache`
  ).get() as { latest: string | null; rows: number }
  const ticketFreshness = db.prepare(
    `SELECT MAX(cached_at) AS latest, COUNT(*) AS rows FROM ticket_cache`
  ).get() as { latest: string | null; rows: number }

  res.json({
    source: { key: src.key, label: src.label },
    office_tz: OFFICE_TZ,
    today: todayIso,
    counts,
    project_cache: { last_refresh: freshness.latest, rows: freshness.rows },
    ticket_cache:  { last_refresh: ticketFreshness.latest, rows: ticketFreshness.rows },
    refresh_hint: 'POST /api/projects/refresh (full QB resync) — usually fixes lag',
  })
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

  // Dev-only: seed mock history so the sparkline isn't blank on
  // first render. Skipped for live-source goals (real data flows) and
  // skipped in production (clean slate is the desired prod behavior).
  if (!dataSource && process.env['NODE_ENV'] !== 'production') {
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

// ─── Scoreboard banner ───────────────────────────────────
// Admin-curated ticker items. Goal-hit celebrations live client-side
// and are merged into the marquee for ~30s when they fire.

interface BannerItem {
  id: number
  text: string
  active: number
  priority: number
}

// Open to any authed user — the scoreboard reads this on every poll.
router.get('/banner', (_req: Request, res: Response): void => {
  const items = db.prepare(
    `SELECT id, text, priority FROM scoreboard_banner
     WHERE active = 1 ORDER BY priority DESC, id ASC`
  ).all()
  res.json({ items })
})

// Admin: full list including inactive.
router.get('/banner/all', requireRole('admin'), (_req: Request, res: Response): void => {
  const items = db.prepare(
    `SELECT id, text, active, priority FROM scoreboard_banner ORDER BY priority DESC, id ASC`
  ).all() as BannerItem[]
  res.json({ items })
})

router.post('/banner', requireRole('admin'), (req: Request, res: Response): void => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  if (text.length === 0) { res.status(400).json({ error: 'Text required' }); return }
  const priority = typeof req.body?.priority === 'number' ? Math.round(req.body.priority) : 0
  const active = req.body?.active === false ? 0 : 1
  const info = db.prepare(
    `INSERT INTO scoreboard_banner (text, active, priority) VALUES (?, ?, ?)`
  ).run(text, active, priority)
  const item = db.prepare(
    `SELECT id, text, active, priority FROM scoreboard_banner WHERE id = ?`
  ).get(info.lastInsertRowid as number)
  res.json({ item })
})

router.put('/banner/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = Number(req.params['id'])
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'Invalid id' }); return }
  const fields: Array<{ col: string; val: unknown }> = []
  if (typeof req.body?.text === 'string' && req.body.text.trim().length > 0) {
    fields.push({ col: 'text', val: req.body.text.trim() })
  }
  if (typeof req.body?.active === 'boolean') {
    fields.push({ col: 'active', val: req.body.active ? 1 : 0 })
  }
  if (typeof req.body?.priority === 'number') {
    fields.push({ col: 'priority', val: Math.round(req.body.priority) })
  }
  if (fields.length === 0) { res.status(400).json({ error: 'No editable fields' }); return }
  const setSql = fields.map(f => `${f.col} = ?`).join(', ')
  const info = db.prepare(
    `UPDATE scoreboard_banner SET ${setSql}, updated_at = datetime('now') WHERE id = ?`
  ).run(...fields.map(f => f.val), id)
  if (info.changes === 0) { res.status(404).json({ error: 'Not found' }); return }
  const item = db.prepare(
    `SELECT id, text, active, priority FROM scoreboard_banner WHERE id = ?`
  ).get(id)
  res.json({ item })
})

router.delete('/banner/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = Number(req.params['id'])
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'Invalid id' }); return }
  const info = db.prepare(`DELETE FROM scoreboard_banner WHERE id = ?`).run(id)
  if (info.changes === 0) { res.status(404).json({ error: 'Not found' }); return }
  res.json({ ok: true })
})

export { router as dailyGoalsRouter }
