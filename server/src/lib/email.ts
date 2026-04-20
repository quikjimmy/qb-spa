// Pluggable email sender.
//
// - If RESEND_API_KEY is set, uses Resend's HTTP API (no SDK dep).
// - Otherwise, logs the email to stdout so dev + "not configured yet" paths
//   don't break — useful for pulling the reset link by hand until real email
//   is wired up.
//
// EMAIL_FROM sets the sender address (must be a domain verified with Resend
// in production). Defaults to 'no-reply@kinhome.local' so the provider will
// reject it loudly if misconfigured — better than a silent wrong-from.

export interface OutgoingEmail {
  to: string
  subject: string
  html: string
  text: string
}

export interface SendResult {
  ok: boolean
  provider: 'resend' | 'console'
  id?: string
  error?: string
}

function getFrom(): string {
  return process.env['EMAIL_FROM'] || 'Kin Home Portal <no-reply@kinhome.local>'
}

async function sendViaResend(e: OutgoingEmail, apiKey: string): Promise<SendResult> {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: getFrom(),
        to: [e.to],
        subject: e.subject,
        html: e.html,
        text: e.text,
      }),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { ok: false, provider: 'resend', error: `HTTP ${r.status}: ${text.slice(0, 500)}` }
    }
    const data = await r.json().catch(() => ({})) as { id?: string }
    return { ok: true, provider: 'resend', id: data.id }
  } catch (err) {
    return { ok: false, provider: 'resend', error: err instanceof Error ? err.message : String(err) }
  }
}

function sendViaConsole(e: OutgoingEmail): SendResult {
  // Safe to log — this is the dev fallback. Once RESEND_API_KEY is set,
  // this branch is never taken so nothing lands in Railway logs.
  console.log('── EMAIL (console fallback, no RESEND_API_KEY) ──')
  console.log(`From:    ${getFrom()}`)
  console.log(`To:      ${e.to}`)
  console.log(`Subject: ${e.subject}`)
  console.log('---')
  console.log(e.text)
  console.log('─────────────────────────────────────────────────')
  return { ok: true, provider: 'console' }
}

export async function sendEmail(e: OutgoingEmail): Promise<SendResult> {
  const resendKey = process.env['RESEND_API_KEY']
  if (resendKey) return sendViaResend(e, resendKey)
  return sendViaConsole(e)
}
