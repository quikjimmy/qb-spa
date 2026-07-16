// Site Survey — "floating" Arrivy tasks. Surfaces field tasks that aren't
// anchored to a QB project:
//   (a) tasks on signed-but-unsubmitted Enerflo deals (Integrations app),
//       joined by the Enerflo V2 deal ID both tables share
//   (b) tasks with no project and no matched unsubmitted deal
//
// Two live QB queries + a JS join. Volumes are small (verified 2026-07:
// ~183 unsubmitted deals with deal IDs, ~83 project-less tasks), so no
// SQLite cache — just a 60s in-memory TTL with in-flight dedupe.
import { Router, type Request, type Response } from 'express'
import db from '../db'
import { F, QB, qbQuery, chunk, fieldValue, presetOfficeRange, type QbRecord } from './field'
import { classifyArrivyStatus, deriveArrivyTaskType, joinArrivyCustomerName } from '../lib/arrivyTask'
import { getDealProgress } from '../lib/enerflo'
import { officeTodayIso, officeDayBoundsUtc, addDaysIso } from '../lib/officeTime'

const router = Router()

// ─── Enerflo data table (Integrations app bscp8ubd6) ─────
// Holds every deal pushed from Enerflo; once a deal is submitted it also
// gets a Projects-table record. "Signed not Submitted" (148) is the
// QB-computed flag for deals that signed but never made it to Projects.
const ENERFLO_TABLE = 'bscp8usde'
const EF = {
  recordId: 3,
  dealId: 144,              // enerflo_deal_id — v2 UUID; blank on stale 2023-era rows
  signedNotSubmitted: 148,
  override: 164,            // verified 2026-07-15: 148 does NOT fold this in — must filter separately
  isTest: 154,
  custFullName: 138,
  custFirst: 111,
  custLast: 112,
  custState: 14,
  systemSize: 34,
  lenderName: 50,
  epcName: 85,
  signedAt: 128,            // Signed - Date/Time
  dealUrl: 153,
  installUrl: 152,
  // Bump-out context: who to press on (closer) + where the deal lives.
  agentFirst: 76,
  agentLast: 77,
  agentEmail: 117,
  agentPhone: 122,
  salesOffice: 83,
  custPhone: 113,
  custEmail: 6,
  custAddress: 11,
  custCity: 13,
}
const EF_SELECT = [EF.recordId, EF.dealId, EF.custFullName, EF.custFirst, EF.custLast, EF.custState, EF.systemSize, EF.lenderName, EF.epcName, EF.signedAt, EF.dealUrl, EF.installUrl, EF.agentFirst, EF.agentLast, EF.agentEmail, EF.agentPhone, EF.salesOffice, EF.custPhone, EF.custEmail, EF.custAddress, EF.custCity]

// Official: Enerflo V2 Deal ID on the Arrivy table. Its formula falls back
// to the task's own record id (a plain integer) when no real deal ID is
// set, so only UUID-shaped values count as deal references.
const ARRIVY_DEAL_ID = 61
const ARRIVY_SELECT = [3, ARRIVY_DEAL_ID, F.templateName, F.scheduledDateTime, F.customerFirstName, F.customerLastName, F.taskStatus, F.taskUrl, F.submittedDateTime, F.enrouteStatus, F.startedStatus]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// fid 144 occasionally holds TWO comma-joined UUIDs (duplicate Enerflo
// submissions) — take the first well-formed one.
function firstUuid(raw: unknown): string {
  const m = String(raw || '').toLowerCase().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  return m ? m[0] : ''
}
// Arrivy has no is-test flag; known pollution: "Test Test", "Tester
// McTesterson", "Test Customer", "Propel Test1".
const TEST_NAME_RE = /\btest(er)?\b|test\d/i
// Unassigned tasks scheduled further back than this are de-emphasized
// (default-hidden client-side), not dropped.
const STALE_DAYS = 90

const TTL_MS = 60_000

interface FloatingTask {
  arrivy_record_id: string
  enerflo_deal_id: string   // '' when fid 61 held the non-UUID fallback
  template_name: string
  task_type_key: string
  task_type_label: string
  customer_name: string
  scheduled_at: string
  status: string
  status_label: string
  task_url: string
  submitted_at: string
  // Raw progression signals so the client can render the same
  // ER/OS/SUB/APPR chip rail as the Field-window cards.
  enroute_at: string
  started_at: string
  arrivy_complete: boolean
  is_probable_test: boolean
  is_stale: boolean
}

interface FloatingDeal {
  enerflo_deal_id: string
  qb_record_id: number
  customer_name: string
  state: string
  system_size_kw: number
  lender_name: string
  epc_name: string
  signed_at: string
  deal_url: string
  install_url: string
  closer_name: string
  closer_email: string
  closer_phone: string
  sales_office: string
  cust_phone: string
  cust_email: string
  cust_address: string
  // Enerflo's Is Test flag misses name-only test data ("Propel Test1"),
  // so deals get the same name heuristic as unassigned tasks.
  is_probable_test: boolean
  tasks: FloatingTask[]
}

interface FloatingResponse {
  deals: FloatingDeal[]
  zeroTaskDeals: FloatingDeal[]
  unassignedTasks: FloatingTask[]
  kpi: {
    dealsWithTasks: number
    tasksOnDeals: number
    unassignedTasks: number
    floatingSurveys: number
    zeroTaskDeals: number
  }
  fetchedAt: string
}

function urlValue(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'url' in (raw as Record<string, unknown>)) {
    return String((raw as Record<string, unknown>)['url'] || '')
  }
  return String(raw || '')
}

function shapeDeal(rec: QbRecord): FloatingDeal {
  const first = String(fieldValue(rec, EF.custFirst) || '').trim()
  const last = String(fieldValue(rec, EF.custLast) || '').trim()
  const customer = String(fieldValue(rec, EF.custFullName) || '').trim() || [first, last].filter(Boolean).join(' ')
  return {
    enerflo_deal_id: firstUuid(fieldValue(rec, EF.dealId)),
    qb_record_id: Number(fieldValue(rec, EF.recordId)) || 0,
    customer_name: customer,
    is_probable_test: TEST_NAME_RE.test(customer),
    state: String(fieldValue(rec, EF.custState) || '').trim(),
    system_size_kw: Number(fieldValue(rec, EF.systemSize)) || 0,
    lender_name: String(fieldValue(rec, EF.lenderName) || '').trim(),
    epc_name: String(fieldValue(rec, EF.epcName) || '').trim(),
    signed_at: String(fieldValue(rec, EF.signedAt) || ''),
    deal_url: urlValue(fieldValue(rec, EF.dealUrl)),
    install_url: urlValue(fieldValue(rec, EF.installUrl)),
    closer_name: [String(fieldValue(rec, EF.agentFirst) || '').trim(), String(fieldValue(rec, EF.agentLast) || '').trim()].filter(Boolean).join(' '),
    closer_email: String(fieldValue(rec, EF.agentEmail) || '').trim(),
    closer_phone: String(fieldValue(rec, EF.agentPhone) || '').trim(),
    sales_office: String(fieldValue(rec, EF.salesOffice) || '').trim(),
    cust_phone: String(fieldValue(rec, EF.custPhone) || '').trim(),
    cust_email: String(fieldValue(rec, EF.custEmail) || '').trim(),
    cust_address: [String(fieldValue(rec, EF.custAddress) || '').trim(), String(fieldValue(rec, EF.custCity) || '').trim(), String(fieldValue(rec, EF.custState) || '').trim()].filter(Boolean).join(', '),
    tasks: [],
  }
}

function shapeTask(rec: QbRecord, staleCutoffIso: string): FloatingTask {
  const template = String(fieldValue(rec, F.templateName) || '').trim()
  const tt = deriveArrivyTaskType(template)
  const c = classifyArrivyStatus(rec)
  const rawDealId = firstUuid(fieldValue(rec, ARRIVY_DEAL_ID))
  const scheduledAt = String(fieldValue(rec, F.scheduledDateTime) || '')
  const customer = joinArrivyCustomerName(rec)
  return {
    arrivy_record_id: String(fieldValue(rec, 3) || ''),
    enerflo_deal_id: UUID_RE.test(rawDealId) ? rawDealId : '',
    template_name: template,
    task_type_key: tt.key,
    task_type_label: tt.label,
    customer_name: customer,
    scheduled_at: scheduledAt,
    status: c.status,
    status_label: c.label,
    task_url: urlValue(fieldValue(rec, F.taskUrl)),
    submitted_at: String(fieldValue(rec, F.submittedDateTime) || ''),
    enroute_at: String(fieldValue(rec, F.enrouteStatus) || ''),
    started_at: String(fieldValue(rec, F.startedStatus) || ''),
    arrivy_complete: /\bcomplete\b/i.test(String(fieldValue(rec, F.taskStatus) || '')),
    is_probable_test: TEST_NAME_RE.test(customer),
    is_stale: !!scheduledAt && scheduledAt.slice(0, 10) < staleCutoffIso,
  }
}

// Surveys first, then scheduled ascending, unscheduled last.
function taskSort(a: FloatingTask, b: FloatingTask): number {
  const aSurvey = a.task_type_key === 'survey' ? 0 : 1
  const bSurvey = b.task_type_key === 'survey' ? 0 : 1
  if (aSurvey !== bSurvey) return aSurvey - bSurvey
  if (!a.scheduled_at && !b.scheduled_at) return 0
  if (!a.scheduled_at) return 1
  if (!b.scheduled_at) return -1
  return a.scheduled_at.localeCompare(b.scheduled_at)
}

// Signed-date floor: fid 148 is a QB formula, so QB evaluates it across
// the whole Enerflo table (every deal since 2023) — that's what blew the
// prod 503 "Operation took too long". The cheap scalar date predicate
// lets QB prune the ancient rows first. Every signed-not-submitted deal
// with a v2 deal ID is 2024+ (verified 2026-07-15), so nothing real is
// dropped.
const SIGNED_FLOOR = '2024-01-01'

// QB intermittently 503s on heavy formula queries — retry with backoff
// before giving up.
async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      if (i < attempts - 1 && /503|timeout|took too long/i.test(msg)) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

async function buildFloating(): Promise<FloatingResponse> {
  // The fid-144 guard is mandatory: without it the flag matches ~1,026
  // rows, mostly stale 2023-era records with no v2 deal ID.
  const dealWhere = `{${EF.signedNotSubmitted}.EX.true}AND{${EF.override}.EX.false}AND{${EF.isTest}.EX.false}AND{${EF.dealId}.XEX.''}AND{${EF.signedAt}.OAF.'${SIGNED_FLOOR}'}`
  const taskWhere = `{${F.relatedProject}.EX.''}`
  const [dealRecs, taskRecs] = await Promise.all([
    qbQuery(ENERFLO_TABLE, dealWhere, EF_SELECT),
    qbQuery(QB.arrivyTable, taskWhere, ARRIVY_SELECT),
  ])
  if (dealRecs.length === 1000 || taskRecs.length === 1000) {
    console.warn(`[survey-tasks] hit 1000-row page cap (deals=${dealRecs.length}, tasks=${taskRecs.length}) — add pagination`)
  }

  // Dedupe deals by deal ID — duplicate submissions exist (QB fids 145/146
  // track them). Keep latest signed, tie-break highest record id.
  const dealById = new Map<string, FloatingDeal>()
  for (const rec of dealRecs) {
    const deal = shapeDeal(rec)
    if (!deal.enerflo_deal_id) continue
    const existing = dealById.get(deal.enerflo_deal_id)
    if (!existing
      || deal.signed_at > existing.signed_at
      || (deal.signed_at === existing.signed_at && deal.qb_record_id > existing.qb_record_id)) {
      dealById.set(deal.enerflo_deal_id, deal)
    }
  }

  const staleCutoffIso = addDaysIso(officeTodayIso(), -STALE_DAYS)
  const unassigned: FloatingTask[] = []
  for (const rec of taskRecs) {
    const task = shapeTask(rec, staleCutoffIso)
    const deal = task.enerflo_deal_id ? dealById.get(task.enerflo_deal_id) : undefined
    if (deal) deal.tasks.push(task)
    else unassigned.push(task)
  }

  const withTasks: FloatingDeal[] = []
  const zeroTask: FloatingDeal[] = []
  for (const deal of dealById.values()) {
    if (deal.tasks.length) { deal.tasks.sort(taskSort); withTasks.push(deal) }
    else zeroTask.push(deal)
  }
  withTasks.sort((a, b) => a.signed_at.localeCompare(b.signed_at))          // longest-floating first
  zeroTask.sort((a, b) => b.signed_at.localeCompare(a.signed_at))           // newest first — old ones are noise
  unassigned.sort(taskSort)

  // KPI counts reflect the default-visible set: test/stale rows are hidden
  // until toggled, so they don't inflate the tiles.
  const visibleDeals = withTasks.filter(d => !d.is_probable_test)
  const visibleUnassigned = unassigned.filter(t => !t.is_probable_test && !t.is_stale)
  const tasksOnDeals = visibleDeals.reduce((n, d) => n + d.tasks.length, 0)
  const floatingSurveys =
    visibleDeals.reduce((n, d) => n + d.tasks.filter(t => t.task_type_key === 'survey').length, 0)
    + visibleUnassigned.filter(t => t.task_type_key === 'survey').length

  return {
    deals: withTasks,
    zeroTaskDeals: zeroTask,
    unassignedTasks: unassigned,
    kpi: {
      dealsWithTasks: visibleDeals.length,
      tasksOnDeals,
      unassignedTasks: visibleUnassigned.length,
      floatingSurveys,
      zeroTaskDeals: zeroTask.length,
    },
    fetchedAt: new Date().toISOString(),
  }
}

let cache: { data: FloatingResponse; at: number } | null = null
let inFlight: Promise<FloatingResponse> | null = null

async function getFloating(forceRefresh: boolean): Promise<FloatingResponse> {
  if (!forceRefresh && cache && Date.now() - cache.at < TTL_MS) return cache.data
  if (!inFlight) {
    inFlight = withRetry(buildFloating, 2)
      .then(data => { cache = { data, at: Date.now() }; return data })
      .finally(() => { inFlight = null })
  }
  // Stale-while-revalidate: any cached copy is served immediately while
  // the refresh lands in the background — users never wait on QB.
  if (!forceRefresh && cache) {
    inFlight.catch(e => console.warn('[survey-tasks] background refresh failed:', e))
    return cache.data
  }
  try {
    return await inFlight
  } catch (e) {
    if (cache) {
      console.warn('[survey-tasks] QB fetch failed — serving stale cache:', e)
      return cache.data
    }
    throw e
  }
}

// Warm the cache shortly after boot so the first visitor never eats the
// cold QB query (which can run long enough to 503 under load).
setTimeout(() => { getFloating(false).catch(e => console.warn('[survey-tasks] boot warm failed:', e)) }, 5_000)

// ─── Survey tasks in a date window ─────
// Server-side variant of /api/field/tasks scoped to survey templates,
// with cancel detection from the Arrivy task log and project meta
// (state / lender / EPC) joined from project_cache so the client can
// run the standard milestone filters.

const WINDOW_SELECT = [3, F.templateName, F.scheduledDateTime, F.customerFirstName, F.customerLastName, F.taskStatus, F.taskUrl, F.submittedDateTime, F.enrouteStatus, F.startedStatus, F.relatedProject, F.kw, F.crew, F.assignedCrew, F.enrouteName]
// Arrivy task log fields (table bvbbznmdb) — same ids field.ts uses.
const LOG = { relatedTask: 94, eventType: 76, statusSubType: 77, timestamp: 79 }

// Crew cells come back as arrays of user objects or {name,email} shapes.
function crewStr(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (Array.isArray(raw)) {
    return raw.map(item => {
      if (item && typeof item === 'object') {
        const o = item as { name?: unknown; email?: unknown }
        return String(o.name || o.email || '')
      }
      return item ? String(item) : ''
    }).filter(Boolean).join(', ')
  }
  if (typeof raw === 'object') {
    const o = raw as { name?: unknown; email?: unknown }
    return String(o.name || o.email || '')
  }
  return String(raw)
}

interface WindowTask {
  arrivy_record_id: string
  project_rid: string
  customer_name: string
  template_name: string
  scheduled_at: string
  submitted_at: string
  enroute_at: string
  started_at: string
  arrivy_complete: boolean
  status: string
  status_label: string
  task_url: string
  crew: string
  kw: number
  state: string
  lender: string
  epc: string
}

// GET /api/survey-tasks/window?preset=today  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/window', async (req: Request, res: Response) => {
  try {
    const fromParam = String(req.query['from'] || '')
    const toParam = String(req.query['to'] || '')
    const preset = String(req.query['preset'] || 'today')
    const custom = /^\d{4}-\d{2}-\d{2}$/.test(fromParam) && /^\d{4}-\d{2}-\d{2}$/.test(toParam)
    const { fromDate, toDate } = custom ? { fromDate: fromParam, toDate: toParam } : presetOfficeRange(preset)
    const fromStr = officeDayBoundsUtc(fromDate).from.toISOString()
    const toStr = officeDayBoundsUtc(toDate).to.toISOString()

    const [taskRecs, logRecs] = await Promise.all([
      qbQuery(QB.arrivyTable,
        `{${F.scheduledDateTime}.OAF.'${fromStr}'}AND{${F.scheduledDateTime}.OBF.'${toStr}'}`,
        WINDOW_SELECT,
        { sortBy: [{ fieldId: F.scheduledDateTime, order: 'DESC' }] }),
      qbQuery(QB.arrivyTaskLogTable,
        `{${LOG.timestamp}.OAF.'${fromStr}'}AND{${LOG.timestamp}.OBF.'${toStr}'}AND{${LOG.eventType}.EX.'TASK_STATUS'}`,
        [3, LOG.relatedTask, LOG.statusSubType]).catch(() => [] as QbRecord[]),
    ])

    // Task-log cancels — the task row's status often doesn't update when
    // an in-flight task is cancelled (same rule as /api/field/tasks).
    const cancelledRids = new Set<string>()
    for (const log of logRecs) {
      const sub = String(fieldValue(log, LOG.statusSubType) || '')
      if (/cancel|exception|notdone|not\s*done/i.test(sub)) {
        const rid = String(fieldValue(log, LOG.relatedTask) || '')
        if (rid) cancelledRids.add(rid)
      }
    }

    const surveys = taskRecs.filter(rec => {
      const tpl = String(fieldValue(rec, F.templateName) || '').toLowerCase()
      return tpl.includes('survey') || tpl.includes('site visit')
    })

    // Project meta for the standard filters.
    const rids = [...new Set(surveys.map(r => String(fieldValue(r, F.relatedProject) || '')).filter(Boolean))]
    const meta = new Map<string, { state: string; lender: string; epc: string; system_size_kw: number; customer_name: string }>()
    for (const ids of chunk(rids, 500)) {
      if (!ids.length) continue
      const rows = db.prepare(
        `SELECT record_id, state, lender, epc, system_size_kw, customer_name FROM project_cache WHERE record_id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids) as Array<{ record_id: number | string; state: string | null; lender: string | null; epc: string | null; system_size_kw: number | null; customer_name: string | null }>
      for (const r of rows) meta.set(String(r.record_id), { state: r.state || '', lender: r.lender || '', epc: r.epc || '', system_size_kw: r.system_size_kw || 0, customer_name: r.customer_name || '' })
    }

    const tasks: WindowTask[] = surveys.map(rec => {
      const rid = String(fieldValue(rec, 3) || '')
      const projectRid = String(fieldValue(rec, F.relatedProject) || '')
      const m = projectRid ? meta.get(projectRid) : undefined
      const cancelled = cancelledRids.has(rid)
      const c = cancelled ? { status: 'cancelled', label: 'Cancelled' } : classifyArrivyStatus(rec)
      return {
        arrivy_record_id: rid,
        project_rid: projectRid,
        customer_name: joinArrivyCustomerName(rec) || m?.customer_name || '',
        template_name: String(fieldValue(rec, F.templateName) || '').trim(),
        scheduled_at: String(fieldValue(rec, F.scheduledDateTime) || ''),
        submitted_at: String(fieldValue(rec, F.submittedDateTime) || ''),
        enroute_at: String(fieldValue(rec, F.enrouteStatus) || ''),
        started_at: String(fieldValue(rec, F.startedStatus) || ''),
        arrivy_complete: /\bcomplete\b/i.test(String(fieldValue(rec, F.taskStatus) || '')),
        status: c.status,
        status_label: c.label,
        task_url: urlValue(fieldValue(rec, F.taskUrl)),
        crew: crewStr(fieldValue(rec, F.crew)) || crewStr(fieldValue(rec, F.assignedCrew)) || crewStr(fieldValue(rec, F.enrouteName)),
        kw: parseFloat(String(fieldValue(rec, F.kw) || '0')) || m?.system_size_kw || 0,
        state: m?.state || '',
        lender: m?.lender || '',
        epc: m?.epc || '',
      }
    })

    res.json({ preset: custom ? 'custom' : preset, from: fromDate, to: toDate, tasks })
  } catch (e) {
    console.error('[survey-tasks] window failed:', e)
    res.status(502).json({ error: e instanceof Error ? e.message : 'QuickBase query failed' })
  }
})

// GET /api/survey-tasks/deal-progress?deal_id=<enerflo v2 uuid>
// Live Enerflo GraphQL — where the customer is in the deal flow
// (Title Check / Consumption / ... / Project Submission).
router.get('/deal-progress', async (req: Request, res: Response) => {
  const dealId = String(req.query['deal_id'] || '').trim()
  if (!dealId) { res.status(400).json({ error: 'deal_id required' }); return }
  res.json(await getDealProgress(dealId))
})

// GET /api/survey-tasks/floating?refresh=1
router.get('/floating', async (req: Request, res: Response) => {
  try {
    const data = await getFloating(req.query['refresh'] === '1')
    res.json(data)
  } catch (e) {
    console.error('[survey-tasks] floating failed:', e)
    res.status(502).json({ error: e instanceof Error ? e.message : 'QuickBase query failed' })
  }
})

export { router as surveyTasksRouter }
