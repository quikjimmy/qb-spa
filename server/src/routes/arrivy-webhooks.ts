// Public Arrivy webhook ingest. NOT behind JWT auth — Arrivy POSTs
// directly here. Optional shared-secret verification via env var:
//
//   ARRIVY_WEBHOOK_SECRET   if set, requests must include either:
//                            • X-Arrivy-Signature: HMAC-SHA256(body, secret) hex, OR
//                            • X-Arrivy-Token: <secret>      (literal match)
//
// If unset, all incoming POSTs are accepted (useful for initial wire-up
// and Arrivy dashboard "test event" buttons). Tighten by setting the
// env var once you've confirmed traffic is flowing.
//
// Endpoint:
//   POST /api/webhooks/arrivy
//
// Behavior:
//   1. Persist the raw payload to arrivy_webhook_events (forensics + replay).
//   2. Dispatch by event_type:
//        TASK_STATUS sub-type CANCELLED/EXCEPTION → notify PC + write
//          a feed event so cancels surface in real-time instead of
//          waiting for a page load to scan the QB log.
//        Other event types are stored only — handlers can layer in.
//   3. Always return 200 quickly so Arrivy doesn't retry.

import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'
import db from '../db'
import { notifyPcOfSurveyCancel } from '../lib/notify'
import { fireArrivyLateFlag } from '../lib/predictedLatePoller'

const router = Router()

interface ArrivyWebhookPayload {
  type?: string                 // TASK_STATUS, TASK_RESCHEDULED, CREW_ASSIGNED, etc.
  event_type?: string           // alternate naming Arrivy sometimes uses
  sub_type?: string             // STARTED, ENROUTE, COMPLETE, CANCELLED, EXCEPTION
  status?: string               // alternate slot for sub_type
  task_id?: string | number
  task?: { id?: string | number; external_id?: string; title?: string; customer_name?: string }
  external_id?: string
  customer_name?: string
  reporter?: { name?: string; email?: string }
  reporter_name?: string
  timestamp?: string
  // Free-form bag — Arrivy ships lots of optional metadata.
  [k: string]: unknown
}

function verifySignature(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean | null {
  const secret = process.env['ARRIVY_WEBHOOK_SECRET']
  if (!secret) return null  // open mode — caller logs it
  const hdrSig = String(headers['x-arrivy-signature'] || headers['X-Arrivy-Signature'] || '').trim()
  const hdrTok = String(headers['x-arrivy-token']     || headers['X-Arrivy-Token']     || '').trim()
  // Literal token match (simpler — works for Arrivy's basic webhook setup).
  if (hdrTok && hdrTok === secret) return true
  // HMAC-SHA256 — preferred when Arrivy exposes signing.
  if (hdrSig) {
    const expect = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    try {
      const a = Buffer.from(hdrSig, 'hex')
      const b = Buffer.from(expect, 'hex')
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true
    } catch { /* malformed — falls through to false */ }
  }
  return false
}

// Pull the QB project record_id off the payload. Arrivy can carry it
// in 'project_rid', 'related_project', or as part of the task's
// extras. We try a few common slots.
function pickProjectRid(p: ArrivyWebhookPayload): number | null {
  const candidates = [
    p['project_rid'], p['related_project'], p['kin_project_rid'],
    (p['task'] as Record<string, unknown> | undefined)?.['project_rid'],
    (p['task'] as Record<string, unknown> | undefined)?.['related_project'],
  ]
  for (const c of candidates) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function pickTaskId(p: ArrivyWebhookPayload): string {
  const t = p['task'] as Record<string, unknown> | undefined
  return String(p.task_id ?? p.external_id ?? t?.['id'] ?? t?.['external_id'] ?? '').trim()
}

function pickEventType(p: ArrivyWebhookPayload): string {
  return String(p.type ?? p.event_type ?? '').toUpperCase()
}

function pickSubStatus(p: ArrivyWebhookPayload): string {
  return String(p.sub_type ?? p.status ?? '').toUpperCase()
}

function pickCustomerName(p: ArrivyWebhookPayload): string {
  const t = p['task'] as Record<string, unknown> | undefined
  return String(p.customer_name ?? t?.['customer_name'] ?? t?.['title'] ?? '').trim()
}

function isCancelLike(subType: string): boolean {
  return /CANCEL|EXCEPTION|NOT.?DONE/i.test(subType)
}

function isSurveyTask(p: ArrivyWebhookPayload): boolean {
  const t = p['task'] as Record<string, unknown> | undefined
  const tpl = String(t?.['template_name'] ?? t?.['title'] ?? p['template_name'] ?? '').toLowerCase()
  return tpl.includes('survey') || tpl.includes('site visit')
}

router.post('/arrivy', (req: Request, res: Response): void => {
  const rawBody = typeof req.body === 'string'
    ? req.body
    : JSON.stringify(req.body || {})
  let payload: ArrivyWebhookPayload = {}
  try { payload = typeof req.body === 'object' ? req.body as ArrivyWebhookPayload : JSON.parse(rawBody || '{}') }
  catch { /* leave payload empty — we still log raw */ }

  const sigCheck = verifySignature(rawBody, req.headers as Record<string, string | string[] | undefined>)
  // sigCheck === null  → no secret configured (open mode)
  // sigCheck === true  → verified
  // sigCheck === false → rejected
  if (sigCheck === false) {
    res.status(401).json({ error: 'Invalid Arrivy webhook signature' })
    return
  }

  const eventType  = pickEventType(payload)
  const subStatus  = pickSubStatus(payload)
  const taskId     = pickTaskId(payload)
  const projectRid = pickProjectRid(payload)
  const customer   = pickCustomerName(payload)

  // Persist first, dispatch after — so a handler exception still
  // leaves the raw event recoverable.
  const ins = db.prepare(`
    INSERT INTO arrivy_webhook_events
      (event_type, sub_status, arrivy_task_id, project_rid, customer_name, raw_json, signature_ok)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventType || null,
    subStatus || null,
    taskId || null,
    projectRid,
    customer || null,
    rawBody,
    sigCheck === null ? null : (sigCheck ? 1 : 0),
  )
  const eventId = Number(ins.lastInsertRowid) || 0

  // Dispatch — best effort. We respond 200 either way so Arrivy doesn't
  // retry on our internal handler errors.
  let dispatchError: string | null = null
  try {
    if (eventType === 'TASK_STATUS' && isCancelLike(subStatus) && isSurveyTask(payload) && projectRid) {
      notifyPcOfSurveyCancel({
        projectRid,
        taskRid: taskId || String(eventId),
        customerName: customer || null,
        cancelledAt: String(payload.timestamp ?? new Date().toISOString()),
        cancelledBy: payload.reporter?.name || payload.reporter_name || null,
        // Phase isn't carried directly on a single webhook event — the
        // /api/field/project-tasks log walk fills phase in on the next
        // page load. Webhook fires the alert; UI fills the detail.
        phase: null,
      })
    }
    // Late fast-path: Arrivy's own PREDICTED_LATE / LATE / NO_SHOW flags
    // fire the in-app alert instantly instead of waiting up to 5 min for
    // the predicted-late sweep. Dedup inside fireArrivyLateFlag (same
    // (user, type, link) key the sweep uses) guarantees no double-send.
    if ((eventType === 'PREDICTED_LATE' || eventType === 'LATE' || eventType === 'NO_SHOW') && projectRid) {
      fireArrivyLateFlag({
        projectRid,
        taskRid: taskId || String(eventId),
        stage: eventType,
        customerName: customer || null,
        crew: payload.reporter?.name || payload.reporter_name || null,
        scheduledIso: typeof payload.timestamp === 'string' ? payload.timestamp : null,
      })
    }
  } catch (e) {
    dispatchError = e instanceof Error ? e.message : String(e)
  }
  db.prepare(`UPDATE arrivy_webhook_events SET dispatched_at = datetime('now'), dispatch_error = ? WHERE id = ?`)
    .run(dispatchError, eventId)

  res.json({ ok: true, id: eventId })
})

// GET helper for Arrivy's dashboard "test reachability" pings — some
// SaaS test panels send a GET first to confirm the URL resolves before
// switching to POST. Returning 200 here keeps that path clean.
router.get('/arrivy', (_req: Request, res: Response): void => {
  res.json({ ok: true, message: 'Arrivy webhook endpoint — POST events here.' })
})

// Diagnostic: recent events. Behind JWT auth (mounted under a different
// router downstream — see index.ts wiring). The public POST route above
// stays auth-free.
export const arrivyWebhookAdminRouter = Router()
arrivyWebhookAdminRouter.get('/recent', (req: Request, res: Response): void => {
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query['limit'] || '50'), 10) || 50))
  const rows = db.prepare(
    `SELECT id, event_type, sub_status, arrivy_task_id, project_rid, customer_name,
            signature_ok, dispatched_at, dispatch_error, received_at
       FROM arrivy_webhook_events
      ORDER BY id DESC
      LIMIT ?`
  ).all(limit)
  res.json({ rows })
})

export const arrivyWebhookRouter = router
