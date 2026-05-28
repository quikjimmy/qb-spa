// In-process pub/sub for Dialpad webhook events. Small enough that a Map of
// subscribers is fine — we don't need Redis for a single-instance Railway
// deploy. If we ever scale horizontally, swap this for a proper broker.
import type { Response } from 'express'

export interface DialpadEvent {
  id: number
  event_kind: string
  event_state: string | null
  call_id: string | null
  user_email: string | null
  user_name: string | null
  external_number: string | null
  direction: string | null
  // Routing-tree fields hoisted from raw_json. target_* = who Dialpad
  // chose to ring; entry_point_target_* = the public-facing line the
  // call entered on. Optional so legacy SELECT lists that omit them still
  // satisfy the type — PR-1b/c will tighten where they're actually used.
  target_kind?: string | null
  target_id?: string | null
  entry_point_target_kind?: string | null
  entry_point_target_id?: string | null
  raw_json: string
  received_at: string
}

type Subscriber = (event: DialpadEvent) => void

const subscribers = new Set<Subscriber>()

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

export function publish(event: DialpadEvent): void {
  for (const fn of subscribers) {
    try { fn(event) } catch { /* swallow — one bad consumer shouldn't break others */ }
  }
}

// SSE helper: writes event stream headers, pipes published events to the
// response, and cleans up the subscriber on disconnect. Optional `decorate`
// runs per-subscriber before serialization so per-user fields (is_mine,
// caller_kind, ...) can be stamped without contaminating the shared
// publish queue.
export function attachSseStream(
  res: Response,
  decorate?: (event: DialpadEvent) => Record<string, unknown>,
): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Disable Nginx-style proxy buffering if a proxy is in front.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  // Initial comment so the client knows the connection is open.
  res.write(`: connected\n\n`)

  const send = (event: DialpadEvent) => {
    const payload = decorate ? decorate(event) : event
    res.write(`event: dialpad\n`)
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  const unsub = subscribe(send)

  // Heartbeat every 25s keeps load balancers from killing idle connections.
  const heartbeat = setInterval(() => { res.write(`: ping\n\n`) }, 25_000)

  const cleanup = () => { clearInterval(heartbeat); unsub() }
  res.on('close', cleanup)
  res.on('error', cleanup)
}
