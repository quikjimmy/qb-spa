const QB_PROJECTS_TABLE = 'br9kwm8na'
const QB_API = 'https://api.quickbase.com/v1/records/query'

const ACTIVE_FILTER = '{255.EX.Active}'
const PROJECT_COORDINATOR_EMAIL_FID = 822

interface QbField {
  value?: unknown
}

interface QbRecord {
  [fid: string]: QbField | undefined
}

interface QueryDefinition {
  label: string
  where: string
  select: number[]
  sortFid?: number
}

interface QueryResult {
  label: string
  records: QbRecord[]
  count: number
  error: string | null
}

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

function val(record: QbRecord, fid: number): string {
  const raw = record[String(fid)]?.value
  if (raw === null || raw === undefined) return ''
  if (Array.isArray(raw)) return raw.map(v => String(v)).join(', ')
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (obj['name']) return String(obj['name'])
    if (obj['email']) return String(obj['email'])
  }
  return String(raw)
}

function num(record: QbRecord, fid: number): number {
  const n = Number(val(record, fid))
  return Number.isFinite(n) ? n : 0
}

function daysSince(raw: string): number | null {
  if (!raw) return null
  const ms = new Date(raw).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
}

async function qbQuery(query: QueryDefinition): Promise<QueryResult> {
  const { realm, token } = getQbConfig()
  if (!token) {
    return { label: query.label, records: [], count: 0, error: 'QB_USER_TOKEN not configured on server' }
  }

  const body: Record<string, unknown> = {
    from: QB_PROJECTS_TABLE,
    select: query.select,
    where: query.where,
    options: { top: 200 },
  }
  if (query.sortFid) body['sortBy'] = [{ fieldId: query.sortFid, order: 'ASC' }]

  try {
    const res = await fetch(QB_API, {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify(body),
    })
    const data = await res.json() as { data?: QbRecord[]; metadata?: { totalRecords?: number }; message?: string; error?: string }
    if (!res.ok) {
      return { label: query.label, records: [], count: 0, error: data.message || data.error || `Quickbase error ${res.status}` }
    }
    return {
      label: query.label,
      records: data.data || [],
      count: Number(data.metadata?.totalRecords || data.data?.length || 0),
      error: null,
    }
  } catch (err) {
    return { label: query.label, records: [], count: 0, error: String(err) }
  }
}

function stateClause(stateFilter?: string): string {
  return stateFilter ? `AND{189.EX.${stateFilter}}` : ''
}

function coordinatorClause(coordinator: string, coordinatorEmail?: string): string {
  const identity = (coordinatorEmail || coordinator).replace(/[{}]/g, '').trim()
  const safe = identity
  return safe ? `{${PROJECT_COORDINATOR_EMAIL_FID}.CT.${safe}}` : `{${PROJECT_COORDINATOR_EMAIL_FID}.XEX.}`
}

function queryDefinitions(coordinator: string, stateFilter?: string, inspectionDays?: number, coordinatorEmail?: string): QueryDefinition[] {
  const state = stateClause(stateFilter)
  const coordinatorFilter = coordinatorClause(coordinator, coordinatorEmail)
  const inspFloor = inspectionDays
    ? new Date(Date.now() - inspectionDays * 86_400_000).toISOString().slice(0, 10)
    : ''
  const inspClause = inspFloor ? `AND{491.OAF.${inspFloor}}` : ''

  return [
    {
      label: 'todays_installs',
      where: `${coordinatorFilter}AND{178.IR.today}AND${ACTIVE_FILTER}${state}`,
      select: [3, 6, 13, 178, 207, 208, 344, 534, 189],
      sortFid: 178,
    },
    {
      label: 'tomorrows_installs',
      where: `${coordinatorFilter}AND{178.IR.tomorrow}AND${ACTIVE_FILTER}${state}`,
      select: [3, 6, 13, 178, 207, 208, 344, 534, 189],
      sortFid: 178,
    },
    {
      label: 'stuck_permits',
      where: `${coordinatorFilter}AND{207.XEX.}AND{208.EX.}AND${ACTIVE_FILTER}${state}`,
      select: [3, 6, 13, 189, 207, 318],
      sortFid: 207,
    },
    {
      label: 'ic_no_inspection',
      where: `${coordinatorFilter}AND{534.XEX.}AND{491.EX.}AND{534.OAF.${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}}AND${ACTIVE_FILTER}${state}`,
      select: [3, 6, 13, 534, 344, 189],
      sortFid: 534,
    },
    {
      label: 'inspection_no_pto',
      where: `${coordinatorFilter}AND{491.XEX.}AND{538.EX.}AND${ACTIVE_FILTER}${state}${inspClause}`,
      select: [3, 6, 13, 491, 344, 189],
      sortFid: 491,
    },
  ]
}

export async function buildLivePcMorningBriefingPayload(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const stateFilter = options['state_filter'] ? String(options['state_filter']) : undefined
  const inspectionDays = options['inspection_days'] ? Number(options['inspection_days']) : undefined
  const coordinator = String(options['coordinator'] || 'Paige Elkins')
  const coordinatorEmail = options['coordinator_email'] ? String(options['coordinator_email']).trim().toLowerCase() : undefined
  const queries = queryDefinitions(coordinator, stateFilter, inspectionDays, coordinatorEmail)
  const results = await Promise.all(queries.map(qbQuery))
  const byLabel = new Map(results.map(result => [result.label, result]))

  const todaysInstalls = byLabel.get('todays_installs')?.records || []
  const tomorrowsInstalls = byLabel.get('tomorrows_installs')?.records || []
  const stuckPermits = byLabel.get('stuck_permits')?.records || []
  const icNoInspection = byLabel.get('ic_no_inspection')?.records || []
  const inspectionNoPto = byLabel.get('inspection_no_pto')?.records || []

  const installs = todaysInstalls.map(record => {
    const permitApproved = val(record, 208)
    const permitSubmitted = val(record, 207)
    const pendingDays = permitSubmitted ? daysSince(permitSubmitted) : null
    return {
      rid: val(record, 3),
      customer_name: val(record, 6),
      location: val(record, 189) || 'Location TBD',
      lender: val(record, 344) || 'Lender TBD',
      permit_status: permitApproved
        ? `Permit approved ${permitApproved}`
        : permitSubmitted
          ? `NO PERMIT - submitted ${permitSubmitted}${pendingDays !== null ? `, ${pendingDays}d pending` : ''}`
          : 'Permit status unknown',
      system_kw: num(record, 13),
    }
  })

  const attentionItems = [
    ...stuckPermits.map(record => ({
      rid: val(record, 3),
      project_name: val(record, 6),
      issue: `Permit pending${daysSince(val(record, 207)) !== null ? ` ${daysSince(val(record, 207))} days` : ''}`,
      context: `Submitted ${val(record, 207) || 'date unknown'}${val(record, 318) ? `; AHJ ${val(record, 318)}` : ''}.`,
      system_kw: num(record, 13),
    })),
    ...icNoInspection.map(record => ({
      rid: val(record, 3),
      project_name: val(record, 6),
      issue: `Install complete, no inspection${daysSince(val(record, 534)) !== null ? ` after ${daysSince(val(record, 534))} days` : ''}`,
      context: `Install completed ${val(record, 534) || 'date unknown'}; lender ${val(record, 344) || 'unknown'}.`,
      system_kw: num(record, 13),
    })),
    ...inspectionNoPto.map(record => ({
      rid: val(record, 3),
      project_name: val(record, 6),
      issue: `Inspection passed, no PTO${daysSince(val(record, 491)) !== null ? ` after ${daysSince(val(record, 491))} days` : ''}`,
      context: `Inspection passed ${val(record, 491) || 'date unknown'}; lender ${val(record, 344) || 'unknown'}.`,
      system_kw: num(record, 13),
    })),
  ].slice(0, 12)

  const wins = [
    todaysInstalls.length ? `${todaysInstalls.length} install${todaysInstalls.length === 1 ? '' : 's'} scheduled today` : '',
    tomorrowsInstalls.length ? `${tomorrowsInstalls.length} install${tomorrowsInstalls.length === 1 ? '' : 's'} scheduled tomorrow` : '',
  ].filter(Boolean)

  return {
    coordinator,
    coordinator_email: coordinatorEmail || null,
    day: new Date().toLocaleDateString(undefined, { weekday: 'long' }),
    installs,
    attention_items: attentionItems,
    wins,
    source: 'quickbase_live',
    query_counts: Object.fromEntries(results.map(result => [result.label, result.count])),
    query_errors: Object.fromEntries(results.filter(result => result.error).map(result => [result.label, result.error])),
  }
}
