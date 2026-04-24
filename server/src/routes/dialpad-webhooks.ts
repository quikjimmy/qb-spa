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
  state?: string
  direction?: string
  target?: { email?: string; name?: string }
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

// Turn a decoded payload into a row for insertion. Accepts both call and sms
// shapes; kind argument picks which extractor to use.
function flatten(kind: string, payload: Record<string, unknown>): Omit<DialpadEvent, 'id' | 'received_at'> {
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
    }
  }
  // call or generic
  const p = payload as CallPayload
  const user = p.target || p.user || p.operator || {}
  const dir = (p.direction || '').toLowerCase()
  return {
    event_kind: kind || 'call',
    event_state: firstNonEmpty(p.state),
    call_id: p.call_id != null ? String(p.call_id) : null,
    user_email: firstNonEmpty(user.email),
    user_name: firstNonEmpty(user.name),
    external_number: firstNonEmpty(p.external_number, p.contact?.phone, dir.includes('out') ? p.to_number : p.from_number),
    direction: dir.includes('out') ? 'outbound' : dir.includes('in') ? 'inbound' : null,
    raw_json: JSON.stringify(payload),
  }
}

// Handler factory — one signed endpoint per webhook kind.
function makeHandler(kind: 'call' | 'sms' | 'generic') {
  return (req: Request, res: Response): void => {
    const secret = loadWebhookSecret()
    if (!secret) { res.status(503).json({ error: 'Webhook secret not configured' }); return }
    const token = extractJwt(req)
    if (!token) { res.status(400).json({ error: 'Missing JWT payload' }); return }
    let decoded: Record<string, unknown>
    try {
      decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, unknown>
    } catch (e) {
      // Intentionally vague — don't leak why verification failed.
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }
    // Dialpad nests the actual payload under various keys depending on product;
    // check `payload`, fall through to the decoded JWT claims themselves.
    const payload = ((decoded as { payload?: Record<string, unknown> }).payload && typeof (decoded as { payload?: unknown }).payload === 'object')
      ? (decoded as { payload: Record<string, unknown> }).payload
      : decoded

    const flat = flatten(kind, payload)
    const result = db.prepare(
      `INSERT INTO dialpad_events (event_kind, event_state, call_id, user_email, user_name, external_number, direction, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(flat.event_kind, flat.event_state, flat.call_id, flat.user_email, flat.user_name, flat.external_number, flat.direction, flat.raw_json)
    const row = db.prepare(
      `SELECT id, event_kind, event_state, call_id, user_email, user_name, external_number, direction, raw_json, received_at
       FROM dialpad_events WHERE id = ?`
    ).get(Number(result.lastInsertRowid)) as DialpadEvent
    publish(row)
    res.status(200).json({ ok: true, id: row.id })
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
