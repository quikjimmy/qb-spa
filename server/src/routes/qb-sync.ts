import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
    appId: process.env['QB_APP_ID'] || 'br9kwm8bk',
  }
}

function qbHeaders(realm: string, token: string) {
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

interface QbRole {
  id: number
  name: string
  access: { id: number; type: string }
}

interface QbFieldPerm {
  permissionType: 'Modify' | 'View' | 'None'
  role: string
  roleId: number
}

interface QbField {
  id: number
  label: string
  fieldType: string
  permissions: QbFieldPerm[]
}

// Fetch all roles from the QB app
async function fetchQbRoles(realm: string, token: string, appId: string): Promise<QbRole[]> {
  const res = await fetch(`https://api.quickbase.com/v1/apps/${appId}/roles`, {
    headers: qbHeaders(realm, token),
  })
  if (!res.ok) throw new Error(`Failed to fetch QB roles: ${res.status}`)
  return res.json()
}

// Fetch all fields + permissions for a table
async function fetchQbFields(realm: string, token: string, tableId: string): Promise<QbField[]> {
  const res = await fetch(
    `https://api.quickbase.com/v1/fields?tableId=${tableId}&includeFieldPerms=true`,
    { headers: qbHeaders(realm, token) },
  )
  if (!res.ok) throw new Error(`Failed to fetch fields for table ${tableId}: ${res.status}`)
  return res.json()
}

// Preview what a sync would do (dry run)
router.get('/preview', async (_req: Request, res: Response): Promise<void> => {
  const { realm, token, appId } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  try {
    const qbRoles = await fetchQbRoles(realm, token, appId)

    // Get existing portal roles that came from QB
    const existingQb = db.prepare(
      "SELECT name, qb_role_id FROM roles WHERE qb_role_id IS NOT NULL"
    ).all() as Array<{ name: string; qb_role_id: number }>
    const existingIds = new Set(existingQb.map(r => r.qb_role_id))

    const newRoles = qbRoles.filter(r => !existingIds.has(r.id))
    const existingRoles = qbRoles.filter(r => existingIds.has(r.id))

    res.json({
      qbRoles: qbRoles.map(r => ({ id: r.id, name: r.name, accessType: r.access.type })),
      newRoles: newRoles.map(r => ({ id: r.id, name: r.name })),
      existingRoles: existingRoles.map(r => ({ id: r.id, name: r.name })),
      totalQbRoles: qbRoles.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Sync roles from QB into portal
router.post('/roles', async (_req: Request, res: Response): Promise<void> => {
  const { realm, token, appId } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  try {
    const qbRoles = await fetchQbRoles(realm, token, appId)

    const upsertRole = db.prepare(`
      INSERT INTO roles (name, description, is_system, qb_role_id)
      VALUES (?, ?, 0, ?)
      ON CONFLICT (qb_role_id) DO UPDATE SET name = excluded.name
    `)

    let created = 0
    let updated = 0

    const syncTransaction = db.transaction(() => {
      for (const qbRole of qbRoles) {
        const existing = db.prepare('SELECT id FROM roles WHERE qb_role_id = ?').get(qbRole.id)
        const desc = `QB role: ${qbRole.access.type}`
        upsertRole.run(qbRole.name, desc, qbRole.id)
        if (existing) updated++
        else created++
      }
    })
    syncTransaction()

    res.json({ success: true, created, updated, total: qbRoles.length })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Sync field-level permissions for a specific table
router.post('/permissions/:tableId', async (req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  const tableId = req.params['tableId']!

  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  try {
    const fields = await fetchQbFields(realm, token, tableId)

    // Build a map of QB roleId -> portal role id
    const portalRoles = db.prepare(
      'SELECT id, qb_role_id FROM roles WHERE qb_role_id IS NOT NULL'
    ).all() as Array<{ id: number; qb_role_id: number }>
    const roleMap = new Map(portalRoles.map(r => [r.qb_role_id, r.id]))

    const upsertPerm = db.prepare(`
      INSERT INTO permissions (role_id, resource_type, resource_id, can_read, can_write)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (role_id, resource_type, resource_id)
      DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write
    `)

    let permCount = 0

    const syncTransaction = db.transaction(() => {
      for (const field of fields) {
        for (const perm of field.permissions || []) {
          const portalRoleId = roleMap.get(perm.roleId)
          if (!portalRoleId) continue

          const canRead = perm.permissionType === 'Modify' || perm.permissionType === 'View' ? 1 : 0
          const canWrite = perm.permissionType === 'Modify' ? 1 : 0

          // Field-level permission
          upsertPerm.run(portalRoleId, 'field', `${tableId}.${field.id}`, canRead, canWrite)
          permCount++
        }
      }

      // Also create table-level read permissions for roles that can read any field
      const rolesWithAccess = new Set<number>()
      for (const field of fields) {
        for (const perm of field.permissions || []) {
          if (perm.permissionType !== 'None') {
            const portalRoleId = roleMap.get(perm.roleId)
            if (portalRoleId) rolesWithAccess.add(portalRoleId)
          }
        }
      }

      for (const portalRoleId of rolesWithAccess) {
        // Check if any field has write access for this role
        let hasWrite = false
        for (const field of fields) {
          for (const perm of field.permissions || []) {
            const mapped = roleMap.get(perm.roleId)
            if (mapped === portalRoleId && perm.permissionType === 'Modify') {
              hasWrite = true
              break
            }
          }
          if (hasWrite) break
        }
        upsertPerm.run(portalRoleId, 'table', tableId, 1, hasWrite ? 1 : 0)
        permCount++
      }
    })
    syncTransaction()

    res.json({
      success: true,
      tableId,
      fieldsProcessed: fields.length,
      permissionsWritten: permCount,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Full sync — roles + permissions for all key tables
router.post('/full', async (_req: Request, res: Response): Promise<void> => {
  const { realm, token, appId } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  // Key tables from the context doc
  const tables = [
    { id: 'br9kwm8na', name: 'Projects' },
    { id: 'bvbqgs5yc', name: 'Arrivy Tasks' },
    { id: 'bvbbznmdb', name: 'Arrivy Task Log' },
    { id: 'bt4a8ypkq', name: 'Intake Events' },
    { id: 'bsbguxz4i', name: 'Events' },
    { id: 'bsb6bqt3b', name: 'Notes' },
    { id: 'bstdqwrkg', name: 'Tickets' },
    { id: 'bvjf44d7d', name: 'SMS Log' },
    { id: 'bvjf2i36u', name: 'Call Log' },
  ]

  try {
    // Step 1: Sync roles
    const qbRoles = await fetchQbRoles(realm, token, appId)

    const upsertRole = db.prepare(`
      INSERT INTO roles (name, description, is_system, qb_role_id)
      VALUES (?, ?, 0, ?)
      ON CONFLICT (qb_role_id) DO UPDATE SET name = excluded.name
    `)

    let rolesCreated = 0
    db.transaction(() => {
      for (const qbRole of qbRoles) {
        const existing = db.prepare('SELECT id FROM roles WHERE qb_role_id = ?').get(qbRole.id)
        upsertRole.run(qbRole.name, `QB role: ${qbRole.access.type}`, qbRole.id)
        if (!existing) rolesCreated++
      }
    })()

    // Step 2: Sync permissions per table
    const portalRoles = db.prepare(
      'SELECT id, qb_role_id FROM roles WHERE qb_role_id IS NOT NULL'
    ).all() as Array<{ id: number; qb_role_id: number }>
    const roleMap = new Map(portalRoles.map(r => [r.qb_role_id, r.id]))

    const upsertPerm = db.prepare(`
      INSERT INTO permissions (role_id, resource_type, resource_id, can_read, can_write)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (role_id, resource_type, resource_id)
      DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write
    `)

    const tableResults: Array<{ id: string; name: string; fields: number; permissions: number }> = []

    for (const table of tables) {
      try {
        const fields = await fetchQbFields(realm, token, table.id)
        let permCount = 0

        db.transaction(() => {
          const rolesWithAccess = new Map<number, boolean>()

          for (const field of fields) {
            for (const perm of field.permissions || []) {
              const portalRoleId = roleMap.get(perm.roleId)
              if (!portalRoleId) continue

              const canRead = perm.permissionType !== 'None' ? 1 : 0
              const canWrite = perm.permissionType === 'Modify' ? 1 : 0

              upsertPerm.run(portalRoleId, 'field', `${table.id}.${field.id}`, canRead, canWrite)
              permCount++

              if (canRead) {
                const currentWrite = rolesWithAccess.get(portalRoleId) || false
                rolesWithAccess.set(portalRoleId, currentWrite || canWrite === 1)
              }
            }
          }

          for (const [portalRoleId, hasWrite] of rolesWithAccess) {
            upsertPerm.run(portalRoleId, 'table', table.id, 1, hasWrite ? 1 : 0)
            permCount++
          }
        })()

        tableResults.push({ id: table.id, name: table.name, fields: fields.length, permissions: permCount })
      } catch (err) {
        tableResults.push({ id: table.id, name: table.name, fields: 0, permissions: 0 })
      }
    }

    const totalPerms = tableResults.reduce((sum, t) => sum + t.permissions, 0)

    res.json({
      success: true,
      roles: { synced: qbRoles.length, created: rolesCreated },
      tables: tableResults,
      totalPermissions: totalPerms,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { router as qbSyncRouter }
