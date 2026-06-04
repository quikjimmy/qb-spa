// QuickBase Pipeline webhooks — public endpoints (no JWT) verified
// against a shared secret in the X-QB-Webhook-Secret header. QB
// Pipelines doesn't sign payloads natively, so a header-based shared
// secret is the simplest auth surface to configure on their side.

import { Router, type Request, type Response } from 'express'
import db from '../db'
import { invalidateIntakeCaches } from './intake'
import { fetchOneLive } from './projects'

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

const queuedProjectRefreshes = new Set<number>()

function enqueueProjectRefresh(projectRecordId: number, eventId: number): 'queued' | 'coalesced' {
  if (queuedProjectRefreshes.has(projectRecordId)) {
    db.prepare(`
      UPDATE qb_webhook_events
      SET status = 'coalesced', processed_at = datetime('now')
      WHERE id = ?
    `).run(eventId)
    return 'coalesced'
  }
  queuedProjectRefreshes.add(projectRecordId)
  setImmediate(async () => {
    try {
      const fresh = await fetchOneLive(projectRecordId)
      if (!fresh) {
        db.prepare(`
          UPDATE qb_webhook_events
          SET status = 'not_found', error = 'Project not found in QuickBase or filtered out', processed_at = datetime('now')
          WHERE id = ?
        `).run(eventId)
        return
      }
      db.prepare(`
        UPDATE qb_webhook_events
        SET status = 'processed', error = NULL, processed_at = datetime('now')
        WHERE id = ?
      `).run(eventId)
      console.log(`[qb-webhook] refreshed project ${projectRecordId} from event ${eventId}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      db.prepare(`
        UPDATE qb_webhook_events
        SET status = 'failed', error = ?, processed_at = datetime('now')
        WHERE id = ?
      `).run(msg, eventId)
      console.error(`[qb-webhook] refresh project ${projectRecordId} failed:`, msg)
    } finally {
      queuedProjectRefreshes.delete(projectRecordId)
    }
  })
  return 'queued'
}

function acceptProjectRefresh(
  kind: string,
  req: Request,
  res: Response,
  opts: { selfIsProject?: boolean } = {},
): void {
  const verdict = verifySecret(req)
  if (verdict === false) {
    console.warn(`[qb-webhook] ${kind} — bad/missing secret, dropping`)
    res.json({ ok: false, reason: 'auth' })
    return
  }
  if (verdict === null) {
    console.warn(`[qb-webhook] ${kind} — QB_WEBHOOK_SECRET not set, accepting anonymously (dev mode)`)
  }

  const sourceRecordId = pickRecordId(req.body)
  // For edits on the Projects table itself (install completed, PTO, status,
  // M2/M3/DCA dates + amounts — all fields on br9kwm8na), the changed record
  // IS the project, so a Pipeline there sends only its own record id in the
  // generic record_id/rid slot. Fall back to that when no explicit
  // related-project field is present.
  const projectRecordId = pickProjectRecordId(req.body)
    ?? (opts.selfIsProject ? sourceRecordId : null)
  const sourceTable = pickSourceTable(req.body)
  const changedFieldIds = pickChangedFieldIds(req.body)
  const payloadJson = JSON.stringify(req.body ?? {})

  const result = db.prepare(`
    INSERT INTO qb_webhook_events
      (kind, source_table, source_record_id, project_record_id, changed_field_ids, payload_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(kind, sourceTable, sourceRecordId, projectRecordId, changedFieldIds, payloadJson, projectRecordId ? 'queued' : 'ignored')
  const eventId = Number(result.lastInsertRowid)

  if (!projectRecordId) {
    res.json({ ok: false, reason: 'missing_project_record_id', eventId })
    return
  }

  const queueStatus = enqueueProjectRefresh(projectRecordId, eventId)
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

// POST /api/webhooks/qb/project-changed
//
// Fired by a QB Pipeline on the Projects table itself (br9kwm8na) whenever a
// milestone field changes — install completed, PTO approved, status, M2/M3/DCA
// deposit dates + received amounts, etc. The changed record IS the project, so
// we refresh project_cache straight from its own record id. This is the path
// that keeps milestone data live; /project-refresh remains for child tables
// that carry a separate related-project field.
router.post('/project-changed', (req: Request, res: Response): void => {
  acceptProjectRefresh('project-changed', req, res, { selfIsProject: true })
})

// GET /api/webhooks/qb/recent
//
// Diagnostic view of what QB Pipelines are actually delivering — so a stale
// field is debuggable instead of a black box. Guarded by the same shared
// secret as the inbound webhooks (header or ?secret=). Returns status counts
// plus the last 50 events (no payloads, to avoid leaking PII). 'ignored' rows
// = a Pipeline fired but carried no usable project id; zero rows = no Pipeline
// is firing at all.
router.get('/recent', (req: Request, res: Response): void => {
  const expected = process.env['QB_WEBHOOK_SECRET']
  if (expected) {
    const got = String(
      req.header('x-qb-webhook-secret') || req.query['secret'] || '',
    ).trim()
    if (got !== expected) { res.status(403).json({ error: 'forbidden' }); return }
  }
  const byStatus = db.prepare(`
    SELECT kind, status, COUNT(*) AS n, MAX(received_at) AS latest
    FROM qb_webhook_events GROUP BY kind, status ORDER BY n DESC
  `).all()
  const recent = db.prepare(`
    SELECT id, kind, status, project_record_id AS projectRecordId,
           source_table AS sourceTable, changed_field_ids AS changedFieldIds,
           error, received_at AS receivedAt, processed_at AS processedAt
    FROM qb_webhook_events ORDER BY id DESC LIMIT 50
  `).all()
  res.json({ byStatus, recent, secretConfigured: Boolean(expected) })
})

export { router as qbWebhookRouter }
