import type { ProjectNote } from './holdClassifier'

const NOTES_TABLE_ID = 'bsb6bqt3b'

const NOTE_FIDS = {
  record_id: 3,
  note: 6,
  category: 7,
  date: 8,
  note_by: 9,
  project_id: 13,
  disposition: 39,
  new_status: 96,
  current_status: 97,
  internal_note: 136,
} as const

interface QbValue { value: unknown }

function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if ('name' in (v as Record<string, unknown>)) return String((v as { name: string }).name)
    if ('email' in (v as Record<string, unknown>)) return String((v as { email: string }).email)
  }
  return String(v)
}

export async function fetchProjectNotes(projectId: number, sinceDays = 90): Promise<ProjectNote[]> {
  const realm = process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com'
  const token = process.env['QB_USER_TOKEN'] || ''
  if (!token) throw new Error('QB_USER_TOKEN not set')

  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const res = await fetch('https://api.quickbase.com/v1/records/query', {
    method: 'POST',
    headers: {
      'QB-Realm-Hostname': realm,
      'Authorization': `QB-USER-TOKEN ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: NOTES_TABLE_ID,
      select: Object.values(NOTE_FIDS),
      where: `{'${NOTE_FIDS.project_id}'.EX.'${projectId}'}AND{'${NOTE_FIDS.date}'.OAF.'${cutoff}'}`,
      sortBy: [{ fieldId: NOTE_FIDS.date, order: 'DESC' }],
      options: { top: 200 },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QB notes query failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { data?: Array<Record<string, QbValue>> }
  const records = data.data || []

  return records.map((r): ProjectNote => ({
    record_id: Number(toStr(r[String(NOTE_FIDS.record_id)]?.value)) || 0,
    date: toStr(r[String(NOTE_FIDS.date)]?.value),
    category: toStr(r[String(NOTE_FIDS.category)]?.value),
    note_by: toStr(r[String(NOTE_FIDS.note_by)]?.value),
    text: toStr(r[String(NOTE_FIDS.note)]?.value),
    disposition: toStr(r[String(NOTE_FIDS.disposition)]?.value) || undefined,
    new_status: toStr(r[String(NOTE_FIDS.new_status)]?.value) || undefined,
    current_status: toStr(r[String(NOTE_FIDS.current_status)]?.value) || undefined,
    internal_note: toStr(r[String(NOTE_FIDS.internal_note)]?.value) === 'true',
  }))
}
