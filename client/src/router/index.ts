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
        {
          path: 'projects/inspections',
          name: 'inspx-dashboard',
          component: () => import('../views/InspxDashboardView.vue'),
        },
        {
          path: 'projects/pto',
          name: 'pto-dashboard',
          component: () => import('../views/PtoDashboardView.vue'),
        },
        {
          path: 'projects/pc',
          name: 'pc-dashboard',
          component: () => import('../views/PcDashboardView.vue'),
        },
        {
          path: 'projects/field',
          name: 'field-dashboard',
          component: () => import('../views/FieldDashboardView.vue'),
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
  if (to.meta.requiresAuth && !token) {
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
})

export default router
