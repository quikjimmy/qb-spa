import { Router, type Request, type Response } from 'express'
import { checkPermission, getReadableFields, getWritableFields, getRecordFilter } from '../middleware/auth'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

function qbHeaders(realm: string, token: string) {
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

// Test endpoint — queries the Projects table for a small sample
router.get('/test', async (req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured on server' })
    return
  }

  try {
    const response = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({
        from: 'br9kwm8na',
        select: [3, 145, 255],
        options: { top: 5 },
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      res.status(response.status).json({ error: 'QB API error', details: text })
      return
    }

    const data = await response.json()
    res.json({
      success: true,
      message: `Connected to QuickBase. Retrieved ${data.data?.length ?? 0} project records.`,
      sample: data.data?.map((r: Record<string, { value: unknown }>) => ({
        recordId: r['3']?.value,
        customerName: r['145']?.value,
        status: r['255']?.value,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to connect to QuickBase', details: String(err) })
  }
})

// Query proxy — enforces table + field-level read permissions
router.post('/query', async (req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured on server' })
    return
  }

  const userId = req.user!.userId
  const { from: tableId, select, ...rest } = req.body

  if (!tableId) {
    res.status(400).json({ error: "'from' (table ID) is required" })
    return
  }

  // Check table-level read permission
  if (!checkPermission(userId, 'table', tableId, 'read')) {
    res.status(403).json({ error: `No read access to table ${tableId}` })
    return
  }

  // Filter select list to only readable fields
  const readable = getReadableFields(userId, tableId)
  let filteredSelect = select
  if (readable !== 'all' && Array.isArray(select)) {
    filteredSelect = select.filter((fid: number) => readable.includes(fid))
    if (filteredSelect.length === 0) {
      res.status(403).json({ error: 'No readable fields in this query' })
      return
    }
  }

  // Apply record-level filter based on user email
  const recordFilter = getRecordFilter(userId, tableId)
  let where = rest.where || ''
  if (recordFilter) {
    where = where ? `(${where})AND${recordFilter}` : recordFilter
  }

  try {
    const response = await fetch('https://api.quickbase.com/v1/records/query', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({ from: tableId, select: filteredSelect, ...rest, where }),
    })

    const data = await response.json()
    res.status(response.status).json(data)
  } catch (err) {
    res.status(500).json({ error: 'QB proxy error', details: String(err) })
  }
})

// Upsert proxy — enforces table + field-level write permissions
router.post('/upsert', async (req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured on server' })
    return
  }

  const userId = req.user!.userId
  const { to: tableId, data: records, ...rest } = req.body

  if (!tableId) {
    res.status(400).json({ error: "'to' (table ID) is required" })
    return
  }

  // Check table-level write permission
  if (!checkPermission(userId, 'table', tableId, 'write')) {
    res.status(403).json({ error: `No write access to table ${tableId}` })
    return
  }

  // Check field-level write permissions
  const writable = getWritableFields(userId, tableId)
  if (writable !== 'all' && Array.isArray(records)) {
    for (const record of records) {
      const fieldIds = Object.keys(record).map(Number)
      const blocked = fieldIds.filter(fid => !writable.includes(fid))
      if (blocked.length > 0) {
        res.status(403).json({
          error: `No write access to field(s): ${blocked.join(', ')} in table ${tableId}`,
        })
        return
      }
    }
  }

  try {
    const response = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST',
      headers: qbHeaders(realm, token),
      body: JSON.stringify({ to: tableId, data: records, ...rest }),
    })

    const data = await response.json()
    res.status(response.status).json(data)
  } catch (err) {
    res.status(500).json({ error: 'QB proxy error', details: String(err) })
  }
})

export { router as qbRouter }
