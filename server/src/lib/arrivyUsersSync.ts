// Hourly sync of Arrivy crew/team-member roster into the local
// arrivy_users table. Powers inbound-call attribution: when a Dialpad
// inbound call arrives, we join on phone_canonical to tag the caller
// as a crew member ("field" / "internal") vs. external customer.
//
// Strategy: pull the full roster each tick (Arrivy accounts have at
// most low-thousands of users, so a full re-sync is fine), upsert by
// arrivy_id, mark missing rows is_active=0 instead of deleting (keeps
// historical attribution working when a former crew member calls in).

import cron from 'node-cron'
import db from '../db'
import { arrivyConfigured, getArrivyUsers, type ArrivyUser } from './arrivy'
import { canonicalPhone } from './phone'

let started = false

function pickName(u: ArrivyUser): string {
  if (u.name && String(u.name).trim()) return String(u.name).trim()
  const fn = String(u.first_name ?? '').trim()
  const ln = String(u.last_name ?? '').trim()
  return [fn, ln].filter(Boolean).join(' ')
}

function pickPhone(u: ArrivyUser): string {
  return String(u.mobile_number ?? u.phone ?? u.cell_phone ?? '').trim()
}

function pickRole(u: ArrivyUser): string {
  return String(u.type ?? u.role ?? '').trim()
}

function isActive(u: ArrivyUser): boolean {
  if (u.is_disabled === true) return false
  if (u.is_active === false) return false
  return true
}

interface SyncResult {
  fetched: number
  upserted: number
  deactivated: number
  durationMs: number
}

export async function syncArrivyUsers(): Promise<SyncResult> {
  const t0 = Date.now()
  if (!arrivyConfigured()) {
    return { fetched: 0, upserted: 0, deactivated: 0, durationMs: 0 }
  }
  const users = await getArrivyUsers()
  const now = new Date().toISOString()
  const seenIds = new Set<string>()

  const upsert = db.prepare(`
    INSERT INTO arrivy_users (arrivy_id, name, email, role, raw_phone, phone_canonical, is_active, last_synced_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(arrivy_id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      role = excluded.role,
      raw_phone = excluded.raw_phone,
      phone_canonical = excluded.phone_canonical,
      is_active = excluded.is_active,
      last_synced_at = excluded.last_synced_at,
      raw_json = excluded.raw_json
  `)

  let upserted = 0
  const tx = db.transaction((rows: ArrivyUser[]) => {
    for (const u of rows) {
      const id = String(u.id ?? u.external_id ?? '').trim()
      if (!id) continue
      seenIds.add(id)
      const rawPhone = pickPhone(u)
      upsert.run(
        id,
        pickName(u) || null,
        String(u.email ?? '').trim() || null,
        pickRole(u) || null,
        rawPhone || null,
        canonicalPhone(rawPhone) || null,
        isActive(u) ? 1 : 0,
        now,
        JSON.stringify(u),
      )
      upserted++
    }
  })
  tx(users)

  // Mark anyone we didn't see in this pull as inactive — preserves
  // attribution history without leaving stale "active" flags.
  let deactivated = 0
  if (seenIds.size > 0) {
    const placeholders = [...seenIds].map(() => '?').join(',')
    const res = db.prepare(
      `UPDATE arrivy_users SET is_active = 0, last_synced_at = ? WHERE is_active = 1 AND arrivy_id NOT IN (${placeholders})`
    ).run(now, ...[...seenIds])
    deactivated = res.changes
  }

  return { fetched: users.length, upserted, deactivated, durationMs: Date.now() - t0 }
}

export function startArrivyUsersScheduler(): void {
  if (started) return
  started = true
  if (!arrivyConfigured()) {
    console.log('[arrivy-users] scheduler not started — ARRIVY_AUTH_KEY/_TOKEN missing')
    return
  }
  // Run once on boot (after a short delay so we don't slow startup).
  setTimeout(() => {
    syncArrivyUsers()
      .then(r => console.log(`[arrivy-users] startup sync: fetched=${r.fetched} upserted=${r.upserted} deactivated=${r.deactivated} in ${r.durationMs}ms`))
      .catch(e => console.error('[arrivy-users] startup sync failed:', e instanceof Error ? e.message : e))
  }, 15_000)
  // Re-sync hourly. Roster changes are rare so a tighter cadence wastes API budget.
  cron.schedule('7 * * * *', async () => {
    try {
      const r = await syncArrivyUsers()
      if (r.fetched > 0) {
        console.log(`[arrivy-users] hourly sync: fetched=${r.fetched} upserted=${r.upserted} deactivated=${r.deactivated} in ${r.durationMs}ms`)
      }
    } catch (e) {
      console.error('[arrivy-users] hourly sync failed:', e instanceof Error ? e.message : e)
    }
  })
  console.log('[arrivy-users] scheduler started: hourly at :07')
}
