import { Router, type Request, type Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import db from '../db'
import { sendEmail } from '../lib/email'

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

function getCommsRingScope(userId: number): 'mine' | 'all' {
  const row = db.prepare(`SELECT comms_ring_scope FROM users WHERE id = ?`).get(userId) as { comms_ring_scope: string | null } | undefined
  return row?.comms_ring_scope === 'all' ? 'all' : 'mine'
}

// rolesOverride lets the "View as role" flow present the impersonated role to
// the client (so role-based UI gating behaves exactly as that role would)
// without touching the admin's real role assignments.
function buildUserResponse(user: DbUser, rolesOverride?: string[]) {
  const roles = rolesOverride ?? getUserRoles(user.id)
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles,
    commsRingScope: getCommsRingScope(user.id),
  }
}

function roleExists(name: string): boolean {
  return !!db.prepare('SELECT 1 FROM roles WHERE name = ?').get(name)
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
    user: { id: userId, email, name, roles, commsRingScope: 'mine' as const },
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
      userId: number; actAsDepartmentId?: number; actAsRole?: string
    }
    const user = db.prepare('SELECT id, email, name, is_active FROM users WHERE id = ?').get(payload.userId) as DbUser | undefined

    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    // Surface the active View-as scope so the client can render the
    // banner + dropdown state without a separate request. Two flavours:
    // department scope (permission-based) and role scope (role-based).
    let scope: { departmentId?: number; departmentName?: string; role?: string } | null = null
    let rolesOverride: string[] | undefined
    if (payload.actAsRole != null) {
      scope = { role: payload.actAsRole }
      rolesOverride = [payload.actAsRole]
    } else if (payload.actAsDepartmentId != null) {
      const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(payload.actAsDepartmentId) as { id: number; name: string } | undefined
      if (dept) scope = { departmentId: dept.id, departmentName: dept.name }
    }

    res.json({ user: buildUserResponse(user, rolesOverride), scope })
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
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as { userId: number; actAsDepartmentId?: number; actAsRole?: string }

    // View-as role: return only that role's grants so view/table/field gates
    // behave as the role would (role-based middleware reads the token roles).
    if (payload.actAsRole != null) {
      const perms = db.prepare(`
        SELECT p.resource_type, p.resource_id, p.can_read, p.can_write
        FROM permissions p
        JOIN roles r ON r.id = p.role_id
        WHERE r.name = ?
        ORDER BY p.resource_type, p.resource_id
      `).all(payload.actAsRole)
      res.json({ permissions: perms })
      return
    }

    // View-as scope: return only the active department's grants so the
    // client behaves exactly as a department member would.
    if (payload.actAsDepartmentId != null) {
      const perms = db.prepare(`
        SELECT resource_type, resource_id, can_read, can_write
        FROM department_permissions
        WHERE department_id = ?
        ORDER BY resource_type, resource_id
      `).all(payload.actAsDepartmentId)
      res.json({ permissions: perms })
      return
    }

    // Effective permissions = union of role-grants + dept-grants for the
    // user. MAX(can_read|can_write) across both sources, grouped by
    // (resource_type, resource_id). Matches the union logic in
    // checkPermission / requireViewPermission so the client and server
    // agree on what's allowed.
    const perms = db.prepare(`
      SELECT resource_type, resource_id,
        MAX(can_read) AS can_read,
        MAX(can_write) AS can_write
      FROM (
        SELECT p.resource_type, p.resource_id, p.can_read, p.can_write
        FROM permissions p
        JOIN user_roles ur ON ur.role_id = p.role_id
        WHERE ur.user_id = ?
        UNION ALL
        SELECT dp.resource_type, dp.resource_id, dp.can_read, dp.can_write
        FROM department_permissions dp
        JOIN user_departments ud ON ud.department_id = dp.department_id
        WHERE ud.user_id = ?
      )
      GROUP BY resource_type, resource_id
      ORDER BY resource_type, resource_id
    `).all(payload.userId, payload.userId)

    res.json({ permissions: perms })
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

// ─── Admin "View-as department" scope ────────────────────────
// Issues a new JWT with an actAsDepartmentId claim so an admin can
// browse the app as if they belonged only to that department.
// Caller must have admin role in the DB (checked here, not via the
// requireRole middleware, so this endpoint stays callable when the
// caller is already scoped and wants to switch / exit).
function callerIsDbAdmin(userId: number): boolean {
  const row = db.prepare(`
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  return !!row
}

// List departments available to the scope picker. Admin-only at the
// DB-role level so a scoped admin can still see the list to exit/
// switch (the regular /api/admin/departments would 403 in scope mode).
router.get('/scope/departments', (req: Request, res: Response): void => {
  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Not authenticated' }); return }
  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as { userId: number }
    if (!callerIsDbAdmin(payload.userId)) {
      res.status(403).json({ error: 'View-as is admin-only' })
      return
    }
    const departments = db.prepare(
      `SELECT id, name, description FROM departments ORDER BY name`
    ).all()
    res.json({ departments })
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

router.post('/scope', (req: Request, res: Response): void => {
  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Not authenticated' }); return }
  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as { userId: number }
    if (!callerIsDbAdmin(payload.userId)) {
      res.status(403).json({ error: 'View-as is admin-only' })
      return
    }
    const deptId = Number((req.body as { department_id?: unknown })?.department_id)
    if (!Number.isFinite(deptId)) { res.status(400).json({ error: 'department_id is required' }); return }
    const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(deptId) as { id: number; name: string } | undefined
    if (!dept) { res.status(404).json({ error: 'Department not found' }); return }

    const user = db.prepare('SELECT id, email, name, is_active FROM users WHERE id = ?').get(payload.userId) as DbUser | undefined
    if (!user) { res.status(404).json({ error: 'User not found' }); return }

    const roles = getUserRoles(user.id)
    const token = jwt.sign(
      { userId: user.id, email: user.email, roles, actAsDepartmentId: dept.id },
      getJwtSecret(),
      { expiresIn: '8h' }, // shorter than a normal session — View-as is for testing, not living in
    )
    res.json({
      token,
      user: buildUserResponse(user),
      scope: { departmentId: dept.id, departmentName: dept.name },
    })
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

router.post('/scope/clear', (req: Request, res: Response): void => {
  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Not authenticated' }); return }
  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as { userId: number }
    const user = db.prepare('SELECT id, email, name, is_active FROM users WHERE id = ?').get(payload.userId) as DbUser | undefined
    if (!user) { res.status(404).json({ error: 'User not found' }); return }

    // Re-issue a normal JWT reflecting current DB roles, no scope claim.
    const roles = getUserRoles(user.id)
    const token = jwt.sign(
      { userId: user.id, email: user.email, roles },
      getJwtSecret(),
      { expiresIn: '7d' },
    )
    res.json({ token, user: buildUserResponse(user), scope: null })
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

// ─── Admin "View-as role" scope ──────────────────────────────
// Issues a JWT whose `roles` claim is replaced by the single impersonated
// role (admin dropped) + an `actAsRole` marker. Role-based middleware
// (requireRole, isReferralAgent) and the client's role gating then behave
// exactly as that role. Admin status is resolved from the DB userId, so the
// admin can still switch/exit while impersonating.
router.get('/scope/roles', (req: Request, res: Response): void => {
  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Not authenticated' }); return }
  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as { userId: number }
    if (!callerIsDbAdmin(payload.userId)) {
      res.status(403).json({ error: 'View-as is admin-only' })
      return
    }
    // Only the app's own system roles are impersonable (is_system = 1) —
    // the dozens of QB-synced roles aren't wired to client gating. Exclude
    // admin and the legacy lowercase aliases (crew/customer/lender).
    const roles = db.prepare(
      `SELECT name, description FROM roles
       WHERE is_system = 1 AND name NOT IN ('admin', 'crew', 'customer', 'lender')
       ORDER BY name`
    ).all()
    res.json({ roles })
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

router.post('/scope/role', (req: Request, res: Response): void => {
  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Not authenticated' }); return }
  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret()) as { userId: number }
    if (!callerIsDbAdmin(payload.userId)) {
      res.status(403).json({ error: 'View-as is admin-only' })
      return
    }
    const role = String((req.body as { role?: unknown })?.role || '').trim()
    if (!role) { res.status(400).json({ error: 'role is required' }); return }
    if (role === 'admin') { res.status(400).json({ error: 'Cannot impersonate admin' }); return }
    if (!roleExists(role)) { res.status(404).json({ error: 'Role not found' }); return }

    const user = db.prepare('SELECT id, email, name, is_active FROM users WHERE id = ?').get(payload.userId) as DbUser | undefined
    if (!user) { res.status(404).json({ error: 'User not found' }); return }

    const token = jwt.sign(
      { userId: user.id, email: user.email, roles: [role], actAsRole: role },
      getJwtSecret(),
      { expiresIn: '8h' }, // testing window, not a place to live
    )
    res.json({
      token,
      user: buildUserResponse(user, [role]),
      scope: { role },
    })
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
    user: { id: user.id, email: user.email, name: user.name, roles, commsRingScope: getCommsRingScope(user.id) },
  })
})

// ── Self-serve forgot password ───────────────────────────
// In-memory rate limit: max 3 attempts per email per 15 min.
// Resets on server restart — good enough to discourage casual abuse.
const forgotAttempts = new Map<string, { count: number; resetAt: number }>()
const FORGOT_WINDOW_MS = 15 * 60 * 1000
const FORGOT_MAX = 3

function forgotRateLimited(email: string): boolean {
  const now = Date.now()
  const key = email.toLowerCase().trim()
  const entry = forgotAttempts.get(key)
  if (!entry || entry.resetAt < now) {
    forgotAttempts.set(key, { count: 1, resetAt: now + FORGOT_WINDOW_MS })
    return false
  }
  entry.count++
  if (entry.count > FORGOT_MAX) return true
  return false
}

router.post('/forgot', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body as { email?: string }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'Valid email is required' }); return
  }

  // Always respond OK with a generic message so we don't leak which emails
  // are registered. Rate-limit separately.
  const GENERIC = { ok: true, message: 'If that email is registered, a reset link was sent.' }

  if (forgotRateLimited(email)) {
    // Still return generic — silent throttle.
    res.json(GENERIC); return
  }

  const user = db.prepare(
    'SELECT id, email, name, is_active FROM users WHERE email = ?'
  ).get(email.toLowerCase().trim()) as { id: number; email: string; name: string; is_active: number } | undefined

  if (!user || !user.is_active) { res.json(GENERIC); return }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()   // 1 hour for self-serve
  db.prepare('UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?').run(token, expiresAt, user.id)

  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host
  const resetUrl = `${proto}://${host}/reset/${token}`

  const subject = 'Reset your Kin Home Portal password'
  const text = [
    `Hi ${user.name || ''},`,
    '',
    'We got a request to reset your Kin Home Portal password. Click the link below to pick a new one:',
    '',
    resetUrl,
    '',
    'This link expires in 1 hour. If you didn\'t request this, you can ignore this email.',
  ].join('\n')

  const html = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 16px;font-size:20px">Reset your password</h2>
      <p style="margin:0 0 16px;color:#475569;line-height:1.5">
        Hi ${user.name || ''}, we got a request to reset your Kin Home Portal password.
        Click below to pick a new one.
      </p>
      <p style="margin:0 0 16px"><a href="${resetUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Reset password</a></p>
      <p style="margin:0 0 16px;color:#475569;line-height:1.5;font-size:13px">
        Or paste this URL into your browser:<br>
        <span style="font-family:ui-monospace,monospace;color:#0f172a;word-break:break-all">${resetUrl}</span>
      </p>
      <p style="margin:24px 0 0;color:#94a3b8;line-height:1.5;font-size:12px">
        This link expires in 1 hour. If you didn't request this, you can ignore this email.
      </p>
    </div>
  `

  // Fire-and-forget-ish: we await so we can log failures server-side, but the
  // user still gets the generic 200 regardless of provider outcome.
  const result = await sendEmail({ to: user.email, subject, html, text })
  if (!result.ok) {
    console.error(`[auth/forgot] email send failed for ${user.email} via ${result.provider}: ${result.error}`)
  }
  res.json(GENERIC)
})

// ── Password reset (admin-initiated) ─────────────────────

// Validate a reset token (GET so the frontend can check before showing the form)
router.get('/reset/:token', (req: Request, res: Response): void => {
  const user = db.prepare(
    'SELECT id, email, name, reset_expires_at FROM users WHERE reset_token = ?'
  ).get(req.params['token']) as { id: number; email: string; name: string; reset_expires_at: string } | undefined

  if (!user) { res.status(404).json({ error: 'Invalid reset link' }); return }
  if (!user.reset_expires_at || new Date(user.reset_expires_at) < new Date()) {
    res.status(410).json({ error: 'Reset link has expired' }); return
  }
  res.json({ email: user.email, name: user.name })
})

// Apply the reset — user sets a new password.
router.post('/reset/:token', (req: Request, res: Response): void => {
  const { password } = req.body
  if (!password || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' }); return
  }

  const user = db.prepare(
    'SELECT id, email, name, reset_expires_at, is_active FROM users WHERE reset_token = ?'
  ).get(req.params['token']) as { id: number; email: string; name: string; reset_expires_at: string; is_active: number } | undefined

  if (!user) { res.status(404).json({ error: 'Invalid reset link' }); return }
  if (!user.reset_expires_at || new Date(user.reset_expires_at) < new Date()) {
    res.status(410).json({ error: 'Reset link has expired' }); return
  }
  if (!user.is_active) { res.status(403).json({ error: 'Account is deactivated' }); return }

  const passwordHash = bcrypt.hashSync(password, 10)
  db.prepare(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?'
  ).run(passwordHash, user.id)

  const roles = getUserRoles(user.id)
  const token = jwt.sign(
    { userId: user.id, email: user.email, roles },
    getJwtSecret(),
    { expiresIn: '7d' }
  )

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, roles, commsRingScope: getCommsRingScope(user.id) },
  })
})

export { router as authRouter }
