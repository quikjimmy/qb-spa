import { Router, type Request, type Response } from 'express'

// Battery Intake Monitoring — read/re-push over the QB "HVC Raw JSON"
// staging table (bvmute72r). Every battery deal sold in the Sunobi Battery
// Sizer lands as one row here; a Zapier/QuickBase pipeline stamps the intake
// outcome back onto it. This route surfaces those rows for the intake team and
// exposes a single idempotent "Re-push" write (set Send to Zap = Yes) so a
// stuck deal can be re-run without touching Zapier. See
// docs/BATTERY_INTAKE_MONITORING_GUIDE.md for the full contract.

const router = Router()

// QB config/headers — same per-route pattern as intake.ts (no shared client).
function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}
function qbHeaders(realm: string, token: string) {
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

const HVC_RAW_TABLE = 'bvmute72r'
const PROJECTS_TABLE = 'br9kwm8na'

// Field-id map for bvmute72r (guide §3/§9).
const HR = {
  dateCreated: 1,
  recordId: 3,
  rawJson: 6,
  proposalId: 8,
  sendToZap: 10,       // ← Re-push write target (boolean)
  sentToZapAt: 11,
  likelyTest: 14,
  testSignals: 15,
  intakeStatus: 16,
  intakeError: 17,
  intakeStep: 18,
  intakeMissing: 19,
  projectRecordId: 20,
  lastAttempt: 21,
  attemptCount: 22,
}
const SELECT = [
  HR.dateCreated, HR.recordId, HR.rawJson, HR.proposalId,
  HR.sendToZap, HR.sentToZapAt, HR.likelyTest, HR.testSignals,
  HR.intakeStatus, HR.intakeError, HR.intakeStep, HR.intakeMissing,
  HR.projectRecordId, HR.lastAttempt, HR.attemptCount,
]

// A deal is "stuck" (needs a human) when the last intake attempt landed in one
// of these states. Blank status = not processed yet, NOT stuck. Kept in sync
// with the client's STUCK set in BatteryIntakeView.vue.
export const STUCK_STATUSES = new Set(['error', 'incomplete', 'manual_review', 'bad_payload'])
export function isStuckStatus(s: string): boolean { return STUCK_STATUSES.has(s) }

const TTL_MS = 60_000
type QbRecord = Record<string, { value: unknown }>
let cache: { rows: QbRecord[]; fetchedAt: string; expiresAt: number } | null = null

function val(record: QbRecord, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}
function isTruthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return /^(true|1|yes)$/i.test(String(v ?? '').trim())
}
// QB returns numeric fids as floats (e.g. 10972.0, 2.0); coerce → int or null.
function intOrNull(record: QbRecord, fid: number): number | null {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined || v === '') return null
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? n : null
}

// Parse the Sunobi deal JSON (fid 6) for the fields worth showing. Defensive:
// any shape mismatch degrades to empty/null rather than throwing, so one bad
// payload can't break the whole list.
interface DealSummary {
  customer_name: string
  customer_address: string
  battery: string
  price: number | null
  rep: string
  source: string
}
function parseDeal(raw: string): DealSummary {
  const empty: DealSummary = { customer_name: '', customer_address: '', battery: '', price: null, rep: '', source: '' }
  if (!raw) return empty
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) as Record<string, unknown> } catch { return empty }
  const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
  const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

  const customer = asObj(obj['customer'])
  const name = str(customer['name']).trim()
    || `${str(customer['firstName'])} ${str(customer['lastName'])}`.trim()

  let address = str(customer['installAddress']).trim()
  if (!address) {
    const a = asObj(customer['installAddr'])
    address = [a['street'], a['unit'], a['city'], a['state'], a['zip']]
      .map(str).map(s => s.trim()).filter(Boolean).join(', ')
  }

  const system = asObj(obj['system'])
  const financing = asObj(obj['financing'])
  const brand = str(system['batteryBrand']).trim()
  const model = str(system['batteryName']).trim()
  const qtyRaw = system['batteryQty']
  const qty = Number(qtyRaw)
  const battery = [brand, model].filter(Boolean).join(' ')
    + (Number.isFinite(qty) && qty > 1 ? ` ×${qty}` : '')

  const priceRaw = financing['customerPrice'] ?? system['customerPrice']
  const priceNum = Number(priceRaw)
  const price = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null

  return {
    customer_name: name,
    customer_address: address,
    battery: battery.trim(),
    price,
    rep: str(asObj(obj['rep'])['name']).trim(),
    source: str(obj['source']).trim(),
  }
}

export function normalizeRow(record: QbRecord, realm: string) {
  const recordId = intOrNull(record, HR.recordId) ?? 0
  const projectRecordId = intOrNull(record, HR.projectRecordId)
  const deal = parseDeal(val(record, HR.rawJson))
  return {
    record_id: recordId,
    proposal_id: val(record, HR.proposalId),
    date_created: val(record, HR.dateCreated),
    intake_status: val(record, HR.intakeStatus),
    intake_error: val(record, HR.intakeError),
    intake_step: val(record, HR.intakeStep),
    intake_missing: val(record, HR.intakeMissing),
    project_record_id: projectRecordId,
    last_attempt: val(record, HR.lastAttempt),
    attempt_count: intOrNull(record, HR.attemptCount) ?? 0,
    send_to_zap: isTruthy(record[String(HR.sendToZap)]?.value),
    sent_to_zap_at: val(record, HR.sentToZapAt),
    likely_test: isTruthy(record[String(HR.likelyTest)]?.value),
    test_signals: val(record, HR.testSignals),
    customer_name: deal.customer_name,
    customer_address: deal.customer_address,
    battery: deal.battery,
    price: deal.price,
    rep: deal.rep,
    source: deal.source,
    qb_url: `https://${realm}/db/${HVC_RAW_TABLE}?a=dr&rid=${recordId}`,
    project_url: projectRecordId
      ? `https://${realm}/db/${PROJECTS_TABLE}?a=dr&rid=${projectRecordId}`
      : '',
  }
}

async function fetchRows(force = false): Promise<{ rows: QbRecord[]; fetchedAt: string }> {
  if (!force && cache && cache.expiresAt > Date.now()) {
    return { rows: cache.rows, fetchedAt: cache.fetchedAt }
  }
  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const all: QbRecord[] = []
  let skip = 0
  const top = 1000
  while (true) {
    const response = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        from: HVC_RAW_TABLE,
        select: SELECT,
        sortBy: [{ fieldId: HR.dateCreated, order: 'DESC' }],
        options: { skip, top },
      }),
    })
    if (!response.ok) {
      throw new Error(`QB HVC query failed (${response.status}): ${(await response.text()).slice(0, 200)}`)
    }
    const data = await response.json() as { data?: QbRecord[] }
    const rows = data.data || []
    all.push(...rows)
    if (rows.length < top || all.length >= 5000) break
    skip += top
  }

  const fetchedAt = new Date().toISOString()
  cache = { rows: all, fetchedAt, expiresAt: Date.now() + TTL_MS }
  return { rows: all, fetchedAt }
}

export type BatteryDeal = ReturnType<typeof normalizeRow>

// Normalized list of every battery deal — shared by the route and the
// stuck-deal notifier so both read the table exactly the same way.
export async function fetchBatteryDeals(force = false): Promise<BatteryDeal[]> {
  const { realm } = getQbConfig()
  const { rows } = await fetchRows(force)
  return rows.map(r => normalizeRow(r, realm))
}

// GET /api/battery-intake — full normalized list, newest first.
// ?fresh=1 bypasses the 60s cache. Client buckets into Stuck/Queued/Tests/All.
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { realm } = getQbConfig()
    const { rows, fetchedAt } = await fetchRows(req.query['fresh'] === '1')
    const items = rows.map(r => normalizeRow(r, realm))
    res.json({ items, count: items.length, as_of: fetchedAt })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// POST /api/battery-intake/:id/repush — set Send to Zap (fid 10) = true on the
// row, merging on Record ID (fid 3). Idempotent & loop-safe by design
// (guide §5): the pipeline only fires on Send-to-Zap *changing* to Yes and
// intake unsets it when done. Verifies the row exists first so a bad id can't
// create a phantom record.
router.post('/:id/repush', async (req: Request, res: Response): Promise<void> => {
  const recordId = parseInt(String(req.params['id'] || ''), 10)
  if (!Number.isFinite(recordId) || recordId <= 0) {
    res.status(400).json({ error: 'Valid record id is required' })
    return
  }
  try {
    const { realm, token } = getQbConfig()
    if (!token) throw new Error('QB_USER_TOKEN not configured')

    const current = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        from: HVC_RAW_TABLE,
        select: [HR.recordId],
        where: `{'${HR.recordId}'.EX.'${recordId}'}`,
        options: { top: 1 },
      }),
    })
    if (!current.ok) {
      throw new Error(`QB HVC lookup failed (${current.status}): ${(await current.text()).slice(0, 200)}`)
    }
    const currentJson = await current.json() as { data?: QbRecord[] }
    if (!currentJson.data?.[0]) {
      res.status(404).json({ error: `Battery deal ${recordId} not found` })
      return
    }

    const response = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        to: HVC_RAW_TABLE,
        mergeFieldId: HR.recordId,
        data: [{
          [String(HR.recordId)]: { value: recordId },
          [String(HR.sendToZap)]: { value: true },
        }],
        fieldsToReturn: [HR.recordId, HR.sendToZap, HR.attemptCount],
      }),
    })
    const qbJson = await response.json()
    if (!response.ok) {
      res.status(response.status).json({ error: 'QB re-push update failed', details: qbJson })
      return
    }

    cache = null // force a live re-read on the next GET so the row updates
    res.json({ ok: true, record_id: recordId, qb: qbJson })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

export { router as batteryIntakeRouter }
