// Helpers for the per-milestone funding notes pulled from QB's
// "Max M_n_ Event" rollups (see server field map: m{1,2,3}_not_ready_note
// and m{1,2,3}_funding_note).
//
//  • not_ready_note — plain-English reason a milestone can't be requested
//    ("Install is not complete", "No photos in the drive").
//  • funding_note   — "Most Recent Funding Note", often prefixed with a
//    `[OCT-06-25  1:43 PM  Quickbase Admin]` stamp → tells us whether/when
//    the team last touched it. May hold several newline-joined entries.

export interface ParsedNote {
  /** When the note was logged, if a `[…]` stamp was present (verbatim, e.g. "OCT-06-25 1:43 PM"). */
  when: string | null
  /** Who logged it, if present (e.g. "Quickbase Admin"). */
  actor: string | null
  /** The note text with the stamp stripped off. */
  body: string
}

function has(v: unknown): boolean {
  return !!(v && String(v).trim() !== '' && String(v).trim() !== '0')
}

// `[OCT-06-25  1:43 PM  Quickbase Admin] body…`
const STAMP_RE = /^\[([A-Z]{3}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s+(.+?)\]\s*([\s\S]*)$/i

export function parseFundingNote(raw: string): ParsedNote {
  const m = STAMP_RE.exec(raw.trim())
  if (m) {
    return { when: `${m[1]} ${m[2]}`.trim(), actor: m[3]!.trim(), body: m[4]!.trim() }
  }
  return { when: null, actor: null, body: raw.trim() }
}

/** Split a (possibly multi-entry, newline-joined) funding note into parsed entries, newest first as stored. */
export function parseFundingNotes(raw: string | null | undefined): ParsedNote[] {
  if (!has(raw)) return []
  return String(raw)
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(parseFundingNote)
    .filter(n => n.body !== '')
}

export type MilestoneKey = 'm1' | 'm2' | 'm3'

export interface MilestoneNotes {
  key: MilestoneKey
  label: 'M1' | 'M2' | 'M3'
  status: string
  /** The "not ready for funding" reason — the headline of why it's held up. */
  reason: string
  /** Parsed most-recent-funding-note entries (with optional stamp). */
  recent: ParsedNote[]
}

// Row shape we read — both snake_case (project_cache row via SELECT *) and
// the audit endpoints' camelCase aliases are accepted so one helper serves
// both the bump-out and the list views.
type Row = Record<string, unknown>

function pick(row: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (has(v)) return String(v).trim()
  }
  return ''
}

const MILESTONES: Array<{ key: MilestoneKey; label: 'M1' | 'M2' | 'M3' }> = [
  { key: 'm1', label: 'M1' },
  { key: 'm2', label: 'M2' },
  { key: 'm3', label: 'M3' },
]

/**
 * Is a milestone's "not ready" blocker still live (worth showing)?
 *
 * QB's "Not Ready for Funding Note" is captured at the funding event and persists
 * after the milestone completes — so it hangs around on Received/Approved projects
 * as stale text. The note is only meaningful while the milestone is *currently*
 * "Not Ready". Once status moves to Ready-to-Request / Pending / Approved /
 * Received / Rejected, the milestone has been submitted (or is past it) and the
 * blocker should be suppressed. Status is the system's truth here, so gate on it
 * directly (a stray requested-date on a still-"Not Ready" row should still show).
 */
export function isBlockerLive(status: string | null | undefined): boolean {
  return /not\s*ready/i.test(String(status ?? ''))
}

/**
 * Collect the milestones whose "not ready" blocker is still live (reason and/or
 * recent note). Milestones that have been submitted/approved/received/rejected are
 * dropped so stale comments don't hang in the section. `only` narrows to a single
 * milestone (used by the list views, which focus on one milestone per report).
 */
export function collectMilestoneNotes(row: Row, only?: MilestoneKey): MilestoneNotes[] {
  const out: MilestoneNotes[] = []
  for (const m of MILESTONES) {
    if (only && m.key !== only) continue
    const reason = pick(row, `${m.key}_not_ready_note`, `${m.label}NotReadyNote`, 'milestoneNotReadyNote')
    const recentRaw = pick(row, `${m.key}_funding_note`, `${m.label}FundingNote`, 'milestoneFundingNote')
    if (!reason && !recentRaw) continue
    const status = pick(row, `${m.key}_status`, `${m.label}Status`, 'milestoneStatus')
    if (!isBlockerLive(status)) continue
    out.push({
      key: m.key,
      label: m.label,
      status,
      reason,
      recent: parseFundingNotes(recentRaw),
    })
  }
  return out
}
