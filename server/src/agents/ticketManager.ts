// Ticket manager + ride-along agents.
//
// Manager: a rules-first daily pass over open tickets (overdue, stale,
// unassigned, due-today-quiet, aging blockers) with an escalation ladder:
//   stage 1 — check-in message INTO the ticket chat (the assignee's reply
//             is the progress update, in the record where it belongs)
//   stage 2 — bell nudge to the assignee
//   stage 3 — escalation bell to the requester
// A ticket is never nudged more than once per 3 days (ticket_nudges).
//
// Ride-along: upcoming Arrivy field visits (next 7 days) are matched
// against open tickets on the same project; tickets judged "field-doable"
// (LLM via callUserLlm when available, keyword fallback otherwise, cached
// per ticket revision) trigger a bell to the project coordinator and the
// ticket assignee — bundle the work, save the truck roll.
import db from '../db'
import { callUserLlm, type ChatMessage } from '../lib/callUserLlm'
import { pcUserIdForProject } from '../lib/notify'
import { qbQuery, QB, F as ARRIVY_F } from '../routes/field'
import { officeTodayIso } from '../lib/officeTime'

const TICKET_LINK = (projectRid: number | null, ticketRid: number) =>
  projectRid ? `/projects/${projectRid}#tickets` : `/tickets?focus=${ticketRid}`

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_nudges (
    ticket_rid INTEGER PRIMARY KEY,
    stage INTEGER NOT NULL DEFAULT 0,
    last_nudged_at TEXT,
    last_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS ticket_field_flags (
    ticket_rid INTEGER PRIMARY KEY,
    field_doable INTEGER NOT NULL DEFAULT 0,
    onsite_note TEXT,
    judged_at TEXT,
    date_modified TEXT
  );
  CREATE TABLE IF NOT EXISTS ride_along_notices (
    project_rid INTEGER NOT NULL,
    event_date TEXT NOT NULL,
    notified_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_rid, event_date)
  );
`)
{
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(ticket_field_flags)`).all() as Array<{ name: string }>).map(c => c.name)
  )
  // Which visit date this ticket was last bundle-posted for — one chat
  // message per ticket per visit, even across reruns.
  if (!cols.has('last_bundle_event')) db.exec(`ALTER TABLE ticket_field_flags ADD COLUMN last_bundle_event TEXT`)
}

// ── Shared helpers ────────────────────────────────────────

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}
function qbHeaders() {
  const { realm, token } = getQbConfig()
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

// LLM runs under a "system" identity: the first user with a connected
// default provider key, falling back to any admin (platform env key path).
export function pickSystemLlmUserId(): number | null {
  const withKey = db.prepare(`SELECT user_id FROM user_provider_keys WHERE is_default = 1 ORDER BY user_id LIMIT 1`).get() as { user_id: number } | undefined
  if (withKey) return withKey.user_id
  const admin = db.prepare(`
    SELECT u.id FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
    WHERE r.name = 'admin' AND u.is_active = 1 ORDER BY u.id LIMIT 1
  `).get() as { id: number } | undefined
  return admin?.id ?? null
}

function bell(userId: number, type: string, title: string, body: string | null, link: string): void {
  try {
    db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(userId, type, title, body, link)
  } catch (e) {
    console.error('[ticket-agents] bell failed:', e instanceof Error ? e.message : e)
  }
}
function userIdByIdentity(email: string | null, name: string | null): number | null {
  if (email) {
    const u = db.prepare(`SELECT id FROM users WHERE LOWER(email) = ? AND is_active = 1`).get(email.toLowerCase()) as { id: number } | undefined
    if (u) return u.id
  }
  if (name) {
    const u = db.prepare(`SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND is_active = 1`).get(name) as { id: number } | undefined
    if (u) return u.id
  }
  return null
}

interface OpenTicket {
  record_id: number
  title: string | null
  description: string | null
  issue: string | null
  custom_issue: string | null
  category: string | null
  status: string | null
  due_date: string | null
  date_created: string | null
  date_modified: string | null
  assigned_to: string | null
  assigned_email: string | null
  requested_by: string | null
  requested_email: string | null
  project_rid: number | null
  project_name: string | null
  blocker: number
}
function openTickets(): OpenTicket[] {
  return db.prepare(`
    SELECT record_id, title, description, issue, custom_issue, category, status,
           due_date, date_created, date_modified, assigned_to, assigned_email,
           requested_by, requested_email, project_rid, project_name, blocker
    FROM ticket_cache
    WHERE status NOT IN ('Completed','Closed','Complete')
  `).all() as OpenTicket[]
}

function daysBefore(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

// Agent-attributed check-in message into the ticket's chat (a Notes
// record with Related Ticket) — same mechanics as the portal chat write.
const NOTES_TABLE = 'bsb6bqt3b'
const NOTE_F = { recordId: 3, note: 6, category: 7, date: 8, relatedProject: 13, visibleToRep: 141, relatedTicket: 159 }
async function postAgentChat(ticket: OpenTicket, text: string): Promise<boolean> {
  try {
    const fields: Record<string, { value: unknown }> = {
      [String(NOTE_F.relatedTicket)]: { value: ticket.record_id },
      [String(NOTE_F.note)]: { value: text },
      [String(NOTE_F.category)]: { value: 'Tickets' },
      [String(NOTE_F.visibleToRep)]: { value: 'Internal Only' },
      [String(NOTE_F.date)]: { value: new Date().toISOString() },
    }
    if (ticket.project_rid) fields[String(NOTE_F.relatedProject)] = { value: ticket.project_rid }
    const r = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST', headers: qbHeaders(),
      body: JSON.stringify({ to: NOTES_TABLE, data: [fields], fieldsToReturn: [NOTE_F.recordId] }),
    })
    const json = await r.json().catch(() => ({})) as { metadata?: { createdRecordIds?: number[] } }
    const created = json.metadata?.createdRecordIds?.[0]
    if (!r.ok || created === undefined) return false
    db.prepare(`INSERT OR REPLACE INTO note_agent_meta (record_id, agent_name) VALUES (?, 'Ari')`).run(created)
    return true
  } catch (e) {
    console.error('[ticket-manager] chat post failed:', e instanceof Error ? e.message : e)
    return false
  }
}

// ── Manager pass ──────────────────────────────────────────

export interface ManagerResult {
  scanned: number
  flagged: number
  checkins: number
  nudges: number
  escalations: number
  capped: boolean
  teamReports: number
  dry_run?: boolean
  preview?: Array<{ ticket: number; title: string; stage: number; reasons: string }>
}

// Daily past-due report to department leads: each lead gets ONE bell
// summarizing their team's overdue tickets, grouped per member, worst
// first. Members = active users in the lead's department(s); tickets
// matched by assignee email (name fallback).
function sendTeamReports(today: string): number {
  const leads = db.prepare(`
    SELECT DISTINCT ud.user_id AS lead_id
    FROM user_departments ud JOIN users u ON u.id = ud.user_id
    WHERE ud.is_lead = 1 AND u.is_active = 1
  `).all() as Array<{ lead_id: number }>
  let sent = 0
  for (const { lead_id } of leads) {
    const members = db.prepare(`
      SELECT DISTINCT u.id, u.name, LOWER(u.email) AS email
      FROM user_departments ud
      JOIN users u ON u.id = ud.user_id
      WHERE u.is_active = 1 AND ud.department_id IN (
        SELECT department_id FROM user_departments WHERE user_id = ? AND is_lead = 1
      )
    `).all(lead_id) as Array<{ id: number; name: string | null; email: string }>
    if (!members.length) continue

    const lines: string[] = []
    let teamTotal = 0
    for (const m of members) {
      const row = db.prepare(`
        SELECT COUNT(*) AS c, MIN(due_date) AS worst FROM ticket_cache
        WHERE status NOT IN ('Completed','Closed','Complete')
          AND due_date < ? AND due_date != '' AND due_date != '0'
          AND (assigned_email = ? OR LOWER(TRIM(assigned_to)) = LOWER(TRIM(?)))
      `).get(today, m.email, m.name ?? '') as { c: number; worst: string | null }
      if (row.c > 0) {
        teamTotal += row.c
        lines.push(`• ${m.name || m.email}: ${row.c} past due (oldest ${String(row.worst).slice(0, 10)})`)
      }
    }
    if (!teamTotal) continue
    lines.sort((a, b) => (parseInt(b.split(': ')[1] ?? '0') || 0) - (parseInt(a.split(': ')[1] ?? '0') || 0))
    bell(lead_id, 'ticket_team_report',
      `Team past-due report: ${teamTotal} ticket${teamTotal > 1 ? 's' : ''} overdue`,
      lines.join('\n'),
      '/tickets?pivot=assigned_to&due=overdue')
    sent++
  }
  return sent
}

// Per-run action cap: the backlog (90+ already-overdue tickets on day
// one) drains over successive daily runs, worst-first, instead of
// carpet-bombing the team's bells in a single morning.
const MAX_ACTIONS_PER_RUN = 25

export async function runTicketManager(trigger: 'cron' | 'manual' = 'cron', dryRun = false): Promise<ManagerResult> {
  const run = db.prepare(`INSERT INTO agent_runs (agent, trigger, status, model, user_id) VALUES ('ticket-manager', ?, 'running', '', NULL)`).run(dryRun ? `${trigger}-dry` : trigger)
  const runId = Number(run.lastInsertRowid)
  const result: ManagerResult = { scanned: 0, flagged: 0, checkins: 0, nudges: 0, escalations: 0, capped: false, teamReports: 0, ...(dryRun ? { dry_run: true, preview: [] } : {}) }
  try {
    const today = officeTodayIso()
    const staleBefore = daysBefore(today, 5)
    const quietBefore = daysBefore(today, 2)
    const blockerBefore = daysBefore(today, 7)
    const tickets = openTickets()
    result.scanned = tickets.length

    const nudgeRow = db.prepare(`SELECT stage, last_nudged_at FROM ticket_nudges WHERE ticket_rid = ?`)
    const saveNudge = db.prepare(`
      INSERT INTO ticket_nudges (ticket_rid, stage, last_nudged_at, last_reason)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(ticket_rid) DO UPDATE SET stage=excluded.stage, last_nudged_at=excluded.last_nudged_at, last_reason=excluded.last_reason
    `)
    const nudgeCooloff = new Date(Date.now() - 3 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)

    // Pass 1 — classify everything; only cooloff-free tickets compete for
    // the capped action slots, ordered worst-first (most overdue, then
    // blockers, then stalest).
    interface Flagged { t: OpenTicket; reasons: string[]; severity: number }
    const flagged: Flagged[] = []
    for (const t of tickets) {
      const reasons: string[] = []
      const due = (t.due_date ?? '').slice(0, 10)
      const modified = (t.date_modified ?? '').slice(0, 10)
      let severity = 0
      if (due && due !== '0' && due < today) {
        reasons.push(`overdue since ${due}`)
        severity += Math.min(60, Math.max(1, Math.round((new Date(today).getTime() - new Date(due).getTime()) / 86_400_000)))
      } else if (due === today && modified && modified < quietBefore) {
        reasons.push('due today with no recent activity'); severity += 10
      }
      if (modified && modified < staleBefore) { reasons.push(`no activity since ${modified}`); severity += 5 }
      if (!t.assigned_to) { reasons.push('unassigned'); severity += 15 }
      if (t.blocker && (t.date_created ?? '').slice(0, 10) < blockerBefore) { reasons.push('aging blocker'); severity += 20 }
      if (!reasons.length) continue
      result.flagged++
      const prev = nudgeRow.get(t.record_id) as { stage: number; last_nudged_at: string | null } | undefined
      if (prev?.last_nudged_at && prev.last_nudged_at > nudgeCooloff) continue
      flagged.push({ t, reasons, severity })
    }
    flagged.sort((a, b) => b.severity - a.severity)
    const actionable = flagged.slice(0, MAX_ACTIONS_PER_RUN)
    result.capped = flagged.length > actionable.length

    for (const { t, reasons } of actionable) {
      const due = (t.due_date ?? '').slice(0, 10)
      const prev = nudgeRow.get(t.record_id) as { stage: number; last_nudged_at: string | null } | undefined
      const stage = Math.min((prev?.stage ?? 0) + 1, 3)
      const label = t.title || `Ticket #${t.record_id}`
      const reasonText = reasons.join('; ')
      const link = TICKET_LINK(t.project_rid, t.record_id)
      const assigneeId = userIdByIdentity(t.assigned_email, t.assigned_to)

      if (dryRun) {
        result.preview!.push({ ticket: t.record_id, title: label, stage, reasons: reasonText })
        continue
      }

      if (stage === 1 && t.assigned_to) {
        // Check-in in the ticket chat — the reply IS the progress update.
        const dueBit = due && due !== '0' ? (due < today ? `This was due ${due}.` : `This is due ${due}.`) : ''
        const msg = `Checking in — ${reasonText}. ${dueBit} What's the current status, and is anything blocking it? A quick reply here keeps everyone in the loop.`.replace(/\s+/g, ' ').trim()
        const posted = await postAgentChat(t, msg)
        if (posted) {
          result.checkins++
          if (assigneeId) bell(assigneeId, 'ticket_nudge', `Ari checked in on: ${label}`, reasonText, link)
        }
      } else if (stage === 2 || (stage === 1 && !t.assigned_to)) {
        if (assigneeId) {
          bell(assigneeId, 'ticket_nudge', `Still waiting: ${label}`, reasonText, link)
          result.nudges++
        } else {
          // Unassigned — the requester is the only person who can fix that.
          const reqId = userIdByIdentity(t.requested_email, t.requested_by)
          if (reqId) { bell(reqId, 'ticket_nudge', `Unassigned ticket needs an owner: ${label}`, reasonText, link); result.nudges++ }
        }
      } else {
        const reqId = userIdByIdentity(t.requested_email, t.requested_by)
        if (reqId) {
          bell(reqId, 'ticket_nudge', `Escalation — no movement on: ${label}`, `${reasonText}. Assigned to ${t.assigned_to || 'nobody'}; two nudges have gone unanswered.`, link)
          result.escalations++
        }
      }
      saveNudge.run(t.record_id, stage, reasonText)
    }

    if (!dryRun) result.teamReports = sendTeamReports(today)

    db.prepare(`UPDATE agent_runs SET status='completed', finished_at=datetime('now'), output=? WHERE id=?`)
      .run(JSON.stringify(result), runId)
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    db.prepare(`UPDATE agent_runs SET status='failed', finished_at=datetime('now'), error=? WHERE id=?`).run(msg, runId)
    throw e
  }
}

// ── Ride-along pass ───────────────────────────────────────

// Keyword fallback when no LLM is reachable — physical/on-site work markers.
const FIELD_WORK_RE = /\b(cts?|meter|main panel|panel upgrade|breaker|fuse|inverter|batter(y|ies)|wir(e|ing)|conduit|label|placard|photo|picture|torque|module|racking|roof|trench|disconnect|junction box|sub ?panel|mpu|derate|jbox|critter guard|consumption|monitoring hardware|on[- ]?site)\b/i

const FIELD_JUDGE_SYSTEM = `You review support tickets for a residential solar company. Decide whether the ticket describes work a FIELD CREW could reasonably complete during a site visit (physical/on-site work: electrical, hardware, photos, labels, measurements) versus office work (data entry, phone calls, paperwork, approvals).

Respond ONLY with JSON: {"field_doable": true|false, "onsite_note": "<one short instruction for the crew, or null>"}`

interface FieldJudgment { field_doable: boolean; onsite_note: string | null }

async function judgeFieldDoable(t: OpenTicket, systemUserId: number | null, llmBudget: { left: number }): Promise<FieldJudgment> {
  const cached = db.prepare(`SELECT field_doable, onsite_note, date_modified FROM ticket_field_flags WHERE ticket_rid = ?`)
    .get(t.record_id) as { field_doable: number; onsite_note: string | null; date_modified: string | null } | undefined
  if (cached && cached.date_modified === t.date_modified) {
    return { field_doable: cached.field_doable === 1, onsite_note: cached.onsite_note }
  }

  const text = `${t.issue || t.custom_issue || ''} — ${t.description || ''}`.slice(0, 800)
  let judgment: FieldJudgment = { field_doable: FIELD_WORK_RE.test(text), onsite_note: null }

  if (systemUserId && llmBudget.left > 0) {
    llmBudget.left--
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: FIELD_JUDGE_SYSTEM },
        { role: 'user', content: `TICKET (category: ${t.category || '—'}):\n${text}` },
      ]
      const llm = await callUserLlm({
        userId: systemUserId, feature: 'ticket-field-judge', messages,
        maxOutputTokens: 1000, temperature: 0.1, timeoutMs: 45_000,
      })
      if (llm.ok) {
        const cleaned = llm.output.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```/g, '')
        const m = cleaned.match(/\{[\s\S]*\}/)
        if (m) {
          const parsed = JSON.parse(m[0]) as { field_doable?: boolean; onsite_note?: string | null }
          judgment = {
            field_doable: parsed.field_doable === true,
            onsite_note: parsed.onsite_note ? String(parsed.onsite_note).slice(0, 200) : null,
          }
        }
      }
    } catch { /* keep keyword judgment */ }
  }

  db.prepare(`
    INSERT INTO ticket_field_flags (ticket_rid, field_doable, onsite_note, judged_at, date_modified)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(ticket_rid) DO UPDATE SET field_doable=excluded.field_doable, onsite_note=excluded.onsite_note, judged_at=excluded.judged_at, date_modified=excluded.date_modified
  `).run(t.record_id, judgment.field_doable ? 1 : 0, judgment.onsite_note, t.date_modified)
  return judgment
}

// Adjust a ticket's due date (Adjusted Due, fid 92 on bstdqwrkg) to align
// with an upcoming visit — the chat message documents who/why.
const TICKETS_TABLE = 'bstdqwrkg'
const TICKET_ADJUSTED_DUE_FID = 92
async function alignTicketDueDate(ticketRid: number, date: string): Promise<boolean> {
  try {
    const r = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST', headers: qbHeaders(),
      body: JSON.stringify({
        to: TICKETS_TABLE,
        mergeFieldId: 3,
        data: [{ '3': { value: ticketRid }, [String(TICKET_ADJUSTED_DUE_FID)]: { value: date } }],
        fieldsToReturn: [3],
      }),
    })
    return r.ok
  } catch { return false }
}

export interface RideAlongResult {
  upcomingVisits: number
  projectsMatched: number
  ticketsJudged: number
  chatPosts: number
  dueAligned: number
  noticesSent: number
}

export async function runRideAlongPass(trigger: 'cron' | 'manual' = 'cron'): Promise<RideAlongResult> {
  const run = db.prepare(`INSERT INTO agent_runs (agent, trigger, status, model, user_id) VALUES ('ticket-ride-along', ?, 'running', '', NULL)`).run(trigger)
  const runId = Number(run.lastInsertRowid)
  const result: RideAlongResult = { upcomingVisits: 0, projectsMatched: 0, ticketsJudged: 0, chatPosts: 0, dueAligned: 0, noticesSent: 0 }
  try {
    const now = new Date()
    const horizon = new Date(now.getTime() + 7 * 86_400_000)
    const visits = await qbQuery(QB.arrivyTable,
      `{${ARRIVY_F.scheduledDateTime}.OAF.'${now.toISOString()}'}AND{${ARRIVY_F.scheduledDateTime}.OBF.'${horizon.toISOString()}'}`,
      [3, ARRIVY_F.scheduledDateTime, ARRIVY_F.templateName, ARRIVY_F.relatedProject, ARRIVY_F.taskStatus],
      { options: { top: 1000 } },
    )
    // Group upcoming (non-cancelled/complete) visits by project.
    const byProject = new Map<number, Array<{ when: string; what: string }>>()
    for (const v of visits) {
      const status = String(v[String(ARRIVY_F.taskStatus)]?.value || '').toUpperCase()
      if (/CANCEL|COMPLETE|EXCEPTION/.test(status)) continue
      const projRid = parseInt(String(v[String(ARRIVY_F.relatedProject)]?.value || '')) || 0
      const when = String(v[String(ARRIVY_F.scheduledDateTime)]?.value || '')
      if (!projRid || !when) continue
      const arr = byProject.get(projRid) ?? []
      arr.push({ when, what: String(v[String(ARRIVY_F.templateName)]?.value || 'Field visit') })
      byProject.set(projRid, arr)
    }
    result.upcomingVisits = [...byProject.values()].reduce((s, a) => s + a.length, 0)
    if (!byProject.size) {
      db.prepare(`UPDATE agent_runs SET status='completed', finished_at=datetime('now'), output=? WHERE id=?`).run(JSON.stringify(result), runId)
      return result
    }

    const systemUserId = pickSystemLlmUserId()
    const llmBudget = { left: 20 }  // per run — keyword fallback beyond this
    const tickets = openTickets().filter(t => t.project_rid && byProject.has(t.project_rid))

    const noticeGate = db.prepare(`SELECT notified_at FROM ride_along_notices WHERE project_rid = ? AND event_date = ?`)
    const saveNotice = db.prepare(`
      INSERT INTO ride_along_notices (project_rid, event_date, notified_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(project_rid, event_date) DO UPDATE SET notified_at=excluded.notified_at
    `)

    const byProjectTickets = new Map<number, Array<{ t: OpenTicket; note: string | null }>>()
    for (const t of tickets) {
      const judgment = await judgeFieldDoable(t, systemUserId, llmBudget)
      result.ticketsJudged++
      if (!judgment.field_doable) continue
      const arr = byProjectTickets.get(t.project_rid!) ?? []
      arr.push({ t, note: judgment.onsite_note })
      byProjectTickets.set(t.project_rid!, arr)
    }

    const bundleGate = db.prepare(`SELECT last_bundle_event FROM ticket_field_flags WHERE ticket_rid = ?`)
    const saveBundle = db.prepare(`UPDATE ticket_field_flags SET last_bundle_event = ? WHERE ticket_rid = ?`)

    for (const [projRid, doable] of byProjectTickets) {
      const events = byProject.get(projRid)!
      const nextEvent = events.sort((a, b) => a.when.localeCompare(b.when))[0]!
      const eventDate = nextEvent.when.slice(0, 10)
      result.projectsMatched++

      const projectName = doable[0]!.t.project_name || `project ${projRid}`
      const whenLabel = new Date(nextEvent.when).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

      // Autonomous, per ticket: durable chat post + due-date alignment.
      // One post per ticket per visit date, regardless of rerun cadence.
      let actedOn = 0
      for (const d of doable) {
        const prior = bundleGate.get(d.t.record_id) as { last_bundle_event: string | null } | undefined
        if (prior?.last_bundle_event === eventDate) continue

        const due = (d.t.due_date ?? '').slice(0, 10)
        const shouldAlign = !due || due === '0' || due > eventDate
        const msg = [
          `A ${nextEvent.what} visit is scheduled for ${whenLabel} at this project. This ticket looks field-doable — bundling it into that visit avoids a separate truck roll.`,
          d.note ? `Suggested crew instruction: ${d.note}` : '',
          shouldAlign ? `I've aligned the due date to ${eventDate} so the work is ready when the crew is on-site.` : '',
        ].filter(Boolean).join(' ')

        const posted = await postAgentChat(d.t, msg)
        if (posted) result.chatPosts++
        if (shouldAlign && await alignTicketDueDate(d.t.record_id, eventDate)) result.dueAligned++
        saveBundle.run(eventDate, d.t.record_id)
        actedOn++
      }

      // ONE bell per project/visit — to the coordinator, who owns dispatch.
      if (actedOn > 0) {
        const gate = noticeGate.get(projRid, eventDate) as { notified_at: string } | undefined
        if (!gate) {
          const list = doable.slice(0, 5).map(d => `• ${d.t.title || `#${d.t.record_id}`}`).join('\n')
          const pcId = pcUserIdForProject(projRid)
          if (pcId) {
            bell(pcId, 'ticket_ride_along',
              `Crew on-site ${whenLabel} at ${projectName} — ${doable.length} ticket${doable.length > 1 ? 's' : ''} bundled`,
              `${nextEvent.what} scheduled. Details posted in each ticket's chat:\n${list}`,
              `/projects/${projRid}#tickets`)
            result.noticesSent++
          }
          saveNotice.run(projRid, eventDate)
        }
      }
    }

    db.prepare(`UPDATE agent_runs SET status='completed', finished_at=datetime('now'), output=? WHERE id=?`).run(JSON.stringify(result), runId)
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    db.prepare(`UPDATE agent_runs SET status='failed', finished_at=datetime('now'), error=? WHERE id=?`).run(msg, runId)
    throw e
  }
}
