// Enerflo v2 GraphQL client — deal progress for the Site Survey bump-out.
//
// Endpoint + auth per docs.enerflo.io: POST https://api.enerflo.io/graphql
// with `Authorization: Bearer <api key>` and `x-org: <subdomain>`.
// Keys are minted in Enerflo (tied to a user account) — set:
//   ENERFLO_API_KEY=...
//   ENERFLO_ORG=kinhome        (default; matches kinhome.enerflo.io)
//
// Schema verified against the live API 2026-07-15:
//   fetchDeal(id: String!) → Deal { status: DealStatus, progress: Float,
//     currentStage, cachedStages: [Stage | StageGroup] }
//   Stage/StageGroup { id, title, order, status: ACTIVE | HIDDEN |
//     DISABLED | COMPLETE | INVALID }

const ENERFLO_GQL = process.env['ENERFLO_API_BASE'] || 'https://api.enerflo.io/graphql'

export function enerfloConfigured(): boolean {
  return !!process.env['ENERFLO_API_KEY']
}

export interface EnerfloDealStep {
  id: string
  name: string
  status: 'complete' | 'active' | 'invalid' | 'pending'
}

export interface EnerfloDealProgress {
  configured: boolean
  ok: boolean
  error?: string
  dealStatus?: string
  progress?: number
  currentStage?: string
  steps: EnerfloDealStep[]
  /** Project-submission attempt — true when Enerflo says the deal WAS
   *  submitted (if it's still not in QB, the intake side failed). */
  submission?: { attempted: boolean; at?: string }
}

const DEAL_QUERY = `
  query dealProgress($id: String!) {
    fetchDeal(id: $id) {
      id
      status
      progress
      currentStage
      state
      history { createdAt diff }
      cachedStages {
        ... on Stage { id title order status }
        ... on StageGroup { id title order status }
      }
    }
  }
`

interface RawStage { id?: string; title?: string; order?: number; status?: string }

// The stages ops actually cares about (James 2026-07-15): Financing
// (absorbing Participate|Propel), Designs, Proposal, Contracting,
// Welcome Call, Pre-Intake Checklist, Project Submission. Everything
// else (Title Check, SmartPoll, Deal Details, Consumption, Battery
// Only, changeorders…) is noise here.
const KEEP_TITLES = [/financing/i, /design/i, /proposal/i, /contracting/i, /welcome\s*call/i, /pre.?intake/i, /project\s*submission/i]
const FOLD_INTO_FINANCING = /participate|propel/i
// Worse-status-wins when folding Participate|Propel into Financing.
const SEVERITY: Record<string, number> = { COMPLETE: 0, ACTIVE: 2, INVALID: 3 }

// 5-minute per-deal cache — the drawer can be opened repeatedly while
// someone works a list.
const cache = new Map<string, { at: number; data: EnerfloDealProgress }>()
const TTL_MS = 5 * 60_000

export async function getDealProgress(dealId: string): Promise<EnerfloDealProgress> {
  if (!enerfloConfigured()) return { configured: false, ok: false, steps: [] }
  const hit = cache.get(dealId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data

  let data: EnerfloDealProgress
  try {
    const res = await fetch(ENERFLO_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env['ENERFLO_API_KEY']}`,
        'x-org': process.env['ENERFLO_ORG'] || 'kinhome',
      },
      body: JSON.stringify({ query: DEAL_QUERY, variables: { id: dealId } }),
    })
    const json = await res.json() as {
      data?: { fetchDeal?: {
        status?: string; progress?: number; currentStage?: string
        state?: Record<string, unknown>
        history?: Array<{ createdAt?: string; diff?: unknown }>
        cachedStages?: RawStage[]
      } }
      errors?: Array<{ message?: string }>
    }
    if (json.errors?.length) {
      const msg = json.errors.map(e => e.message).filter(Boolean).join('; ')
      console.warn(`[enerflo] deal ${dealId} query error:`, msg)
      data = { configured: true, ok: false, error: msg, steps: [] }
    } else if (!json.data?.fetchDeal) {
      data = { configured: true, ok: false, error: 'Deal not found in Enerflo v2', steps: [] }
    } else {
      const deal = json.data.fetchDeal
      const visible = (deal.cachedStages ?? [])
        .filter(s => s.title && s.status !== 'HIDDEN' && s.status !== 'DISABLED')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      // Participate|Propel folds into Financing — worse status wins.
      const foldStatus = visible.find(s => FOLD_INTO_FINANCING.test(String(s.title)))?.status
      const steps: EnerfloDealStep[] = visible
        .filter(s => KEEP_TITLES.some(re => re.test(String(s.title))) && !FOLD_INTO_FINANCING.test(String(s.title)))
        .map(s => {
          let raw = String(s.status || '')
          if (/financing/i.test(String(s.title)) && foldStatus
            && (SEVERITY[foldStatus] ?? 1) > (SEVERITY[raw] ?? 1)) raw = foldStatus
          return {
            id: String(s.id || ''),
            name: String(s.title),
            status: raw === 'COMPLETE' ? 'complete' as const
              : raw === 'ACTIVE' ? 'active' as const
                : raw === 'INVALID' ? 'invalid' as const
                  : 'pending' as const,
          }
        })
      // Submission attempt: Enerflo's own "The project has been
      // submitted." flag, plus the history event where it flipped.
      const attempted = deal.state?.['hasSubmittedProject'] === true
      let at: string | undefined
      if (attempted) {
        for (const e of deal.history ?? []) {
          if (/hasSubmittedProject[\\"']*:\s*true/.test(JSON.stringify(e.diff ?? ''))) {
            if (!at || String(e.createdAt) < at) at = String(e.createdAt)
          }
        }
      }
      data = {
        configured: true,
        ok: true,
        dealStatus: String(deal.status || '').replace(/_/g, ' '),
        progress: typeof deal.progress === 'number' ? Math.round(deal.progress) : undefined,
        currentStage: deal.currentStage || '',
        steps,
        submission: { attempted, ...(at ? { at } : {}) },
      }
    }
  } catch (e) {
    console.warn(`[enerflo] deal ${dealId} fetch failed:`, e)
    data = { configured: true, ok: false, error: e instanceof Error ? e.message : 'Enerflo request failed', steps: [] }
  }
  cache.set(dealId, { at: Date.now(), data })
  return data
}
