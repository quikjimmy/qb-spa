<script setup lang="ts">
// Admin-only "View as department" picker. Issues a scoped JWT via
// /api/auth/scope so the entire app — sidebar, router gates, server
// permission checks — behaves as if the admin were a department
// member. Used to verify what each team actually sees in production
// before rolling out a permission change.
import { ref, onMounted, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

interface DeptOption { id: number; name: string; description: string }
interface RoleOption { name: string; description: string }

const auth = useAuthStore()
const open = ref(false)
const switching = ref(false)
const error = ref('')
const departments = ref<DeptOption[]>([])
const roles = ref<RoleOption[]>([])
const loaded = ref(false)

// Only admins see the picker. Once role-scoped the token no longer carries
// admin, so the account looks non-admin — exit via the persistent banner.
const visible = computed(() => !!auth.user && auth.isAccountAdmin)

async function loadOptions() {
  if (loaded.value) return
  try {
    const [dRes, rRes] = await Promise.all([
      fetch('/api/auth/scope/departments', { headers: { Authorization: `Bearer ${auth.token}` } }),
      fetch('/api/auth/scope/roles', { headers: { Authorization: `Bearer ${auth.token}` } }),
    ])
    if (dRes.ok) departments.value = (await dRes.json() as { departments: DeptOption[] }).departments
    if (rRes.ok) roles.value = (await rRes.json() as { roles: RoleOption[] }).roles
    loaded.value = true
  } catch { /* surfaced as no-options in the dropdown */ }
}

function toggle() {
  if (!open.value) loadOptions()
  open.value = !open.value
}

async function pickRole(role: string) {
  if (switching.value) return
  switching.value = true
  error.value = ''
  try {
    await auth.scopeToRole(role)
    open.value = false
    window.location.reload()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    switching.value = false
  }
}

async function pick(deptId: number) {
  if (switching.value) return
  switching.value = true
  error.value = ''
  try {
    await auth.scopeToDepartment(deptId)
    open.value = false
    // Refresh to ensure all in-flight data re-fetches under the new
    // scope (any view loaded under admin-bypass needs a clean reload).
    window.location.reload()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    switching.value = false
  }
}

async function exit() {
  if (switching.value) return
  switching.value = true
  try {
    await auth.clearScope()
    open.value = false
    window.location.reload()
  } finally {
    switching.value = false
  }
}

// Close on outside click — single button, single dropdown, no fancy
// portal — keep the implementation small.
const root = ref<HTMLDivElement | null>(null)
function onDocClick(e: MouseEvent) {
  if (!open.value || !root.value) return
  if (!root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
watch(() => auth.user, () => { loaded.value = false }, { deep: true })
</script>

<template>
  <div v-if="visible" ref="root" class="relative">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 h-8 px-2 rounded-md text-[11px] font-medium transition-colors cursor-pointer"
      :class="auth.isScoped
        ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-900/50'
        : 'hover:bg-muted'"
      :title="auth.isScoped ? `Currently viewing as: ${auth.scope?.departmentName}` : 'View the app as a specific department'"
      @click.stop="toggle"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
      <span class="hidden sm:inline">
        {{ auth.isScoped ? `as ${auth.scope?.departmentName || auth.scope?.role}` : 'View as' }}
      </span>
    </button>

    <div
      v-if="open"
      class="absolute right-0 top-full mt-1 w-64 rounded-md border bg-popover shadow-md z-50 p-1"
      role="menu"
    >
      <div class="px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">View the app as</div>
      <button
        v-if="auth.isScoped"
        type="button"
        class="w-full text-left px-2 py-1.5 rounded text-[12px] hover:bg-muted transition-colors cursor-pointer flex items-center gap-2"
        :disabled="switching"
        @click="exit"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Exit View-as · back to admin
      </button>
      <div v-if="!loaded" class="px-2 py-2 text-[11px] text-muted-foreground italic">Loading…</div>
      <template v-else>
        <!-- Roles — role-based gating (e.g. Referral Agent) -->
        <div v-if="roles.length" class="my-1 border-t" />
        <div v-if="roles.length" class="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/70">Roles</div>
        <button
          v-for="r in roles" :key="r.name"
          type="button"
          class="w-full text-left px-2 py-1.5 rounded text-[12px] hover:bg-muted transition-colors cursor-pointer"
          :class="auth.scope?.role === r.name ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
          :disabled="switching || auth.scope?.role === r.name"
          @click="pickRole(r.name)"
        >
          <div class="font-medium">{{ r.name }}</div>
          <div v-if="r.description" class="text-[10px] text-muted-foreground truncate">{{ r.description }}</div>
        </button>

        <!-- Departments — permission-based gating -->
        <div v-if="departments.length" class="my-1 border-t" />
        <div v-if="departments.length" class="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/70">Departments</div>
        <button
          v-for="d in departments" :key="d.id"
          type="button"
          class="w-full text-left px-2 py-1.5 rounded text-[12px] hover:bg-muted transition-colors cursor-pointer"
          :class="auth.scope?.departmentId === d.id ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
          :disabled="switching || auth.scope?.departmentId === d.id"
          @click="pick(d.id)"
        >
          <div class="font-medium">{{ d.name }}</div>
          <div v-if="d.description" class="text-[10px] text-muted-foreground truncate">{{ d.description }}</div>
        </button>

        <div v-if="!roles.length && !departments.length" class="px-2 py-2 text-[11px] text-muted-foreground italic">No roles or departments configured.</div>
      </template>
      <p v-if="error" class="px-2 py-1 text-[10px] text-rose-600">{{ error }}</p>
    </div>
  </div>
</template>
