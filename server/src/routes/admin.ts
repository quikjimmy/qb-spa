import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'
import db from '../db'
import { getRecordFilterForRole } from '../middleware/auth'

const router = Router()

// --- Create user (admin invite flow) ---

router.post('/users', (req: Request, res: Response): void => {
  const { email, name, roles } = req.body as {
    email?: string; name?: string; roles?: string[]
  }

  if (!email || !name) {
    res.status(400).json({ error: 'Email and name are required' })
    return
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    res.status(409).json({ error: 'Email already registered' })
    return
  }

  const inviteToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const createUser = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO users (email, name, invite_token, invite_expires_at) VALUES (?, ?, ?, ?)'
    ).run(email, name, inviteToken, expiresAt)
    const userId = result.lastInsertRowid as number

    const assignRole = db.prepare(
      'INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = ?'
    )
    const roleList = roles && roles.length > 0 ? roles : ['customer']
    for (const roleName of roleList) {
      assignRole.run(userId, roleName)
    }

    return userId
  })

  const userId = createUser()
  const assignedRoles = db.prepare(`
    SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?
  `).all(userId) as Array<{ name: string }>

  res.status(201).json({
    user: { id: userId, email, name, roles: assignedRoles.map(r => r.name) },
    inviteLink: `/invite/${inviteToken}`,
  })
})

// --- Roles CRUD ---

router.get('/roles', (_req: Request, res: Response): void => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all()
  res.json({ roles })
})

router.post('/roles', (req: Request, res: Response): void => {
  const { name, description } = req.body
  if (!name) {
    res.status(400).json({ error: 'Role name is required' })
    return
  }
  try {
    const result = db.prepare(
      'INSERT INTO roles (name, description) VALUES (?, ?)'
    ).run(name, description || '')
    res.status(201).json({ id: result.lastInsertRowid, name, description: description || '' })
  } catch {
    res.status(409).json({ error: 'Role already exists' })
  }
})

router.delete('/roles/:id', (req: Request, res: Response): void => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params['id']) as { is_system: number } | undefined
  if (!role) {
    res.status(404).json({ error: 'Role not found' })
    return
  }
  if (role.is_system) {
    res.status(400).json({ error: 'Cannot delete system roles' })
    return
  }
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params['id'])
  res.json({ success: true })
})

// --- Users management ---

router.get('/users', (_req: Request, res: Response): void => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.is_active, u.created_at,
      GROUP_CONCAT(DISTINCT r.name) as role_names,
      GROUP_CONCAT(DISTINCT d.id || ':' || d.name) as dept_pairs
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    LEFT JOIN user_departments ud ON ud.user_id = u.id
    LEFT JOIN departments d ON d.id = ud.department_id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all() as Array<{
    id: number; email: string; name: string; is_active: number;
    created_at: string; role_names: string | null; dept_pairs: string | null
  }>

  res.json({
    users: users.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      is_active: u.is_active,
      created_at: u.created_at,
      roles: u.role_names ? u.role_names.split(',') : [],
      departments: u.dept_pairs
        ? u.dept_pairs.split(',').map(p => { const [id, ...rest] = p.split(':'); return { id: Number(id), name: rest.join(':') } })
        : [],
    })),
  })
})

router.put('/users/:id/roles', (req: Request, res: Response): void => {
  const userId = parseInt(req.params['id']!, 10)
  const { roles } = req.body as { roles: string[] }

  if (!Array.isArray(roles)) {
    res.status(400).json({ error: 'roles must be an array of role names' })
    return
  }

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  const updateRoles = db.transaction(() => {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
    const insert = db.prepare(`
      INSERT INTO user_roles (user_id, role_id)
      SELECT ?, id FROM roles WHERE name = ?
    `)
    for (const roleName of roles) {
      insert.run(userId, roleName)
    }
  })
  updateRoles()

  const updatedRoles = db.prepare(`
    SELECT r.name FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `).all(userId) as Array<{ name: string }>

  res.json({ roles: updatedRoles.map(r => r.name) })
})

router.post('/users/:id/password-reset', (req: Request, res: Response): void => {
  const userId = parseInt(String(req.params['id']), 10)
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: number; email: string } | undefined
  if (!user) { res.status(404).json({ error: 'User not found' }); return }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  db.prepare('UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?').run(token, expiresAt, userId)

  // Build URL from the request itself so it matches whatever origin the admin is using
  // (works for local dev AND prod behind a proxy via x-forwarded-host).
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host
  const resetUrl = `${proto}://${host}/reset/${token}`
  res.json({ ok: true, url: resetUrl, email: user.email, expires_at: expiresAt })
})

router.put('/users/:id/active', (req: Request, res: Response): void => {
  const userId = parseInt(req.params['id']!, 10)
  const { is_active } = req.body
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, userId)
  res.json({ success: true })
})

// --- Permissions CRUD ---

router.get('/permissions', (req: Request, res: Response): void => {
  const roleId = req.query['role_id']
  let perms
  if (roleId) {
    perms = db.prepare(`
      SELECT p.*, r.name as role_name FROM permissions p
      JOIN roles r ON r.id = p.role_id
      WHERE p.role_id = ?
      ORDER BY p.resource_type, p.resource_id
    `).all(roleId)
  } else {
    perms = db.prepare(`
      SELECT p.*, r.name as role_name FROM permissions p
      JOIN roles r ON r.id = p.role_id
      ORDER BY r.name, p.resource_type, p.resource_id
    `).all()
  }
  res.json({ permissions: perms })
})

router.post('/permissions', (req: Request, res: Response): void => {
  const { role_id, resource_type, resource_id, can_read, can_write } = req.body

  if (!role_id || !resource_type || !resource_id) {
    res.status(400).json({ error: 'role_id, resource_type, and resource_id are required' })
    return
  }

  if (!['view', 'table', 'field'].includes(resource_type)) {
    res.status(400).json({ error: 'resource_type must be view, table, or field' })
    return
  }

  try {
    const result = db.prepare(`
      INSERT INTO permissions (role_id, resource_type, resource_id, can_read, can_write)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (role_id, resource_type, resource_id)
      DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write
    `).run(role_id, resource_type, resource_id, can_read ? 1 : 0, can_write ? 1 : 0)

    res.status(201).json({ id: result.lastInsertRowid })
  } catch (err) {
    res.status(400).json({ error: 'Failed to create permission', details: String(err) })
  }
})

router.post('/permissions/bulk', (req: Request, res: Response): void => {
  const { permissions } = req.body as {
    permissions: Array<{
      role_id: number; resource_type: string; resource_id: string;
      can_read: boolean; can_write: boolean
    }>
  }

  if (!Array.isArray(permissions)) {
    res.status(400).json({ error: 'permissions must be an array' })
    return
  }

  const upsert = db.prepare(`
    INSERT INTO permissions (role_id, resource_type, resource_id, can_read, can_write)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (role_id, resource_type, resource_id)
    DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write
  `)

  const bulkUpsert = db.transaction(() => {
    for (const p of permissions) {
      upsert.run(p.role_id, p.resource_type, p.resource_id, p.can_read ? 1 : 0, p.can_write ? 1 : 0)
    }
  })
  bulkUpsert()

  res.json({ success: true, count: permissions.length })
})

router.delete('/permissions/:id', (req: Request, res: Response): void => {
  db.prepare('DELETE FROM permissions WHERE id = ?').run(req.params['id'])
  res.json({ success: true })
})

// Get effective permissions for a user (resolved through all their roles)
router.get('/users/:id/permissions', (req: Request, res: Response): void => {
  const userId = parseInt(req.params['id']!, 10)

  const perms = db.prepare(`
    SELECT p.resource_type, p.resource_id,
      MAX(p.can_read) as can_read,
      MAX(p.can_write) as can_write
    FROM permissions p
    JOIN user_roles ur ON ur.role_id = p.role_id
    WHERE ur.user_id = ?
    GROUP BY p.resource_type, p.resource_id
    ORDER BY p.resource_type, p.resource_id
  `).all(userId)

  res.json({ permissions: perms })
})

// ─── Record Filters CRUD ─────────────────────────────────

router.get('/record-filters', (_req: Request, res: Response): void => {
  const filters = db.prepare(`
    SELECT rf.*, r.name as role_name
    FROM record_filters rf
    JOIN roles r ON r.id = rf.role_id
    ORDER BY r.name, rf.table_id
  `).all()
  res.json({ filters })
})

router.post('/record-filters', (req: Request, res: Response): void => {
  const { role_id, table_id, qb_email_field_id, description } = req.body

  if (!role_id || !table_id || !qb_email_field_id) {
    res.status(400).json({ error: 'role_id, table_id, and qb_email_field_id are required' })
    return
  }

  try {
    const result = db.prepare(`
      INSERT INTO record_filters (role_id, table_id, qb_email_field_id, description)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (role_id, table_id)
      DO UPDATE SET qb_email_field_id = excluded.qb_email_field_id, description = excluded.description
    `).run(role_id, table_id, qb_email_field_id, description || '')

    res.status(201).json({ id: result.lastInsertRowid })
  } catch (err) {
    res.status(400).json({ error: 'Failed to create filter', details: String(err) })
  }
})

router.delete('/record-filters/:id', (req: Request, res: Response): void => {
  db.prepare('DELETE FROM record_filters WHERE id = ?').run(req.params['id'])
  res.json({ success: true })
})

// ─── Test as User ────────────────────────────────────────

// Impersonate a portal user — applies their role's field permissions AND record filters
// Accepts user_id OR email. If email is provided and no portal user exists, it still
// runs the query using that email for record filters (useful for testing QB emails
// that aren't portal users yet).
router.post('/impersonate-query', async (req: Request, res: Response): Promise<void> => {
  const { user_id, email: rawEmail, table_id, select } = req.body as {
    user_id?: number
    email?: string
    table_id: string
    select: number[]
  }

  if ((!user_id && !rawEmail) || !table_id || !Array.isArray(select)) {
    res.status(400).json({ error: 'user_id or email, plus table_id and select[] are required' })
    return
  }

  const realm = process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com'
  const token = process.env['QB_USER_TOKEN'] || ''
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  // Resolve user — by id or email
  let user: { id: number; email: string; name: string } | undefined

  if (user_id) {
    user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(user_id) as typeof user
  } else if (rawEmail) {
    user = db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(rawEmail) as typeof user
  }

  // If no portal user found but we have an email, create a temporary context
  // so we can still test record filters with that email
  const testEmail = user?.email || rawEmail || ''
  if (!user && !testEmail) {
    res.status(400).json({ error: 'Could not resolve a user or email to test' })
    return
  }

  // Build user info for response
  const userInfo = user
    ? { id: user.id, email: user.email, name: user.name, roles: [] as string[] }
    : { id: 0, email: testEmail, name: testEmail, roles: [] as string[] }

  // Get user's roles (if portal user exists)
  let userRoles: Array<{ id: number; name: string }> = []
  if (user) {
    userRoles = db.prepare(`
      SELECT r.id, r.name FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
    `).all(user.id) as Array<{ id: number; name: string }>
    userInfo.roles = userRoles.map(r => r.name)
  }

  const isAdmin = userRoles.some(r => r.name === 'admin')

  // If no portal user, skip permission checks — just run the query with email record filter
  // This lets admins test "what would someone with this email see" before creating a portal user
  const isEmailOnlyTest = !user

  // Check table-level read across all user roles
  let hasTableRead = isAdmin || isEmailOnlyTest
  if (!isAdmin && !isEmailOnlyTest) {
    const tableAccess = db.prepare(`
      SELECT MAX(p.can_read) as allowed
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ? AND p.resource_type = 'table' AND p.resource_id = ?
    `).get(user!.id, table_id) as { allowed: number | null } | undefined
    hasTableRead = tableAccess?.allowed === 1
  }

  if (!hasTableRead) {
    res.json({
      allowed: false,
      message: `${userInfo.name} has no read access to this table`,
      user: userInfo,
      requestedFields: select,
      allowedFields: [],
      blockedFields: select,
      fieldDetails: select.map(id => ({ id, canRead: false, canWrite: false })),
      recordFilter: null,
      data: [],
    })
    return
  }

  // Get field-level permissions (merged across all roles)
  let allowedFields: number[]
  let blockedFields: number[]
  let fieldDetails: Array<{ id: number; canRead: boolean; canWrite: boolean }>

  if (isAdmin || isEmailOnlyTest) {
    // Admin or email-only test: all fields allowed
    allowedFields = select
    blockedFields = []
    fieldDetails = select.map(id => ({ id, canRead: true, canWrite: isAdmin }))
  } else {
    const fieldPerms = db.prepare(`
      SELECT p.resource_id, MAX(p.can_read) as can_read, MAX(p.can_write) as can_write
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ? AND p.resource_type = 'field' AND p.resource_id LIKE ?
      GROUP BY p.resource_id
    `).all(user!.id, `${table_id}.%`) as Array<{ resource_id: string; can_read: number; can_write: number }>

    if (fieldPerms.length === 0) {
      allowedFields = select
      blockedFields = []
      fieldDetails = select.map(id => ({ id, canRead: true, canWrite: true }))
    } else {
      const readMap = new Map(fieldPerms.map(f => [
        parseInt(f.resource_id.split('.')[1]!, 10),
        { canRead: f.can_read === 1, canWrite: f.can_write === 1 },
      ]))
      allowedFields = select.filter(fid => readMap.get(fid)?.canRead)
      blockedFields = select.filter(fid => !readMap.get(fid)?.canRead)
      fieldDetails = select.map(fid => ({
        id: fid,
        canRead: readMap.get(fid)?.canRead ?? false,
        canWrite: readMap.get(fid)?.canWrite ?? false,
      }))
    }
  }

  // Build record filter — for portal users use their roles, for email-only use all configured filters
  let recordFilterDisplay: string | null = null
  let whereClause = ''

  if (!isAdmin) {
    if (isEmailOnlyTest) {
      // Email-only test: apply ALL record filters for this table using the provided email
      const allFilters = db.prepare(`
        SELECT DISTINCT qb_email_field_id FROM record_filters WHERE table_id = ?
      `).all(table_id) as Array<{ qb_email_field_id: number }>
      const clauses = allFilters.map(f => `{'${f.qb_email_field_id}'.EX.'${testEmail}'}`)
      if (clauses.length === 1) {
        whereClause = clauses[0]!
      } else if (clauses.length > 1) {
        whereClause = `(${clauses.join('OR')})`
      }
    } else {
      const filterClauses: string[] = []
      for (const role of userRoles) {
        const clause = getRecordFilterForRole(role.id, user!.email, table_id)
        if (clause) filterClauses.push(clause)
      }
      if (filterClauses.length === 1) {
        whereClause = filterClauses[0]!
      } else if (filterClauses.length > 1) {
        whereClause = `(${filterClauses.join('OR')})`
      }
    }
    if (whereClause) recordFilterDisplay = whereClause
  }

  if (allowedFields.length === 0) {
    res.json({
      allowed: true,
      message: 'Table access granted but no readable fields in this selection',
      user: userInfo,
      requestedFields: select,
      allowedFields,
      blockedFields,
      fieldDetails,
      recordFilter: recordFilterDisplay,
      data: [],
    })
    return
  }

  try {
    const qbBody: Record<string, unknown> = {
      from: table_id,
      select: allowedFields,
      options: { top: 10 },
    }
    if (whereClause) qbBody.where = whereClause

    const qbRes = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': realm,
        'Authorization': `QB-USER-TOKEN ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(qbBody),
    })

    const data = await qbRes.json()

    if (!qbRes.ok) {
      res.json({
        allowed: true,
        user: userInfo,
        requestedFields: select,
        allowedFields,
        blockedFields,
        fieldDetails,
        recordFilter: recordFilterDisplay,
        data: [],
        qbError: data.message || data.description || 'QB query failed',
      })
      return
    }

    res.json({
      allowed: true,
      user: userInfo,
      requestedFields: select,
      allowedFields,
      blockedFields,
      fieldDetails,
      recordFilter: recordFilterDisplay,
      recordCount: data.data?.length ?? 0,
      data: data.data || [],
      fields: data.fields || [],
    })
  } catch (err) {
    res.status(500).json({ error: 'QB query failed', details: String(err) })
  }
})

// ── Data cache status ────────────────────────────────────
// Lists each SQLite cache that mirrors QB data, with row count + last sync.

interface CacheInfo {
  key: string
  label: string
  description: string
  table: string
  refreshPath: string
  total: number
  last_refresh: string | null
}

const CACHE_REGISTRY: Array<Omit<CacheInfo, 'total' | 'last_refresh'>> = [
  { key: 'projects', label: 'Projects', description: 'Master project cache (statuses, milestones, dates)', table: 'project_cache', refreshPath: '/api/projects/refresh' },
  { key: 'pc_outreach', label: 'PC Outreach', description: 'Open outreach touchpoints (PC Dashboard)', table: 'outreach_cache', refreshPath: '/api/pc-dashboard/refresh' },
  { key: 'pc_outreach_completed', label: 'PC Outreach – Completed', description: 'Completed outreach for performance analytics', table: 'outreach_completed_cache', refreshPath: '/api/pc-dashboard/refresh-analytics' },
  { key: 'pc_adders', label: 'Adders', description: 'Post-POS adders pending sales-rep notification (bsaycczmf)', table: 'adder_notify_cache', refreshPath: '/api/pc-dashboard/refresh-adders' },
  { key: 'pto', label: 'PTO', description: 'PTO workflow records (PTO Dashboard)', table: 'pto_cache', refreshPath: '/api/pto/refresh' },
  { key: 'inspx', label: 'INSPX', description: 'Inspection workflow records', table: 'inspx_cache', refreshPath: '/api/analytics/inspx/refresh' },
  { key: 'tickets', label: 'Tickets', description: 'Ticket/blocker cache', table: 'ticket_cache', refreshPath: '/api/tickets/refresh' },
]

// ── Departments ──────────────────────────────────────────

router.get('/departments', (_req: Request, res: Response): void => {
  const rows = db.prepare(
    `SELECT d.id, d.name, d.description, d.created_at,
            COUNT(ud.user_id) AS user_count
     FROM departments d
     LEFT JOIN user_departments ud ON ud.department_id = d.id
     GROUP BY d.id
     ORDER BY d.name`
  ).all()
  res.json({ departments: rows })
})

router.post('/departments', (req: Request, res: Response): void => {
  const { name, description } = req.body as { name?: string; description?: string }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }
  try {
    const r = db.prepare(
      `INSERT INTO departments (name, description) VALUES (?, ?)`
    ).run(name.trim().slice(0, 60), (description || '').slice(0, 300))
    res.json({ ok: true, id: Number(r.lastInsertRowid) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) { res.status(409).json({ error: 'department already exists' }); return }
    res.status(500).json({ error: msg })
  }
})

router.patch('/departments/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const { name, description } = req.body as { name?: string; description?: string }
  const sets: string[] = []
  const params: unknown[] = []
  if (name !== undefined) { sets.push('name = ?'); params.push(name.trim().slice(0, 60)) }
  if (description !== undefined) { sets.push('description = ?'); params.push(description.slice(0, 300)) }
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }
  params.push(id)
  db.prepare(`UPDATE departments SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  res.json({ ok: true })
})

router.delete('/departments/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  db.prepare(`DELETE FROM departments WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// Set the full list of departments for a user (admin only; mounted under authenticate+requireRole)
router.put('/users/:id/departments', (req: Request, res: Response): void => {
  const userId = parseInt(String(req.params['id']), 10)
  const { department_ids } = req.body as { department_ids?: number[] }
  if (!Array.isArray(department_ids)) { res.status(400).json({ error: 'department_ids must be an array' }); return }
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM user_departments WHERE user_id = ?`).run(userId)
    const ins = db.prepare(`INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)`)
    for (const dId of department_ids) {
      if (typeof dId === 'number' && Number.isFinite(dId)) ins.run(userId, dId)
    }
  })
  txn()
  res.json({ ok: true })
})

router.get('/caches', (_req: Request, res: Response): void => {
  const caches: CacheInfo[] = CACHE_REGISTRY.map(c => {
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS total, MAX(cached_at) AS last_refresh FROM ${c.table}`
      ).get() as { total: number; last_refresh: string | null }
      return { ...c, total: row.total, last_refresh: row.last_refresh }
    } catch {
      // Table doesn't exist yet (never initialized) — report zero
      return { ...c, total: 0, last_refresh: null }
    }
  })
  res.json({ caches })
})

export { router as adminRouter }
