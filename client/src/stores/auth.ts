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

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'))
  const user = ref<User | null>(null)
  const permissions = ref<Permission[]>([])
  const router = useRouter()

  const isAuthenticated = computed(() => !!token.value)
  const isAdmin = computed(() => user.value?.roles.includes('admin') ?? false)

  function setAuth(newToken: string, newUser: User) {
    token.value = newToken
    user.value = newUser
    localStorage.setItem('token', newToken)
  }

  function logout() {
    token.value = null
    user.value = null
    permissions.value = []
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
      // Load permissions after user is set
      await fetchPermissions()
    } catch {
      logout()
    }
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

  return { token, user, permissions, isAuthenticated, isAdmin, setAuth, login, register, logout, fetchUser }
})
