// In-process pub/sub for PhotoGuard live updates, mirroring lib/feedEvents.ts.
// Single-instance Railway deploy → a Set of subscribers is enough.
import type { Response } from 'express'

export type PhotoGuardEventType =
  | 'scan_started' | 'scan_progress' | 'scan_complete' | 'scan_failed'
  | 'photo_added' | 'photo_validated' | 'photo_reviewed'
  | 'form_imported'

export interface PhotoGuardEvent {
  type: PhotoGuardEventType
  taskId?: number
  photoId?: number
  arrivyTaskId?: string
  status?: string
  message?: string
  // Free-form payload so a consumer can patch its local row without refetching.
  data?: Record<string, unknown>
  at: string
}

type Subscriber = (evt: PhotoGuardEvent) => void

const subscribers = new Set<Subscriber>()

export function subscribePhotoGuard(fn: Subscriber): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

export function publishPhotoGuardEvent(evt: Omit<PhotoGuardEvent, 'at'>): void {
  const full: PhotoGuardEvent = { ...evt, at: new Date().toISOString() }
  for (const fn of subscribers) {
    try { fn(full) } catch { /* one bad consumer shouldn't break others */ }
  }
}

export function attachPhotoGuardSseStream(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  res.write(`: connected\n\n`)

  const send = (evt: PhotoGuardEvent) => {
    res.write(`event: photoguard\n`)
    res.write(`data: ${JSON.stringify(evt)}\n\n`)
  }
  const unsub = subscribePhotoGuard(send)

  const heartbeat = setInterval(() => { res.write(`: ping\n\n`) }, 25_000)

  const cleanup = () => { clearInterval(heartbeat); unsub() }
  res.on('close', cleanup)
  res.on('error', cleanup)
}
