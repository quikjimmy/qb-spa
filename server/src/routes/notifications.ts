import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

// Get notifications for current user
router.get('/', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const limit = Math.min(parseInt(req.query['limit'] as string) || 20, 50)

  const items = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit)

  const unread = db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(userId) as { count: number }

  res.json({ notifications: items, unreadCount: unread.count })
})

// Get unread count only (lightweight poll)
router.get('/unread-count', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const unread = db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(userId) as { count: number }

  res.json({ count: unread.count })
})

// Mark one as read
router.put('/:id/read', (req: Request, res: Response): void => {
  db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?'
  ).run(req.params['id'], req.user!.userId)
  res.json({ success: true })
})

// Mark all as read
router.put('/read-all', (req: Request, res: Response): void => {
  db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0'
  ).run(req.user!.userId)
  res.json({ success: true })
})

// Create notification (for other services / agents to call)
router.post('/', (req: Request, res: Response): void => {
  const { user_id, type, title, body, link } = req.body

  if (!user_id || !title) {
    res.status(400).json({ error: 'user_id and title are required' })
    return
  }

  const result = db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)'
  ).run(user_id, type || 'info', title, body || null, link || null)

  res.status(201).json({ id: result.lastInsertRowid })
})

// Bulk create (for all users or specific users)
router.post('/broadcast', (req: Request, res: Response): void => {
  const { user_ids, type, title, body, link } = req.body

  if (!title) {
    res.status(400).json({ error: 'title is required' })
    return
  }

  const insert = db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)'
  )

  let targets: number[]
  if (user_ids && Array.isArray(user_ids)) {
    targets = user_ids
  } else {
    // Broadcast to all active users
    targets = (db.prepare('SELECT id FROM users WHERE is_active = 1').all() as Array<{ id: number }>).map(u => u.id)
  }

  const tx = db.transaction(() => {
    for (const uid of targets) {
      insert.run(uid, type || 'info', title, body || null, link || null)
    }
  })
  tx()

  res.json({ sent: targets.length })
})

export { router as notificationsRouter }
