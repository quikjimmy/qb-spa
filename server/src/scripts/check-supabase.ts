import 'dotenv/config'

async function main() {
  const url = process.env['SUPABASE_URL']!
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']!

  // Check REST API
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  })
  console.log('REST API status:', res.status)

  // Try creating a test table via PostgREST - won't work but confirms connection
  const res2 = await fetch(`${url}/rest/v1/users?select=count`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }
  })
  console.log('Users table:', res2.status, res2.headers.get('content-range'))
}

main().catch(console.error)
