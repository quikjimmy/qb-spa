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
import { ptoAnalyticsRouter } from './routes/pto-analytics'
import { ptoCacheRouter } from './routes/pto-cache'
import { inspxAnalyticsRouter } from './routes/inspx-analytics'
import { agentsRouter } from './routes/agents'
import { pcDashboardRouter } from './routes/pc-dashboard'
import { feedbackRouter } from './routes/feedback'
import { userAgentsRouter } from './routes/user-agents'
import { userSettingsRouter } from './routes/user-settings'
import { agentOrgRouter } from './routes/agent-org'
import { agentLabRouter } from './routes/agent-lab'
import { agentApprovalsRouter } from './routes/agent-approvals'
import { dialpadRouter } from './routes/dialpad'
import { dialpadWebhookRouter } from './routes/dialpad-webhooks'
import { fieldRouter } from './routes/field'
import { authenticate, requireRole } from './middleware/auth'
import { startAgentScheduler } from './agents/scheduler'
import { startDialpadEventMirror } from './lib/dialpadEventMirror'
import { startProjectCacheScheduler } from './routes/projects'

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
app.use(express.json({ limit: '1mb' }))

// Serve uploaded media files
app.use('/uploads', express.static(UPLOADS_DIR))

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

// Public routes
app.use('/api/auth', authRouter)
// Dialpad webhook ingest — PUBLIC (signed with per-org HMAC). Mounted before
// the authenticate middleware so Dialpad can POST without a portal JWT.
app.use('/api/webhooks/dialpad', dialpadWebhookRouter)

// Protected routes — require JWT
app.use('/api/qb', authenticate, qbRouter)
app.use('/api/feed', authenticate, feedRouter)
app.use('/api/notifications', authenticate, notificationsRouter)
app.use('/api/projects', authenticate, projectsRouter)
app.use('/api/tickets', authenticate, ticketsRouter)
app.use('/api/analytics/pto', authenticate, ptoAnalyticsRouter)
app.use('/api/pto', authenticate, ptoCacheRouter)
app.use('/api/analytics/inspx', authenticate, inspxAnalyticsRouter)
app.use('/api/agents', authenticate, requireRole('admin'), agentsRouter)
app.use('/api/pc-dashboard', authenticate, pcDashboardRouter)
app.use('/api/feedback', authenticate, feedbackRouter)
app.use('/api/user-agents', authenticate, userAgentsRouter)
app.use('/api/user-settings', authenticate, userSettingsRouter)
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

if (isProd) {
  const clientDist = process.env['CLIENT_DIST']
    ? path.resolve(process.env['CLIENT_DIST'])
    : path.resolve(process.cwd(), '../client/dist')
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist))
    app.get(/^(?!\/api\/|\/uploads\/).*/, (_req, res) => {
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
})
