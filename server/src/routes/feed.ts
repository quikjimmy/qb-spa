import { Router, type Request, type Response } from 'express'
import db from '../db'

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

  // Attach reactions to items
  const enrichedItems = (items as Array<Record<string, unknown>>).map(item => ({
    ...item,
    reactions: reactionsMap[(item as { id: number }).id] || [],
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

export { router as feedRouter }
