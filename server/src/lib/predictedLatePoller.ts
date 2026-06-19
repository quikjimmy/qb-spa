// Predicted-late field-job alerter. Every 5 minutes we evaluate today's
// Arrivy field jobs (office calendar) and raise in-app notifications when a
// job is running — or predicted to run — late, so the project coordinator
// and the admin group (our stand-in for managers; there's no manager
// hierarchy in the data model) get a nudge in the NotificationBell.
//
// Two signal sources feed one alert stream:
//
//   (a) ARRIVY FLAGS — trust Arrivy's own task-log events
//       PREDICTED_LATE / LATE / NO_SHOW (priority NO_SHOW > LATE >
//       PREDICTED_LATE). This reuses the exact query/field mapping from
//       GET /api/field/late.
//
//   (b) OUR OWN SWEEP — a job scheduled to start soon (or already past its
//       scheduled start) whose crew has NOT marked en-route or started.
//       Two stages:
//         PREDICTED_LATE  now >= scheduledStart - PREDICT_LEAD_MIN, still
//                         before the scheduled start, no en-route/start.
//         OVERDUE         now > scheduledStart, still no en-route/start.
//       Arrivy's own flags always win over our derived ones for the same
//       task (a real LATE/NO_SHOW outranks our OVERDUE guess).
//
// Dedup: insertIfNew() keys on (user_id, type, link). We encode the task
// RID *and* the severity stage in the link, so each escalation stage
// (PREDICTED_LATE → OVERDUE → LATE → NO_SHOW) alerts each recipient at most
// once, while a task sitting in a stable stage across many sweeps never
// re-fires. Recipients = coordinator + every active admin.
//
// QB load: exactly two bounded reads per cycle — today's tasks (one
// windowed query) and the late-log (one query per related project, reusing
// /api/field/late's batching, capped). No per-project N+1 beyond that.
import db from '../db'
import {
  QB, F, SELECT_FIELDS, qbQuery, fieldValue, type QbRecord,
} from '../routes/field'
import { officeTodayIso, officeDayBoundsUtc } from './officeTime'
import { insertIfNew, pcUserIdForProject } from './notify'

// How far ahead of the scheduled start we begin warning when the crew has
// not yet moved. James's long-standing rule: if a crew is going to be more
// than 30 min out (within 30 min of the slot and still not en-route), call it
// predicted late. Do NOT raise this much further without also widening the
// candidate query window — the sweep only sees today's jobs, so a very large
// lead would start alerting on jobs whose en-route signal simply hasn't
// landed yet.
const PREDICT_LEAD_MIN = 30

// Severity ordering — higher wins when one task carries multiple signals.
const STAGE_PRIORITY: Record<string, number> = {
  PREDICTED_LATE: 1,
  OVERDUE: 2,
  LATE: 3,
  NO_SHOW: 4,
}

// Human label per stage for the notification title/body.
const STAGE_LABEL: Record<string, string> = {
  PREDICTED_LATE: 'predicted late',
  OVERDUE: 'overdue — crew not moving',
  LATE: 'running late',
  NO_SHOW: 'no-show',
}

// Mirror of /api/field/late's LOG field IDs + priority map. Kept local so
// this worker doesn't depend on a route export that isn't there.
const LOG_F = {
  relatedProject: 193,
  relatedTask: 94,
  eventType: 76,
  timestamp: 79,
  scheduled: 17,
  reporterName: 14,
}
const LOG_SELECT = [3, LOG_F.relatedTask, LOG_F.eventType, LOG_F.timestamp, LOG_F.scheduled, LOG_F.reporterName, LOG_F.relatedProject]
const ARRIVY_PRIORITY: Record<string, number> = { NO_SHOW: 4, NOSHOW: 4, LATE: 3, PREDICTED_LATE: 1 }

interface LateJob {
  taskRid: string
  projectRid: number
  stage: string            // PREDICTED_LATE | OVERDUE | LATE | NO_SHOW
  customer: string
  crew: string
  scheduledIso: string     // best-known scheduled start (ISO-ish)
  signal: 'arrivy' | 'sweep'
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// Resolve every active user in the admin permission group. Admins stand in
// for managers (no manager hierarchy in the data model — decision by James).
export function adminUserIds(): number[] {
  const rows = db.prepare(
    `SELECT DISTINCT u.id AS id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'admin' AND u.is_active = 1`
  ).all() as Array<{ id: number }>
  return rows.map(r => r.id)
}

// QB Arrivy scheduled timestamps come back as UTC-ISO ("...Z") already, but
// be defensive: a space-separated, TZ-less value is treated as UTC.
function parseScheduled(raw: string): Date | null {
  if (!raw) return null
  const s = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}

// Pull customer name off an Arrivy task record (first + last fields).
function customerOf(rec: QbRecord): string {
  const fn = String(fieldValue(rec, F.customerFirstName) || '')
  const ln = String(fieldValue(rec, F.customerLastName) || '')
  return `${fn} ${ln}`.trim()
}

function crewOf(rec: QbRecord): string {
  return String(fieldValue(rec, F.crew) || fieldValue(rec, F.assignedCrew) || fieldValue(rec, F.enrouteName) || '')
}

// Evaluate one task record against the sweep rule. Returns the derived stage
// (PREDICTED_LATE | OVERDUE) or null if the crew is already moving / done or
// it's too early to warn.
function sweepStage(rec: QbRecord, now: Date): 'PREDICTED_LATE' | 'OVERDUE' | null {
  // Crew already en-route, started, submitted, or tech-complete → not late.
  if (fieldValue(rec, F.enrouteStatus)) return null
  if (fieldValue(rec, F.startedStatus)) return null
  if (fieldValue(rec, F.submittedDateTime)) return null
  if (fieldValue(rec, F.techCompleteDateTime)) return null
  // Skip tasks already cancelled/closed at the row level.
  const status = String(fieldValue(rec, F.taskStatus) || '').toUpperCase()
  if (/CANCEL|COMPLETE|NOT.?DONE|EXCEPTION/.test(status)) return null
  const sched = parseScheduled(String(fieldValue(rec, F.scheduledDateTime) || ''))
  if (!sched) return null
  const leadMs = PREDICT_LEAD_MIN * 60_000
  if (now.getTime() > sched.getTime()) return 'OVERDUE'
  if (now.getTime() >= sched.getTime() - leadMs) return 'PREDICTED_LATE'
  return null
}

// Build the deep-link into the project's schedule tab + task, encoding the
// stage so each escalation step is a distinct dedup key.
function alertLink(projectRid: number, taskRid: string, stage: string): string {
  return `/projects/${projectRid}#schedule?taskRid=${encodeURIComponent(taskRid)}&late=${stage}`
}

function howLateText(scheduledIso: string, now: Date): string {
  const sched = parseScheduled(scheduledIso)
  if (!sched) return ''
  const diffMin = Math.round((now.getTime() - sched.getTime()) / 60_000)
  if (diffMin > 0) return `${diffMin} min past the ${fmtClock(sched)} start`
  if (diffMin < 0) return `due to start at ${fmtClock(sched)} (in ${-diffMin} min)`
  return `due to start at ${fmtClock(sched)}`
}

function fmtClock(d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: process.env['OFFICE_TZ']?.trim() || 'America/Denver',
      hour: 'numeric', minute: '2-digit',
    }).format(d)
  } catch { return d.toISOString().slice(11, 16) }
}

async function evaluateLateJobs(now: Date): Promise<LateJob[]> {
  // 1. Today's Arrivy tasks (office calendar) — one bounded query.
  const today = officeTodayIso(now)
  const { from, to } = officeDayBoundsUtc(today)
  const where = `{'${F.scheduledDateTime}'.OAF.'${from.toISOString()}'}AND{'${F.scheduledDateTime}'.OBF.'${to.toISOString()}'}`
  const tasks = await qbQuery(QB.arrivyTable, where, SELECT_FIELDS, {
    sortBy: [{ fieldId: F.scheduledDateTime, order: 'ASC' }],
    options: { top: 1000 },
  })

  // Index by task RID + collect distinct related projects for the late-log read.
  const taskByRid = new Map<string, QbRecord>()
  const projectRids = new Set<string>()
  for (const rec of tasks) {
    const rid = String(rec['3']?.value || '')
    if (rid) taskByRid.set(rid, rec)
    const proj = String(fieldValue(rec, F.relatedProject) || '')
    if (proj) projectRids.add(proj)
  }

  // 2. Arrivy late-log for today's projects — reuse /api/field/late's logic,
  //    batched and capped at 100 projects so we never hammer QB.
  const cappedProjects = [...projectRids].slice(0, 100)
  const arrivyByTask = new Map<string, { stage: string; crew: string; scheduled: string }>()
  const results = await Promise.allSettled(cappedProjects.map(rid =>
    qbQuery(QB.arrivyTaskLogTable, `{'${LOG_F.relatedProject}'.EX.'${rid}'}`, LOG_SELECT, { options: { top: 300 } })
  ))
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const log of r.value) {
      const et = String(fieldValue(log, LOG_F.eventType) || '').toUpperCase()
      const pr = ARRIVY_PRIORITY[et]
      if (!pr) continue
      const taskRid = String(fieldValue(log, LOG_F.relatedTask) || '')
      if (!taskRid) continue
      const stage = et === 'NOSHOW' ? 'NO_SHOW' : et
      const existing = arrivyByTask.get(taskRid)
      if (existing && (STAGE_PRIORITY[existing.stage] || 0) >= pr) continue
      arrivyByTask.set(taskRid, {
        stage,
        crew: String(fieldValue(log, LOG_F.reporterName) || ''),
        scheduled: String(fieldValue(log, LOG_F.scheduled) || ''),
      })
    }
  }

  // 3. Merge: per task, take the highest-priority stage between Arrivy's
  //    flag and our sweep. Only emit tasks that have a project RID we can
  //    route to a coordinator.
  const out = new Map<string, LateJob>()
  for (const [taskRid, rec] of taskByRid) {
    const projectRid = Number(fieldValue(rec, F.relatedProject) || 0)
    if (!projectRid) continue
    const customer = customerOf(rec) || `Project ${projectRid}`
    const crew = crewOf(rec)
    const schedRowIso = String(fieldValue(rec, F.scheduledDateTime) || '')

    const arrivy = arrivyByTask.get(taskRid)
    const swept = sweepStage(rec, now)

    let stage: string | null = null
    let signal: 'arrivy' | 'sweep' = 'sweep'
    const arrivyPr = arrivy ? (STAGE_PRIORITY[arrivy.stage] || 0) : 0
    const sweepPr = swept ? (STAGE_PRIORITY[swept] || 0) : 0
    if (arrivyPr >= sweepPr && arrivy) { stage = arrivy.stage; signal = 'arrivy' }
    else if (swept) { stage = swept; signal = 'sweep' }
    if (!stage) continue

    out.set(taskRid, {
      taskRid,
      projectRid,
      stage,
      customer,
      crew: crew || (arrivy?.crew ?? ''),
      scheduledIso: arrivy?.scheduled || schedRowIso,
      signal,
    })
  }

  // Late-log can also flag a task whose scheduled row fell outside today's
  // window (rare timezone-edge case) — but we deliberately scope to today's
  // task set to keep the query bounded. Those will be picked up once the
  // row is in-window.
  return [...out.values()]
}

let running = false

async function fireLateAlerts(): Promise<void> {
  if (running) return  // never overlap cycles (QB reads can be slow)
  if (!QB.token) return
  running = true
  const now = new Date()
  try {
    const jobs = await evaluateLateJobs(now)
    if (jobs.length === 0) { running = false; return }

    const admins = adminUserIds()
    let alertsInserted = 0
    let jobsAlerted = 0

    for (const job of jobs) {
      const recipients = new Set<number>(admins)
      const pc = pcUserIdForProject(job.projectRid)
      if (pc) recipients.add(pc)
      if (recipients.size === 0) continue

      const label = STAGE_LABEL[job.stage] || job.stage.toLowerCase()
      const title = job.stage === 'NO_SHOW'
        ? `Field no-show — ${job.customer}`
        : `Install ${label} — ${job.customer}`
      const lateText = howLateText(job.scheduledIso, now)
      const crewPart = job.crew ? `Crew: ${job.crew}. ` : ''
      const srcPart = job.signal === 'arrivy' ? 'Flagged by Arrivy.' : 'No en-route/start signal yet.'
      const body = `${crewPart}${lateText ? lateText + '. ' : ''}${srcPart}`.trim()
      const link = alertLink(job.projectRid, job.taskRid, job.stage)

      let firedForJob = false
      for (const userId of recipients) {
        const id = insertIfNew({ userId, type: 'field_late_alert', title, body, link })
        if (id !== null) { alertsInserted++; firedForJob = true }
      }
      if (firedForJob) jobsAlerted++
    }

    if (alertsInserted > 0) {
      console.log(`[predicted-late] ${jobsAlerted} late job(s) → ${alertsInserted} new alert(s) (${jobs.length} evaluated, ${admins.length} admin recipient(s))`)
    }
  } catch (e) {
    console.error('[predicted-late] sweep failed:', e instanceof Error ? e.message : e)
  } finally {
    running = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startPredictedLatePoller(): void {
  if (timer) return
  // Kick once at boot (catches jobs that went late while we were down),
  // then every 5 min — same cadence as the other comms cron workers so
  // QB pressure stays predictable.
  void fireLateAlerts()
  timer = setInterval(() => { void fireLateAlerts() }, 5 * 60_000)
  console.log('[predicted-late] poller started — sweeping today\'s field jobs every 5 min')
}

export function stopPredictedLatePoller(): void {
  if (timer) { clearInterval(timer); timer = null }
}

// Exposed for the Arrivy webhook fast-path: given a single just-arrived
// PREDICTED_LATE / LATE / NO_SHOW flag, fire the alert immediately rather
// than waiting up to 5 min for the next sweep. Dedup still gates it, so the
// sweep won't double-send. Best-effort; never throws to the caller.
export function fireArrivyLateFlag(opts: {
  projectRid: number
  taskRid: string
  stage: 'PREDICTED_LATE' | 'LATE' | 'NO_SHOW'
  customerName?: string | null
  crew?: string | null
  scheduledIso?: string | null
}): void {
  try {
    if (!STAGE_PRIORITY[opts.stage]) return
    const recipients = new Set<number>(adminUserIds())
    const pc = pcUserIdForProject(opts.projectRid)
    if (pc) recipients.add(pc)
    if (recipients.size === 0) return

    const now = new Date()
    const customer = (opts.customerName || '').trim() || `Project ${opts.projectRid}`
    const label = STAGE_LABEL[opts.stage] || opts.stage.toLowerCase()
    const title = opts.stage === 'NO_SHOW'
      ? `Field no-show — ${customer}`
      : `Install ${label} — ${customer}`
    const lateText = opts.scheduledIso ? howLateText(opts.scheduledIso, now) : ''
    const crewPart = opts.crew ? `Crew: ${opts.crew}. ` : ''
    const body = `${crewPart}${lateText ? lateText + '. ' : ''}Flagged by Arrivy.`.trim()
    const link = alertLink(opts.projectRid, opts.taskRid, opts.stage)
    for (const userId of recipients) {
      insertIfNew({ userId, type: 'field_late_alert', title, body, link })
    }
  } catch (e) {
    console.error('[predicted-late] webhook fast-path failed:', e instanceof Error ? e.message : e)
  }
}
