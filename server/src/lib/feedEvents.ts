// In-process pub/sub for live feed items, mirroring lib/dialpadEvents.ts.
// Webhook-minted feed posts are published here and piped to any open
// /api/feed/stream connections. Single-instance Railway deploy → a Set
// of subscribers is enough; swap for a broker if we ever scale out.
import type { Response } from 'express'

// Matches the item shape GET /api/feed returns so the client can treat
// a streamed item exactly like a fetched one (reactions/media start empty).
export interface FeedStreamItem {
  id: number
  qb_source: string
  qb_record_id: number | null
  event_type: string
  title: string
  body: string | null
  actor_name: string | null
  actor_email: string | null
  project_id: number | null
  project_name: string | null
  metadata: string | null
  occurred_at: string
  comment_count: number
  reactions: unknown[]
  media: unknown[]
}

type Subscriber = (item: FeedStreamItem) => void

const subscribers = new Set<Subscriber>()

export function subscribeFeed(fn: Subscriber): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

export function publishFeedItem(item: FeedStreamItem): void {
  for (const fn of subscribers) {
    try { fn(item) } catch { /* swallow — one bad consumer shouldn't break others */ }
  }
}

export function attachFeedSseStream(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Disable Nginx-style proxy buffering if a proxy is in front.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  res.write(`: connected\n\n`)

  const send = (item: FeedStreamItem) => {
    res.write(`event: feed\n`)
    res.write(`data: ${JSON.stringify(item)}\n\n`)
  }
  const unsub = subscribeFeed(send)

  // Heartbeat every 25s keeps load balancers from killing idle connections.
  const heartbeat = setInterval(() => { res.write(`: ping\n\n`) }, 25_000)

  const cleanup = () => { clearInterval(heartbeat); unsub() }
  res.on('close', cleanup)
  res.on('error', cleanup)
}
