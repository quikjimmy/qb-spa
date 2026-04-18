<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const auth = useAuthStore()

// ─── Types ───────────────────────────────────────────────

interface Role {
  id: number
  name: string
  description: string
  is_system: number
  qb_role_id: number | null
}

interface PortalUser {
  id: number
  email: string
  name: string
  roles: string[]
  is_active: number
  created_at: string
}

interface Permission {
  id: number
  role_id: number
  role_name: string
  resource_type: string
  resource_id: string
  can_read: number
  can_write: number
}

// ─── State ───────────────────────────────────────────────

const loading = ref(true)
const roles = ref<Role[]>([])
const users = ref<PortalUser[]>([])
const allPermissions = ref<Permission[]>([])

// Invite user
const inviteForm = ref({ name: '', email: '' })
const inviteRoles = ref<Set<string>>(new Set(['customer']))
const inviteError = ref('')
const inviteSubmitting = ref(false)
const lastInviteLink = ref('')
const inviteCopied = ref(false)

// Edit roles dialog
const editDialog = ref(false)
const editingUser = ref<PortalUser | null>(null)
const editingRoles = ref<Set<string>>(new Set())

// Create role
const newRoleName = ref('')
const newRoleDesc = ref('')

// Permissions
const permRoleId = ref('')
const permResourceType = ref('view')
const permResourceId = ref('')
const permCanRead = ref(true)
const permCanWrite = ref(false)
const selectedPermRole = ref('')

// ─── Computed ────────────────────────────────────────────

const resourcePlaceholder = computed(() => {
  switch (permResourceType.value) {
    case 'view': return 'e.g. dashboard, projects, admin'
    case 'table': return 'e.g. br9kwm8na'
    case 'field': return 'e.g. br9kwm8na.145'
    default: return ''
  }
})

// ─── API helpers ─────────────────────────────────────────

function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

async function loadRoles() {
  const res = await fetch('/api/admin/roles', { headers: hdrs() })
  const data = await res.json()
  roles.value = data.roles
}

async function loadUsers() {
  const res = await fetch('/api/admin/users', { headers: hdrs() })
  const data = await res.json()
  users.value = data.users
}

async function loadPermissions() {
  const url = selectedPermRole.value
    ? `/api/admin/permissions?role_id=${selectedPermRole.value}`
    : '/api/admin/permissions'
  const res = await fetch(url, { headers: hdrs() })
  const data = await res.json()
  allPermissions.value = data.permissions
}

// ─── Invite user ─────────────────────────────────────────

async function inviteUser() {
  inviteError.value = ''
  lastInviteLink.value = ''
  inviteCopied.value = false

  if (!inviteForm.value.name.trim() || !inviteForm.value.email.trim()) {
    inviteError.value = 'Name and email are required'
    return
  }
  if (inviteRoles.value.size === 0) {
    inviteError.value = 'Select at least one role'
    return
  }

  inviteSubmitting.value = true
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        email: inviteForm.value.email.trim(),
        name: inviteForm.value.name.trim(),
        roles: [...inviteRoles.value],
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      inviteError.value = data.error || 'Failed to create user'
      return
    }
    lastInviteLink.value = `${window.location.origin}${data.inviteLink}`
    inviteForm.value = { name: '', email: '' }
    inviteRoles.value = new Set(['customer'])
    await loadUsers()
  } finally {
    inviteSubmitting.value = false
  }
}

function toggleInviteRole(name: string) {
  const next = new Set(inviteRoles.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  inviteRoles.value = next
}

async function copyInviteLink() {
  await navigator.clipboard.writeText(lastInviteLink.value)
  inviteCopied.value = true
  setTimeout(() => { inviteCopied.value = false }, 2000)
}

// ─── Edit user roles ─────────────────────────────────────

function openEditRoles(user: PortalUser) {
  editingUser.value = user
  editingRoles.value = new Set(user.roles)
  editDialog.value = true
}

function toggleEditRole(name: string) {
  const next = new Set(editingRoles.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  editingRoles.value = next
}

async function saveUserRoles() {
  if (!editingUser.value) return
  await fetch(`/api/admin/users/${editingUser.value.id}/roles`, {
    method: 'PUT',
    headers: hdrs(),
    body: JSON.stringify({ roles: [...editingRoles.value] }),
  })
  editDialog.value = false
  editingUser.value = null
  await loadUsers()
}

async function toggleUserActive(user: PortalUser) {
  await fetch(`/api/admin/users/${user.id}/active`, {
    method: 'PUT',
    headers: hdrs(),
    body: JSON.stringify({ is_active: !user.is_active }),
  })
  await loadUsers()
}

// ─── Roles ───────────────────────────────────────────────

async function createRole() {
  if (!newRoleName.value.trim()) return
  await fetch('/api/admin/roles', {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ name: newRoleName.value.trim(), description: newRoleDesc.value.trim() }),
  })
  newRoleName.value = ''
  newRoleDesc.value = ''
  await loadRoles()
}

async function deleteRole(id: number) {
  await fetch(`/api/admin/roles/${id}`, { method: 'DELETE', headers: hdrs() })
  await Promise.all([loadRoles(), loadPermissions()])
}

// ─── Permissions ─────────────────────────────────────────

async function addPermission() {
  if (!permRoleId.value || !permResourceId.value.trim()) return
  await fetch('/api/admin/permissions', {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({
      role_id: parseInt(permRoleId.value),
      resource_type: permResourceType.value,
      resource_id: permResourceId.value.trim(),
      can_read: permCanRead.value,
      can_write: permCanWrite.value,
    }),
  })
  permResourceId.value = ''
  permCanRead.value = true
  permCanWrite.value = false
  await loadPermissions()
}

async function deletePermission(id: number) {
  await fetch(`/api/admin/permissions/${id}`, { method: 'DELETE', headers: hdrs() })
  await loadPermissions()
}

// ─── Test as User ────────────────────────────────────────

const testUserId = ref('')
const testEmail = ref('')
const testMode = ref<'user' | 'email'>('user')
const testTableId = ref('br9kwm8na')
const testLoading = ref(false)
const testError = ref('')

interface FieldDetail {
  id: number
  canRead: boolean
  canWrite: boolean
}

interface TestUserInfo {
  id: number
  email: string
  name: string
  roles: string[]
}

interface TestResult {
  allowed: boolean
  message?: string
  user: TestUserInfo
  requestedFields: number[]
  allowedFields: number[]
  blockedFields: number[]
  fieldDetails: FieldDetail[]
  recordFilter: string | null
  recordCount?: number
  qbError?: string
  data: Array<Record<string, { value: unknown }>>
}

const testResult = ref<TestResult | null>(null)

const testFields = [
  { id: 3, label: 'Record ID#' },
  { id: 145, label: 'Customer Name' },
  { id: 146, label: 'Customer Address' },
  { id: 148, label: 'Mobile Phone' },
  { id: 149, label: 'Email' },
  { id: 255, label: 'Status' },
  { id: 339, label: 'Sales Office' },
  { id: 344, label: 'Lender' },
  { id: 355, label: 'Closer' },
  { id: 522, label: 'Sales Date' },
  { id: 534, label: 'Install Completed' },
  { id: 538, label: 'PTO Approved' },
  { id: 820, label: 'Project Coordinator' },
  { id: 13, label: 'System Size (kW)' },
]

const testFieldMap = Object.fromEntries(testFields.map(f => [f.id, f.label]))

const testTables = [
  { id: 'br9kwm8na', name: 'Projects' },
  { id: 'bvbqgs5yc', name: 'Arrivy Tasks' },
  { id: 'bvbbznmdb', name: 'Arrivy Task Log' },
  { id: 'bt4a8ypkq', name: 'Intake Events' },
  { id: 'bsbguxz4i', name: 'Events' },
  { id: 'bsb6bqt3b', name: 'Notes' },
  { id: 'bstdqwrkg', name: 'Tickets' },
  { id: 'bvjf44d7d', name: 'SMS Log' },
  { id: 'bvjf2i36u', name: 'Call Log' },
]

async function runTestAsUser() {
  const hasInput = testMode.value === 'user' ? testUserId.value : testEmail.value.trim()
  if (!hasInput) return
  testLoading.value = true
  testError.value = ''
  testResult.value = null

  const body: Record<string, unknown> = {
    table_id: testTableId.value,
    select: testFields.map(f => f.id),
  }
  if (testMode.value === 'user') {
    body.user_id = parseInt(testUserId.value)
  } else {
    body.email = testEmail.value.trim()
  }

  try {
    const res = await fetch('/api/admin/impersonate-query', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      testError.value = data.error || 'Test failed'
      return
    }
    testResult.value = data
  } catch (e) {
    testError.value = e instanceof Error ? e.message : 'Test failed'
  } finally {
    testLoading.value = false
  }
}

// ─── Record Filters ──────────────────────────────────────

interface RecordFilter {
  id: number
  role_id: number
  role_name: string
  table_id: string
  qb_email_field_id: number
  description: string
}

const recordFilters = ref<RecordFilter[]>([])
const rfRoleId = ref('')
const rfTableId = ref('br9kwm8na')
const rfFieldId = ref('')
const rfDescription = ref('')

async function loadRecordFilters() {
  const res = await fetch('/api/admin/record-filters', { headers: hdrs() })
  const data = await res.json()
  recordFilters.value = data.filters
}

async function addRecordFilter() {
  if (!rfRoleId.value || !rfTableId.value || !rfFieldId.value) return
  await fetch('/api/admin/record-filters', {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({
      role_id: parseInt(rfRoleId.value),
      table_id: rfTableId.value,
      qb_email_field_id: parseInt(rfFieldId.value),
      description: rfDescription.value,
    }),
  })
  rfFieldId.value = ''
  rfDescription.value = ''
  await loadRecordFilters()
}

async function deleteRecordFilter(id: number) {
  await fetch(`/api/admin/record-filters/${id}`, { method: 'DELETE', headers: hdrs() })
  await loadRecordFilters()
}

// ─── QB Sync ─────────────────────────────────────────────

interface SyncTableResult {
  id: string
  name: string
  fields: number
  permissions: number
}

interface SyncResult {
  roles: { synced: number; created: number }
  tables: SyncTableResult[]
  totalPermissions: number
}

const syncing = ref(false)
const syncResult = ref<SyncResult | null>(null)
const syncError = ref('')

async function runFullSync() {
  syncing.value = true
  syncResult.value = null
  syncError.value = ''
  try {
    const res = await fetch('/api/admin/qb-sync/full', {
      method: 'POST',
      headers: hdrs(),
    })
    const data = await res.json()
    if (!res.ok) {
      syncError.value = data.error || 'Sync failed'
      return
    }
    syncResult.value = data
    await Promise.all([loadRoles(), loadPermissions()])
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : 'Sync failed'
  } finally {
    syncing.value = false
  }
}

// ─── Init ────────────────────────────────────────────────

const router = useRouter()

onMounted(async () => {
  if (!auth.user) await auth.fetchUser()
  if (!auth.isAdmin) {
    router.replace('/')
    return
  }
  try {
    await Promise.all([loadRoles(), loadUsers(), loadPermissions(), loadRecordFilters()])
  } catch (e) {
    console.error('Admin load failed:', e)
  }
  loading.value = false
})
</script>

<template>
  <div class="grid gap-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Admin</h1>
      <p class="text-muted-foreground mt-1">Manage portal users, roles, and permissions.</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-20 text-muted-foreground">
      Loading...
    </div>

      <Tabs v-else default-value="users">
        <TabsList class="mb-6">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="qb-sync">QB Sync</TabsTrigger>
          <TabsTrigger value="test-user">Test as User</TabsTrigger>
        </TabsList>

        <!-- ════════════ USERS TAB ════════════ -->
        <TabsContent value="users" class="grid gap-6">

          <!-- Invite form -->
          <Card>
            <CardHeader>
              <CardTitle>Invite User</CardTitle>
              <CardDescription>
                Add a user and generate an invite link. They set their own password.
              </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-5">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div class="space-y-2">
                  <Label for="invite-name">Full name</Label>
                  <Input
                    id="invite-name"
                    v-model="inviteForm.name"
                    placeholder="Jane Smith"
                    autocomplete="off"
                  />
                </div>
                <div class="space-y-2">
                  <Label for="invite-email">Email address</Label>
                  <Input
                    id="invite-email"
                    v-model="inviteForm.email"
                    type="email"
                    placeholder="jane@example.com"
                    autocomplete="off"
                  />
                </div>
              </div>

              <!-- Role checkboxes -->
              <div class="space-y-3">
                <Label>Assign roles</Label>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label
                    v-for="role in roles"
                    :key="role.id"
                    class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
                    :class="inviteRoles.has(role.name) ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'"
                  >
                    <Checkbox
                      :checked="inviteRoles.has(role.name)"
                      @update:checked="toggleInviteRole(role.name)"
                      class="mt-0.5"
                    />
                    <div class="grid gap-0.5">
                      <span class="text-sm font-medium leading-none">{{ role.name }}</span>
                      <span class="text-xs text-muted-foreground">{{ role.description }}</span>
                    </div>
                  </label>
                </div>
              </div>

              <p v-if="inviteError" class="text-sm text-destructive">{{ inviteError }}</p>

              <div>
                <Button @click="inviteUser" :disabled="inviteSubmitting">
                  {{ inviteSubmitting ? 'Creating...' : 'Create & Generate Invite Link' }}
                </Button>
              </div>

              <!-- Invite link result -->
              <div
                v-if="lastInviteLink"
                class="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-800 p-4 space-y-3"
              >
                <p class="text-sm font-medium text-green-800 dark:text-green-300">
                  User created. Send them this link to set their password:
                </p>
                <div class="flex gap-2">
                  <Input
                    :model-value="lastInviteLink"
                    readonly
                    class="font-mono text-xs flex-1"
                    @focus="($event.target as HTMLInputElement).select()"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    class="shrink-0"
                    @click="copyInviteLink"
                  >
                    {{ inviteCopied ? 'Copied!' : 'Copy' }}
                  </Button>
                </div>
                <p class="text-xs text-muted-foreground">Link expires in 7 days.</p>
              </div>
            </CardContent>
          </Card>

          <!-- User list -->
          <Card>
            <CardHeader>
              <CardTitle>All Users</CardTitle>
              <CardDescription>
                {{ users.length }} user{{ users.length === 1 ? '' : 's' }} registered. These accounts are independent of QuickBase.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead class="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="u in users" :key="u.id">
                    <TableCell>
                      <div>
                        <p class="font-medium text-sm">{{ u.name }}</p>
                        <p class="text-xs text-muted-foreground">{{ u.email }}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div class="flex gap-1 flex-wrap">
                        <Badge
                          v-for="r in u.roles"
                          :key="r"
                          :variant="r === 'admin' ? 'default' : 'secondary'"
                          class="text-xs"
                        >
                          {{ r }}
                        </Badge>
                        <span v-if="u.roles.length === 0" class="text-xs text-muted-foreground italic">
                          no roles
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <span
                          class="h-2 w-2 rounded-full"
                          :class="u.is_active ? 'bg-green-500' : 'bg-muted-foreground/30'"
                        />
                        <span class="text-xs text-muted-foreground">
                          {{ u.is_active ? 'Active' : 'Inactive' }}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell class="text-right">
                      <div class="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" @click="openEditRoles(u)">
                          Edit roles
                        </Button>
                        <Button
                          :variant="u.is_active ? 'ghost' : 'outline'"
                          size="sm"
                          @click="toggleUserActive(u)"
                        >
                          {{ u.is_active ? 'Deactivate' : 'Activate' }}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ════════════ ROLES TAB ════════════ -->
        <TabsContent value="roles" class="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Create Role</CardTitle>
              <CardDescription>Define a new role to assign to portal users.</CardDescription>
            </CardHeader>
            <CardContent>
              <form @submit.prevent="createRole" class="flex gap-3 items-end">
                <div class="space-y-2 w-48">
                  <Label for="role-name">Name</Label>
                  <Input id="role-name" v-model="newRoleName" placeholder="e.g. inspector" />
                </div>
                <div class="space-y-2 flex-1">
                  <Label for="role-desc">Description</Label>
                  <Input id="role-desc" v-model="newRoleDesc" placeholder="What does this role do?" />
                </div>
                <Button type="submit" :disabled="!newRoleName.trim()">Create Role</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All Roles</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead class="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="role in roles" :key="role.id">
                    <TableCell class="font-medium">{{ role.name }}</TableCell>
                    <TableCell class="text-muted-foreground">{{ role.description }}</TableCell>
                    <TableCell>
                      <Badge variant="outline" class="text-xs">
                        {{ role.is_system ? 'system' : role.qb_role_id ? 'QB' : 'custom' }}
                      </Badge>
                    </TableCell>
                    <TableCell class="text-right">
                      <Button
                        v-if="!role.is_system && !role.qb_role_id"
                        variant="ghost"
                        size="sm"
                        class="text-destructive hover:text-destructive"
                        @click="deleteRole(role.id)"
                      >
                        Delete
                      </Button>
                      <span v-else class="text-xs text-muted-foreground">
                        {{ role.qb_role_id ? 'synced' : 'built-in' }}
                      </span>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ════════════ PERMISSIONS TAB ════════════ -->
        <TabsContent value="permissions" class="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Add Permission</CardTitle>
              <CardDescription>
                Control what each role can read or write.
                Use <code class="text-xs bg-muted px-1 py-0.5 rounded">tableId.fieldId</code> for field-level control.
              </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4">
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div class="space-y-2">
                  <Label>Role</Label>
                  <Select v-model="permRoleId">
                    <SelectTrigger>
                      <SelectValue placeholder="Select role..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="r in roles" :key="r.id" :value="String(r.id)">
                        {{ r.name }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-2">
                  <Label>Resource type</Label>
                  <Select v-model="permResourceType">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="view">View (page)</SelectItem>
                      <SelectItem value="table">Table</SelectItem>
                      <SelectItem value="field">Field</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-2">
                  <Label>Resource ID</Label>
                  <Input v-model="permResourceId" :placeholder="resourcePlaceholder" />
                </div>
              </div>

              <div class="flex items-center gap-6">
                <label class="flex items-center gap-2 cursor-pointer">
                  <Checkbox :checked="permCanRead" @update:checked="(v: boolean) => permCanRead = v" />
                  <span class="text-sm">Can read</span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <Checkbox :checked="permCanWrite" @update:checked="(v: boolean) => permCanWrite = v" />
                  <span class="text-sm">Can write</span>
                </label>
                <Button class="ml-auto" @click="addPermission" :disabled="!permRoleId || !permResourceId.trim()">
                  Add Permission
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div class="flex items-center justify-between gap-4">
                <CardTitle>Permission Rules</CardTitle>
                <div class="w-52">
                  <Select v-model="selectedPermRole" @update:model-value="loadPermissions">
                    <SelectTrigger>
                      <SelectValue placeholder="Filter by role..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">All roles</SelectItem>
                      <SelectItem v-for="r in roles" :key="r.id" :value="String(r.id)">
                        {{ r.name }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Read</TableHead>
                    <TableHead>Write</TableHead>
                    <TableHead class="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="p in allPermissions" :key="p.id">
                    <TableCell>
                      <Badge variant="secondary" class="text-xs">{{ p.role_name }}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" class="text-xs">{{ p.resource_type }}</Badge>
                    </TableCell>
                    <TableCell class="font-mono text-xs">{{ p.resource_id }}</TableCell>
                    <TableCell>
                      <span
                        class="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs"
                        :class="p.can_read ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'"
                      >
                        {{ p.can_read ? 'R' : '—' }}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        class="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs"
                        :class="p.can_write ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-muted text-muted-foreground'"
                      >
                        {{ p.can_write ? 'W' : '—' }}
                      </span>
                    </TableCell>
                    <TableCell class="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        class="text-destructive hover:text-destructive"
                        @click="deletePermission(p.id)"
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                  <TableRow v-if="allPermissions.length === 0">
                    <TableCell colspan="6" class="text-center text-muted-foreground py-12">
                      No permissions configured. Add one above to get started.
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ════════════ QB SYNC TAB ════════════ -->
        <TabsContent value="qb-sync" class="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Sync from QuickBase</CardTitle>
              <CardDescription>
                Pull roles and field-level permissions directly from your QuickBase app.
                This imports all 47 QB roles and their read/write permissions across every field in every table —
                so portal roles automatically inherit the same access rules as QB.
              </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4">
              <div class="rounded-lg border p-4 space-y-2 text-sm">
                <p class="font-medium">What this does:</p>
                <ul class="space-y-1 text-muted-foreground ml-4 list-disc">
                  <li>Fetches all roles from the QB app (<code class="text-xs bg-muted px-1 py-0.5 rounded">br9kwm8bk</code>)</li>
                  <li>Creates matching portal roles (linked by QB role ID)</li>
                  <li>For each of 9 key tables, fetches every field's permission per role</li>
                  <li>Maps QB <strong>Modify</strong> → read + write, <strong>View</strong> → read only, <strong>None</strong> → no access</li>
                  <li>Existing permissions are updated, not duplicated</li>
                </ul>
              </div>

              <div>
                <Button
                  @click="runFullSync"
                  :disabled="syncing"
                  size="lg"
                >
                  {{ syncing ? 'Syncing...' : 'Run Full Sync' }}
                </Button>
              </div>

              <!-- Error -->
              <div
                v-if="syncError"
                class="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-800 p-4 text-sm text-red-800 dark:text-red-300"
              >
                {{ syncError }}
              </div>

              <!-- Results -->
              <div v-if="syncResult" class="space-y-4">
                <div class="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-800 p-4 space-y-1">
                  <p class="text-sm font-medium text-green-800 dark:text-green-300">Sync complete</p>
                  <p class="text-sm text-green-700 dark:text-green-400">
                    {{ syncResult.roles.synced }} roles synced
                    ({{ syncResult.roles.created }} new) &middot;
                    {{ syncResult.totalPermissions.toLocaleString() }} permissions written
                  </p>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Table</TableHead>
                      <TableHead>ID</TableHead>
                      <TableHead class="text-right">Fields</TableHead>
                      <TableHead class="text-right">Permissions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="t in syncResult.tables" :key="t.id">
                      <TableCell class="font-medium">{{ t.name }}</TableCell>
                      <TableCell class="font-mono text-xs text-muted-foreground">{{ t.id }}</TableCell>
                      <TableCell class="text-right">{{ t.fields.toLocaleString() }}</TableCell>
                      <TableCell class="text-right">{{ t.permissions.toLocaleString() }}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ════════════ TEST AS USER TAB ════════════ -->
        <TabsContent value="test-user" class="grid gap-6">

          <!-- Record Filters config -->
          <Card>
            <CardHeader>
              <CardTitle>Record Filters</CardTitle>
              <CardDescription>
                Control which records a role can see. Each rule says: "when this role queries this table,
                only return records where QB field X matches the user's email."
              </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4">
              <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div class="space-y-2">
                  <Label>Role</Label>
                  <Select v-model="rfRoleId">
                    <SelectTrigger><SelectValue placeholder="Select role..." /></SelectTrigger>
                    <SelectContent class="max-h-72">
                      <SelectItem v-for="r in roles" :key="r.id" :value="String(r.id)">{{ r.name }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-2">
                  <Label>Table</Label>
                  <Select v-model="rfTableId">
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="t in testTables" :key="t.id" :value="t.id">{{ t.name }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-2">
                  <Label>QB Email Field ID</Label>
                  <Input v-model="rfFieldId" placeholder="e.g. 149" type="number" />
                </div>
                <div class="flex items-end">
                  <Button @click="addRecordFilter" :disabled="!rfRoleId || !rfFieldId" class="w-full">
                    Add Filter
                  </Button>
                </div>
              </div>

              <Table v-if="recordFilters.length">
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Table</TableHead>
                    <TableHead>Email Field</TableHead>
                    <TableHead class="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="rf in recordFilters" :key="rf.id">
                    <TableCell><Badge variant="secondary" class="text-xs">{{ rf.role_name }}</Badge></TableCell>
                    <TableCell class="font-mono text-xs">
                      {{ testTables.find(t => t.id === rf.table_id)?.name || rf.table_id }}
                    </TableCell>
                    <TableCell class="font-mono text-xs">Field #{{ rf.qb_email_field_id }}</TableCell>
                    <TableCell class="text-right">
                      <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="deleteRecordFilter(rf.id)">Remove</Button>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p v-else class="text-sm text-muted-foreground">No record filters configured. All non-admin users see all records (field permissions still apply).</p>
            </CardContent>
          </Card>

          <!-- Test as User -->
          <Card>
            <CardHeader>
              <CardTitle>Test as User</CardTitle>
              <CardDescription>
                Select a portal user or type any email to see what they'd get — field permissions, record filters, and live data.
              </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-5">
              <!-- Mode toggle -->
              <div class="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                <button
                  class="px-3 py-1.5 text-sm rounded-md transition-colors"
                  :class="testMode === 'user' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'"
                  @click="testMode = 'user'"
                >
                  Portal user
                </button>
                <button
                  class="px-3 py-1.5 text-sm rounded-md transition-colors"
                  :class="testMode === 'email' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'"
                  @click="testMode = 'email'"
                >
                  Any email
                </button>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <!-- Portal user select -->
                <div v-if="testMode === 'user'" class="space-y-2">
                  <Label>User</Label>
                  <Select v-model="testUserId">
                    <SelectTrigger>
                      <SelectValue placeholder="Select a user..." />
                    </SelectTrigger>
                    <SelectContent class="max-h-72">
                      <SelectItem v-for="u in users" :key="u.id" :value="String(u.id)">
                        <span class="flex items-center gap-2">
                          {{ u.name }}
                          <span class="text-[10px] text-muted-foreground">{{ u.email }}</span>
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <!-- Email input -->
                <div v-else class="space-y-2">
                  <Label>Email</Label>
                  <Input
                    v-model="testEmail"
                    type="email"
                    placeholder="anyone@example.com"
                  />
                </div>
                <div class="space-y-2">
                  <Label>Table</Label>
                  <Select v-model="testTableId">
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="t in testTables" :key="t.id" :value="t.id">{{ t.name }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="flex items-end">
                  <Button
                    @click="runTestAsUser"
                    :disabled="testLoading || (testMode === 'user' ? !testUserId : !testEmail.trim())"
                    class="w-full sm:w-auto"
                  >
                    {{ testLoading ? 'Querying...' : 'Run Test' }}
                  </Button>
                </div>
              </div>

              <!-- Error -->
              <div
                v-if="testError"
                class="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-800 p-4 text-sm text-red-800 dark:text-red-300"
              >
                {{ testError }}
              </div>

              <!-- No table access -->
              <div
                v-if="testResult && !testResult.allowed"
                class="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 p-4"
              >
                <p class="text-sm font-medium text-amber-800 dark:text-amber-300">No access</p>
                <p class="text-sm text-amber-700 dark:text-amber-400">{{ testResult.message }}</p>
              </div>

              <!-- Results -->
              <template v-if="testResult?.allowed">
                <!-- User summary -->
                <div class="rounded-lg border p-4 space-y-2">
                  <div class="flex items-center gap-3">
                    <p class="font-medium text-sm">{{ testResult.user.name }}</p>
                    <span class="text-xs text-muted-foreground">{{ testResult.user.email }}</span>
                    <Badge v-for="r in testResult.user.roles" :key="r" variant="secondary" class="text-xs">{{ r }}</Badge>
                  </div>
                  <div v-if="testResult.recordFilter" class="flex items-start gap-2">
                    <Badge variant="outline" class="text-xs shrink-0">Record filter</Badge>
                    <code class="text-xs text-muted-foreground break-all">{{ testResult.recordFilter }}</code>
                  </div>
                  <p v-else class="text-xs text-muted-foreground">No record filter — sees all records</p>
                </div>

                <!-- QB error -->
                <div
                  v-if="testResult.qbError"
                  class="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 p-4 text-sm text-amber-800 dark:text-amber-300"
                >
                  QB returned an error: {{ testResult.qbError }}
                </div>

                <!-- Counts -->
                <div class="flex gap-4 items-center flex-wrap">
                  <div class="rounded-lg border p-3 text-center min-w-[100px]">
                    <p class="text-2xl font-semibold">{{ testResult.requestedFields.length }}</p>
                    <p class="text-xs text-muted-foreground">Requested</p>
                  </div>
                  <span class="text-muted-foreground text-lg">→</span>
                  <div class="rounded-lg border p-3 text-center min-w-[100px] border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-700">
                    <p class="text-2xl font-semibold text-green-700 dark:text-green-400">{{ testResult.allowedFields.length }}</p>
                    <p class="text-xs text-muted-foreground">Can Read</p>
                  </div>
                  <div
                    v-if="testResult.blockedFields.length"
                    class="rounded-lg border p-3 text-center min-w-[100px] border-red-300 bg-red-50 dark:bg-red-950/20 dark:border-red-700"
                  >
                    <p class="text-2xl font-semibold text-red-600 dark:text-red-400">{{ testResult.blockedFields.length }}</p>
                    <p class="text-xs text-muted-foreground">Blocked</p>
                  </div>
                  <div class="rounded-lg border p-3 text-center min-w-[100px]">
                    <p class="text-2xl font-semibold">{{ testResult.recordCount ?? testResult.data.length }}</p>
                    <p class="text-xs text-muted-foreground">Records</p>
                  </div>
                </div>

                <!-- Field breakdown -->
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div
                    v-for="fd in testResult.fieldDetails"
                    :key="fd.id"
                    class="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                    :class="fd.canRead ? 'bg-card' : 'bg-muted/50 opacity-50'"
                  >
                    <span :class="!fd.canRead && 'line-through text-muted-foreground'">
                      {{ testFieldMap[fd.id] || `Field ${fd.id}` }}
                      <span class="text-xs text-muted-foreground ml-1">#{{ fd.id }}</span>
                    </span>
                    <div class="flex gap-1">
                      <span
                        class="inline-flex h-5 w-auto px-1.5 items-center justify-center rounded text-[10px] font-medium"
                        :class="fd.canRead
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'"
                      >
                        {{ fd.canRead ? 'READ' : 'NO READ' }}
                      </span>
                      <span
                        v-if="fd.canRead"
                        class="inline-flex h-5 w-auto px-1.5 items-center justify-center rounded text-[10px] font-medium"
                        :class="fd.canWrite
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-muted text-muted-foreground'"
                      >
                        {{ fd.canWrite ? 'WRITE' : 'READ ONLY' }}
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Sample data -->
                <div v-if="testResult.data.length" class="space-y-2">
                  <p class="text-sm font-medium">Sample data ({{ testResult.data.length }} records)</p>
                  <div class="rounded-lg border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead v-for="fid in testResult.allowedFields" :key="fid" class="whitespace-nowrap text-xs">
                            {{ testFieldMap[fid] || `#${fid}` }}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow v-for="(row, i) in testResult.data" :key="i">
                          <TableCell v-for="fid in testResult.allowedFields" :key="fid" class="text-xs whitespace-nowrap max-w-[200px] truncate">
                            {{ row[String(fid)]?.value ?? '' }}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>
                <p v-else-if="testResult.recordFilter" class="text-sm text-muted-foreground">
                  No records matched this user's email filter.
                </p>
              </template>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

    <!-- Edit Roles Dialog -->
    <Dialog v-model:open="editDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Roles</DialogTitle>
          <DialogDescription v-if="editingUser">
            {{ editingUser.name }} &mdash; {{ editingUser.email }}
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-2 py-2">
          <label
            v-for="role in roles"
            :key="role.id"
            class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
            :class="editingRoles.has(role.name) ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'"
          >
            <Checkbox
              :checked="editingRoles.has(role.name)"
              @update:checked="toggleEditRole(role.name)"
              class="mt-0.5"
            />
            <div class="grid gap-0.5">
              <span class="text-sm font-medium leading-none">{{ role.name }}</span>
              <span class="text-xs text-muted-foreground">{{ role.description }}</span>
            </div>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editDialog = false">Cancel</Button>
          <Button @click="saveUserRoles">Save Roles</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
