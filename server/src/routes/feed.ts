import { Router, type Request, type Response } from 'express'
import db from '../db'
import { upload } from '../lib/upload'
import { generateThumbnail } from '../lib/media'
import { attachFeedSseStream } from '../lib/feedEvents'
import fs from 'fs'

const router = Router()

// Live feed stream (SSE). Auth via ?token= (EventSource can't set
// headers — authenticate middleware falls back to the query param).
// Referral Agent exclusion comes free and is LOAD-BEARING: the router
// mount's referralAgentScope 403s any param-less call from that role,
// and this stream is global/unfiltered — do NOT add a project_id
// passthrough here or Referral Agents could subscribe scoped but
// receive everything.
router.get('/stream', (_req: Request, res: Response): void => {
  attachFeedSseStream(res)
})

// Milestone families for the story-circle filters. Matches both the
// webhook-mint metadata (milestone_col) and legacy batch metadata
// (numeric fieldId) so pre-attribution rows still bucket correctly.
const FAMILY_DEF: Record<string, { cols: string[]; fids: number[] }> = {
  survey: { cols: ['survey_scheduled', 'survey_submitted', 'survey_approved'], fids: [166, 164, 165] },
  design: { cols: ['cad_submitted', 'design_completed'], fids: [699, 1774] },
  permit: { cols: ['permit_submitted', 'permit_approved', 'permit_rejected'], fids: [207, 208, 706] },
  nem: { cols: ['nem_submitted', 'nem_approved', 'nem_rejected'], fids: [326, 327, 1878] },
  install: { cols: ['install_scheduled', 'install_completed'], fids: [178, 534] },
  inspection: { cols: ['inspection_scheduled', 'inspection_passed'], fids: [226, 491] },
  pto: { cols: ['pto_submitted', 'pto_approved'], fids: [537, 538] },
}
const FAMILY_ORDER = ['survey', 'design', 'permit', 'nem', 'install', 'inspection', 'pto', 'status']

function familyForMeta(col: string | null, fid: number | null): string | null {
  for (const [family, def] of Object.entries(FAMILY_DEF)) {
    if (col && def.cols.includes(col)) return family
    if (fid != null && def.fids.includes(fid)) return family
  }
  return null
}

// Get feed items with pagination, optional filters
router.get('/', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const limit = Math.min(parseInt(req.query['limit'] as string) || 30, 100)
  const offset = parseInt(req.query['offset'] as string) || 0
  const actor = req.query['actor'] as string | undefined
  const actorName = req.query['actor_name'] as string | undefined
  const projectId = req.query['project_id'] as string | undefined
  const eventType = req.query['event_type'] as string | undefined
  const family = req.query['family'] as string | undefined
  const person = req.query['person'] as string | undefined

  let where = 'WHERE 1=1'
  const params: unknown[] = []

  if (actor) {
    where += ' AND f.actor_email = ?'
    params.push(actor)
  }
  if (actorName) {
    where += ' AND f.actor_name = ?'
    params.push(actorName)
  }
  if (projectId) {
    where += ' AND f.project_id = ?'
    params.push(parseInt(projectId))
  }
  if (eventType) {
    where += ' AND f.event_type = ?'
    params.push(eventType)
  }
  // Story-circle filters: a milestone family, or a person who is either
  // the credited actor OR tagged in metadata.mentions (coordinators are
  // mentions, never actors — see lib/feedMint.ts attribution rules).
  if (family === 'status') {
    where += " AND f.event_type = 'status_change'"
  } else if (family && FAMILY_DEF[family]) {
    const def = FAMILY_DEF[family]!
    where += ` AND f.event_type = 'milestone' AND json_valid(f.metadata) AND (
      json_extract(f.metadata, '$.milestone_col') IN (${def.cols.map(() => '?').join(',')})
      OR CAST(json_extract(f.metadata, '$.fieldId') AS INTEGER) IN (${def.fids.map(() => '?').join(',')})
    )`
    params.push(...def.cols, ...def.fids)
  }
  if (person) {
    where += ` AND (f.actor_name = ? OR (json_valid(f.metadata) AND (
      json_extract(f.metadata, '$.qb_last_modified_by') = ?
      OR EXISTS (
        SELECT 1 FROM json_each(json_extract(f.metadata, '$.mentions')) je
        WHERE json_extract(je.value, '$.name') = ?
      )
    )))`
    params.push(person, person, person)
  }

  // Sort by "when the feed learned it", not raw occurred_at: batch
  // backfill stamps scheduled milestones with the milestone date itself,
  // and a future-dated "Install Scheduled (Jun 22)" would otherwise pin
  // the top of the feed forever, burying live webhook posts beneath it.
  // MIN(occurred_at, ingested_at) keeps past events on their real date
  // and future-dated announcements on the day we learned about them.
  const items = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM comments c WHERE c.feed_item_id = f.id) as comment_count
    FROM feed_items f
    ${where}
    ORDER BY MIN(f.occurred_at, f.ingested_at) DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM feed_items f ${where}
  `).get(...params) as { count: number }

  // Get reactions for these items, grouped by emoji with count + whether current user reacted
  const itemIds = (items as Array<{ id: number }>).map(i => i.id)
  const reactionsMap: Record<number, Array<{ emoji: string; count: number; reacted: boolean }>> = {}

  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(',')
    const reactionRows = db.prepare(`
      SELECT r.feed_item_id, r.emoji, COUNT(*) as count,
        MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) as user_reacted
      FROM reactions r
      WHERE r.feed_item_id IN (${placeholders})
      GROUP BY r.feed_item_id, r.emoji
    `).all(userId, ...itemIds) as Array<{
      feed_item_id: number; emoji: string; count: number; user_reacted: number
    }>

    for (const row of reactionRows) {
      if (!reactionsMap[row.feed_item_id]) reactionsMap[row.feed_item_id] = []
      reactionsMap[row.feed_item_id]!.push({
        emoji: row.emoji,
        count: row.count,
        reacted: row.user_reacted === 1,
      })
    }
  }

  // Load media attachments for these items
  const mediaMap: Record<number, Array<Record<string, unknown>>> = {}
  if (itemIds.length > 0) {
    const mPlaceholders = itemIds.map(() => '?').join(',')
    const mediaRows = db.prepare(`
      SELECT * FROM media_attachments WHERE feed_item_id IN (${mPlaceholders}) ORDER BY sort_order
    `).all(...itemIds) as Array<Record<string, unknown> & { feed_item_id: number; file_name: string; thumb_file_name: string }>

    for (const row of mediaRows) {
      if (!mediaMap[row.feed_item_id]) mediaMap[row.feed_item_id] = []
      mediaMap[row.feed_item_id]!.push({
        id: row.id,
        url: `/uploads/${row.file_name}`,
        thumbUrl: row.thumb_file_name ? `/uploads/thumbs/${row.thumb_file_name}` : `/uploads/${row.file_name}`,
        mediaType: row.media_type,
        width: row.width,
        height: row.height,
        durationSec: row.duration_sec,
      })
    }
  }

  // Attach reactions + media to items
  const enrichedItems = (items as Array<Record<string, unknown>>).map(item => ({
    ...item,
    reactions: reactionsMap[(item as { id: number }).id] || [],
    media: mediaMap[(item as { id: number }).id] || [],
  }))

  // Story bubbles: people = credited actors ∪ mention-tagged names
  // (coordinators etc.). Attribution rules mean most QB posts have no
  // actor, so mentions carry the people row.
  let people: unknown[] = []
  try {
    people = db.prepare(`
      SELECT name, SUM(c) as activity_count, MAX(latest) as latest_activity FROM (
        SELECT actor_name as name, COUNT(*) as c, MAX(occurred_at) as latest
        FROM feed_items
        WHERE actor_name IS NOT NULL AND actor_name != 'System'
        GROUP BY actor_name
        UNION ALL
        SELECT json_extract(je.value, '$.name') as name, COUNT(*) as c, MAX(f.occurred_at) as latest
        FROM feed_items f, json_each(json_extract(f.metadata, '$.mentions')) je
        WHERE f.metadata IS NOT NULL AND json_valid(f.metadata)
        GROUP BY json_extract(je.value, '$.name')
        UNION ALL
        SELECT json_extract(metadata, '$.qb_last_modified_by') as name, COUNT(*) as c, MAX(occurred_at) as latest
        FROM feed_items
        WHERE actor_name IS NULL AND metadata IS NOT NULL AND json_valid(metadata)
        GROUP BY json_extract(metadata, '$.qb_last_modified_by')
      )
      WHERE name IS NOT NULL AND name != ''
      GROUP BY name
      ORDER BY latest_activity DESC
      LIMIT 30
    `).all()
  } catch (e) {
    console.error('[feed] people aggregation failed:', e instanceof Error ? e.message : e)
  }

  // Story bubbles: milestone families (+ status), bucketed from metadata.
  const families: Array<{ family: string; count: number; latest_activity: string }> = []
  try {
    const famRaw = db.prepare(`
      SELECT json_extract(metadata, '$.milestone_col') as col,
             CAST(json_extract(metadata, '$.fieldId') AS INTEGER) as fid,
             COUNT(*) as c, MAX(occurred_at) as latest
      FROM feed_items
      WHERE event_type = 'milestone' AND metadata IS NOT NULL AND json_valid(metadata)
      GROUP BY 1, 2
    `).all() as Array<{ col: string | null; fid: number | null; c: number; latest: string }>
    const agg = new Map<string, { count: number; latest_activity: string }>()
    for (const row of famRaw) {
      const fam = familyForMeta(row.col, row.fid)
      if (!fam) continue
      const cur = agg.get(fam)
      if (cur) { cur.count += row.c; if (row.latest > cur.latest_activity) cur.latest_activity = row.latest }
      else agg.set(fam, { count: row.c, latest_activity: row.latest })
    }
    const statusAgg = db.prepare(`
      SELECT COUNT(*) as c, MAX(occurred_at) as latest FROM feed_items WHERE event_type = 'status_change'
    `).get() as { c: number; latest: string | null }
    if (statusAgg.c > 0 && statusAgg.latest) agg.set('status', { count: statusAgg.c, latest_activity: statusAgg.latest })
    for (const fam of FAMILY_ORDER) {
      const entry = agg.get(fam)
      if (entry) families.push({ family: fam, ...entry })
    }
  } catch (e) {
    console.error('[feed] family aggregation failed:', e instanceof Error ? e.message : e)
  }

  // Get distinct event types for filter
  const eventTypes = db.prepare(`
    SELECT DISTINCT event_type FROM feed_items ORDER BY event_type
  `).all()

  res.json({
    items: enrichedItems,
    total: total.count,
    limit,
    offset,
    people,
    families,
    eventTypes,
  })
})

// Get comments for a feed item
router.get('/:id/comments', (req: Request, res: Response): void => {
  const comments = db.prepare(`
    SELECT c.*, u.name as user_name, u.email as user_email
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.feed_item_id = ?
    ORDER BY c.created_at ASC
  `).all(req.params['id'])

  res.json({ comments })
})

// Add a comment
router.post('/:id/comments', (req: Request, res: Response): void => {
  const feedItemId = parseInt(String(req.params['id'] || ''), 10)
  const { body } = req.body

  if (!body?.trim()) {
    res.status(400).json({ error: 'Comment body is required' })
    return
  }

  const feedItem = db.prepare('SELECT id FROM feed_items WHERE id = ?').get(feedItemId)
  if (!feedItem) {
    res.status(404).json({ error: 'Feed item not found' })
    return
  }

  const result = db.prepare(
    'INSERT INTO comments (feed_item_id, user_id, body) VALUES (?, ?, ?)'
  ).run(feedItemId, req.user!.userId, body.trim())

  const comment = db.prepare(`
    SELECT c.*, u.name as user_name, u.email as user_email
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(result.lastInsertRowid)

  res.status(201).json({ comment })
})

// Toggle a reaction (add if not exists, remove if exists)
router.post('/:id/reactions', (req: Request, res: Response): void => {
  const feedItemId = parseInt(String(req.params['id'] || ''), 10)
  const userId = req.user!.userId
  const { emoji } = req.body

  if (!emoji) {
    res.status(400).json({ error: 'emoji is required' })
    return
  }

  const existing = db.prepare(
    'SELECT id FROM reactions WHERE feed_item_id = ? AND user_id = ? AND emoji = ?'
  ).get(feedItemId, userId, emoji)

  if (existing) {
    db.prepare('DELETE FROM reactions WHERE feed_item_id = ? AND user_id = ? AND emoji = ?')
      .run(feedItemId, userId, emoji)
    res.json({ action: 'removed', emoji })
  } else {
    db.prepare('INSERT INTO reactions (feed_item_id, user_id, emoji) VALUES (?, ?, ?)')
      .run(feedItemId, userId, emoji)
    res.json({ action: 'added', emoji })
  }
})

// ─── Create a post (portal user) — supports text + media ─

router.post('/', upload.array('media', 10), async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId
  const { title, body, project_id, project_name, event_type } = req.body
  const files = (req.files as Express.Multer.File[]) || []

  if (!body?.trim() && !title?.trim() && files.length === 0) {
    res.status(400).json({ error: 'Post content or media is required' })
    return
  }

  const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId) as { name: string; email: string } | undefined
  if (!user) { res.status(404).json({ error: 'User not found' }); return }

  const result = db.prepare(`
    INSERT INTO feed_items
      (qb_source, qb_record_id, event_type, title, body, actor_name, actor_email,
       project_id, project_name, metadata, occurred_at)
    VALUES ('portal', NULL, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    event_type || 'user_post',
    title?.trim() || (body?.trim() || '').slice(0, 80) || 'Post',
    body?.trim() || '',
    user.name,
    user.email,
    project_id || null,
    project_name || null,
    JSON.stringify({ source: 'user', userId, hasMedia: files.length > 0 }),
  )

  const feedItemId = result.lastInsertRowid as number

  // Process media files
  const insertMedia = db.prepare(`
    INSERT INTO media_attachments
      (feed_item_id, file_name, original_name, mime_type, size_bytes, media_type, width, height, duration_sec, thumb_file_name, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    const isVideo = file.mimetype.startsWith('video/')
    const mediaType = isVideo ? 'video' : 'image'

    let width = 0
    let height = 0
    let thumbFileName: string | null = null

    if (!isVideo) {
      try {
        const thumb = await generateThumbnail(file.path)
        width = thumb.width
        height = thumb.height
        thumbFileName = thumb.thumbFileName
      } catch {
        // Thumbnail generation failed — use original
      }
    }

    insertMedia.run(
      feedItemId, file.filename, file.originalname, file.mimetype,
      file.size, mediaType, width || null, height || null,
      null, thumbFileName, i,
    )
  }

  // Return the created item with media
  const item = db.prepare('SELECT * FROM feed_items WHERE id = ?').get(feedItemId) as Record<string, unknown>
  const media = (db.prepare('SELECT * FROM media_attachments WHERE feed_item_id = ?').all(feedItemId) as Array<Record<string, unknown>>)
    .map(m => ({
      id: m.id,
      url: `/uploads/${m.file_name}`,
      thumbUrl: m.thumb_file_name ? `/uploads/thumbs/${m.thumb_file_name}` : `/uploads/${m.file_name}`,
      mediaType: m.media_type,
      width: m.width,
      height: m.height,
      durationSec: m.duration_sec,
    }))

  res.status(201).json({ item: { ...item, media, reactions: [] } })
})

// ─── Agent post endpoint (API key or JWT) ────────────────

router.post('/agent', (req: Request, res: Response): void => {
  const { agent_id, agent_name, title, body, event_type, project_id, project_name, status, duration_sec, records_processed, error_message } = req.body

  if (!agent_id || !title) {
    res.status(400).json({ error: 'agent_id and title are required' })
    return
  }

  const metadata = JSON.stringify({
    source: 'agent',
    agent_id,
    status: status || 'completed',
    duration_sec: duration_sec || null,
    records_processed: records_processed || null,
    error_message: error_message || null,
  })

  const result = db.prepare(`
    INSERT INTO feed_items
      (qb_source, qb_record_id, event_type, title, body, actor_name, actor_email,
       project_id, project_name, metadata, occurred_at)
    VALUES ('agent', NULL, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now'))
  `).run(
    event_type || 'agent_run',
    title,
    body || '',
    agent_name || agent_id,
    project_id || null,
    project_name || null,
    metadata,
  )

  const item = db.prepare('SELECT * FROM feed_items WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json({ item })
})

export { router as feedRouter }
