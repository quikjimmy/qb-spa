import 'dotenv/config'
import db from '../db'
// Force import the pc-dashboard route to create the table
import '../routes/pc-dashboard'

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
  console.log('Step 1: Query QB...')
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
      options: { top: 10 },
    }),
  })

  console.log('QB Status:', res.status)
  if (!res.ok) {
    console.log('Error:', await res.text())
    return
  }

  const data = await res.json()
  console.log('Total matching:', data.metadata?.totalRecords)
  console.log('Fetched:', (data.data || []).length, 'records')

  // Show first record raw
  if (data.data?.[0]) {
    const r = data.data[0]
    console.log('\nFirst record raw fields:')
    for (const f of fMap) {
      console.log(`  ${f.col} (fid ${f.fid}):`, JSON.stringify(r[String(f.fid)]?.value).slice(0, 80))
    }
  }

  // Try inserting
  console.log('\nStep 2: Check table exists...')
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM outreach_cache').get() as { c: number }
    console.log('outreach_cache row count before insert:', count.c)
  } catch (err) {
    console.log('TABLE ERROR:', err)
    return
  }

  // Insert first 5
  const cols = fMap.map(f => f.col).join(', ')
  const placeholders = fMap.map(() => '?').join(', ')
  const insert = db.prepare(
    `INSERT OR REPLACE INTO outreach_cache (${cols}, cached_at) VALUES (${placeholders}, datetime('now'))`
  )

  let inserted = 0
  for (const record of (data.data || []).slice(0, 5)) {
    const values = fMap.map(f => {
      if (f.col === 'attempts' || f.col === 'display_order') return parseFloat(val(record, f.fid)) || 0
      return val(record, f.fid)
    })
    try {
      insert.run(...values)
      inserted++
    } catch (err) {
      console.log('INSERT ERROR:', err)
      console.log('Values:', values)
    }
  }
  console.log('Inserted:', inserted)

  const after = db.prepare('SELECT COUNT(*) AS c FROM outreach_cache').get() as { c: number }
  console.log('outreach_cache row count after:', after.c)

  // Check today filter
  const today = new Date().toISOString().split('T')[0]
  const dueTodayOrEarlier = db.prepare('SELECT COUNT(*) AS c FROM outreach_cache WHERE due_date <= ?').get(today) as { c: number }
  console.log(`Due today or earlier (${today}):`, dueTodayOrEarlier.c)
}

main().catch(console.error)
