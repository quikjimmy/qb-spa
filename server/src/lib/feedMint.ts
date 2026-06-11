// Webhook → feed post minting. When a QB pipeline fires project-refresh,
// qb-webhooks snapshots the old project_cache row, lets fetchOneLive
// overwrite it, then calls mintFromProjectDiff(old, fresh, actor) here.
// Newly-set milestone dates and status changes become feed_items rows,
// published live over SSE (lib/feedEvents) and mirrored to notifications
// for tagged portal users.
//
// Minting is deliberately webhook-path only: the tier scheduler also
// rewrites cache rows in bulk, but those refreshes have no "doer" and a
// first bulk pass would storm the feed with stale history. The dedup_key
// contract (db.ts) leaves room to add a scheduler diff later.
import db from '../db'
import { publishFeedItem, type FeedStreamItem } from './feedEvents'

type CacheRow = Record<string, unknown>

export type MintTone = 'celebration' | 'scheduled' | 'attention'

interface MilestoneDef {
  col: string
  fid: number
  label: string
  tone: MintTone
  // Two copy variants: `phrase` reads after the actor's bolded name in
  // the caption ("**Jane Doe** approved the site survey for Smith, John");
  // `solo` is a standalone sentence for unattributed posts ("Site survey
  // approved for Smith, John"). Attribution is payload-actor-or-nothing,
  // so solo copy must never imply a doer.
  phrase: (customer: string, date: string) => string
  solo: (customer: string, date: string) => string
  // Reschedules are news for *_scheduled fields; for completions a changed
  // value is almost always a QB data correction — skip those.
  mintOnReschedule: boolean
  reschedulePhrase?: (customer: string, date: string) => string
  rescheduleSolo?: (customer: string, date: string) => string
}

const MILESTONE_DEFS: MilestoneDef[] = [
  // ── Celebrations ──
  { col: 'survey_approved', fid: 165, label: 'Survey Approved', tone: 'celebration', mintOnReschedule: false,
    phrase: c => `approved the site survey for ${c}`,
    solo: c => `Site survey approved for ${c}` },
  { col: 'design_completed', fid: 1774, label: 'Design Completed', tone: 'celebration', mintOnReschedule: false,
    phrase: c => `completed the design for ${c}`,
    solo: c => `Design completed for ${c}` },
  { col: 'permit_approved', fid: 208, label: 'Permit Approved', tone: 'celebration', mintOnReschedule: false,
    phrase: c => `landed the permit approval for ${c}`,
    solo: c => `Permit approved for ${c}` },
  { col: 'nem_approved', fid: 327, label: 'NEM Approved', tone: 'celebration', mintOnReschedule: false,
    phrase: c => `got NEM approved for ${c}`,
    solo: c => `NEM approved for ${c}` },
  { col: 'install_completed', fid: 534, label: 'Install Completed', tone: 'celebration', mintOnReschedule: false,
    phrase: c => `completed the install for ${c}`,
    solo: c => `Install completed for ${c}` },
  { col: 'inspection_passed', fid: 491, label: 'Inspection Passed', tone: 'celebration', mintOnReschedule: false,
    phrase: c => `passed inspection for ${c}`,
    solo: c => `Inspection passed for ${c}` },
  { col: 'pto_approved', fid: 538, label: 'PTO Approved', tone: 'celebration', mintOnReschedule: false,
    phrase: c => `secured PTO for ${c} — system is live`,
    solo: c => `PTO approved — ${c}'s system is live` },
  // ── Forward-looking schedules ──
  { col: 'survey_scheduled', fid: 166, label: 'Survey Scheduled', tone: 'scheduled', mintOnReschedule: true,
    phrase: (c, d) => `scheduled the site survey for ${c}${d ? ` — ${d}` : ''}`,
    solo: (c, d) => `Site survey on the calendar for ${c}${d ? ` — ${d}` : ''}`,
    reschedulePhrase: (c, d) => `moved ${c}'s survey${d ? ` to ${d}` : ''}`,
    rescheduleSolo: (c, d) => `${c}'s survey moved${d ? ` to ${d}` : ''}` },
  { col: 'install_scheduled', fid: 178, label: 'Install Scheduled', tone: 'scheduled', mintOnReschedule: true,
    phrase: (c, d) => `put ${c}'s install on the calendar${d ? ` — ${d}` : ''}`,
    solo: (c, d) => `Install on the calendar for ${c}${d ? ` — ${d}` : ''}`,
    reschedulePhrase: (c, d) => `moved ${c}'s install${d ? ` to ${d}` : ''}`,
    rescheduleSolo: (c, d) => `${c}'s install moved${d ? ` to ${d}` : ''}` },
  { col: 'inspection_scheduled', fid: 226, label: 'Inspection Scheduled', tone: 'scheduled', mintOnReschedule: true,
    phrase: (c, d) => `scheduled inspection for ${c}${d ? ` — ${d}` : ''}`,
    solo: (c, d) => `Inspection on the calendar for ${c}${d ? ` — ${d}` : ''}`,
    reschedulePhrase: (c, d) => `moved ${c}'s inspection${d ? ` to ${d}` : ''}`,
    rescheduleSolo: (c, d) => `${c}'s inspection moved${d ? ` to ${d}` : ''}` },
  // ── Attention (calm copy — actionable, never alarming) ──
  { col: 'permit_rejected', fid: 706, label: 'Permit Needs Another Pass', tone: 'attention', mintOnReschedule: false,
    phrase: c => `flagged ${c}'s permit for another pass`,
    solo: c => `${c}'s permit needs another pass` },
  { col: 'nem_rejected', fid: 1878, label: 'NEM Needs Another Pass', tone: 'attention', mintOnReschedule: false,
    phrase: c => `flagged ${c}'s NEM submission for another pass`,
    solo: c => `${c}'s NEM submission needs another pass` },
]

// Cap per-diff posts: a QB mass-backfill that sets many dates at once
// collapses into a single summary post instead of flooding the feed.
const STORM_CAP = 5

const NOTIFY_MENTIONS = true

// QB pipelines/automations run AS their owning user, so [Last Modified
// By] — and even the payload's merge-field actor — names the pipeline
// OWNER for changes the automation made, not whoever did the real work.
// Identities listed here (comma-separated names/emails in
// FEED_AUTOMATION_ACTORS, case-insensitive) are never credited or
// "likely"-chipped; their posts get an honest "Automated" marker
// instead. Note the tradeoff: a listed account's GENUINE manual edits
// also demote — use a dedicated service account for pipelines to keep
// personal attribution clean.
const AUTOMATION_ACTORS = new Set(
  (process.env['FEED_AUTOMATION_ACTORS'] || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
)

function isAutomationActor(name: string | null | undefined, email: string | null | undefined): boolean {
  if (AUTOMATION_ACTORS.size === 0) return false
  return (!!name && AUTOMATION_ACTORS.has(name.trim().toLowerCase()))
    || (!!email && AUTOMATION_ACTORS.has(email.trim().toLowerCase()))
}

function isSet(v: unknown): boolean {
  if (v == null) return false
  const s = String(v).trim()
  return s !== '' && s !== '0'
}

function str(row: CacheRow, col: string): string {
  const v = row[col]
  return v == null ? '' : String(v)
}

// 'YYYY-MM-DD...' → 'Jun 15'. Parse date-only strings at noon to dodge
// the UTC-midnight day shift.
function fmtDate(raw: string): string {
  if (!raw) return ''
  const d = raw.length === 10 ? new Date(`${raw}T12:00:00`) : new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export interface PayloadActor { name?: string | null; email?: string | null }

export interface Mention {
  name: string
  email: string | null
  role: string
  user_id: number | null
}

// Snapshot MUST run before fetchOneLive — its INSERT OR REPLACE destroys
// the prior row, and the diff needs it.
export function snapshotProject(recordId: number): CacheRow | undefined {
  return db.prepare(`SELECT * FROM project_cache WHERE record_id = ?`).get(recordId) as CacheRow | undefined
}

// Attribution is binary: the pipeline payload's actor (QB snapshots the
// record at trigger time, so it IS the person whose edit fired the
// webhook) — or nobody. The fetched [Last Modified By] (FID 5) is NOT
// used for crediting: it's read 1–2s after the change, and a second
// edit by someone else in that window would pin their name on this
// post. It goes into metadata as an audit hint only. The coordinator
// is an assignment, never a doer — chip-tagged, never credited.
function resolveActor(payloadActor: PayloadActor | null): { name: string; email: string | null } | null {
  if (payloadActor?.name?.trim()) {
    return { name: payloadActor.name.trim(), email: payloadActor.email?.trim() || null }
  }
  return null
}

// Match a QB name/email to a portal user so mention chips can carry a
// user_id. Email (via the cross-system user_email_lookup view) wins;
// name match is the fallback for text-lookup fields like coordinator.
function matchPortalUser(name: string, email: string | null): number | null {
  if (email) {
    const byEmail = db.prepare(`SELECT user_id FROM user_email_lookup WHERE email = LOWER(TRIM(?)) LIMIT 1`)
      .get(email) as { user_id: number } | undefined
    if (byEmail) return byEmail.user_id
  }
  if (name) {
    const byName = db.prepare(`SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND is_active = 1 LIMIT 1`)
      .get(name) as { id: number } | undefined
    if (byName) return byName.id
  }
  return null
}

function resolveMentions(fresh: CacheRow): Mention[] {
  const mentions: Mention[] = []
  const coord = str(fresh, 'coordinator').trim()
  if (coord) {
    mentions.push({ name: coord, email: null, role: 'coordinator', user_id: matchPortalUser(coord, null) })
  }
  return mentions
}

function notifyMentions(item: FeedStreamItem, mentions: Mention[], actor: { name: string; email: string | null } | null): void {
  if (!NOTIFY_MENTIONS) return
  const actorUserId = actor ? matchPortalUser(actor.name, actor.email) : null
  const insert = db.prepare(`
    INSERT INTO notifications (user_id, type, title, body, link)
    VALUES (?, 'feed_mention', ?, ?, '/feed')
  `)
  for (const m of mentions) {
    if (m.user_id == null) continue
    if (actorUserId != null && m.user_id === actorUserId) continue  // don't notify the doer about their own post
    try {
      insert.run(m.user_id, item.title, item.project_name ? `${item.project_name} — you were tagged` : 'You were tagged in a feed post')
    } catch (e) {
      console.error('[feed-mint] notification insert failed:', e instanceof Error ? e.message : e)
    }
  }
}

// INSERT OR IGNORE (not ON CONFLICT(dedup_key) DO NOTHING): SQLite can't
// target a partial unique index in a conflict clause without repeating
// its WHERE; OR IGNORE covers it and `changes === 0` still detects dups.
//
// occurred_at is passed in (ms precision, UTC, +1ms per post in a batch)
// rather than datetime('now'): the legacy UNIQUE(qb_source, qb_record_id,
// event_type, occurred_at) constraint would otherwise swallow the second
// of two posts minted for the same project in the same second.
const insertFeedItem = db.prepare(`
  INSERT OR IGNORE INTO feed_items
    (qb_source, qb_record_id, event_type, title, body, actor_name, actor_email,
     project_id, project_name, metadata, occurred_at, dedup_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

// '2026-06-09 21:39:23.123' — SQLite-style UTC datetime with ms. String
// sort order stays correct alongside second-precision values.
function sqliteDatetimeMs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

const selectFeedItem = db.prepare(`SELECT * FROM feed_items WHERE id = ?`)

interface PendingPost {
  eventType: string
  title: string
  body: string
  dedupKey: string
  meta: Record<string, unknown>
}

function insertAndPublish(
  posts: PendingPost[],
  rid: number,
  fresh: CacheRow,
  actor: { name: string; email: string | null } | null,
  mentions: Mention[],
  eventId: number | undefined,
  source: 'webhook' | 'scheduler',
  actorWasAutomation: boolean,
): number {
  const projectName = str(fresh, 'customer_name') || null
  // "Likely doer" hint from the live fetch (FID 5) — rendered as an
  // explicitly-uncertain "likely" credit, never the headline actor
  // (see resolveActor for why it can't be trusted as fact). Suppressed
  // entirely when it names an automation identity.
  let lmbHint = str(fresh, 'last_modified_by').trim() || null
  let lmbEmailHint = str(fresh, 'last_modified_by_email').trim() || null
  const lmbIsAutomation = isAutomationActor(lmbHint, lmbEmailHint)
  if (lmbIsAutomation) { lmbHint = null; lmbEmailHint = null }
  const batchStart = Date.now()
  let minted = 0
  for (const [i, p] of posts.entries()) {
    const metadata = JSON.stringify({
      source,
      actor_source: actor ? 'webhook' : 'none',
      automated: (lmbIsAutomation || actorWasAutomation) || undefined,
      qb_last_modified_by: lmbHint,
      qb_last_modified_by_email: lmbEmailHint,
      webhook_event_id: eventId ?? null,
      mentions,
      ...p.meta,
    })
    let result
    try {
      result = insertFeedItem.run(
        'projects', rid, p.eventType, p.title, p.body,
        actor?.name ?? null, actor?.email ?? null, rid, projectName, metadata,
        sqliteDatetimeMs(new Date(batchStart + i)), p.dedupKey,
      )
    } catch (e) {
      console.error('[feed-mint] insert failed:', e instanceof Error ? e.message : e)
      continue
    }
    if (result.changes === 0) continue  // dedup hit (webhook retry / batch backfill already posted)
    minted++
    const row = selectFeedItem.get(Number(result.lastInsertRowid)) as Record<string, unknown>
    const item: FeedStreamItem = {
      ...(row as unknown as FeedStreamItem),
      comment_count: 0,
      reactions: [],
      media: [],
    }
    publishFeedItem(item)
    notifyMentions(item, mentions, actor)
  }
  return minted
}

// Entry point — called from qb-webhooks after fetchOneLive. Wrapped in
// try/catch by the caller: minting is best-effort and must never fail
// the cache refresh.
export function mintFromProjectDiff(
  oldRow: CacheRow | undefined,
  fresh: CacheRow,
  payloadActor: PayloadActor | null,
  opts: { eventId?: number; source?: 'webhook' | 'scheduler' } = {},
): { minted: number } {
  // First-ever cache of this project: no baseline — minting would post
  // the project's entire milestone history at once.
  if (!oldRow) return { minted: 0 }

  const rid = Number(fresh['record_id'])
  if (!Number.isFinite(rid) || rid <= 0) return { minted: 0 }

  const customer = str(fresh, 'customer_name') || 'this project'
  // A payload actor that names an automation identity demotes to
  // unattributed — the pipeline owner didn't do the work.
  const payloadIsAutomation = isAutomationActor(payloadActor?.name ?? null, payloadActor?.email ?? null)
  const actor = payloadIsAutomation ? null : resolveActor(payloadActor)
  const mentions = resolveMentions(fresh)

  const posts: PendingPost[] = []

  for (const def of MILESTONE_DEFS) {
    const oldVal = str(oldRow, def.col)
    const newVal = str(fresh, def.col)
    if (!isSet(newVal)) continue
    const wasSet = isSet(oldVal)
    if (wasSet && oldVal === newVal) continue
    if (wasSet && !def.mintOnReschedule) continue  // completion-date edits = QB corrections

    const reschedule = wasSet && def.mintOnReschedule
    const dateStr = fmtDate(newVal)
    const body = reschedule
      ? (actor ? def.reschedulePhrase! : def.rescheduleSolo!)(customer, dateStr)
      : (actor ? def.phrase : def.solo)(customer, dateStr)
    posts.push({
      eventType: 'milestone',
      title: reschedule ? def.label.replace('Scheduled', 'Rescheduled') : def.label,
      body,
      dedupKey: `projects:${rid}:milestone:${def.col}:${newVal}`,
      meta: {
        tone: def.tone,
        milestone_col: def.col,
        milestone_fid: def.fid,
        milestone_date: newVal,
        ...(reschedule ? { previous_date: oldVal } : {}),
      },
    })
  }

  // Status change — any old≠new, including first set.
  const oldStatus = str(oldRow, 'status').trim()
  const newStatus = str(fresh, 'status').trim()
  if (newStatus && newStatus !== oldStatus) {
    const today = new Date().toISOString().slice(0, 10)
    const body = actor
      ? (oldStatus ? `moved ${customer} from ${oldStatus} to ${newStatus}` : `set ${customer} to ${newStatus}`)
      : (oldStatus ? `${customer} moved from ${oldStatus} to ${newStatus}` : `${customer} is now ${newStatus}`)
    posts.push({
      eventType: 'status_change',
      title: newStatus,
      body,
      dedupKey: `projects:${rid}:status:${newStatus}:${today}`,
      meta: { tone: 'scheduled', old_status: oldStatus || null, new_status: newStatus },
    })
  }

  if (posts.length === 0) return { minted: 0 }

  // Storm cap — collapse a mass-backfill into one summary post.
  if (posts.length > STORM_CAP) {
    console.warn(`[feed-mint] project ${rid}: ${posts.length} transitions in one diff — collapsing to summary post`)
    const cols = posts.map(p => `${p.meta['milestone_col'] ?? p.eventType}:${p.meta['milestone_date'] ?? p.meta['new_status'] ?? ''}`).sort()
    const summary: PendingPost = {
      eventType: 'project_update',
      title: `${posts.length} updates`,
      body: actor ? `made ${posts.length} updates on ${customer}` : `${posts.length} updates on ${customer}`,
      dedupKey: `projects:${rid}:bulk:${cols.join('+')}`,
      meta: { tone: 'scheduled', updates: posts.map(p => p.title) },
    }
    return { minted: insertAndPublish([summary], rid, fresh, actor, mentions, opts.eventId, opts.source ?? 'webhook', payloadIsAutomation) }
  }

  return { minted: insertAndPublish(posts, rid, fresh, actor, mentions, opts.eventId, opts.source ?? 'webhook', payloadIsAutomation) }
}
