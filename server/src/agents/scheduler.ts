import cron from 'node-cron'
import { runHoldClassifier } from './runner'

let started = false

export function startAgentScheduler(): void {
  if (started) return
  started = true

  // 02:00 America/Los_Angeles daily
  cron.schedule('0 2 * * *', async () => {
    console.log('[agent-scheduler] firing hold-classifier')
    try {
      const result = await runHoldClassifier('cron')
      console.log(`[agent-scheduler] hold-classifier ${result.status}:`, result)
    } catch (err) {
      console.error('[agent-scheduler] hold-classifier error:', err)
    }
  }, { timezone: 'America/Los_Angeles' })

  console.log('[agent-scheduler] registered hold-classifier @ 02:00 PT daily')
}
