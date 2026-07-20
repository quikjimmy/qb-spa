// Battery-intake stuck-deal notifier. Every 5 min it reads the HVC Raw JSON
// staging table and surfaces any battery deal that failed intake ("stuck" =
// error / incomplete / manual_review / bad_payload; blank = not processed yet,
// never alerts).
//
// Two delivery channels, by design:
//   1. In-app bell — one notification per admin (a durable record + the in-app
//      triage deep link). Deduped via the notifications table.
//   2. Slack — posted to the intake team's channel (the "normal channel" people
//      actually watch) via chat.postMessage as the configured Slack app (Ari's
//      app), so alerts appear as Ari. Delivery is deliberately deterministic:
//      an LLM DRAFTS the human line, but delivery never depends on the LLM
//      (draft failure falls back to a plain factual line).
//
// Anti-silent-failure measures (the whole point):
//   • A heartbeat 3×/day (8am / 1pm / 8pm MT, "healthy — N stuck") so SILENCE
//     reads as "the monitor died", not "all clear".
//   • QB-read failures are surfaced to Slack (rate-limited), with a recovery
//     ping when reads succeed again.
//   • Slack dedup rows are written only AFTER a successful post, so a failed
//     post retries next sweep instead of being silently swallowed.

import db from '../db'
import { insertIfNew } from './notify'
import { adminUserIds } from './predictedLatePoller'
import { fetchBatteryDeals, isStuckStatus, type BatteryDeal } from '../routes/battery-intake'
import { callUserLlm } from './callUserLlm'
import { pickSystemLlmUserId } from '../agents/ticketManager'
import { postSlackMessage } from './slack'
import { officeTodayIso } from './officeTime'

const STATUS_LABEL: Record<string, string> = {
  error: 'Error',
  incomplete: 'Incomplete',
  manual_review: 'Manual review',
  bad_payload: 'Bad payload',
}

const HEARTBEAT_HOURS_MT = [8, 13, 20] // post a "healthy" ping at 8am / 1pm / 8pm MT
const ERROR_REPOST_MS = 60 * 60_000 // re-alert a persisting QB failure at most hourly
const SUMMARY_THRESHOLD = 3       // >N newly-stuck in one sweep → one summary, not a burst

// Slack post dedup + notifier state (heartbeat date, last error). Colocated
// with the notifier; created on import like the other lib-owned tables.
db.exec(`
  CREATE TABLE IF NOT EXISTS battery_intake_slack_alerts (
    record_id INTEGER NOT NULL,
    intake_status TEXT NOT NULL,
    notified_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (record_id, intake_status)
  );
  CREATE TABLE IF NOT EXISTS battery_intake_notifier_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`)

function slackToken(): string { return (process.env['ARI_SLACK_BOT_TOKEN'] || '').trim() }
function slackChannel(): string { return (process.env['INTAKE_SLACK_CHANNEL_ID'] || '').trim() }
function slackConfigured(): boolean { return !!slackToken() && !!slackChannel() }
async function postSlack(text: string): Promise<{ ok: boolean; error?: string }> {
  return postSlackMessage(slackToken(), slackChannel(), text)
}

function appBaseUrl(): string { return (process.env['PUBLIC_APP_URL'] || 'http://localhost:5173').replace(/\/+$/, '') }
function dealLink(d: BatteryDeal): string { return `${appBaseUrl()}/projects/battery-intake?deal=${d.record_id}` }

function getState(key: string): string | null {
  const r = db.prepare('SELECT value FROM battery_intake_notifier_state WHERE key = ?').get(key) as { value: string } | undefined
  return r?.value ?? null
}
function setState(key: string, value: string): void {
  db.prepare('INSERT INTO battery_intake_notifier_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
function clearState(key: string): void {
  db.prepare('DELETE FROM battery_intake_notifier_state WHERE key = ?').run(key)
}
function alreadyAlerted(recordId: number, status: string): boolean {
  return !!db.prepare('SELECT 1 FROM battery_intake_slack_alerts WHERE record_id = ? AND intake_status = ?').get(recordId, status)
}
function recordSlackAlert(recordId: number, status: string): void {
  db.prepare('INSERT OR IGNORE INTO battery_intake_slack_alerts (record_id, intake_status) VALUES (?, ?)').run(recordId, status)
}

function fallbackLine(d: BatteryDeal): string {
  const label = STATUS_LABEL[d.intake_status] ?? d.intake_status
  const reason = (d.intake_error || d.intake_missing || '').replace(/\s+/g, ' ').trim()
  return reason ? `${label} — ${reason}` : label
}

// LLM DRAFTS the human line (what failed + what to tell the rep). Delivery does
// not depend on it — any failure returns the deterministic fallback.
async function draftLine(d: BatteryDeal): Promise<string> {
  const fallback = fallbackLine(d)
  const userId = pickSystemLlmUserId()
  if (!userId) return fallback
  const facts = [
    `Customer: ${d.customer_name || 'Unknown'}`,
    `Intake status: ${d.intake_status}`,
    `Error: ${d.intake_error || '(none)'}`,
    `Missing data: ${d.intake_missing || '(none)'}`,
    `Stopped at step: ${d.intake_step || '(none)'}`,
    `Sales rep on the deal: ${d.rep || '(unknown)'}`,
  ].join('\n')
  try {
    const llm = await callUserLlm({
      userId,
      feature: 'battery-intake-alert',
      messages: [
        { role: 'system', content: 'You draft a one- or two-sentence Slack alert for the solar intake team about a battery deal that failed to process through intake. State plainly what went wrong and the concrete next step — including, when data is missing or wrong, what the sales rep who submitted the deal needs to correct. No greeting, no emoji, do not restate the customer name. Be specific and brief.' },
        { role: 'user', content: facts },
      ],
      // ≥2000 so reasoning models (the fleet runs GLM 5.2 Cloud via Ollama)
      // have room to emit visible text after their thinking phase — at a low
      // budget the answer comes back empty. Actual drafts are short.
      maxOutputTokens: 2000,
      temperature: 0.2,
      timeoutMs: 30_000,
    })
    if (!llm.ok) return fallback
    const out = (llm.output || '').replace(/\s+/g, ' ').trim()
    return out || fallback
  } catch {
    return fallback
  }
}

async function postStuckDeal(d: BatteryDeal): Promise<boolean> {
  const line = await draftLine(d)
  const label = STATUS_LABEL[d.intake_status] ?? d.intake_status
  const text = [
    `:warning: *Battery intake stuck* — ${d.customer_name || 'Unknown customer'}`,
    line,
    `Status: \`${label}\`${d.attempt_count ? ` · attempt ${d.attempt_count}` : ''}`,
    `<${dealLink(d)}|Triage in monitor> · <${d.qb_url}|QuickBase row>`,
  ].join('\n')
  const r = await postSlack(text)
  if (!r.ok) console.error('[battery-stuck] slack post failed:', r.error)
  return r.ok
}

async function postSummary(deals: BatteryDeal[]): Promise<boolean> {
  const lines = deals.map(d => `• ${d.customer_name || 'Unknown'} — \`${STATUS_LABEL[d.intake_status] ?? d.intake_status}\` <${dealLink(d)}|open>`).join('\n')
  const r = await postSlack(`:warning: *${deals.length} battery deals failed intake*\n${lines}`)
  if (!r.ok) console.error('[battery-stuck] slack summary post failed:', r.error)
  return r.ok
}

function officeHourMT(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
}

async function maybeHeartbeat(deals: BatteryDeal[]): Promise<void> {
  // Fire once per scheduled slot (8am / 1pm / 8pm MT). On each 5-min sweep we
  // resolve the latest slot whose hour has passed today and post if we haven't
  // already for that (date, slot). A slot missed while the server was down is
  // caught on the next boot sweep (we post the current latest slot, not a
  // backlog of all missed ones).
  const hour = officeHourMT()
  const due = HEARTBEAT_HOURS_MT.filter(s => hour >= s).pop()
  if (due === undefined) return // before the first slot of the day
  const slot = `${officeTodayIso()}:${due}`
  if (getState('last_heartbeat_slot') === slot) return
  const stuck = deals.filter(d => isStuckStatus(d.intake_status)).length
  const queued = deals.filter(d => d.send_to_zap).length
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const r = await postSlack(`:white_check_mark: Battery intake monitor healthy — ${stuck} stuck, ${queued} queued, ${deals.length} total. Last checked ${when} MT.`)
  if (r.ok) setState('last_heartbeat_slot', slot)
  else console.error('[battery-stuck] heartbeat post failed:', r.error)
}

async function reportQbError(err: string): Promise<void> {
  const last = getState('last_error_at')
  if (last && Date.now() - new Date(last).getTime() < ERROR_REPOST_MS) return // hourly at most
  setState('last_error_at', new Date().toISOString())
  await postSlack(`:rotating_light: Battery intake monitor can't read QuickBase — stuck-deal alerts may be delayed. Error: ${err.slice(0, 300)}`)
}

async function noteRecovery(): Promise<void> {
  if (!getState('last_error_at')) return
  clearState('last_error_at')
  await postSlack(':white_check_mark: Battery intake monitor recovered — QuickBase reads are succeeding again.')
}

let timer: ReturnType<typeof setInterval> | null = null
let running = false

async function sweep(): Promise<void> {
  if (running) return // never overlap cycles — QB + LLM reads can be slow
  running = true
  try {
    const admins = adminUserIds()
    const slackOn = slackConfigured()

    let deals: BatteryDeal[]
    try {
      deals = await fetchBatteryDeals(true) // live read, bypass the 60s cache
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[battery-stuck] QB fetch failed:', msg)
      if (slackOn) await reportQbError(msg)
      return
    }
    if (slackOn) await noteRecovery() // reads work again → clear/announce recovery

    const stuck = deals.filter(d => isStuckStatus(d.intake_status))

    // 1. In-app bell — one per admin, deduped by the notifications table.
    let bellCreated = 0
    for (const d of stuck) {
      const reason = (d.intake_error || d.intake_missing || '').replace(/\s+/g, ' ').trim().slice(0, 140)
      const title = `Battery intake stuck: ${d.customer_name || 'Unknown customer'}`
      const body = reason ? `${STATUS_LABEL[d.intake_status] ?? d.intake_status} — ${reason}` : (STATUS_LABEL[d.intake_status] ?? d.intake_status)
      const link = `/projects/battery-intake?deal=${d.record_id}&s=${d.intake_status}`
      for (const userId of admins) {
        if (insertIfNew({ userId, type: 'battery_intake_stuck', title, body, link })) bellCreated++
      }
    }
    if (bellCreated > 0) console.log(`[battery-stuck] ${stuck.length} stuck deal(s) → ${bellCreated} new bell alert(s) (${admins.length} admin(s))`)

    // 2. Slack — post only deals not already alerted for this status; record the
    //    dedup row only AFTER a successful post so a failure retries next sweep.
    if (slackOn) {
      const candidates = stuck.filter(d => !alreadyAlerted(d.record_id, d.intake_status))
      if (candidates.length > SUMMARY_THRESHOLD) {
        if (await postSummary(candidates)) candidates.forEach(d => recordSlackAlert(d.record_id, d.intake_status))
      } else {
        for (const d of candidates) {
          if (await postStuckDeal(d)) recordSlackAlert(d.record_id, d.intake_status)
        }
      }
      // 3. Heartbeat (3×/day) — silence then means "died", not "all clear".
      await maybeHeartbeat(deals)
    }
  } finally {
    running = false
  }
}

export function startBatteryStuckNotifier(): void {
  if (timer) return
  // Initial pass at startup catches deals that went stuck while the server was
  // down. Then every 5 min — the shared house cadence for QB-reading pollers.
  sweep().catch(e => console.error('[battery-stuck] initial pass failed:', e instanceof Error ? e.message : e))
  timer = setInterval(() => {
    sweep().catch(e => console.error('[battery-stuck] sweep failed:', e instanceof Error ? e.message : e))
  }, 5 * 60_000)
  const ch = slackConfigured() ? 'bell + Slack' : 'bell only (ARI_SLACK_BOT_TOKEN / INTAKE_SLACK_CHANNEL_ID unset)'
  console.log(`[battery-stuck] notifier started — sweeping every 5 min (${ch})`)
}

export function stopBatteryStuckNotifier(): void {
  if (timer) { clearInterval(timer); timer = null }
}
