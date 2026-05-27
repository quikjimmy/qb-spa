import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { UPLOADS_DIR } from './lib/upload'
import { authRouter } from './routes/auth'
import { qbRouter } from './routes/qb'
import { adminRouter } from './routes/admin'
import { qbSyncRouter } from './routes/qb-sync'
import { feedRouter } from './routes/feed'
import { feedIngestRouter } from './routes/feed-ingest'
import { notificationsRouter } from './routes/notifications'
import { projectsRouter } from './routes/projects'
import { ticketsRouter } from './routes/tickets'
import { addersRouter } from './routes/adders'
import { attachmentsRouter } from './routes/attachments'
import { notesRouter } from './routes/notes'
import { intakeRouter } from './routes/intake'
import { retentionRouter } from './routes/retention'
import { ptoAnalyticsRouter } from './routes/pto-analytics'
import { ptoCacheRouter } from './routes/pto-cache'
import { inspxAnalyticsRouter } from './routes/inspx-analytics'
import { designAnalyticsRouter } from './routes/design-analytics'
import { permitAnalyticsRouter } from './routes/permit-analytics'
import { agentsRouter } from './routes/agents'
import { pcDashboardRouter } from './routes/pc-dashboard'
import { feedbackRouter } from './routes/feedback'
import { improvementProposalsRouter } from './routes/improvement-proposals'
import { userAgentsRouter } from './routes/user-agents'
import { userSettingsRouter } from './routes/user-settings'
import { chatRouter } from './routes/chat'
import { agentOrgRouter } from './routes/agent-org'
import { agentLabRouter } from './routes/agent-lab'
import { agentApprovalsRouter } from './routes/agent-approvals'
import { dialpadRouter } from './routes/dialpad'
import { dialpadWebhookRouter } from './routes/dialpad-webhooks'
import { arrivyWebhookRouter, arrivyWebhookAdminRouter } from './routes/arrivy-webhooks'
import { fieldRouter } from './routes/field'
import { authenticate, requireRole, requireViewPermission } from './middleware/auth'
import { startAgentScheduler } from './agents/scheduler'
import { startMessageReminders } from './lib/messageReminders'
import { startUnreadSmsNotifier } from './lib/unreadSmsNotifier'
import { startDialpadEventMirror } from './lib/dialpadEventMirror'
import { startProjectCacheScheduler } from './routes/projects'
import { startTicketCacheScheduler } from './routes/tickets'
import { startArrivyUsersScheduler } from './lib/arrivyUsersSync'
import { startFeedbackTriageScheduler } from './lib/feedbackTriageSchedule'
import { reportsRouter } from './routes/reports'
import { fundingRouter } from './routes/funding'
import { qbWebhookRouter } from './routes/qb-webhooks'
import { githubWebhookRouter } from './routes/github-webhooks'
import { dailyGoalsRouter } from './routes/daily-goals'

const app = express()
const PORT = Number(process.env['PORT']) || 3001
const isProd = process.env['NODE_ENV'] === 'production'

// Trust Railway's edge proxy so req.protocol honors X-Forwarded-Proto: https.
// Without this, req.protocol is always "http" internally and Dialpad rejects
// the webhook URL we build for subscriptions.
app.set('trust proxy', 1)

if (!isProd) {
  app.use(cors({ origin: 'http://localhost:5173', credentials: true }))
}
// Stash the raw buffer on req so webhook handlers that need HMAC
// verification (e.g. GitHub) can compute the signature against the
// untransformed bytes. Cheap (~no overhead) and unused by other routes.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf },
}))

// Serve uploaded media files
app.use('/uploads', express.static(UPLOADS_DIR))

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

// Public routes
app.use('/api/auth', authRouter)
// Dialpad webhook ingest — PUBLIC (signed with per-org HMAC). Mounted before
// the authenticate middleware so Dialpad can POST without a portal JWT.
app.use('/api/webhooks/dialpad', dialpadWebhookRouter)
// Arrivy ingest (POST /api/webhooks/arrivy) — public, optional shared
// secret via ARRIVY_WEBHOOK_SECRET env var. Admin GET /api/field/webhooks/recent
// (auth-protected) lists recent ingests for forensics.
app.use('/api/webhooks', arrivyWebhookRouter)
app.use('/api/field/webhooks', authenticate, arrivyWebhookAdminRouter)
// QB Pipeline webhooks — PUBLIC, gated by shared secret in
// X-QB-Webhook-Secret header. Used to invalidate intake caches when
// a new project lands so dashboards see it on the next 30s poll.
app.use('/api/webhooks/qb', qbWebhookRouter)
// GitHub webhooks — PUBLIC, HMAC-verified per request via GITHUB_WEBHOOK_SECRET.
// Listens for pull_request events to flip approved proposals to shipped.
app.use('/api/webhooks', githubWebhookRouter)

// Protected routes — require JWT
app.use('/api/qb', authenticate, qbRouter)
app.use('/api/feed', authenticate, feedRouter)
app.use('/api/notifications', authenticate, notificationsRouter)
app.use('/api/projects', authenticate, projectsRouter)
app.use('/api/tickets', authenticate, ticketsRouter)
app.use('/api/adders', authenticate, addersRouter)
app.use('/api/attachments', authenticate, attachmentsRouter)
app.use('/api/notes', authenticate, notesRouter)
app.use('/api/intake', authenticate, intakeRouter)
app.use('/api/retention', authenticate, retentionRouter)
app.use('/api/analytics/pto', authenticate, ptoAnalyticsRouter)
app.use('/api/pto', authenticate, ptoCacheRouter)
app.use('/api/analytics/inspx', authenticate, inspxAnalyticsRouter)
app.use('/api/analytics/design', authenticate, designAnalyticsRouter)
app.use('/api/analytics/permit', authenticate, permitAnalyticsRouter)
app.use('/api/daily-goals', authenticate, dailyGoalsRouter)
app.use('/api/agents', authenticate, requireRole('admin'), agentsRouter)
app.use('/api/pc-dashboard', authenticate, pcDashboardRouter)
app.use('/api/feedback', authenticate, feedbackRouter)
app.use('/api/improvement-proposals', authenticate, improvementProposalsRouter)
app.use('/api/user-agents', authenticate, userAgentsRouter)
app.use('/api/user-settings', authenticate, userSettingsRouter)
app.use('/api/chat', authenticate, chatRouter)
app.use('/api/agent-org', authenticate, agentOrgRouter)
app.use('/api/agent-org/approvals', authenticate, agentApprovalsRouter)
app.use('/api/agent-lab', authenticate, agentLabRouter)
app.use('/api/agent-approvals', authenticate, agentApprovalsRouter)
app.use('/api/dialpad', authenticate, dialpadRouter)
app.use('/api/field', authenticate, fieldRouter)

// Admin routes — require JWT + admin role
app.use('/api/admin', authenticate, requireRole('admin'), adminRouter)
app.use('/api/admin/qb-sync', authenticate, requireRole('admin'), qbSyncRouter)
app.use('/api/admin/feed', authenticate, requireRole('admin'), feedIngestRouter)
// Booked & Boarded executive report. Sensitive financials → admin only.
app.use('/api/reports', authenticate, requireRole('admin'), reportsRouter)
app.use('/api/funding', authenticate, requireViewPermission('funding'), fundingRouter)

if (isProd) {
  const clientDist = process.env['CLIENT_DIST']
    ? path.resolve(process.env['CLIENT_DIST'])
    : path.resolve(process.cwd(), '../client/dist')
  if (fs.existsSync(clientDist)) {
    // Serve hashed assets with long-lived cache (file names change
    // on every Vite build so this is safe), but serve index.html
    // with no-store so always-on kiosks like OptiSign / Chromecast
    // pick up new builds the moment Railway redeploys instead of
    // holding onto a stale HTML that references vanished asset
    // filenames.
    app.use(express.static(clientDist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-store, must-revalidate')
        }
      },
    }))
    app.get(/^(?!\/api\/|\/uploads\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, must-revalidate')
      res.sendFile(path.join(clientDist, 'index.html'))
    })
  } else {
    console.warn(`client/dist not found at ${clientDist} — static serving disabled`)
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} (${isProd ? 'production' : 'development'})`)
  // Each scheduler is wrapped so a single one's failure can't cascade
  // into the others or take down the listen. Errors get logged but
  // the server keeps responding to /api/health for Railway.
  try { startAgentScheduler() } catch (e) { console.error('[startup] agent scheduler failed:', e) }
  try { startDialpadEventMirror() } catch (e) { console.error('[startup] dialpad mirror failed:', e) }
  try { startProjectCacheScheduler() } catch (e) { console.error('[startup] project cache scheduler failed:', e) }
  try { startTicketCacheScheduler() } catch (e) { console.error('[startup] ticket cache scheduler failed:', e) }
  try { startMessageReminders() } catch (e) { console.error('[startup] message reminders failed:', e) }
  try { startUnreadSmsNotifier() } catch (e) { console.error('[startup] unread sms notifier failed:', e) }
  try { startArrivyUsersScheduler() } catch (e) { console.error('[startup] arrivy users scheduler failed:', e) }
  try { startFeedbackTriageScheduler() } catch (e) { console.error('[startup] feedback triage scheduler failed:', e) }
})
