import 'dotenv/config'
import '../routes/pc-dashboard'
import db from '../db'
import jwt from 'jsonwebtoken'

const jwtSecret = process.env['JWT_SECRET'] || 'secret'

async function main() {
  const token = jwt.sign({ userId: 1, email: 'james@kinhome.com', role: 'admin' }, jwtSecret, { expiresIn: '1h' })

  const res = await fetch('http://localhost:3001/api/pc-dashboard', {
    headers: { 'Authorization': `Bearer ${token}` }
  })

  console.log('HTTP Status:', res.status)

  if (!res.ok) {
    console.log('Error:', await res.text())
    return
  }

  const d = await res.json()
  const kpi = Object.entries(d.kpi || {}).filter(([, v]) => (v as number) > 0)
  console.log('KPI (non-zero):', JSON.stringify(Object.fromEntries(kpi)))
  console.log('Unresponsive:', (d.exceptions?.unresponsive || []).length)
  console.log('Blocked NEM:', (d.exceptions?.blockedNem || []).length)
  console.log('Cache:', JSON.stringify(d.cache))
  console.log('Stage order:', d.stageOrder)

  // Show first record from first non-empty group
  for (const [stage, records] of Object.entries(d.groups || {})) {
    if ((records as unknown[]).length > 0) {
      console.log(`\nFirst record from "${stage}":`)
      const r = (records as unknown[])[0]
      console.log(JSON.stringify(r, null, 2).slice(0, 500))
      break
    }
  }
}

main().catch(console.error)
