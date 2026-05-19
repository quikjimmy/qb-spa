import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import db from '../db'
import { noteUserActivity } from '../lib/activity'

function getJwtSecret() {
  return process.env['JWT_SECRET'] || 'dev-secret-change-me'
}

export interface AuthPayload {
  userId: number
  email: string
  roles: string[]
  // Admin-only impersonation: when set, the bearer is "acting as" a
  // member of this department. Admin role bypass is suppressed and
  // every permission check is restricted to this single department's
  // grants — so a scoped admin sees exactly what a Funding-team
  // member would see, app-wide. Cleared by issuing a fresh JWT.
  actAsDepartmentId?: number
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization']
  // Fall back to ?token= query string for endpoints like SSE where the
  // client can't set an Authorization header (EventSource API limitation).
  // Header path is preferred and always wins when present.
  const queryToken = typeof req.query['token'] === 'string' ? (req.query['token'] as string) : ''
  let token: string | null = null
  if (header?.startsWith('Bearer ')) token = header.slice(7)
  else if (queryToken) token = queryToken

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid token' })
    return
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as AuthPayload
    req.user = payload
    // Record activity so background schedulers know whether to run,
    // and stamp the user's last_active_at for the admin presence view.
    noteUserActivity(payload.userId)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Require at least one of the specified roles. Admin always passes —
// unless they're scoped to a department (View-as mode), in which case
// the admin bypass is suppressed so the test session reflects reality.
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    const scoped = req.user.actAsDepartmentId != null
    if (!scoped && req.user.roles.includes('admin')) {
      next()
      return
    }
    if (scoped) {
      // Scoped admins act as department members — no role bypass.
      res.status(403).json({ error: 'Not available while scoped to a department' })
      return
    }
    const hasRole = req.user.roles.some(r => roles.includes(r))
    if (!hasRole) {
      res.status(403).json({ error: 'Insufficient permissions' })
      return
    }
    next()
  }
}

// Middleware: allow admins, OR any user with read access to (view, viewId)
// from EITHER their role-permissions OR their department-permissions.
// Anything else gets a 403. Used by sections (Funding, etc.) that need
// to be visible beyond the admin role without becoming public.
export function requireViewPermission(viewId: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return }
    const scopeId = req.user.actAsDepartmentId
    // Scoped mode: ONLY the active department's perms count.
    if (scopeId != null) {
      const row = db.prepare(`
        SELECT MAX(can_read) AS allowed
        FROM department_permissions
        WHERE department_id = ? AND resource_type = 'view' AND resource_id = ?
      `).get(scopeId, viewId) as { allowed: number | null } | undefined
      if (row?.allowed === 1) { next(); return }
      res.status(403).json({ error: 'Insufficient permissions (scoped)' })
      return
    }
    // Normal admin bypass.
    if (req.user.roles.includes('admin')) { next(); return }
    const row = db.prepare(`
      SELECT MAX(allowed) AS allowed FROM (
        SELECT MAX(p.can_read) AS allowed
        FROM permissions p
        JOIN user_roles ur ON ur.role_id = p.role_id
        WHERE ur.user_id = ? AND p.resource_type = 'view' AND p.resource_id = ?
        UNION ALL
        SELECT MAX(dp.can_read) AS allowed
        FROM department_permissions dp
        JOIN user_departments ud ON ud.department_id = dp.department_id
        WHERE ud.user_id = ? AND dp.resource_type = 'view' AND dp.resource_id = ?
      )
    `).get(req.user.userId, viewId, req.user.userId, viewId) as { allowed: number | null } | undefined
    if (row?.allowed === 1) { next(); return }
    res.status(403).json({ error: 'Insufficient permissions' })
  }
}

// --- Permission checking utilities ---

interface PermissionRow {
  can_read: number
  can_write: number
}

export function checkPermission(
  userId: number,
  resourceType: 'view' | 'table' | 'field',
  resourceId: string,
  action: 'read' | 'write',
  scopeDeptId?: number,
): boolean {
  const column = action === 'read' ? 'can_read' : 'can_write'

  // Scoped mode: ignore the user's actual roles/depts entirely and
  // resolve permission as if they belonged only to scopeDeptId.
  if (scopeDeptId != null) {
    const row = db.prepare(`
      SELECT MAX(${column}) AS allowed
      FROM department_permissions
      WHERE department_id = ? AND resource_type = ? AND resource_id = ?
    `).get(scopeDeptId, resourceType, resourceId) as { allowed: number | null } | undefined
    return row?.allowed === 1
  }

  // Admin bypass — check if user has admin role
  const adminCheck = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  if (adminCheck) return true

  const row = db.prepare(`
    SELECT MAX(allowed) AS allowed FROM (
      SELECT MAX(p.${column}) AS allowed
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ? AND p.resource_type = ? AND p.resource_id = ?
      UNION ALL
      SELECT MAX(dp.${column}) AS allowed
      FROM department_permissions dp
      JOIN user_departments ud ON ud.department_id = dp.department_id
      WHERE ud.user_id = ? AND dp.resource_type = ? AND dp.resource_id = ?
    )
  `).get(userId, resourceType, resourceId, userId, resourceType, resourceId) as { allowed: number | null } | undefined

  return row?.allowed === 1
}

// Get all readable field IDs for a user on a given table. When
// `scopeDeptId` is set, ignore the user's actual grants and resolve
// solely against that department's permissions (admin View-as mode).
export function getReadableFields(userId: number, tableId: string, scopeDeptId?: number): number[] | 'all' {
  if (scopeDeptId != null) {
    const tableAccess = db.prepare(`
      SELECT MAX(can_read) AS allowed FROM department_permissions
      WHERE department_id = ? AND resource_type = 'table' AND resource_id = ?
    `).get(scopeDeptId, tableId) as { allowed: number | null } | undefined
    if (!tableAccess || tableAccess.allowed !== 1) return []
    const fp = db.prepare(`
      SELECT resource_id, can_read FROM department_permissions
      WHERE department_id = ? AND resource_type = 'field' AND resource_id LIKE ?
    `).all(scopeDeptId, `${tableId}.%`) as Array<{ resource_id: string; can_read: number }>
    if (fp.length === 0) return 'all'
    return fp.filter(f => f.can_read === 1).map(f => parseInt(f.resource_id.split('.')[1]!, 10))
  }

  // Admin gets everything
  const adminCheck = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  if (adminCheck) return 'all'

  // Check table-level read access first — across BOTH role and dept perms.
  const tableAccess = db.prepare(`
    SELECT MAX(allowed) AS allowed FROM (
      SELECT MAX(p.can_read) AS allowed
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ? AND p.resource_type = 'table' AND p.resource_id = ?
      UNION ALL
      SELECT MAX(dp.can_read) AS allowed
      FROM department_permissions dp
      JOIN user_departments ud ON ud.department_id = dp.department_id
      WHERE ud.user_id = ? AND dp.resource_type = 'table' AND dp.resource_id = ?
    )
  `).get(userId, tableId, userId, tableId) as { allowed: number | null } | undefined

  if (!tableAccess || tableAccess.allowed !== 1) return []

  // Field-level restrictions — union role-grants and dept-grants. A field
  // is readable if either grant says so (MAX over both sources).
  const fieldPerms = db.prepare(`
    SELECT resource_id, MAX(can_read) AS can_read FROM (
      SELECT p.resource_id, p.can_read
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ? AND p.resource_type = 'field' AND p.resource_id LIKE ?
      UNION ALL
      SELECT dp.resource_id, dp.can_read
      FROM department_permissions dp
      JOIN user_departments ud ON ud.department_id = dp.department_id
      WHERE ud.user_id = ? AND dp.resource_type = 'field' AND dp.resource_id LIKE ?
    )
    GROUP BY resource_id
  `).all(userId, `${tableId}.%`, userId, `${tableId}.%`) as Array<{ resource_id: string; can_read: number }>

  // No field-level permissions defined = all fields readable (table-level grants all)
  if (fieldPerms.length === 0) return 'all'

  // Return only explicitly readable fields
  return fieldPerms
    .filter(f => f.can_read === 1)
    .map(f => parseInt(f.resource_id.split('.')[1]!, 10))
}

// Get all writable field IDs for a user on a given table. Honors the
// optional scopeDeptId like getReadableFields().
export function getWritableFields(userId: number, tableId: string, scopeDeptId?: number): number[] | 'all' {
  if (scopeDeptId != null) {
    const tableAccess = db.prepare(`
      SELECT MAX(can_write) AS allowed FROM department_permissions
      WHERE department_id = ? AND resource_type = 'table' AND resource_id = ?
    `).get(scopeDeptId, tableId) as { allowed: number | null } | undefined
    if (!tableAccess || tableAccess.allowed !== 1) return []
    const fp = db.prepare(`
      SELECT resource_id, can_write FROM department_permissions
      WHERE department_id = ? AND resource_type = 'field' AND resource_id LIKE ?
    `).all(scopeDeptId, `${tableId}.%`) as Array<{ resource_id: string; can_write: number }>
    if (fp.length === 0) return 'all'
    return fp.filter(f => f.can_write === 1).map(f => parseInt(f.resource_id.split('.')[1]!, 10))
  }

  const adminCheck = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  if (adminCheck) return 'all'

  const tableAccess = db.prepare(`
    SELECT MAX(allowed) AS allowed FROM (
      SELECT MAX(p.can_write) AS allowed
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ? AND p.resource_type = 'table' AND p.resource_id = ?
      UNION ALL
      SELECT MAX(dp.can_write) AS allowed
      FROM department_permissions dp
      JOIN user_departments ud ON ud.department_id = dp.department_id
      WHERE ud.user_id = ? AND dp.resource_type = 'table' AND dp.resource_id = ?
    )
  `).get(userId, tableId, userId, tableId) as { allowed: number | null } | undefined

  if (!tableAccess || tableAccess.allowed !== 1) return []

  const fieldPerms = db.prepare(`
    SELECT resource_id, MAX(can_write) AS can_write FROM (
      SELECT p.resource_id, p.can_write
      FROM permissions p
      JOIN user_roles ur ON ur.role_id = p.role_id
      WHERE ur.user_id = ? AND p.resource_type = 'field' AND p.resource_id LIKE ?
      UNION ALL
      SELECT dp.resource_id, dp.can_write
      FROM department_permissions dp
      JOIN user_departments ud ON ud.department_id = dp.department_id
      WHERE ud.user_id = ? AND dp.resource_type = 'field' AND dp.resource_id LIKE ?
    )
    GROUP BY resource_id
  `).all(userId, `${tableId}.%`, userId, `${tableId}.%`) as Array<{ resource_id: string; can_write: number }>

  if (fieldPerms.length === 0) return 'all'

  return fieldPerms
    .filter(f => f.can_write === 1)
    .map(f => parseInt(f.resource_id.split('.')[1]!, 10))
}

// Get the record filter WHERE clause for a user on a given table
// Returns null if no filter needed (admin or no rules configured).
// When scoped to a department, admin bypass is suppressed but record
// filters still resolve against the real user's email + roles —
// departments don't (yet) carry record filters of their own.
export function getRecordFilter(userId: number, tableId: string, scopeDeptId?: number): string | null {
  // Admin bypass — only when NOT scoped.
  if (scopeDeptId == null) {
    const adminCheck = db.prepare(`
      SELECT 1 FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.name = 'admin'
    `).get(userId)
    if (adminCheck) return null
  }

  // Get user email
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined
  if (!user) return null

  // Find all record filter rules for this user's roles on this table
  const filters = db.prepare(`
    SELECT rf.qb_email_field_id
    FROM record_filters rf
    JOIN user_roles ur ON ur.role_id = rf.role_id
    WHERE ur.user_id = ? AND rf.table_id = ?
  `).all(userId, tableId) as Array<{ qb_email_field_id: number }>

  if (filters.length === 0) return null

  // If a user has multiple roles with filters on the same table,
  // use OR — they can see records matching any of their roles' filters
  const clauses = filters.map(f => `{'${f.qb_email_field_id}'.EX.'${user.email}'}`)

  if (clauses.length === 1) return clauses[0]!
  return `(${clauses.join('OR')})`
}

// Same logic but for a specific role + email (for impersonation)
export function getRecordFilterForRole(roleId: number, email: string, tableId: string): string | null {
  const filter = db.prepare(`
    SELECT qb_email_field_id FROM record_filters
    WHERE role_id = ? AND table_id = ?
  `).get(roleId, tableId) as { qb_email_field_id: number } | undefined

  if (!filter) return null
  return `{'${filter.qb_email_field_id}'.EX.'${email}'}`
}
