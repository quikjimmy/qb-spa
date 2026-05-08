// Inbound-call attribution: given one-or-many phone numbers, classify
// each as 'crew' (Arrivy field member), 'internal' (Arrivy office /
// qb-spa user), or 'external' (likely customer). Used to colour-code
// comms entries in Comms Hub + per-project Communications.

import db from '../db'
import { canonicalPhone } from './phone'

export type CallerKind = 'crew' | 'internal' | 'external'

export interface CallerInfo {
  kind: CallerKind
  /** Display name (Arrivy crew name or qb-spa user full_name). */
  name: string | null
  /** Arrivy role / type when matched against arrivy_users. */
  role: string | null
  /** Source of the match — useful for debugging unexpected attributions. */
  source: 'arrivy' | 'app_user' | 'contact' | null
}

const FIELD_ROLE_RX = /tech|crew|field|installer|surveyor|driver/i

function classifyByRole(role: string | null): CallerKind {
  if (!role) return 'crew'
  return FIELD_ROLE_RX.test(role) ? 'crew' : 'internal'
}

// Map a saved-contact `kind` onto the existing chip vocabulary so the live
// rail / inbox don't need a new color for every category.
function classifyContactKind(kind: string | null): CallerKind {
  if (kind === 'crew') return 'crew'
  if (kind === 'employee') return 'internal'
  // 'customer' and 'supplier' both render as plain external (no chip).
  return 'external'
}

/** Bulk-lookup. Pass an array of raw phone strings; returns a Map keyed
 *  by the canonical phone with the matched caller info. Numbers with
 *  no match are simply absent — callers can default to 'external'. */
export function lookupCallers(rawPhones: Array<string | null | undefined>): Map<string, CallerInfo> {
  const out = new Map<string, CallerInfo>()
  const canonicals = [...new Set(
    rawPhones.map(p => canonicalPhone(p)).filter(Boolean)
  )]
  if (canonicals.length === 0) return out

  const placeholders = canonicals.map(() => '?').join(',')

  // Arrivy crew first — the more specific source.
  const arrivyRows = db.prepare(
    `SELECT phone_canonical, name, role FROM arrivy_users WHERE phone_canonical IN (${placeholders})`
  ).all(...canonicals) as Array<{ phone_canonical: string; name: string | null; role: string | null }>
  for (const r of arrivyRows) {
    if (!r.phone_canonical) continue
    out.set(r.phone_canonical, {
      kind: classifyByRole(r.role),
      name: r.name,
      role: r.role,
      source: 'arrivy',
    })
  }

  // Saved contacts (Add Contact dialog) — fill in any phones Arrivy didn't
  // claim. A user explicitly saved this name, so trust it over the QB
  // project-cache fallback that read paths consult downstream. Wrapped in
  // a runtime guard because the table is freshly added and older deploys
  // may not have run the schema bootstrap yet.
  const afterArrivy = canonicals.filter(c => !out.has(c))
  if (afterArrivy.length > 0 && hasContactsTable()) {
    try {
      const contactPlaceholders = afterArrivy.map(() => '?').join(',')
      const contactRows = db.prepare(
        `SELECT phone_canonical, first_name, last_name, kind
         FROM dialpad_contacts WHERE phone_canonical IN (${contactPlaceholders})`
      ).all(...afterArrivy) as Array<{
        phone_canonical: string; first_name: string; last_name: string | null; kind: string | null
      }>
      for (const r of contactRows) {
        if (!r.phone_canonical) continue
        const fullName = [r.first_name, r.last_name].filter(p => p && p !== '—').join(' ').trim()
        out.set(r.phone_canonical, {
          kind: classifyContactKind(r.kind),
          name: fullName || r.first_name,
          role: r.kind,
          source: 'contact',
        })
      }
    } catch (e) {
      logContactsFallbackError(e)
    }
  }

  // qb-spa users — fill in any phones Arrivy didn't claim. The users table
  // does NOT currently carry primary_phone or full_name columns; this branch
  // is wrapped in a runtime guard so a future additive migration lights it
  // up automatically without breaking comms in the meantime. Without the
  // guard, every /events/recent + every SSE-decorated event threw
  // SqliteError: no such column: full_name and the live feed silently died.
  const remaining = canonicals.filter(c => !out.has(c))
  if (remaining.length > 0 && hasUsersPhoneColumns()) {
    try {
      const userRows = db.prepare(
        `SELECT id, name AS full_name, primary_phone FROM users
         WHERE primary_phone IS NOT NULL AND primary_phone != ''`
      ).all() as Array<{ id: number; full_name: string | null; primary_phone: string | null }>
      const userByPhone = new Map<string, { name: string | null }>()
      for (const u of userRows) {
        const c = canonicalPhone(u.primary_phone)
        if (c) userByPhone.set(c, { name: u.full_name })
      }
      for (const c of remaining) {
        const u = userByPhone.get(c)
        if (!u) continue
        out.set(c, { kind: 'internal', name: u.name, role: 'app user', source: 'app_user' })
      }
    } catch (e) {
      // Cache the failure so we don't spam logs on every comms request.
      logUsersFallbackError(e)
    }
  }

  return out
}

// Checked once per process — re-evaluating PRAGMA on every comms event is
// pointless when the schema can't change at runtime without a restart.
let _usersPhoneColumnsChecked = false
let _usersPhoneColumnsExist = false
function hasUsersPhoneColumns(): boolean {
  if (_usersPhoneColumnsChecked) return _usersPhoneColumnsExist
  _usersPhoneColumnsChecked = true
  try {
    const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
    const names = new Set(cols.map(c => c.name))
    _usersPhoneColumnsExist = names.has('primary_phone')
  } catch { _usersPhoneColumnsExist = false }
  return _usersPhoneColumnsExist
}

let _loggedUsersFallbackError = false
function logUsersFallbackError(e: unknown): void {
  if (_loggedUsersFallbackError) return
  _loggedUsersFallbackError = true
  console.warn('[caller-attribution] users-fallback query failed (suppressing further):',
    e instanceof Error ? e.message : String(e))
}

let _contactsTableChecked = false
let _contactsTableExists = false
function hasContactsTable(): boolean {
  if (_contactsTableChecked) return _contactsTableExists
  _contactsTableChecked = true
  try {
    const row = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='dialpad_contacts'`
    ).get()
    _contactsTableExists = !!row
  } catch { _contactsTableExists = false }
  return _contactsTableExists
}

let _loggedContactsFallbackError = false
function logContactsFallbackError(e: unknown): void {
  if (_loggedContactsFallbackError) return
  _loggedContactsFallbackError = true
  console.warn('[caller-attribution] contacts-fallback query failed (suppressing further):',
    e instanceof Error ? e.message : String(e))
}

/** Single-shot convenience wrapper. Returns null when no match found
 *  (callers typically treat that as 'external'). */
export function lookupCaller(rawPhone: string | null | undefined): CallerInfo | null {
  const m = lookupCallers([rawPhone])
  const c = canonicalPhone(rawPhone)
  return m.get(c) ?? null
}

/** Decorate an array of comms items in-place with a `caller_kind` and
 *  `caller_name` field. Picks the right phone for inbound vs outbound:
 *  inbound  → from_number / external_number  (the *other party*)
 *  outbound → to_number   / external_number  (the *other party*)
 *  Anything we can't classify gets caller_kind='external'. */
export function decorateCommsItems<T extends Record<string, unknown>>(items: T[]): T[] {
  // Collect every candidate phone in a single bulk lookup.
  const phones: string[] = []
  for (const it of items) {
    const dir = String(it['direction'] ?? '').toLowerCase()
    const ext = String(it['external_number'] ?? '')
    const from = String(it['from_number'] ?? '')
    const to = String(it['to_number'] ?? '')
    // For inbound, the other party is the from-number; for outbound
    // it's the to-number. external_number is provided by Dialpad as
    // "the non-Dialpad side" and is the most reliable when present.
    if (ext) phones.push(ext)
    else if (dir === 'inbound' || dir === 'in') phones.push(from)
    else phones.push(to)
  }
  const lookup = lookupCallers(phones)
  for (const it of items) {
    const dir = String(it['direction'] ?? '').toLowerCase()
    const ext = String(it['external_number'] ?? '')
    const from = String(it['from_number'] ?? '')
    const to = String(it['to_number'] ?? '')
    const phone = ext || ((dir === 'inbound' || dir === 'in') ? from : to)
    const info = lookup.get(canonicalPhone(phone))
    ;(it as Record<string, unknown>)['caller_kind'] = info?.kind ?? 'external'
    if (info?.name) (it as Record<string, unknown>)['caller_name'] = info.name
    if (info?.role) (it as Record<string, unknown>)['caller_role'] = info.role
  }
  return items
}
