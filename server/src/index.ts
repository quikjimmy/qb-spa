import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
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
import { authenticate, requireRole } from './middleware/auth'
import { startAgentScheduler } from './agents/scheduler'

const app = express()
const PORT = process.env['PORT'] || 3001

app.use(cors({ origin: 'http://localhost:5173', credentials: true }))
app.use(express.json({ limit: '1mb' }))

// Serve uploaded media files
app.use('/uploads', express.static(UPLOADS_DIR))

// Public routes
app.use('/api/auth', authRouter)

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

// Admin routes — require JWT + admin role
app.use('/api/admin', authenticate, requireRole('admin'), adminRouter)
app.use('/api/admin/qb-sync', authenticate, requireRole('admin'), qbSyncRouter)
app.use('/api/admin/feed', authenticate, requireRole('admin'), feedIngestRouter)

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  startAgentScheduler()
})
