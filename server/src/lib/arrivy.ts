// Arrivy REST API client. Uses server-side env vars only — never read or
// log credentials from the request side. Set these on Railway:
//   ARRIVY_AUTH_KEY      (X-Auth-Key header)
//   ARRIVY_AUTH_TOKEN    (X-Auth-Token header)
// Optional override:
//   ARRIVY_API_BASE      (defaults to https://www.arrivy.com/api)

// Default base verified against the existing Site Survey Review Bot spec
// (context-files/full-backup-2026-03-31/workspace/knowledge/site-survey-bot-spec.md).
// Override via ARRIVY_API_BASE env var if Arrivy ever shifts.
const BASE = process.env['ARRIVY_API_BASE'] || 'https://app.arrivy.com/api'

interface ArrivyHeaders {
  'X-Auth-Key': string
  'X-Auth-Token': string
  'Content-Type': string
}

function authHeaders(): ArrivyHeaders | null {
  const key = process.env['ARRIVY_AUTH_KEY']
  const token = process.env['ARRIVY_AUTH_TOKEN']
  if (!key || !token) return null
  return {
    'X-Auth-Key': key,
    'X-Auth-Token': token,
    'Content-Type': 'application/json',
  }
}

export function arrivyConfigured(): boolean {
  return authHeaders() !== null
}

export class ArrivyApiError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`Arrivy API ${status}: ${body.slice(0, 300)}`)
    this.status = status
    this.body = body
  }
}

async function arrivyGet<T>(path: string): Promise<T> {
  const h = authHeaders()
  if (!h) throw new Error('Arrivy auth not configured (ARRIVY_AUTH_KEY / ARRIVY_AUTH_TOKEN)')
  const res = await fetch(`${BASE}${path}`, { headers: h as unknown as Record<string, string> })
  if (!res.ok) throw new ArrivyApiError(res.status, await res.text())
  return res.json() as Promise<T>
}

// Shape of a single attached file as Arrivy returns it. Real responses
// have many more fields; we keep the ones we use.
export interface ArrivyFile {
  id?: string | number
  filename?: string
  file_url?: string
  thumb_url?: string
  type?: string
  uploaded_by?: string
  uploaded_on?: string
  // For status-change attachments, Arrivy includes the action that
  // produced the file ("STARTED", "ENROUTE", "CANCELLED", etc.).
  action?: string
}

export interface ArrivyTask {
  id?: string | number
  external_id?: string
  title?: string
  status?: string
  status_id?: number
  start_datetime?: string
  end_datetime?: string
  files?: ArrivyFile[]
  // Some Arrivy responses use 'attachments' instead of 'files'.
  attachments?: ArrivyFile[]
  extras?: Record<string, unknown>
  extra_fields?: Record<string, unknown>
  reporter_name?: string
  reporter_email?: string
  // Free-form bag for whatever else Arrivy ships back — kept so the route
  // can return the raw shape and the client can inspect.
  [k: string]: unknown
}

/** Fetch a single Arrivy task by its numeric external_id (the long id you
 *  see on app.arrivy.com/tasks/<id>). Returns the raw API shape. */
export function getArrivyTask(externalId: string): Promise<ArrivyTask> {
  return arrivyGet<ArrivyTask>(`/tasks/${encodeURIComponent(externalId)}`)
}

/** Files attached to a task (photos, signatures, forms). Endpoint name
 *  may vary between Arrivy account tiers — we try the documented one
 *  first; callers can fall back to reading task.files inline. */
export function getArrivyTaskFiles(externalId: string): Promise<ArrivyFile[]> {
  return arrivyGet<ArrivyFile[]>(`/tasks/${encodeURIComponent(externalId)}/files`)
}

/** Status-history entries on a task (when Arrivy is the source of truth
 *  rather than QB's mirror). Optional — used to enrich the timeline
 *  with photos that were attached to specific status changes. */
export function getArrivyTaskStatuses(externalId: string): Promise<unknown[]> {
  return arrivyGet<unknown[]>(`/tasks/${encodeURIComponent(externalId)}/statuses`)
}

// ─── Users / crew ─────────────────────────────────────────────────────
//
// Arrivy returns crew members from /users (legacy) or /team_members on
// some account tiers. Shapes vary slightly — we keep the union of the
// fields we use across both. The sync job in lib/arrivyUsersSync.ts
// pages through results and mirrors them into the local arrivy_users
// table for fast joins (e.g. "is this inbound caller a crew member?").

export interface ArrivyUser {
  id?: string | number
  external_id?: string
  name?: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  mobile_number?: string
  cell_phone?: string
  type?: string         // "TECHNICIAN", "DISPATCHER", "ADMIN", etc.
  role?: string
  is_active?: boolean
  is_disabled?: boolean
  // Free-form bag — Arrivy returns lots of optional metadata.
  [k: string]: unknown
}

export async function getArrivyUsers(): Promise<ArrivyUser[]> {
  // Arrivy's /users endpoint paginates via ?page=N (older accounts) OR
  // returns a flat list (newer accounts). We try the simple form first
  // and fall back to /team_members on 404.
  try {
    return await arrivyGet<ArrivyUser[]>('/users')
  } catch (e) {
    if (e instanceof ArrivyApiError && e.status === 404) {
      return await arrivyGet<ArrivyUser[]>('/team_members')
    }
    throw e
  }
}
