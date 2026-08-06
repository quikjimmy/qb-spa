// Durable upload queue.
//
// A crew in a dead zone — a metal roof, a basement panel, a rural install —
// must be able to keep shooting. Photos go into IndexedDB (not memory), so
// they survive a reload, a backgrounded tab, or a phone that dies on the way
// home, and drain automatically when the connection returns.
//
// IndexedDB stores Blobs natively via structured clone, so the actual image
// bytes are kept, not a reference to a File the OS may release.
//
// Honest limitation: this drains while the page is open. Background Sync would
// let it run with the tab closed, but iOS Safari doesn't implement it and most
// field phones are iPhones — promising background upload there would be a lie.
// The UI therefore tells people to keep the tab open until the count hits zero.
import { ref, computed } from 'vue'
import { authHeaders } from '@/lib/photoguard'
import { isOnline, uploadSample, recordSample } from '@/lib/connectivity'

const DB_NAME = 'photoguard'
const DB_VERSION = 1
const STORE = 'uploads'

export interface QueuedUpload {
  id: string
  submissionId: number
  fieldHash: string
  fieldLabel: string
  source: 'camera' | 'upload' | 'video_frame'
  filename: string
  capturedAt: string
  lat: number | null
  lng: number | null
  blob: Blob
  bytes: number
  attempts: number
  lastError: string
  createdAt: string
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('submissionId', 'submissionId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB error'))
  }))
}

// ─── Reactive view ────────────────────────────────────────────────────

const items = ref<QueuedUpload[]>([])
const draining = ref(false)
const lastError = ref('')

export const queueCount = computed(() => items.value.length)
export const queueBytes = computed(() => items.value.reduce((n, i) => n + i.bytes, 0))

/** Pending uploads for one requirement, so a tile can show "1 waiting". */
export function queuedFor(fieldHash: string): QueuedUpload[] {
  return items.value.filter(i => i.fieldHash === fieldHash)
}

export async function refreshQueue(): Promise<void> {
  try {
    const all = await tx<QueuedUpload[]>('readonly', s => s.getAll() as IDBRequest<QueuedUpload[]>)
    items.value = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } catch {
    items.value = []
  }
}

export async function enqueue(item: Omit<QueuedUpload, 'id' | 'attempts' | 'lastError' | 'createdAt'>): Promise<void> {
  const full: QueuedUpload = {
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    attempts: 0,
    lastError: '',
    createdAt: new Date().toISOString(),
  }
  await tx('readwrite', s => s.put(full))
  await refreshQueue()
}

async function remove(id: string): Promise<void> {
  await tx('readwrite', s => s.delete(id))
}

async function update(item: QueuedUpload): Promise<void> {
  await tx('readwrite', s => s.put(item))
}

export async function clearQueue(): Promise<void> {
  await tx('readwrite', s => s.clear())
  await refreshQueue()
}

// ─── Draining ─────────────────────────────────────────────────────────

/** Transport-level failure = worth retrying. A 4xx from our own API is not:
 *  re-sending a photo the server has already rejected just burns battery. */
function isRetryable(status: number | null): boolean {
  if (status == null) return true          // fetch threw — network
  if (status === 429) return true
  return status >= 500
}

const MAX_ATTEMPTS = 8

export async function drainQueue(onUploaded?: () => void): Promise<void> {
  if (draining.value || !navigator.onLine) return
  draining.value = true
  lastError.value = ''
  try {
    await refreshQueue()
    for (const item of [...items.value]) {
      if (!navigator.onLine) break

      const fd = new FormData()
      fd.append('file', item.blob, item.filename)
      fd.append('submissionId', String(item.submissionId))
      fd.append('fieldHash', item.fieldHash)
      fd.append('source', item.source)
      fd.append('capturedAt', item.capturedAt)
      if (item.lat != null) fd.append('lat', String(item.lat))
      if (item.lng != null) fd.append('lng', String(item.lng))

      const t0 = performance.now()
      let status: number | null = null
      try {
        const res = await fetch('/api/photoguard/upload', {
          method: 'POST', headers: authHeaders(), body: fd,
        })
        status = res.status
        if (res.ok) {
          // Every drained upload doubles as a throughput measurement.
          recordSample(item.submissionId, uploadSample(
            item.bytes, performance.now() - t0,
            item.lat != null && item.lng != null ? { lat: item.lat, lng: item.lng } : null,
          ))
          await remove(item.id)
          onUploaded?.()
          continue
        }
        const body = await res.json().catch(() => ({})) as { error?: string }
        item.lastError = body.error || `Upload failed (${res.status})`
      } catch (e) {
        status = null
        item.lastError = e instanceof Error ? e.message : 'Network error'
      }

      item.attempts++
      if (!isRetryable(status) || item.attempts >= MAX_ATTEMPTS) {
        // Keep it, but stop hammering — surfaced in the UI for a manual call.
        item.lastError += item.attempts >= MAX_ATTEMPTS ? ' (gave up retrying)' : ' (rejected)'
      }
      lastError.value = item.lastError
      await update(item)
      await refreshQueue()
      // Don't spin the whole queue against a wall.
      if (status == null) break
    }
  } finally {
    draining.value = false
    await refreshQueue()
  }
}

let started = false
let timer: ReturnType<typeof setInterval> | null = null

/** Start automatic draining: on reconnect, and on a slow poll as a backstop
 *  for flaky links where the `online` event never fires. */
export function startQueueWorker(onUploaded?: () => void): () => void {
  void refreshQueue()
  const kick = () => { void drainQueue(onUploaded) }

  if (!started) started = true
  window.addEventListener('online', kick)
  timer = setInterval(() => { if (navigator.onLine && items.value.length) kick() }, 20_000)
  kick()

  return () => {
    window.removeEventListener('online', kick)
    if (timer) { clearInterval(timer); timer = null }
  }
}

export function useUploadQueue() {
  return { items, queueCount, queueBytes, draining, lastError, isOnline, drainQueue, refreshQueue, clearQueue }
}
