import { Router, type Request, type Response } from 'express'

const router = Router()

function canAccessLab(req: Request): boolean {
  if (req.user?.roles.includes('admin')) return true
  return process.env['AGENT_LAB_ENABLED_FOR_ALL'] === '1'
}

router.get('/status', (req: Request, res: Response): void => {
  res.json({
    enabled: true,
    can_access: canAccessLab(req),
    requires_admin: process.env['AGENT_LAB_ENABLED_FOR_ALL'] !== '1',
  })
})

export { router as agentLabRouter }

