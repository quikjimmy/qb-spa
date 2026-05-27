import cron from 'node-cron'
import { runFeedbackTriage } from '../agents/feedbackTriage'
import { isSupportedProvider, type ProviderId } from './userProviderKeys'

let started = false

function readTriageConfig(): { userId: number; provider?: ProviderId } | null {
  const rawUserId = process.env['TRIAGE_USER_ID']
  if (!rawUserId) return null
  const userId = Number(rawUserId)
  if (!Number.isInteger(userId) || userId <= 0) return null

  const rawProvider = process.env['TRIAGE_PROVIDER']
  if (rawProvider && isSupportedProvider(rawProvider)) {
    return { userId, provider: rawProvider }
  }
  return { userId }
}

async function runNightlyTriage(): Promise<void> {
  const cfg = readTriageConfig()
  if (!cfg) {
    console.warn('[feedback-triage] skipped — TRIAGE_USER_ID not set')
    return
  }
  try {
    const summary = await runFeedbackTriage({ userId: cfg.userId, provider: cfg.provider })
    console.log(
      `[feedback-triage] nightly: considered=${summary.feedback_considered} clusters=${summary.clusters_created} proposals=${summary.proposals_drafted} model=${summary.model}`
    )
  } catch (err) {
    console.error('[feedback-triage] nightly failed:', err instanceof Error ? err.message : err)
  }
}

export function startFeedbackTriageScheduler(): void {
  if (started) return
  started = true
  const cfg = readTriageConfig()
  if (!cfg) {
    console.log('[feedback-triage] scheduler not started — TRIAGE_USER_ID missing')
    return
  }
  // 03:13 server-local time daily — off-peak, slightly off the hour so it
  // doesn't pile up against other nightly jobs.
  cron.schedule('13 3 * * *', () => {
    void runNightlyTriage()
  })
  console.log(`[feedback-triage] scheduler started: 03:13 daily (user=${cfg.userId}${cfg.provider ? `, provider=${cfg.provider}` : ''})`)
}
