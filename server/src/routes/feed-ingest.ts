import { Router, type Request, type Response } from 'express'
import db from '../db'

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

async function qbQuery(realm: string, token: string, tableId: string, select: number[], where?: string, top = 200) {
  const body: Record<string, unknown> = {
    from: tableId,
    select,
    sortBy: [{ fieldId: 2, order: 'DESC' }],
    options: { top },
  }
  if (where) body.where = where

  const res = await fetch('https://api.quickbase.com/v1/records/query', {
    method: 'POST',
    headers: qbHeaders(realm, token),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QB query failed (${res.status}): ${text}`)
  }
  return res.json()
}

function val(record: Record<string, { value: unknown }>, fieldId: number): string {
  return String(record[String(fieldId)]?.value ?? '')
}

const upsertFeedItem = db.prepare(`
  INSERT OR IGNORE INTO feed_items
    (qb_source, qb_record_id, event_type, title, body, actor_name, actor_email, project_id, project_name, metadata, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

// ─── Ingest: Project milestones ──────────────────────────

async function ingestMilestones(realm: string, token: string): Promise<number> {
  // Query projects with milestone dates, modified recently
  const milestoneFields = [
    { fid: 166, label: 'Survey Scheduled' },
    { fid: 164, label: 'Survey Submitted' },
    { fid: 165, label: 'Survey Approved' },
    { fid: 207, label: 'Permit Submitted' },
    { fid: 208, label: 'Permit Approved' },
    { fid: 178, label: 'Install Scheduled' },
    { fid: 534, label: 'Install Completed' },
    { fid: 226, label: 'Inspection Scheduled' },
    { fid: 491, label: 'Inspection Passed' },
    { fid: 537, label: 'PTO Submitted' },
    { fid: 538, label: 'PTO Approved' },
  ]

  const selectIds = [3, 145, 255, 820, 2, ...milestoneFields.map(m => m.fid)]

  // Get projects modified in the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const data = await qbQuery(realm, token, 'br9kwm8na', selectIds, `{'2'.AF.'${sevenDaysAgo}'}`, 500)

  let count = 0
  const ingestTx = db.transaction(() => {
    for (const record of data.data || []) {
      const projectId = parseInt(val(record, 3))
      const projectName = val(record, 145)
      const coordinator = val(record, 820)

      for (const ms of milestoneFields) {
        const dateVal = val(record, ms.fid)
        if (!dateVal || dateVal === '' || dateVal === '0') continue

        try {
          upsertFeedItem.run(
            'projects', projectId, 'milestone',
            `${ms.label}`,
            `${projectName} — ${ms.label}`,
            coordinator || 'System',
            null,
            projectId, projectName,
            JSON.stringify({ milestone: ms.label, fieldId: ms.fid, status: val(record, 255) }),
            dateVal
          )
          count++
        } catch { /* duplicate, skip */ }
      }
    }
  })
  ingestTx()
  return count
}

// ─── Ingest: Project status changes ──────────────────────

async function ingestStatusChanges(realm: string, token: string): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const data = await qbQuery(realm, token, 'br9kwm8na', [3, 145, 255, 820, 2], `{'2'.AF.'${sevenDaysAgo}'}`, 500)

  let count = 0
  const ingestTx = db.transaction(() => {
    for (const record of data.data || []) {
      const projectId = parseInt(val(record, 3))
      const projectName = val(record, 145)
      const status = val(record, 255)
      const coordinator = val(record, 820)
      const modified = val(record, 2)

      if (!status || !modified) continue

      try {
        upsertFeedItem.run(
          'projects', projectId, 'status_change',
          `Status: ${status}`,
          `${projectName} is now ${status}`,
          coordinator || 'System',
          null,
          projectId, projectName,
          JSON.stringify({ status }),
          modified
        )
        count++
      } catch { /* duplicate */ }
    }
  })
  ingestTx()
  return count
}

// ─── Ingest: Notes ───────────────────────────────────────

async function ingestNotes(realm: string, token: string): Promise<number> {
  // Notes table: bsb6bqt3b
  // Need to discover field IDs — use common ones
  // 3 = Record ID, 6 = note body (text), 1 = date created, 2 = date modified
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let data: { data: Array<Record<string, { value: unknown }>> }
  try {
    data = await qbQuery(realm, token, 'bsb6bqt3b', [3, 6, 7, 8, 1, 2], `{'1'.AF.'${sevenDaysAgo}'}`, 200)
  } catch {
    // Field IDs might be wrong — skip gracefully
    return 0
  }

  let count = 0
  const ingestTx = db.transaction(() => {
    for (const record of data.data || []) {
      const recordId = parseInt(val(record, 3))
      const noteBody = val(record, 6) || val(record, 7) || val(record, 8)
      const created = val(record, 1)

      if (!noteBody || !created) continue

      try {
        upsertFeedItem.run(
          'notes', recordId, 'note_added',
          'Note added',
          noteBody.length > 200 ? noteBody.substring(0, 200) + '...' : noteBody,
          'System',
          null,
          null, null,
          null,
          created
        )
        count++
      } catch { /* duplicate */ }
    }
  })
  ingestTx()
  return count
}

// ─── Ingest: Tickets ─────────────────────────────────────

async function ingestTickets(realm: string, token: string): Promise<number> {
  // Tickets: bstdqwrkg
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let data: { data: Array<Record<string, { value: unknown }>> }
  try {
    // 3=ID, 6=title/description, 1=date created, 2=date modified
    data = await qbQuery(realm, token, 'bstdqwrkg', [3, 6, 7, 8, 1, 2], `{'1'.AF.'${sevenDaysAgo}'}`, 200)
  } catch {
    return 0
  }

  let count = 0
  const ingestTx = db.transaction(() => {
    for (const record of data.data || []) {
      const recordId = parseInt(val(record, 3))
      const title = val(record, 6) || val(record, 7) || `Ticket #${recordId}`
      const created = val(record, 1)

      if (!created) continue

      try {
        upsertFeedItem.run(
          'tickets', recordId, 'ticket_created',
          'Ticket created',
          title.length > 200 ? title.substring(0, 200) + '...' : title,
          'System',
          null,
          null, null,
          null,
          created
        )
        count++
      } catch { /* duplicate */ }
    }
  })
  ingestTx()
  return count
}

// ─── Ingest: Arrivy task events ──────────────────────────

async function ingestTaskEvents(realm: string, token: string): Promise<number> {
  // Arrivy Task Log: bvbbznmdb
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let data: { data: Array<Record<string, { value: unknown }>> }
  try {
    // 3=ID, 6-8=various text fields, 1=date created, 2=date modified
    data = await qbQuery(realm, token, 'bvbbznmdb', [3, 6, 7, 8, 9, 1, 2], `{'1'.AF.'${sevenDaysAgo}'}`, 200)
  } catch {
    return 0
  }

  let count = 0
  const ingestTx = db.transaction(() => {
    for (const record of data.data || []) {
      const recordId = parseInt(val(record, 3))
      const desc = val(record, 6) || val(record, 7) || val(record, 8) || val(record, 9)
      const created = val(record, 1)

      if (!created) continue

      try {
        upsertFeedItem.run(
          'task_log', recordId, 'task_event',
          'Field task event',
          desc.length > 200 ? desc.substring(0, 200) + '...' : desc,
          'System',
          null,
          null, null,
          null,
          created
        )
        count++
      } catch { /* duplicate */ }
    }
  })
  ingestTx()
  return count
}

// ─── Trigger full ingestion ──────────────────────────────

router.post('/ingest', async (_req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  const results: Record<string, number | string> = {}

  try {
    results.milestones = await ingestMilestones(realm, token)
  } catch (e) { results.milestones = `error: ${e}` }

  try {
    results.statusChanges = await ingestStatusChanges(realm, token)
  } catch (e) { results.statusChanges = `error: ${e}` }

  try {
    results.notes = await ingestNotes(realm, token)
  } catch (e) { results.notes = `error: ${e}` }

  try {
    results.tickets = await ingestTickets(realm, token)
  } catch (e) { results.tickets = `error: ${e}` }

  try {
    results.taskEvents = await ingestTaskEvents(realm, token)
  } catch (e) { results.taskEvents = `error: ${e}` }

  const totalItems = db.prepare('SELECT COUNT(*) as count FROM feed_items').get() as { count: number }

  res.json({
    success: true,
    ingested: results,
    totalFeedItems: totalItems.count,
  })
})

// Stats
router.get('/stats', (_req: Request, res: Response): void => {
  const total = db.prepare('SELECT COUNT(*) as count FROM feed_items').get() as { count: number }
  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count FROM feed_items GROUP BY event_type ORDER BY count DESC
  `).all()
  const bySource = db.prepare(`
    SELECT qb_source, COUNT(*) as count FROM feed_items GROUP BY qb_source ORDER BY count DESC
  `).all()
  const latest = db.prepare(
    'SELECT occurred_at FROM feed_items ORDER BY occurred_at DESC LIMIT 1'
  ).get() as { occurred_at: string } | undefined

  res.json({ total: total.count, byType, bySource, latestItem: latest?.occurred_at })
})

export { router as feedIngestRouter }
