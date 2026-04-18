import 'dotenv/config'
import '../routes/pc-dashboard'
import db from '../db'

const realm = process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com'
const token = process.env['QB_USER_TOKEN'] || ''
const OUTREACH_TABLE = 'btvik5kwi'

const fMap = [
  { fid: 3, col: 'record_id' },
  { fid: 10, col: 'project_rid' },
  { fid: 6, col: 'touchpoint_name' },
  { fid: 11, col: 'customer_name' },
  { fid: 56, col: 'project_status' },
  { fid: 63, col: 'project_state' },
  { fid: 65, col: 'project_lender' },
  { fid: 87, col: 'preferred_outreach' },
  { fid: 20, col: 'due_date' },
  { fid: 33, col: 'update_outreach' },
  { fid: 17, col: 'project_coordinator' },
  { fid: 94, col: 'coordinator_user' },
  { fid: 18, col: 'outreach_completed_date' },
  { fid: 36, col: 'display_order' },
  { fid: 43, col: 'outreach_status' },
  { fid: 44, col: 'attempts' },
  { fid: 77, col: 'is_unresponsive' },
  { fid: 51, col: 'preferred_comms' },
  { fid: 8, col: 'note' },
]

function val(r: Record<string, { value: unknown }>, fid: number): string {
  const v = r[String(fid)]?.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if ('name' in (v as Record<string, unknown>)) return String((v as { name: string }).name)
    if ('email' in (v as Record<string, unknown>)) return String((v as { email: string }).email)
  }
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

async function main() {
  console.log('Syncing PC outreach from QB...')
  const start = Date.now()

  let allRecords: Array<Record<string, { value: unknown }>> = []
  let skip = 0
  const batchSize = 1000

  while (true) {
    process.stdout.write(`  Batch ${Math.floor(skip / batchSize) + 1} (skip=${skip})...`)
    const res = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: OUTREACH_TABLE,
        select: fMap.map(f => f.fid),
        where: "{'18'.EX.''}AND{'20'.XEX.''}AND{'20'.OAF.'2024-01-01'}",
        sortBy: [{ fieldId: 36, order: 'ASC' }],
        options: { skip, top: batchSize },
      }),
    })

    if (!res.ok) {
      console.log(' ERROR:', res.status, await res.text())
      return
    }
    const data = await res.json()
    const records = data.data || []
    allRecords = allRecords.concat(records)
    console.log(` got ${records.length} (total: ${allRecords.length})`)
    if (records.length < batchSize) break
    skip += batchSize
  }

  console.log(`\nInserting ${allRecords.length} records into outreach_cache...`)
  db.prepare('DELETE FROM outreach_cache').run()

  const cols = fMap.map(f => f.col).join(', ')
  const placeholders = fMap.map(() => '?').join(', ')
  const insert = db.prepare(
    `INSERT OR REPLACE INTO outreach_cache (${cols}, cached_at) VALUES (${placeholders}, datetime('now'))`
  )

  db.transaction(() => {
    for (const record of allRecords) {
      const values = fMap.map(f => {
        if (f.col === 'attempts' || f.col === 'display_order') return parseFloat(val(record, f.fid)) || 0
        return val(record, f.fid)
      })
      insert.run(...values)
    }
  })()

  const today = new Date().toISOString().split('T')[0]
  const total = (db.prepare('SELECT COUNT(*) AS c FROM outreach_cache').get() as { c: number }).c
  const dueToday = (db.prepare('SELECT COUNT(*) AS c FROM outreach_cache WHERE due_date <= ?').get(today) as { c: number }).c

  // Show touchpoint breakdown for due-today records
  const byTouchpoint = db.prepare(
    `SELECT touchpoint_name, COUNT(*) AS c FROM outreach_cache WHERE due_date <= ? GROUP BY touchpoint_name ORDER BY c DESC`
  ).all(today) as Array<{ touchpoint_name: string; c: number }>

  console.log(`\nDone in ${Date.now() - start}ms`)
  console.log(`Total cached: ${total}`)
  console.log(`Due today or earlier (${today}): ${dueToday}`)
  console.log('\nBreakdown by touchpoint:')
  for (const r of byTouchpoint) {
    console.log(`  ${r.touchpoint_name}: ${r.c}`)
  }

  // Show coordinator breakdown
  const byCoord = db.prepare(
    `SELECT project_coordinator, COUNT(*) AS c FROM outreach_cache WHERE due_date <= ? GROUP BY project_coordinator ORDER BY c DESC LIMIT 10`
  ).all(today) as Array<{ project_coordinator: string; c: number }>
  console.log('\nTop coordinators (due today):')
  for (const r of byCoord) {
    console.log(`  ${r.project_coordinator || '(blank)'}: ${r.c}`)
  }
}

main().catch(console.error)
