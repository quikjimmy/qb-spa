// Leaf-bucket metadata: label, Tailwind color class, and the dialtone icon
// component to render. Kept in one file so the activity feed, drill-down,
// and any future live-call widget stay visually consistent.
import type { Component } from 'vue'
import DtIconPhoneIncoming from '@dialpad/dialtone-icons/vue3/phone-incoming'
import DtIconPhoneOutgoing from '@dialpad/dialtone-icons/vue3/phone-outgoing'
import DtIconPhoneMissed from '@dialpad/dialtone-icons/vue3/phone-missed'
import DtIconPhoneHangUp from '@dialpad/dialtone-icons/vue3/phone-hang-up'
import DtIconPhoneForward from '@dialpad/dialtone-icons/vue3/phone-forward'
import DtIconPhoneOff from '@dialpad/dialtone-icons/vue3/phone-off'
import DtIconVoicemail from '@dialpad/dialtone-icons/vue3/voicemail'
import DtIconBellRing from '@dialpad/dialtone-icons/vue3/bell-ring'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'

export type CallBucket =
  | 'in_answered' | 'in_missed' | 'in_abandoned' | 'in_voicemail'
  | 'in_transfer_unanswered' | 'in_callback_requested'
  | 'out_connected' | 'out_cancelled' | 'out_callback_attempt'
  | 'other'

export interface BucketMeta {
  label: string
  short: string
  icon: Component
  // Tailwind classes — colorClass is for the icon itself, bgClass for its circle
  colorClass: string
  bgClass: string
}

export const BUCKET_META: Record<CallBucket, BucketMeta> = {
  in_answered:            { label: 'Inbound answered',   short: 'Answered',   icon: DtIconPhoneIncoming, colorClass: 'text-emerald-600', bgClass: 'bg-emerald-100' },
  in_missed:              { label: 'Missed',             short: 'Missed',     icon: DtIconPhoneMissed,   colorClass: 'text-amber-600',   bgClass: 'bg-amber-100' },
  in_abandoned:           { label: 'Abandoned',          short: 'Abandoned',  icon: DtIconPhoneHangUp,   colorClass: 'text-rose-600',    bgClass: 'bg-rose-100' },
  in_voicemail:           { label: 'Voicemail',          short: 'Voicemail',  icon: DtIconVoicemail,     colorClass: 'text-violet-600',  bgClass: 'bg-violet-100' },
  in_transfer_unanswered: { label: 'Transfer (unans.)',  short: 'Transfer',   icon: DtIconPhoneForward,  colorClass: 'text-orange-600',  bgClass: 'bg-orange-100' },
  in_callback_requested:  { label: 'Callback requested', short: 'Callback',   icon: DtIconBellRing,      colorClass: 'text-sky-600',     bgClass: 'bg-sky-100' },
  out_connected:          { label: 'Outbound connected', short: 'Connected',  icon: DtIconPhoneOutgoing, colorClass: 'text-emerald-600', bgClass: 'bg-emerald-100' },
  out_cancelled:          { label: 'Outbound cancelled', short: 'Cancelled',  icon: DtIconPhoneOff,      colorClass: 'text-slate-500',   bgClass: 'bg-slate-100' },
  out_callback_attempt:   { label: 'Callback attempt',   short: 'Callback',   icon: DtIconPhoneForward,  colorClass: 'text-sky-600',     bgClass: 'bg-sky-100' },
  other:                  { label: 'Other',              short: 'Other',      icon: DtIconPhone,         colorClass: 'text-slate-500',   bgClass: 'bg-slate-100' },
}

export function bucketMeta(bucket: string): BucketMeta {
  return BUCKET_META[bucket as CallBucket] || BUCKET_META.other
}

// Format a Dialpad-style phone number into a readable one.
// Handles "+14072216330" → "+1 (407) 221-6330" for NANP numbers,
// passes others through unchanged.
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return raw
}

export function fmtTalkSec(sec: number): string {
  if (!sec || sec < 1) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60); const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

// "2026-04-22 13:32:56.752781" → { date: "Apr 22", time: "1:32 PM" }
export function splitStartedAt(iso: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  // Dialpad returns "YYYY-MM-DD HH:MM:SS.ffffff" — replace space with T for Date parsing.
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'))
  if (isNaN(d.getTime())) return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
  const dateStr = d.toLocaleString(undefined, { month: 'short', day: 'numeric' })
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return { date: dateStr, time: timeStr }
}
