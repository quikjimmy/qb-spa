import { createRouter, createWebHistory } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // Auth pages — no sidebar
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
    },
    // TV scoreboard — full-screen, no sidebar. Auth still required so
    // the device signs in once and stays parked here.
    {
      path: '/scoreboard',
      name: 'scoreboard',
      component: () => import('../views/ScoreboardView.vue'),
      meta: { requiresAuth: true },
    },
    // TV-locked variant. Same component as /scoreboard but renders
    // at a fixed 1080×1920 portrait layout — no mobile breakpoint,
    // no orientation-driven letterbox. This is the URL we hand to
    // OptiSign / wall-mounted signage so the TV layout is decoupled
    // from desktop + mobile responsive tweaks.
    {
      path: '/scoreboard/tv',
      name: 'scoreboard-tv',
      component: () => import('../views/ScoreboardView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('../views/RegisterView.vue'),
    },
    {
      path: '/invite/:token',
      name: 'invite',
      component: () => import('../views/InviteView.vue'),
    },
    {
      path: '/reset/:token',
      name: 'reset',
      component: () => import('../views/ResetView.vue'),
    },
    {
      path: '/forgot',
      name: 'forgot',
      component: () => import('../views/ForgotView.vue'),
    },

    // App shell — sidebar layout
    {
      path: '/',
      component: AppLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'home',
          component: () => import('../views/HomeView.vue'),
        },
        {
          path: 'feed',
          name: 'feed',
          component: () => import('../views/FeedView.vue'),
        },
        {
          path: 'projects',
          name: 'projects',
          component: () => import('../views/ProjectsView.vue'),
        },
        // Field is a cross-cutting crew-ops surface, not a single
        // milestone — promoted out of Projects to a top-level route.
        // The legacy /projects/field path stays as a redirect so old
        // bookmarks land somewhere sensible.
        {
          path: 'field',
          name: 'field-dashboard',
          component: () => import('../views/FieldDashboardView.vue'),
        },
        { path: 'projects/field', redirect: '/field' },
        // Milestone-organized sub-pages within Projects. Order matches
        // the project lifecycle and the AppSidebar nav. Stubs use the
        // shared MilestonePlaceholder; built views (PC, Inspections,
        // PTO, All Projects) keep their existing components.
        {
          path: 'projects/sales',
          name: 'milestone-sales',
          component: () => import('../views/MilestonePlaceholder.vue'),
          meta: { order: 2, title: 'Sales', description: 'Sale agreement signed → handoff to Intake. Pipeline view, sale-date filters, closer / setter performance.' },
        },
        {
          path: 'projects/intake',
          name: 'milestone-intake',
          component: () => import('../views/IntakeDashboardView.vue'),
          meta: { order: 3, title: 'Intake', description: 'KCA + welcome call, intake failed-run recovery, and retry queue.' },
        },
        {
          path: 'projects/pc',
          name: 'pc-dashboard',
          component: () => import('../views/PcDashboardView.vue'),
          meta: { order: 4, title: 'Project Coordination' },
        },
        {
          path: 'projects/site-survey',
          name: 'milestone-site-survey',
          component: () => import('../views/MilestonePlaceholder.vue'),
          meta: { order: 5, title: 'Site Survey', description: 'Surveys scheduled / in-flight / submitted / cancelled. Field crew + customer reschedule loops live here.' },
        },
        {
          path: 'projects/design',
          name: 'milestone-design',
          component: () => import('../views/DesignDashboardView.vue'),
          meta: { order: 6, title: 'Design & Engineering', description: 'Site Survey Review queue (HITL) + design-team workflow. CAD submission, design completion, rejected-survey rework.' },
        },
        {
          path: 'projects/permit',
          name: 'milestone-permit',
          component: () => import('../views/PermitDashboardView.vue'),
          meta: { order: 7, title: 'Permit', description: 'AHJ submissions, approvals, rejections + missing-items checklists.' },
        },
        {
          path: 'projects/nem',
          name: 'milestone-nem',
          component: () => import('../views/MilestonePlaceholder.vue'),
          meta: { order: 8, title: 'NEM', description: 'Utility interconnect — submissions, approvals, rejections, follow-ups by utility company.' },
        },
        {
          path: 'projects/install',
          name: 'milestone-install',
          component: () => import('../views/MilestonePlaceholder.vue'),
          meta: { order: 9, title: 'Install', description: 'Scheduled / in-flight / completed installs. Crew assignment, day-of monitoring, post-install QC.' },
        },
        {
          path: 'projects/inspections',
          name: 'inspx-dashboard',
          component: () => import('../views/InspxDashboardView.vue'),
          meta: { order: 10, title: 'Inspection' },
        },
        {
          path: 'projects/pto',
          name: 'pto-dashboard',
          component: () => import('../views/PtoDashboardView.vue'),
          meta: { order: 11, title: 'PTO' },
        },
        {
          path: 'projects/retention',
          name: 'milestone-retention',
          component: () => import('../views/MilestonePlaceholder.vue'),
          meta: { order: 12, title: 'Retention', description: 'At-risk / pending-cancel projects, save plays, customer outreach.' },
        },
        {
          path: 'projects/post-pto',
          name: 'milestone-post-pto',
          component: () => import('../views/MilestonePlaceholder.vue'),
          meta: { order: 13, title: 'Post PTO', description: 'After permission to operate — warranty, monitoring exceptions, referrals, NPS.' },
        },
        {
          path: 'projects/:id(\\d+)',
          name: 'project-detail',
          component: () => import('../views/ProjectDetailView.vue'),
        },
        {
          path: 'comms',
          name: 'comms-hub',
          component: () => import('../views/CommsHubView.vue'),
        },
        {
          path: 'agents/coming-soon',
          name: 'agents-coming-soon',
          component: () => import('../views/AgentsComingSoon.vue'),
        },
        {
          path: 'agents',
          name: 'agents',
          component: () => import('../views/AgentsView.vue'),
        },
        {
          path: 'agents/new',
          name: 'agent-create',
          component: () => import('../views/AgentCreateView.vue'),
        },
        {
          path: 'agents/tasks/:id',
          name: 'agent-task-editor',
          component: () => import('../views/AgentTaskEditorView.vue'),
          meta: { requiresAdmin: true },
        },
        {
          path: 'agents/:id',
          name: 'agent-dashboard',
          component: () => import('../views/AgentDashboardView.vue'),
        },
        {
          path: 'tickets',
          name: 'tickets',
          component: () => import('../views/TicketsView.vue'),
        },
        {
          // Admin-only executive flash report. Sensitive financials → gate
          // at the route, the API, and the sidebar nav.
          path: 'reports/booked-and-boarded',
          name: 'booked-and-boarded',
          component: () => import('../views/BookedBoardedView.vue'),
          meta: { requiresAdmin: true },
        },
        {
          path: 'funding',
          name: 'funding',
          component: () => import('../views/FundingDashboardView.vue'),
          meta: { requiresView: 'funding' },
        },
        {
          path: 'funding/m1-not-m2',
          name: 'funding-m1-not-m2',
          component: () => import('../views/M1NotM2View.vue'),
          meta: { requiresView: 'funding' },
        },
        {
          path: 'chat',
          name: 'chat',
          component: () => import('../views/ChatView.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../views/SettingsView.vue'),
        },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('../views/AdminView.vue'),
          meta: { requiresAdmin: true },
        },
        {
          path: 'admin/daily-goals',
          name: 'admin-daily-goals',
          component: () => import('../views/DailyGoalsAdminView.vue'),
          meta: { requiresAdmin: true },
        },
      ],
    },
  ],
})

// Agents section is under construction. Default everyone to the
// teaser at /agents/coming-soon. Admins can opt in to the WIP via:
//   1. URL: append ?preview=1 to /agents (or any sub-route)
//   2. Persisted: localStorage 'agents.preview' = '1' (set by the
//      teaser's "Preview WIP" button so subsequent navigations stay
//      in WIP without re-passing the query).
function shouldShowAgentsTeaser(
  toPath: string,
  toQuery: Record<string, unknown>,
  isAdmin: boolean,
): boolean {
  if (!toPath.startsWith('/agents')) return false
  if (toPath === '/agents/coming-soon') return false
  if (!isAdmin) return true
  const previewQuery = toQuery['preview'] === '1'
  let previewStored = false
  try { previewStored = localStorage.getItem('agents.preview') === '1' } catch { /* ignore */ }
  return !(previewQuery || previewStored)
}

router.beforeEach(async (to) => {
  const token = localStorage.getItem('token')
  // Pages embedded in OptiSign / Chromecast / an iframe pass their
  // JWT via ?token=... since they have no localStorage session.
  // ScoreboardView reads the query param on mount and uses it as the
  // bearer JWT for API calls — here we just let the navigation
  // through without redirecting to /login.
  const hasUrlToken = typeof to.query['token'] === 'string' && (to.query['token'] as string).length > 0
  if (to.meta.requiresAuth && !token && !hasUrlToken) {
    return { name: 'login' }
  }
  if ((to.name === 'login' || to.name === 'register') && token) {
    return { name: 'home' }
  }
  if (!token) return
  // Lazy-resolve the auth store (Pinia is mounted before the first
  // navigation completes, but this keeps the import out of the
  // module's static graph).
  const { useAuthStore } = await import('@/stores/auth')
  const auth = useAuthStore()
  // The store may not have hydrated user data yet on a hard reload —
  // pull it once if missing so the gate reads accurate role info.
  if (!auth.user && auth.token) {
    try { await auth.fetchUser() } catch { /* ignore — fall through as non-admin */ }
  }
  if (shouldShowAgentsTeaser(to.path, to.query as Record<string, unknown>, auth.isAdmin)) {
    return { path: '/agents/coming-soon' }
  }
  // Routes with meta.requiresAdmin (admin diagnostics, agent task editor,
  // booked-and-boarded report) bounce non-admins to home. The server-side
  // route is also requireRole('admin') — this guard just keeps the URL
  // out of the bundle path for non-admins so they don't see "report
  // failed to load" flashes.
  if (to.meta['requiresAdmin'] && !auth.isAdmin) {
    return { name: 'home' }
  }
  // requiresView: '<viewId>' — admins always pass; otherwise the user
  // needs read access for that view (matches server's requireViewPermission).
  const requiresView = to.meta['requiresView']
  if (typeof requiresView === 'string' && !auth.hasViewPermission(requiresView)) {
    return { name: 'home' }
  }
})

export default router
