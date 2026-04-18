import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authRouter } from './routes/auth'
import { qbRouter } from './routes/qb'
import { adminRouter } from './routes/admin'
import { qbSyncRouter } from './routes/qb-sync'
import { feedRouter } from './routes/feed'
import { feedIngestRouter } from './routes/feed-ingest'
import { notificationsRouter } from './routes/notifications'
import { projectsRouter } from './routes/projects'
import { authenticate, requireRole } from './middleware/auth'

const app = express()
const PORT = process.env['PORT'] || 3001

app.use(cors({ origin: 'http://localhost:5173', credentials: true }))
app.use(express.json())

// Public routes
app.use('/api/auth', authRouter)

// Protected routes — require JWT
app.use('/api/qb', authenticate, qbRouter)
app.use('/api/feed', authenticate, feedRouter)
app.use('/api/notifications', authenticate, notificationsRouter)
app.use('/api/projects', authenticate, projectsRouter)

// Admin routes — require JWT + admin role
app.use('/api/admin', authenticate, requireRole('admin'), adminRouter)
app.use('/api/admin/qb-sync', authenticate, requireRole('admin'), qbSyncRouter)
app.use('/api/admin/feed', authenticate, requireRole('admin'), feedIngestRouter)

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
