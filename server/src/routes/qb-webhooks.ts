// QuickBase Pipeline webhooks — public endpoints (no JWT) verified
// against a shared secret in the X-QB-Webhook-Secret header. QB
// Pipelines doesn't sign payloads natively, so a header-based shared
// secret is the simplest auth surface to configure on their side.

import { Router, type Request, type Response } from 'express'
import { invalidateIntakeCaches } from './intake'

const router = Router()

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

export { router as qbWebhookRouter }
