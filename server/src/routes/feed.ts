import { Router, type Request, type Response } from 'express'
import db from '../db'
import { upload } from '../lib/upload'
import { generateThumbnail } from '../lib/media'
import fs from 'fs'

const router = Router()

// Get feed items with pagination, optional filters
router.get('/', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const limit = Math.min(parseInt(req.query['limit'] as string) || 30, 100)
  const offset = parseInt(req.query['offset'] as string) || 0
  const actor = req.query['actor'] as string | undefined
  const actorName = req.query['actor_name'] as string | undefined
  const projectId = req.query['project_id'] as string | undefined
  const eventType = req.query['event_type'] as string | undefined

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

  const items = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM comments c WHERE c.feed_item_id = f.id) as comment_count
    FROM feed_items f
    ${where}
    ORDER BY f.occurred_at DESC
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

  // Get distinct actors with activity counts for the story bubbles
  const actors = db.prepare(`
    SELECT actor_name, actor_email, COUNT(*) as activity_count,
      MAX(occurred_at) as latest_activity
    FROM feed_items
    WHERE actor_name IS NOT NULL AND actor_name != 'System'
    GROUP BY actor_name
    ORDER BY latest_activity DESC
    LIMIT 30
  `).all()

  // Get distinct event types for filter
  const eventTypes = db.prepare(`
    SELECT DISTINCT event_type FROM feed_items ORDER BY event_type
  `).all()

  res.json({
    items: enrichedItems,
    total: total.count,
    limit,
    offset,
    actors,
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
  const feedItemId = parseInt(req.params['id']!, 10)
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
  const feedItemId = parseInt(req.params['id']!, 10)
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
  const media = db.prepare('SELECT * FROM media_attachments WHERE feed_item_id = ?').all(feedItemId)
    .map((m: Record<string, unknown>) => ({
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
