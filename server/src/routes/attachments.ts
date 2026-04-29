import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

// QB attachments table: br9kwm8ke
//   3   Record ID#
//   1   Date Created
//   7   File attachment (file field — value is { versions: [...] })
//   19  Attachment Type (text)
//   38  Display Image (boolean)
//   22  Related Project
//   60  Related Note
//   62  Related Survey
//   76  Related Sales Task Submission
//   77  Related Sales Task
//   78  Related Ticket
//   79  Related Interconnection (NEM)
//   80  Related Permit
const ATTACH_TABLE = 'br9kwm8ke'
const F = {
  recordId: 3,
  dateCreated: 1,
  file: 7,
  link: 8,
  attachmentType: 19,
  displayImage: 38,
  relatedProject: 22,
  relatedNote: 60,
  relatedSurvey: 62,
  relatedSalesTaskSubmission: 76,
  relatedSalesTask: 77,
  relatedTicket: 78,
  relatedInterconnection: 79,
  relatedPermit: 80,
}
const SELECT_FIDS = [
  F.recordId, F.dateCreated, F.file, F.link, F.attachmentType, F.displayImage,
  F.relatedProject, F.relatedNote, F.relatedSurvey,
  F.relatedSalesTaskSubmission, F.relatedSalesTask,
  F.relatedTicket, F.relatedInterconnection, F.relatedPermit,
]

function val(record: Record<string, { value: unknown }>, fid: number): string {
  const v = record[String(fid)]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}

// QB file attachment values come back as objects:
//   { url?: string, versions: [{ fileName, uploaded, creator, ... }] }
// We persist filename + the full object as JSON so the client can render
// a download link without another QB round-trip.
function extractFile(record: Record<string, { value: unknown }>): { fileName: string; raw: string | null } {
  const v = record[String(F.file)]?.value
  if (!v) return { fileName: '', raw: null }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>
    let fileName = ''
    const versions = obj['versions']
    if (Array.isArray(versions) && versions.length > 0) {
      const last = versions[versions.length - 1] as Record<string, unknown>
      fileName = String(last['fileName'] ?? '')
    }
    return { fileName, raw: JSON.stringify(v) }
  }
  return { fileName: String(v), raw: String(v) }
}

// ── Cache ──
db.exec(`
  CREATE TABLE IF NOT EXISTS attachment_cache (
    record_id INTEGER PRIMARY KEY,
    project_rid INTEGER,
    date_created TEXT,
    file_name TEXT,
    file_blob TEXT,
    link_url TEXT,
    attachment_type TEXT,
    display_image INTEGER,
    related_note INTEGER,
    related_survey INTEGER,
    related_sales_task_submission INTEGER,
    related_sales_task INTEGER,
    related_ticket INTEGER,
    related_interconnection INTEGER,
    related_permit INTEGER,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_attach_project ON attachment_cache(project_rid)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_attach_date ON attachment_cache(date_created DESC)`)
// Defensive add for environments where the table predates the link_url column.
{
  try {
    const cols = db.prepare(`PRAGMA table_info(attachment_cache)`).all() as Array<{ name: string }>
    if (!cols.find(c => c.name === 'link_url')) {
      db.exec(`ALTER TABLE attachment_cache ADD COLUMN link_url TEXT`)
    }
  } catch { /* swallow — duplicate-column races on hot reload */ }
}

async function refreshForProject(projectId: number): Promise<{ total: number }> {
  const { realm, token } = getQbConfig()
  if (!token) throw new Error('QB_USER_TOKEN not configured')

  const res = await fetch('https://api.quickbase.com/v1/records/query', {
    method: 'POST',
    headers: {
      'QB-Realm-Hostname': realm,
      'Authorization': `QB-USER-TOKEN ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: ATTACH_TABLE,
      select: SELECT_FIDS,
      where: `{'${F.relatedProject}'.EX.'${projectId}'}`,
      sortBy: [{ fieldId: F.dateCreated, order: 'DESC' }],
      options: { top: 1000 },
    }),
  })
  if (!res.ok) {
    throw new Error(`QB attachment query failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { data?: Array<Record<string, { value: unknown }>> }
  const records = data.data ?? []

  const tx = db.transaction((rows: typeof records) => {
    db.prepare(`DELETE FROM attachment_cache WHERE project_rid = ?`).run(projectId)
    const insert = db.prepare(`
      INSERT OR REPLACE INTO attachment_cache (
        record_id, project_rid, date_created, file_name, file_blob, link_url,
        attachment_type, display_image,
        related_note, related_survey, related_sales_task_submission,
        related_sales_task, related_ticket, related_interconnection, related_permit,
        cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
    for (const r of rows) {
      const rid = parseInt(val(r, F.recordId))
      if (!rid) continue
      const projRid = parseInt(val(r, F.relatedProject)) || projectId
      const file = extractFile(r)
      insert.run(
        rid, projRid,
        val(r, F.dateCreated) || null,
        file.fileName,
        file.raw,
        val(r, F.link) || null,
        val(r, F.attachmentType) || null,
        val(r, F.displayImage) === 'true' ? 1 : 0,
        parseInt(val(r, F.relatedNote)) || null,
        parseInt(val(r, F.relatedSurvey)) || null,
        parseInt(val(r, F.relatedSalesTaskSubmission)) || null,
        parseInt(val(r, F.relatedSalesTask)) || null,
        parseInt(val(r, F.relatedTicket)) || null,
        parseInt(val(r, F.relatedInterconnection)) || null,
        parseInt(val(r, F.relatedPermit)) || null,
      )
    }
  })
  tx(records)

  return { total: records.length }
}

// GET /api/attachments?project_id=N
//   ?live=1 (default) refreshes from QB before responding. Defensive
//   fallback to cache if the QB call fails so a hiccup never blanks the UI.
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const projectId = parseInt(String(req.query['project_id'] || ''), 10)
  if (!Number.isFinite(projectId) || projectId <= 0) {
    res.status(400).json({ error: 'project_id is required' })
    return
  }
  const live = req.query['live'] !== '0'
  try {
    if (live) {
      try { await refreshForProject(projectId) }
      catch (e) {
        console.error('[attachments] live refresh failed:', e instanceof Error ? e.message : e)
      }
    }
    const items = db.prepare(`
      SELECT record_id, project_rid, date_created, file_name, file_blob, link_url,
             attachment_type, display_image,
             related_note, related_survey, related_sales_task_submission,
             related_sales_task, related_ticket, related_interconnection, related_permit
      FROM attachment_cache
      WHERE project_rid = ?
      ORDER BY date_created DESC, record_id DESC
    `).all(projectId)
    res.json({ items, count: items.length })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// ─── Link preview ──────────────────────────────────────────
// GET /api/attachments/preview?url=<encoded>
// Returns { image, title, site, favicon } parsed from the URL's HTML head.
// Best-effort: scrapes <meta property="og:image"|"og:title"|"og:site_name">
// + Twitter fallbacks + <link rel="icon">. Memory-cached per URL so the
// same link doesn't refetch every load.

interface LinkPreview { image: string | null; title: string | null; site: string | null; favicon: string | null }
const previewCache = new Map<string, { value: LinkPreview; ts: number }>()
const PREVIEW_TTL_MS = 60 * 60 * 1000 // 1h

function pickMeta(html: string, names: string[]): string | null {
  // Match <meta property="..." content="..."> or content-first ordering, single/double quotes.
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${n}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, 'i')
    const m = html.match(re)
    if (m && m[1]) return m[1]
    const re2 = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name)\\s*=\\s*["']${n}["']`, 'i')
    const m2 = html.match(re2)
    if (m2 && m2[1]) return m2[1]
  }
  return null
}

function pickFavicon(html: string): string | null {
  const m = html.match(/<link[^>]+rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*href\s*=\s*["']([^"']+)["']/i)
    ?? html.match(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["'][^"']*icon[^"']*["']/i)
  return m?.[1] ?? null
}

function abs(base: string, maybeRelative: string | null): string | null {
  if (!maybeRelative) return null
  try { return new URL(maybeRelative, base).toString() } catch { return null }
}

router.get('/preview', async (req: Request, res: Response): Promise<void> => {
  const raw = String(req.query['url'] || '').trim()
  if (!raw) { res.status(400).json({ error: 'url required' }); return }
  let url: URL
  try {
    url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      res.status(400).json({ error: 'unsupported protocol' }); return
    }
  } catch { res.status(400).json({ error: 'invalid url' }); return }

  const cached = previewCache.get(url.toString())
  if (cached && Date.now() - cached.ts < PREVIEW_TTL_MS) {
    res.json(cached.value)
    return
  }

  try {
    const r = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KinPortal/1.0; +https://kin.example)',
        'Accept': 'text/html,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(7_000),
    })
    if (!r.ok) {
      const fallback: LinkPreview = { image: null, title: null, site: url.hostname, favicon: `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=64` }
      previewCache.set(url.toString(), { value: fallback, ts: Date.now() })
      res.json(fallback)
      return
    }
    // Read up to 256 KB — meta tags live in <head>, no need for the full body.
    const buf = await r.arrayBuffer()
    const limited = buf.byteLength > 256 * 1024 ? buf.slice(0, 256 * 1024) : buf
    const html = Buffer.from(limited).toString('utf-8')

    const ogImage = pickMeta(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'])
    const ogTitle = pickMeta(html, ['og:title', 'twitter:title'])
      ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
      ?? null
    const ogSite = pickMeta(html, ['og:site_name', 'application-name']) ?? url.hostname
    const fav = pickFavicon(html)

    const value: LinkPreview = {
      image: abs(url.toString(), ogImage),
      title: ogTitle,
      site: ogSite,
      favicon: abs(url.toString(), fav) ?? `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=64`,
    }
    previewCache.set(url.toString(), { value, ts: Date.now() })
    res.json(value)
  } catch (e) {
    // Network / timeout / abort — return the favicon-only fallback so the UI
    // still has something to render and doesn't show a hard error.
    const fallback: LinkPreview = { image: null, title: null, site: url.hostname, favicon: `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=64` }
    previewCache.set(url.toString(), { value: fallback, ts: Date.now() })
    res.json(fallback)
    void e
  }
})

export { router as attachmentsRouter }
