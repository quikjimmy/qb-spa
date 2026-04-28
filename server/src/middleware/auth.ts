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
    // Record activity so background schedulers know whether to run.
    // Off-hours with no authenticated traffic = no QB pulls.
    noteUserActivity()
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Require at least one of the specified roles
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    // Admin always passes
    if (req.user.roles.includes('admin')) {
      next()
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

// --- Permission checking utilities ---

interface PermissionRow {
  can_read: number
  can_write: number
}

export function checkPermission(
  userId: number,
  resourceType: 'view' | 'table' | 'field',
  resourceId: string,
  action: 'read' | 'write'
): boolean {
  // Admin bypass — check if user has admin role
  const adminCheck = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  if (adminCheck) return true

  const column = action === 'read' ? 'can_read' : 'can_write'
  const row = db.prepare(`
    SELECT MAX(p.${column}) as allowed
    FROM permissions p
    JOIN user_roles ur ON ur.role_id = p.role_id
    WHERE ur.user_id = ?
      AND p.resource_type = ?
      AND p.resource_id = ?
  `).get(userId, resourceType, resourceId) as { allowed: number | null } | undefined

  return row?.allowed === 1
}

// Get all readable field IDs for a user on a given table
export function getReadableFields(userId: number, tableId: string): number[] | 'all' {
  // Admin gets everything
  const adminCheck = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  if (adminCheck) return 'all'

  // Check table-level read access first
  const tableAccess = db.prepare(`
    SELECT MAX(p.can_read) as allowed
    FROM permissions p
    JOIN user_roles ur ON ur.role_id = p.role_id
    WHERE ur.user_id = ?
      AND p.resource_type = 'table'
      AND p.resource_id = ?
  `).get(userId, tableId) as { allowed: number | null } | undefined

  if (!tableAccess || tableAccess.allowed !== 1) return []

  // Check if there are any field-level restrictions
  const fieldPerms = db.prepare(`
    SELECT p.resource_id, p.can_read
    FROM permissions p
    JOIN user_roles ur ON ur.role_id = p.role_id
    WHERE ur.user_id = ?
      AND p.resource_type = 'field'
      AND p.resource_id LIKE ?
  `).all(userId, `${tableId}.%`) as Array<{ resource_id: string; can_read: number }>

  // No field-level permissions defined = all fields readable (table-level grants all)
  if (fieldPerms.length === 0) return 'all'

  // Return only explicitly readable fields
  return fieldPerms
    .filter(f => f.can_read === 1)
    .map(f => parseInt(f.resource_id.split('.')[1]!, 10))
}

// Get all writable field IDs for a user on a given table
export function getWritableFields(userId: number, tableId: string): number[] | 'all' {
  const adminCheck = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  if (adminCheck) return 'all'

  const tableAccess = db.prepare(`
    SELECT MAX(p.can_write) as allowed
    FROM permissions p
    JOIN user_roles ur ON ur.role_id = p.role_id
    WHERE ur.user_id = ?
      AND p.resource_type = 'table'
      AND p.resource_id = ?
  `).get(userId, tableId) as { allowed: number | null } | undefined

  if (!tableAccess || tableAccess.allowed !== 1) return []

  const fieldPerms = db.prepare(`
    SELECT p.resource_id, p.can_write
    FROM permissions p
    JOIN user_roles ur ON ur.role_id = p.role_id
    WHERE ur.user_id = ?
      AND p.resource_type = 'field'
      AND p.resource_id LIKE ?
  `).all(userId, `${tableId}.%`) as Array<{ resource_id: string; can_write: number }>

  if (fieldPerms.length === 0) return 'all'

  return fieldPerms
    .filter(f => f.can_write === 1)
    .map(f => parseInt(f.resource_id.split('.')[1]!, 10))
}

// Get the record filter WHERE clause for a user on a given table
// Returns null if no filter needed (admin or no rules configured)
export function getRecordFilter(userId: number, tableId: string): string | null {
  // Admin bypass
  const adminCheck = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(userId)
  if (adminCheck) return null

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
