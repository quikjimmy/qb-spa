import { Router, type Request, type Response } from 'express'
import db from '../db'
import { parseClosingRefs, verifyGithubSignature } from '../lib/githubIssues'

const router = Router()

interface PullRequestEvent {
  action: string
  pull_request: {
    number: number
    html_url: string
    body: string | null
    merged: boolean
    base: { ref: string }
  }
}

// POST /api/webhooks/github
//
// Listens for pull_request events. When a PR is closed-and-merged, we parse
// "Closes #N" refs out of the PR body and flip every matching proposal to
// 'shipped' (cascading to its member feedback rows via the existing logic
// in improvement-proposals.ts).
//
// Unknown event types, unmerged closes, and PRs with no matching proposals
// all return 200 + a noop summary so GitHub doesn't retry them.
router.post('/github', (req: Request, res: Response): void => {
  const sigHeader = req.header('x-hub-signature-256')
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
  if (!rawBody || !verifyGithubSignature(rawBody.toString('utf8'), sigHeader)) {
    res.status(401).json({ error: 'invalid signature' })
    return
  }

  const event = req.header('x-github-event')
  if (event === 'ping') {
    res.json({ ok: true, pong: true })
    return
  }
  if (event !== 'pull_request') {
    res.json({ ok: true, skipped: `event=${event}` })
    return
  }

  const body = req.body as PullRequestEvent
  if (body.action !== 'closed' || !body.pull_request?.merged) {
    res.json({ ok: true, skipped: `action=${body.action} merged=${body.pull_request?.merged}` })
    return
  }

  const pr = body.pull_request
  const refs = parseClosingRefs(pr.body)
  if (refs.length === 0) {
    res.json({ ok: true, skipped: 'no closing refs in PR body' })
    return
  }

  // Find proposals whose issue numbers match the closing refs. Skip ones
  // already shipped — we don't re-flip or reopen on PR reverts (admin can
  // manually re-open if needed).
  const placeholders = refs.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id FROM improvement_proposals
      WHERE github_issue_number IN (${placeholders})
        AND status NOT IN ('shipped')`
  ).all(...refs) as Array<{ id: number }>

  if (rows.length === 0) {
    res.json({ ok: true, skipped: 'no matching unshipped proposals', refs })
    return
  }

  const update = db.prepare(
    `UPDATE improvement_proposals
        SET status = 'shipped',
            github_pr_number = ?,
            github_pr_url = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  )
  const cascadeFeedback = db.prepare(
    `UPDATE app_feedback
        SET status = 'shipped'
      WHERE cluster_id = (SELECT cluster_id FROM improvement_proposals WHERE id = ?)
        AND status NOT IN ('shipped', 'dismissed')`
  )
  const cascadeCluster = db.prepare(
    `UPDATE feedback_clusters
        SET status = 'shipped', updated_at = datetime('now')
      WHERE id = (SELECT cluster_id FROM improvement_proposals WHERE id = ?)
        AND status NOT IN ('shipped')`
  )

  const flipped: number[] = []
  const tx = db.transaction(() => {
    for (const r of rows) {
      update.run(pr.number, pr.html_url, r.id)
      cascadeFeedback.run(r.id)
      cascadeCluster.run(r.id)
      flipped.push(r.id)
    }
  })
  tx()

  console.log(`[github-webhook] PR #${pr.number} merged → shipped proposals: ${flipped.join(', ')}`)
  res.json({ ok: true, shipped: flipped, pr: pr.number })
})

export { router as githubWebhookRouter }
