import { Router, type Request, type Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import db from '../db'

const router = Router()

function getJwtSecret() {
  return process.env['JWT_SECRET'] || 'dev-secret-change-me'
}

interface DbUser {
  id: number
  email: string
  name: string
  password_hash: string
  is_active: number
}

interface DbRole {
  name: string
}

function getUserRoles(userId: number): string[] {
  const rows = db.prepare(`
    SELECT r.name FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `).all(userId) as DbRole[]
  return rows.map(r => r.name)
}

function buildUserResponse(user: DbUser) {
  const roles = getUserRoles(user.id)
  return { id: user.id, email: user.email, name: user.name, roles }
}

router.post('/register', (req: Request, res: Response): void => {
  const { email, name, password } = req.body

  if (!email || !name || !password) {
    res.status(400).json({ error: 'Email, name, and password are required' })
    return
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    res.status(409).json({ error: 'Email already registered' })
    return
  }

  const passwordHash = bcrypt.hashSync(password, 10)

  const registerTransaction = db.transaction(() => {
    const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c
    const isFirstUser = userCount === 0

    const result = db.prepare(
      'INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)'
    ).run(email, name, passwordHash)

    const userId = result.lastInsertRowid as number

    const customerRole = db.prepare("SELECT id FROM roles WHERE name = 'customer'").get() as { id: number }
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, customerRole.id)

    if (isFirstUser) {
      const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: number }
      db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, adminRole.id)
    }

    return userId
  })

  const userId = registerTransaction()
  const roles = getUserRoles(userId)

  const token = jwt.sign(
    { userId, email, roles },
    getJwtSecret(),
    { expiresIn: '7d' }
  )

  res.status(201).json({
    token,
    user: { id: userId, email, name, roles },
  })
})

router.post('/login', (req: Request, res: Response): void => {
  const { email, password } = req.body

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' })
    return
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as DbUser | undefined

  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid email or password' })
    return
  }

  if (!user.is_active) {
    res.status(403).json({ error: 'Account is deactivated' })
    return
  }

  const roles = getUserRoles(user.id)

  const token = jwt.sign(
    { userId: user.id, email: user.email, roles },
    getJwtSecret(),
    { expiresIn: '7d' }
  )

  res.json({
    token,
    user: buildUserResponse(user),
  })
})

router.get('/me', (req: Request, res: Response): void => {
  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as {
      userId: number
    }
    const user = db.prepare('SELECT id, email, name, is_active FROM users WHERE id = ?').get(payload.userId) as DbUser | undefined

    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    res.json({ user: buildUserResponse(user) })
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

// Get current user's effective permissions (any authenticated user)
router.get('/my-permissions', (req: Request, res: Response): void => {
  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as { userId: number }

    const perms = db.prepare(`
      SELECT p.resource_type, p.resource_id,
        MAX(p.can_read) as can_read,
        MAX(p.can_write) as can_write
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ?
      GROUP BY p.resource_type, p.resource_id
      ORDER BY p.resource_type, p.resource_id
    `).all(payload.userId)

    res.json({ permissions: perms })
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

// Validate an invite token (GET so the frontend can check before showing the form)
router.get('/invite/:token', (req: Request, res: Response): void => {
  const user = db.prepare(
    'SELECT id, email, name, invite_expires_at FROM users WHERE invite_token = ?'
  ).get(req.params['token']) as { id: number; email: string; name: string; invite_expires_at: string } | undefined

  if (!user) {
    res.status(404).json({ error: 'Invalid invite link' })
    return
  }

  if (new Date(user.invite_expires_at) < new Date()) {
    res.status(410).json({ error: 'Invite link has expired' })
    return
  }

  res.json({ email: user.email, name: user.name })
})

// Accept invite — set password and activate
router.post('/invite/:token', (req: Request, res: Response): void => {
  const { password } = req.body

  if (!password || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' })
    return
  }

  const user = db.prepare(
    'SELECT id, email, name, invite_expires_at FROM users WHERE invite_token = ?'
  ).get(req.params['token']) as { id: number; email: string; name: string; invite_expires_at: string } | undefined

  if (!user) {
    res.status(404).json({ error: 'Invalid invite link' })
    return
  }

  if (new Date(user.invite_expires_at) < new Date()) {
    res.status(410).json({ error: 'Invite link has expired' })
    return
  }

  const passwordHash = bcrypt.hashSync(password, 10)
  db.prepare(
    'UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires_at = NULL, is_active = 1 WHERE id = ?'
  ).run(passwordHash, user.id)

  const roles = getUserRoles(user.id)
  const token = jwt.sign(
    { userId: user.id, email: user.email, roles },
    getJwtSecret(),
    { expiresIn: '7d' }
  )

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, roles },
  })
})

export { router as authRouter }
