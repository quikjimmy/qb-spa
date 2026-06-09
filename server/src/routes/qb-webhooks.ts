// QuickBase Pipeline webhooks — public endpoints (no JWT) verified
// against a shared secret in the X-QB-Webhook-Secret header. QB
// Pipelines doesn't sign payloads natively, so a header-based shared
// secret is the simplest auth surface to configure on their side.

import { Router, type Request, type Response } from 'express'
import db from '../db'
import { invalidateIntakeCaches } from './intake'
import { fetchOneLive } from './projects'
import { snapshotProject, mintFromProjectDiff, type PayloadActor } from '../lib/feedMint'

const router = Router()

db.exec(`
  CREATE TABLE IF NOT EXISTS qb_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source_table TEXT,
    source_record_id INTEGER,
    project_record_id INTEGER,
    changed_field_ids TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_qb_wh_project ON qb_webhook_events(project_record_id, received_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_qb_wh_status ON qb_webhook_events(status, received_at DESC)`)
// Actor passed by the QB pipeline (who made the change) — kept for audit
// alongside the feed posts it produces.
{
  const cols = db.prepare(`PRAGMA table_info(qb_webhook_events)`).all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'actor_json')) db.exec(`ALTER TABLE qb_webhook_events ADD COLUMN actor_json TEXT`)
}

function verifySecret(req: Request): boolean | null {
  const expected = process.env['QB_WEBHOOK_SECRET']
  if (!expected) return null  // open mode — log, don't block
  const got = String(req.header('x-qb-webhook-secret') || req.header('X-QB-Webhook-Secret') || '').trim()
  return got !== '' && got === expected
}

// Pull a record_id out of whatever payload shape QB Pipelines sends.
// Common slots: top-level record_id / rid / id, or nested under
// `record` / `data`. Pipelines lets the user pick; we accept whichever.
function pickRecordId(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const candidates = [
    b['record_id'], b['recordId'], b['rid'], b['id'],
    (b['record'] as Record<string, unknown> | undefined)?.['record_id'],
    (b['record'] as Record<string, unknown> | undefined)?.['rid'],
    (b['record'] as Record<string, unknown> | undefined)?.['id'],
    (b['data'] as Record<string, unknown> | undefined)?.['record_id'],
    (b['data'] as Record<string, unknown> | undefined)?.['rid'],
    (b['data'] as Record<string, unknown> | undefined)?.['id'],
  ]
  for (const v of candidates) {
    if (v == null) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function pickProjectRecordId(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const candidates = [
    b['project_record_id'], b['projectRecordId'], b['project_rid'], b['projectRid'],
    b['related_project'], b['relatedProject'], b['related_project_id'], b['relatedProjectId'],
    b['project_id'], b['projectId'],
    (b['record'] as Record<string, unknown> | undefined)?.['project_record_id'],
    (b['record'] as Record<string, unknown> | undefined)?.['project_rid'],
    (b['record'] as Record<string, unknown> | undefined)?.['related_project'],
    (b['record'] as Record<string, unknown> | undefined)?.['relatedProject'],
    (b['data'] as Record<string, unknown> | undefined)?.['project_record_id'],
    (b['data'] as Record<string, unknown> | undefined)?.['project_rid'],
    (b['data'] as Record<string, unknown> | undefined)?.['related_project'],
    (b['data'] as Record<string, unknown> | undefined)?.['relatedProject'],
  ]
  for (const v of candidates) {
    if (v == null) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function pickSourceTable(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const v = b['source_table'] ?? b['sourceTable'] ?? b['table_id'] ?? b['tableId']
    ?? (b['record'] as Record<string, unknown> | undefined)?.['source_table']
    ?? (b['data'] as Record<string, unknown> | undefined)?.['source_table']
  return v == null ? null : String(v)
}

function pickChangedFieldIds(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const v = b['changed_field_ids'] ?? b['changedFieldIds'] ?? b['changed_fields'] ?? b['changedFields']
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean).join(',')
  return v == null ? null : String(v)
}

// Who made the change. Preferred pipeline shape:
//   "actor": {"name": "<last modified by name>", "email": "<last modified by email>"}
// but we also accept a bare string, QB user objects ({name, email, userName}),
// flat actor_name/actor_email pairs, and the usual nested record/data slots.
// Payload actor beats the fetched record's [Last Modified By] (FID 5),
// which can be raced by a second edit between webhook and fetch.
function pickActor(body: unknown): PayloadActor | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>

  const coerce = (v: unknown): PayloadActor | null => {
    if (v == null) return null
    if (typeof v === 'string') {
      const s = v.trim()
      if (!s) return null
      return s.includes('@') ? { name: s.split('@')[0] ?? s, email: s } : { name: s, email: null }
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      const name = o['name'] ?? o['userName'] ?? o['user_name']
      const email = o['email']
      if (name == null && email == null) return null
      return {
        name: name != null ? String(name).trim() : null,
        email: email != null ? String(email).trim() : null,
      }
    }
    return null
  }

  const slots = [
    b['actor'], b['modified_by'], b['modifiedBy'], b['last_modified_by'], b['lastModifiedBy'],
    b['user'], b['triggered_by'], b['triggeredBy'],
    (b['record'] as Record<string, unknown> | undefined)?.['actor'],
    (b['record'] as Record<string, unknown> | undefined)?.['modified_by'],
    (b['data'] as Record<string, unknown> | undefined)?.['actor'],
    (b['data'] as Record<string, unknown> | undefined)?.['modified_by'],
  ]
  for (const v of slots) {
    const actor = coerce(v)
    if (actor?.name || actor?.email) return actor
  }

  // Flat name/email pairs.
  const flatName = b['actor_name'] ?? b['actorName'] ?? b['user_name'] ?? b['userName']
  const flatEmail = b['actor_email'] ?? b['actorEmail'] ?? b['user_email'] ?? b['userEmail']
  if (flatName != null || flatEmail != null) {
    return {
      name: flatName != null ? String(flatName).trim() : null,
      email: flatEmail != null ? String(flatEmail).trim() : null,
    }
  }
  return null
}

// In-flight refresh tracker with a rerun flag. A webhook arriving while
// a fetch for the same project is in flight used to be coalesced and
// silently dropped — but the in-flight fetch may have read QB *before*
// that second change landed. Now the arrival sets `rerun`, and the
// worker loops one more pass (snapshot → fetch → mint) so the change is
// captured. Each pass consumes one rerun flag, so the loop is naturally
// bounded by arrivals. The latest arrival's actor wins for the rerun
// pass; if two doers coalesce into one pass, FID 5 at least reflects
// the most recent QB modifier.
const inFlightRefreshes = new Map<number, { rerun: boolean; actor: PayloadActor | null }>()

function enqueueProjectRefresh(projectRecordId: number, eventId: number, actor: PayloadActor | null): 'queued' | 'coalesced' {
  const inFlight = inFlightRefreshes.get(projectRecordId)
  if (inFlight) {
    inFlight.rerun = true
    inFlight.actor = actor ?? inFlight.actor
    db.prepare(`
      UPDATE qb_webhook_events
      SET status = 'coalesced', processed_at = datetime('now')
      WHERE id = ?
    `).run(eventId)
    return 'coalesced'
  }
  inFlightRefreshes.set(projectRecordId, { rerun: false, actor })
  setImmediate(() => { void runProjectRefresh(projectRecordId, eventId) })
  return 'queued'
}

async function runProjectRefresh(projectRecordId: number, eventId: number): Promise<void> {
  try {
    // Bounded loop: re-runs only while another webhook arrived mid-pass.
    for (;;) {
      const state = inFlightRefreshes.get(projectRecordId)
      if (state) state.rerun = false
      const passActor = state?.actor ?? null

      // Snapshot BEFORE fetchOneLive — its INSERT OR REPLACE destroys the
      // old row, and the feed mint diffs old vs fresh.
      const oldRow = snapshotProject(projectRecordId)
      const fresh = await fetchOneLive(projectRecordId)
      if (!fresh) {
        db.prepare(`
          UPDATE qb_webhook_events
          SET status = 'not_found', error = 'Project not found in QuickBase or filtered out', processed_at = datetime('now')
          WHERE id = ?
        `).run(eventId)
        return
      }

      // Best-effort: a mint failure must never mark the cache refresh
      // (the primary job) as failed.
      try {
        const { minted } = mintFromProjectDiff(oldRow, fresh, passActor, { eventId })
        if (minted > 0) console.log(`[qb-webhook] minted ${minted} feed post(s) for project ${projectRecordId}`)
      } catch (e) {
        console.error(`[qb-webhook] feed mint failed for project ${projectRecordId}:`, e instanceof Error ? e.message : e)
      }

      db.prepare(`
        UPDATE qb_webhook_events
        SET status = 'processed', error = NULL, processed_at = datetime('now')
        WHERE id = ?
      `).run(eventId)
      console.log(`[qb-webhook] refreshed project ${projectRecordId} from event ${eventId}`)

      if (!inFlightRefreshes.get(projectRecordId)?.rerun) return
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    db.prepare(`
      UPDATE qb_webhook_events
      SET status = 'failed', error = ?, processed_at = datetime('now')
      WHERE id = ?
    `).run(msg, eventId)
    console.error(`[qb-webhook] refresh project ${projectRecordId} failed:`, msg)
  } finally {
    inFlightRefreshes.delete(projectRecordId)
  }
}

function acceptProjectRefresh(kind: string, req: Request, res: Response): void {
  const verdict = verifySecret(req)
  if (verdict === false) {
    console.warn(`[qb-webhook] ${kind} — bad/missing secret, dropping`)
    res.json({ ok: false, reason: 'auth' })
    return
  }
  if (verdict === null) {
    console.warn(`[qb-webhook] ${kind} — QB_WEBHOOK_SECRET not set, accepting anonymously (dev mode)`)
  }

  const projectRecordId = pickProjectRecordId(req.body)
  const sourceRecordId = pickRecordId(req.body)
  const sourceTable = pickSourceTable(req.body)
  const changedFieldIds = pickChangedFieldIds(req.body)
  const actor = pickActor(req.body)
  const payloadJson = JSON.stringify(req.body ?? {})

  const result = db.prepare(`
    INSERT INTO qb_webhook_events
      (kind, source_table, source_record_id, project_record_id, changed_field_ids, actor_json, payload_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(kind, sourceTable, sourceRecordId, projectRecordId, changedFieldIds, actor ? JSON.stringify(actor) : null, payloadJson, projectRecordId ? 'queued' : 'ignored')
  const eventId = Number(result.lastInsertRowid)

  if (!projectRecordId) {
    res.json({ ok: false, reason: 'missing_project_record_id', eventId })
    return
  }

  const queueStatus = enqueueProjectRefresh(projectRecordId, eventId, actor)
  res.json({ ok: true, eventId, projectRecordId, sourceRecordId, queued: queueStatus === 'queued', status: queueStatus })
}

// POST /api/webhooks/qb/project-created
//
// Fired by a QB Pipeline whenever a new row lands in the Projects table.
// We don't trust the payload to be the source of truth — we just use it
// as a signal to invalidate the intake in-memory caches so the next
// dashboard poll hits QB live and picks up the new row. Polling already
// runs every 30s on the intake page, so users see the new project in
// 0–30 seconds (worst case).
//
// Returns 200 fast so QB Pipelines doesn't retry. Auth failures still
// return 200 with a debug body — failing loud (401) would surface in
// QB's pipeline UI as a red error and freak people out, when really
// we just want to log + drop unknown senders.
router.post('/project-created', (req: Request, res: Response): void => {
  const verdict = verifySecret(req)
  if (verdict === false) {
    console.warn('[qb-webhook] project-created — bad/missing secret, dropping')
    res.json({ ok: false, reason: 'auth' })
    return
  }
  if (verdict === null) {
    console.warn('[qb-webhook] project-created — QB_WEBHOOK_SECRET not set, accepting anonymously (dev mode)')
  }

  const recordId = pickRecordId(req.body)
  invalidateIntakeCaches(`qb-webhook project-created rid=${recordId ?? 'unknown'}`)

  res.json({ ok: true, recordId, invalidated: ['failedRunsCache', 'intakeManagerCache'] })
})

// POST /api/webhooks/qb/project-refresh
//
// Generic "a child milestone row changed" signal. The payload only needs
// the related project RID; the server pulls the canonical project row
// from QB and updates project_cache. Use this for every milestone table.
router.post('/project-refresh', (req: Request, res: Response): void => {
  acceptProjectRefresh('project-refresh', req, res)
})

// Temporary backwards-compatible alias for any test payloads configured
// before the endpoint name was finalized.
router.post('/project-dirty', (req: Request, res: Response): void => {
  acceptProjectRefresh('project-refresh', req, res)
})

// Permit-specific alias for the first QB pilot. Same behavior as the
// generic project-refresh endpoint, but the event kind makes the audit
// table easier to read.
router.post('/permit', (req: Request, res: Response): void => {
  acceptProjectRefresh('permit', req, res)
})

export { router as qbWebhookRouter }
