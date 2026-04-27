// Public webhook ingest — NOT behind JWT auth. Dialpad signs each webhook as
// a JWT using the secret we provided when registering the subscription; we
// verify with that secret and only accept valid signatures.
//
// Dialpad webhook flow:
//   1. We store a secret (generated in admin UI) per org
//   2. We register the webhook URL + secret via Dialpad's subscription API (or
//      manually in their dashboard) — out of scope for this endpoint
//   3. On each event Dialpad POSTs { payload: "<jwt>" } (body shape varies by
//      product area; we also accept the raw JWT as the body or in Authorization)
//   4. JWT header uses HS256; signature is HMAC-SHA256(body, secret)
//
// Any of the JWT deliveries below are accepted so we're not brittle to the
// exact shape Dialpad chose for a given product:
//   - Content-Type application/jwt  → body is the raw JWT
//   - application/json with { payload: "<jwt>" }  → extract payload
//   - Authorization: Bearer <jwt>  → extract header
import { Router, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import db from '../db'
import { decryptSecret } from '../lib/crypto'
import { publish, type DialpadEvent } from '../lib/dialpadEvents'

const router = Router()

// Accept raw JWT bodies as plain text. express.json() elsewhere already
// handles application/json — but application/jwt arrives as text/plain or
// application/jwt and must be read as a string.
import express from 'express'
router.use(express.text({ type: ['application/jwt', 'text/plain'], limit: '128kb' }))

function loadWebhookSecret(): string | null {
  const row = db.prepare(`SELECT webhook_secret_encrypted FROM dialpad_config WHERE id = 1`).get() as { webhook_secret_encrypted: string | null } | undefined
  if (!row?.webhook_secret_encrypted) return null
  try { return decryptSecret(row.webhook_secret_encrypted) } catch { return null }
}

function extractJwt(req: Request): string | null {
  // Authorization header
  const auth = req.header('authorization') || req.header('Authorization') || ''
  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i)
  if (bearerMatch) return bearerMatch[1]!.trim()
  // Body: string (application/jwt or text/plain)
  if (typeof req.body === 'string' && req.body.trim()) return req.body.trim()
  // Body: { payload: "<jwt>" }
  if (req.body && typeof req.body === 'object' && typeof (req.body as { payload?: string }).payload === 'string') {
    return (req.body as { payload: string }).payload.trim()
  }
  return null
}

interface CallPayload {
  call_id?: string | number
  master_call_id?: string | number
  state?: string
  event_type?: string
  call_state?: string
  type?: string
  direction?: string
  target?: { email?: string; name?: string; type?: string }
  user?: { email?: string; name?: string }
  operator?: { email?: string; name?: string }
  contact?: { phone?: string }
  external_number?: string
  from_number?: string
  to_number?: string
}
interface SmsPayload {
  id?: string | number
  direction?: string
  from_number?: string
  to_number?: string
  from_user?: { email?: string; name?: string }
  to_user?: { email?: string; name?: string }
  text?: string
}

function firstNonEmpty(...vals: Array<string | undefined | null>): string | null {
  for (const v of vals) { if (v && String(v).trim() !== '') return String(v) }
  return null
}

// Auto-subscribe creates both call + SMS subscriptions pointing at the same
// webhook URL. So when kind is 'generic' we inspect the payload to figure out
// whether this is a call or an SMS before classifying.
function inferKind(payload: Record<string, unknown>): 'call' | 'sms' | 'generic' {
  // SMS events typically carry a text body and from/to numbers, no call_id.
  // Cast a wide net on field names — Dialpad uses several variants across
  // products and plan tiers.
  const smsFields = ['text', 'message', 'body', 'message_body', 'sms_body']
  for (const k of smsFields) {
    if (k in payload && typeof payload[k] === 'string' && (payload[k] as string).length > 0) return 'sms'
  }
  if ('message_id' in payload || 'sms_id' in payload) return 'sms'
  if ('event_type' in payload && typeof payload['event_type'] === 'string' && /sms|text|message/i.test(payload['event_type'] as string)) return 'sms'
  if (('from_number' in payload || 'to_number' in payload) && !('call_id' in payload) && !('state' in payload)) return 'sms'
  // Call events have call_id + state.
  if ('call_id' in payload || 'master_call_id' in payload) return 'call'
  if ('state' in payload || 'call_state' in payload) return 'call'
  return 'generic'
}

// Turn a decoded payload into a row for insertion. Accepts both call and sms
// shapes; kind argument picks which extractor to use. When 'generic', infer
// from payload shape.
// Walk common Dialpad payload shapes for the message body. Dialpad's
// SMS events deliver the text at the top level (per the OpenAPI spec's
// SMSProto), but we also tolerate nested shapes seen on some tenants.
function findSmsText(payload: Record<string, unknown>): string | null {
  const direct = payload['text'] || payload['message'] || payload['body'] || payload['message_body'] || payload['content']
  if (typeof direct === 'string' && direct.trim()) return direct
  for (const key of ['data', 'sms', 'message_object', 'event']) {
    const nested = payload[key]
    if (nested && typeof nested === 'object') {
      const inner = findSmsText(nested as Record<string, unknown>)
      if (inner) return inner
    }
  }
  return null
}

function flatten(kind: string, payload: Record<string, unknown>): Omit<DialpadEvent, 'id' | 'received_at'> & { text_body?: string | null } {
  if (kind === 'generic') kind = inferKind(payload)
  if (kind === 'sms') {
    const p = payload as SmsPayload
    const dir = (p.direction || '').toLowerCase()
    const user = dir.includes('in') ? p.to_user : p.from_user
    return {
      event_kind: 'sms',
      event_state: 'received',
      call_id: p.id != null ? String(p.id) : null,
      user_email: firstNonEmpty(user?.email),
      user_name: firstNonEmpty(user?.name),
      external_number: firstNonEmpty(dir.includes('in') ? p.from_number : p.to_number),
      direction: dir.includes('in') ? 'incoming' : dir.includes('out') ? 'outgoing' : null,
      raw_json: JSON.stringify(payload),
      // Populated when the subscription is configured with status:false
      // and Dialpad delivers the actual SMS event with text. Status-only
      // payloads have no text and we fall back to null.
      text_body: findSmsText(payload),
    }
  }
  // call or generic — Dialpad's payload shape varies across event types.
  // Check a handful of known locations for state/direction/user/number so we
  // don't render four identical cards for a single call's lifecycle.
  const p = payload as CallPayload
  const user = p.target || p.user || p.operator || {}
  const dir = (p.direction || '').toLowerCase()

  // Strip an optional "call." prefix some Dialpad events use (e.g. "call.connected").
  const rawState = firstNonEmpty(p.state, p.call_state, p.event_type, p.type) || ''
  const state = rawState.replace(/^call\./i, '').toLowerCase() || null

  return {
    event_kind: kind || 'call',
    event_state: state,
    call_id: firstNonEmpty(
      p.call_id != null ? String(p.call_id) : null,
      p.master_call_id != null ? String(p.master_call_id) : null,
    ),
    user_email: firstNonEmpty(user.email),
    user_name: firstNonEmpty(user.name),
    external_number: firstNonEmpty(p.external_number, p.contact?.phone, dir.includes('out') ? p.to_number : p.from_number),
    direction: dir.includes('out') ? 'outbound' : dir.includes('in') ? 'inbound' : null,
    raw_json: JSON.stringify(payload),
  }
}

// Record each delivery attempt so admins can tell "Dialpad isn't firing"
// apart from "Dialpad fires but we reject". Truncates the body preview
// aggressively — we don't need the full JWT, just enough to eyeball shape.
function logDelivery(args: {
  path: string; method: string; contentType: string | null; bodyPreview: string
  signatureOk: boolean | null; inferredKind: string | null; statusCode: number
  error: string | null; storedEventId: number | null
}): void {
  db.prepare(
    `INSERT INTO dialpad_webhook_deliveries
       (path, method, content_type, body_preview, signature_ok, inferred_kind, status_code, error, stored_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.path, args.method, args.contentType, args.bodyPreview,
    args.signatureOk === null ? null : (args.signatureOk ? 1 : 0),
    args.inferredKind, args.statusCode, args.error, args.storedEventId,
  )
  // Keep the delivery log small — trim to 500 rows so it doesn't grow forever.
  db.prepare(`DELETE FROM dialpad_webhook_deliveries WHERE id < (SELECT MAX(id) - 499 FROM dialpad_webhook_deliveries)`).run()
}

function bodyPreviewOf(req: Request): string {
  if (typeof req.body === 'string') return req.body.slice(0, 500)
  if (req.body && typeof req.body === 'object') {
    try { return JSON.stringify(req.body).slice(0, 500) } catch { return '[unserializable]' }
  }
  return ''
}

// Handler factory — one signed endpoint per webhook kind.
function makeHandler(kind: 'call' | 'sms' | 'generic') {
  return (req: Request, res: Response): void => {
    const meta = {
      path: req.originalUrl || req.url,
      method: req.method,
      contentType: req.header('content-type') || null,
      bodyPreview: bodyPreviewOf(req),
    }
    const secret = loadWebhookSecret()
    if (!secret) {
      logDelivery({ ...meta, signatureOk: null, inferredKind: kind, statusCode: 503, error: 'Webhook secret not configured', storedEventId: null })
      res.status(503).json({ error: 'Webhook secret not configured' }); return
    }
    const token = extractJwt(req)
    if (!token) {
      logDelivery({ ...meta, signatureOk: null, inferredKind: kind, statusCode: 400, error: 'Missing JWT payload', storedEventId: null })
      res.status(400).json({ error: 'Missing JWT payload' }); return
    }
    let decoded: Record<string, unknown>
    try {
      decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, unknown>
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logDelivery({ ...meta, signatureOk: false, inferredKind: kind, statusCode: 401, error: `JWT verify: ${msg}`, storedEventId: null })
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }
    const payload = ((decoded as { payload?: Record<string, unknown> }).payload && typeof (decoded as { payload?: unknown }).payload === 'object')
      ? (decoded as { payload: Record<string, unknown> }).payload
      : decoded

    const flat = flatten(kind, payload)
    const result = db.prepare(
      `INSERT INTO dialpad_events (event_kind, event_state, call_id, user_email, user_name, external_number, direction, raw_json, text_body, text_body_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      flat.event_kind, flat.event_state, flat.call_id, flat.user_email, flat.user_name,
      flat.external_number, flat.direction, flat.raw_json,
      ('text_body' in flat ? flat.text_body : null) || null,
      ('text_body' in flat && flat.text_body) ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    )
    const row = db.prepare(
      `SELECT id, event_kind, event_state, call_id, user_email, user_name, external_number, direction, raw_json, received_at
       FROM dialpad_events WHERE id = ?`
    ).get(Number(result.lastInsertRowid)) as DialpadEvent
    publish(row)
    logDelivery({ ...meta, signatureOk: true, inferredKind: flat.event_kind, statusCode: 200, error: null, storedEventId: row.id })
    res.status(200).json({ ok: true, id: row.id, kind: flat.event_kind })
  }
}

router.post('/call', makeHandler('call'))
router.post('/sms', makeHandler('sms'))
router.post('/', makeHandler('generic'))  // catch-all

// Liveness (no auth; can be pinged to verify Dialpad can reach us)
router.get('/health', (_req: Request, res: Response): void => {
  const secret = loadWebhookSecret()
  res.json({ ok: true, secret_configured: !!secret })
})

export { router as dialpadWebhookRouter }
