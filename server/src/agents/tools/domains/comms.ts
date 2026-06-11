// ─── Customer-support comms domain (Dialpad) ──────────────────────────
// Inbound/outbound call volume, answer/connect rates, and SMS counts over
// a rolling window (default 7 days; pass 30 for the monthly view). Reads
// the same dialpad_call_daily / dialpad_sms_daily caches the Comms Hub
// uses, and folds call buckets with the SAME foldTotals() exported from
// routes/dialpad.ts so bucket semantics never drift.

import db from '../../../db'
import { foldTotals, type CallTotals } from '../../../routes/dialpad'

function pct(numerator: number, denominator: number): number | null {
  if (!denominator) return null
  return Math.round((numerator / denominator) * 1000) / 10 // one decimal
}

export interface CommsStatsResult {
  window_days: number
  coordinator: string | null
  calls: CallTotals
  rates: {
    inbound_answer_rate_pct: number | null
    outbound_connect_rate_pct: number | null
  }
  sms: { total: number; incoming: number; outgoing: number }
}

export function getCommsStats(input: { window_days?: number; coordinator?: string }): CommsStatsResult {
  const windowDays = Math.max(1, Math.min(input.window_days ?? 7, 90))
  const coordinator = input.coordinator?.trim() || ''

  const callWhere = [`dcd.call_date >= date('now', ?)`]
  const callParams: unknown[] = [`-${windowDays} days`]
  if (coordinator) {
    callWhere.push(`COALESCE(u.name, dcd.user_name, dcd.user_email) = ?`)
    callParams.push(coordinator)
  }
  const leafRows = db.prepare(`
    SELECT dcd.bucket AS bucket,
           SUM(dcd.call_count) AS call_count,
           SUM(dcd.talk_time_sec) AS talk_time_sec
    FROM dialpad_call_daily dcd
    LEFT JOIN user_email_lookup uel
      ON uel.email = dcd.user_email AND uel.system IN ('', 'dialpad')
    LEFT JOIN users u ON u.id = uel.user_id
    WHERE ${callWhere.join(' AND ')}
    GROUP BY dcd.bucket
  `).all(...callParams) as Array<{ bucket: string; call_count: number; talk_time_sec: number }>

  const calls = foldTotals(
    leafRows.map(r => ({ bucket: r.bucket, call_count: Number(r.call_count) || 0, talk_time_sec: Number(r.talk_time_sec) || 0 })),
  )

  const smsWhere = [`dsd.sms_date >= date('now', ?)`]
  const smsParams: unknown[] = [`-${windowDays} days`]
  if (coordinator) {
    smsWhere.push(`COALESCE(u.name, dsd.user_name, dsd.user_email) = ?`)
    smsParams.push(coordinator)
  }
  const smsRows = db.prepare(`
    SELECT dsd.direction AS direction, SUM(dsd.message_count) AS message_count
    FROM dialpad_sms_daily dsd
    LEFT JOIN users u ON LOWER(TRIM(u.email)) = dsd.user_email
    WHERE ${smsWhere.join(' AND ')}
    GROUP BY dsd.direction
  `).all(...smsParams) as Array<{ direction: string; message_count: number }>

  const sms = { total: 0, incoming: 0, outgoing: 0 }
  for (const r of smsRows) {
    const n = Number(r.message_count) || 0
    sms.total += n
    if (r.direction === 'incoming') sms.incoming += n
    else if (r.direction === 'outgoing') sms.outgoing += n
  }

  return {
    window_days: windowDays,
    coordinator: coordinator || null,
    calls,
    rates: {
      inbound_answer_rate_pct: pct(calls.inbound_answered, calls.inbound_total),
      outbound_connect_rate_pct: pct(calls.out_connected, calls.outbound_total),
    },
    sms,
  }
}
