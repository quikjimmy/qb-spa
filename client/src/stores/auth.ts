import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useRouter } from 'vue-router'

interface User {
  id: number
  email: string
  name: string
  roles: string[]
}

interface Permission {
  resource_type: 'view' | 'table' | 'field'
  resource_id: string
  can_read: number
  can_write: number
}

interface Scope { departmentId: number; departmentName: string }

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'))
  const user = ref<User | null>(null)
  const permissions = ref<Permission[]>([])
  // View-as scope: when set, the bearer JWT is scoped to a department
  // and the admin role bypass is suppressed app-wide. Mirrored from
  // /api/auth/me so the banner + dropdown stay in sync after refreshes.
  const scope = ref<Scope | null>(null)
  const router = useRouter()

  const isAuthenticated = computed(() => !!token.value)
  // Admin in the underlying account — used to gate the "View as" picker.
  const isAccountAdmin = computed(() => user.value?.roles.includes('admin') ?? false)
  // "Effective" admin — bypasses permission gates app-wide. False while
  // scoped so the test session reflects what a department member sees.
  const isAdmin = computed(() => isAccountAdmin.value && !scope.value)
  const isScoped = computed(() => scope.value != null)

  // True if the user has a per-view read permission. Admin bypass when
  // not scoped. Mirrors `requireViewPermission` on the server.
  function hasViewPermission(resourceId: string): boolean {
    if (isAdmin.value) return true
    return permissions.value.some(p =>
      p.resource_type === 'view' && p.resource_id === resourceId && p.can_read === 1)
  }

  function setAuth(newToken: string, newUser: User) {
    token.value = newToken
    user.value = newUser
    localStorage.setItem('token', newToken)
  }

  function logout() {
    token.value = null
    user.value = null
    permissions.value = []
    scope.value = null
    localStorage.removeItem('token')
    router.push('/login')
  }

  async function fetchUser() {
    if (!token.value) return
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      if (!res.ok) {
        logout()
        return
      }
      const data = await res.json()
      user.value = data.user
      scope.value = data.scope || null
      // Load permissions after user is set
      await fetchPermissions()
    } catch {
      logout()
    }
  }

  // Admin-only: scope the current session to a department. Server issues
  // a new JWT carrying the scope claim; we swap it in atomically and
  // refresh permissions so sidebar/router gates rebind to the dept's view.
  async function scopeToDepartment(departmentId: number) {
    if (!token.value) return
    const res = await fetch('/api/auth/scope', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({ department_id: departmentId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to set scope')
    token.value = data.token
    localStorage.setItem('token', data.token)
    user.value = data.user
    scope.value = data.scope
    await fetchPermissions()
  }

  async function clearScope() {
    if (!token.value) return
    const res = await fetch('/api/auth/scope/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}` },
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to clear scope')
    token.value = data.token
    localStorage.setItem('token', data.token)
    user.value = data.user
    scope.value = null
    await fetchPermissions()
  }

  async function fetchPermissions() {
    if (!token.value || !user.value) return
    try {
      const res = await fetch('/api/auth/my-permissions', {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      if (res.ok) {
        const data = await res.json()
        permissions.value = data.permissions
      }
    } catch {
      // Non-admin users may not have access to this endpoint yet
      // Permissions will be empty — server-side enforcement still applies
    }
  }

  async function login(email: string, password: string) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    setAuth(data.token, data.user)
    await fetchPermissions()
  }

  async function register(email: string, name: string, password: string) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    setAuth(data.token, data.user)
  }

  return {
    token, user, permissions, scope,
    isAuthenticated, isAdmin, isAccountAdmin, isScoped,
    hasViewPermission, setAuth, login, register, logout, fetchUser,
    scopeToDepartment, clearScope,
  }
})
