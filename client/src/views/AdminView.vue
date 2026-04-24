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
  departments?: Array<{ id: number; name: string }>
  is_active: number
  created_at: string
}

interface Department {
  id: number
  name: string
  description: string
  user_count?: number
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
const inviteRoles = ref<Set<string>>(new Set(['Customer']))
const inviteError = ref('')
const inviteSubmitting = ref(false)
const lastInviteLink = ref('')
const inviteCopied = ref(false)
const basicRoleOptions = ['Internal Ops', 'Customer Support', 'Field Ops', 'Customer', 'Sales Manager', 'Sales Rep']

// Edit user access
const accessDialog = ref(false)
const accessUser = ref<PortalUser | null>(null)
const accessRole = ref('Customer')
const accessKeepAdmin = ref(false)
const accessDeptIds = ref<Set<number>>(new Set())
const accessError = ref('')
const accessSaving = ref(false)

const departments = ref<Department[]>([])
const newDeptName = ref('')
const newDeptDesc = ref('')

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
    inviteRoles.value = new Set(['Customer'])
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

// ─── Edit user access ────────────────────────────────────

function normalizeDisplayRole(role: string): string {
  const legacyMap: Record<string, string> = {
    customer: 'Customer',
    crew: 'Field Ops',
    lender: 'Customer Support',
  }
  return legacyMap[role] || role
}

function primaryEditableRole(user: PortalUser): string {
  const role = (user.roles || []).find(r => r !== 'admin') || ''
  return normalizeDisplayRole(role)
}

function openEditAccess(user: PortalUser) {
  accessUser.value = user
  accessRole.value = primaryEditableRole(user) || 'Customer'
  accessKeepAdmin.value = (user.roles || []).includes('admin')
  accessDeptIds.value = new Set((user.departments || []).map(d => Number(d.id)))
  accessError.value = ''
  accessDialog.value = true
  loadAltEmails(user.id)
}

// ─── Alternate emails (cross-system matching) ──────────────
interface AltEmail { id: number; email: string; system: string; label: string | null; created_at: string }
const altEmails = ref<AltEmail[]>([])
const altEmailInput = ref('')
const altSystemInput = ref('')
const altLabelInput = ref('')
const altEmailError = ref('')
const altEmailBusy = ref(false)

const SYSTEM_OPTIONS = [
  { value: '', label: 'Any system' },
  { value: 'dialpad', label: 'Dialpad' },
  { value: 'quickbase', label: 'QuickBase' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'other', label: 'Other' },
]

async function loadAltEmails(userId: number) {
  altEmails.value = []
  altEmailInput.value = ''
  altSystemInput.value = ''
  altLabelInput.value = ''
  altEmailError.value = ''
  try {
    const res = await fetch(`/api/admin/users/${userId}/emails`, { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      altEmails.value = data.emails || []
    }
  } catch { /* ignore */ }
}

async function addAltEmail() {
  if (!accessUser.value) return
  altEmailError.value = ''
  altEmailBusy.value = true
  try {
    const res = await fetch(`/api/admin/users/${accessUser.value.id}/emails`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        email: altEmailInput.value.trim(),
        system: altSystemInput.value,
        label: altLabelInput.value.trim(),
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) { altEmailError.value = body.error || `HTTP ${res.status}`; return }
    await loadAltEmails(accessUser.value.id)
  } finally { altEmailBusy.value = false }
}

async function removeAltEmail(id: number) {
  if (!accessUser.value) return
  await fetch(`/api/admin/users/${accessUser.value.id}/emails/${id}`, { method: 'DELETE', headers: hdrs() })
  await loadAltEmails(accessUser.value.id)
}

function systemLabel(s: string): string {
  return SYSTEM_OPTIONS.find(o => o.value === s)?.label || s || 'Any system'
}

function setAccessDepartment(id: number, checked: boolean) {
  const numericId = Number(id)
  const next = new Set(accessDeptIds.value)
  if (checked) next.add(numericId)
  else next.delete(numericId)
  accessDeptIds.value = next
}

async function saveUserAccess() {
  if (!accessUser.value) return
  accessError.value = ''
  accessSaving.value = true
  try {
    const userId = accessUser.value.id
    const rolesToSave = accessKeepAdmin.value ? ['admin', accessRole.value] : [accessRole.value]
    const roleRes = await fetch(`/api/admin/users/${userId}/roles`, {
      method: 'PUT',
      headers: hdrs(),
      body: JSON.stringify({ roles: rolesToSave }),
    })
    const roleData = await roleRes.json().catch(() => ({}))
    if (!roleRes.ok) {
      accessError.value = roleData.error || `Role save failed (${roleRes.status})`
      return
    }

    const deptRes = await fetch(`/api/admin/users/${userId}/departments`, {
      method: 'PUT',
      headers: hdrs(),
      body: JSON.stringify({ department_ids: [...accessDeptIds.value] }),
    })
    const deptData = await deptRes.json().catch(() => ({}))
    if (!deptRes.ok) {
      accessError.value = deptData.error || `Department save failed (${deptRes.status})`
      return
    }

    const user = users.value.find(u => u.id === userId)
    if (user) {
      user.roles = roleData.roles || rolesToSave
      user.departments = deptData.departments || []
    }
    accessDialog.value = false
    accessUser.value = null
    await Promise.all([loadUsers(), loadDepartments()])
  } finally {
    accessSaving.value = false
  }
}

async function toggleUserActive(user: PortalUser) {
  await fetch(`/api/admin/users/${user.id}/active`, {
    method: 'PUT',
    headers: hdrs(),
    body: JSON.stringify({ is_active: !user.is_active }),
  })
  await loadUsers()
}

// ─── Password reset ──────────────────────────────────────
const resetDialog = ref(false)
const resetResult = ref<{ url: string; email: string; expires_at: string } | null>(null)
const resetCopied = ref(false)

async function sendPasswordReset(user: PortalUser) {
  const res = await fetch(`/api/admin/users/${user.id}/password-reset`, {
    method: 'POST', headers: hdrs(),
  })
  if (!res.ok) {
    alert('Failed to create reset link')
    return
  }
  resetResult.value = await res.json()
  resetCopied.value = false
  resetDialog.value = true
}

async function copyResetLink() {
  if (!resetResult.value) return
  try {
    await navigator.clipboard.writeText(resetResult.value.url)
    resetCopied.value = true
    setTimeout(() => { resetCopied.value = false }, 1500)
  } catch {
    // clipboard denied (older browsers / insecure context) — user can manually copy
  }
}

// ─── Departments ─────────────────────────────────────────
async function loadDepartments() {
  const res = await fetch('/api/admin/departments', { headers: hdrs() })
  if (res.ok) departments.value = (await res.json()).departments || []
}

async function createDepartment() {
  if (!newDeptName.value.trim()) return
  const res = await fetch('/api/admin/departments', {
    method: 'POST', headers: hdrs(),
    body: JSON.stringify({ name: newDeptName.value.trim(), description: newDeptDesc.value.trim() }),
  })
  if (res.ok) { newDeptName.value = ''; newDeptDesc.value = ''; await loadDepartments() }
}

async function deleteDepartment(d: Department) {
  if (!window.confirm(`Delete department "${d.name}"? Users will lose this membership.`)) return
  await fetch(`/api/admin/departments/${d.id}`, { method: 'DELETE', headers: hdrs() })
  await Promise.all([loadDepartments(), loadUsers()])
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

// ─── Data Caches ─────────────────────────────────────────
interface DataCache {
  key: string
  label: string
  description: string
  table: string
  refreshPath: string
  total: number
  last_refresh: string | null
}
const caches = ref<DataCache[]>([])
const cachesLoading = ref(false)
const cacheBusy = ref<Record<string, boolean>>({})
const cacheError = ref<Record<string, string>>({})

async function loadCaches() {
  cachesLoading.value = true
  try {
    const res = await fetch('/api/admin/caches', { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      caches.value = data.caches || []
    }
  } finally { cachesLoading.value = false }
}

async function refreshDataCache(c: DataCache) {
  cacheBusy.value = { ...cacheBusy.value, [c.key]: true }
  cacheError.value = { ...cacheError.value, [c.key]: '' }
  try {
    const res = await fetch(c.refreshPath, { method: 'POST', headers: hdrs() })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      cacheError.value = { ...cacheError.value, [c.key]: body.error || `HTTP ${res.status}` }
    }
    await loadCaches()
  } catch (e) {
    cacheError.value = { ...cacheError.value, [c.key]: e instanceof Error ? e.message : String(e) }
  } finally {
    cacheBusy.value = { ...cacheBusy.value, [c.key]: false }
  }
}

async function refreshAllCaches() {
  for (const c of caches.value) {
    await refreshDataCache(c)
  }
}

function fmtCacheTime(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return iso
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

// ─── Dialpad integration ─────────────────────────────────
interface DialpadConfig {
  connected: boolean
  office_id: string
  key_preview: string | null
  last_tested_at: string | null
  last_test_ok: boolean | null
  last_test_error: string | null
}
const dialpad = ref<DialpadConfig | null>(null)
const dialpadApiKey = ref('')
const dialpadOfficeId = ref('')
const dialpadBusy = ref(false)
const dialpadTestResult = ref<{ ok: boolean; error?: string } | null>(null)

async function loadDialpad() {
  try {
    const res = await fetch('/api/dialpad/config', { headers: hdrs() })
    if (res.ok) {
      const data = await res.json() as DialpadConfig
      dialpad.value = data
      dialpadOfficeId.value = data.office_id || ''
    }
  } catch { /* ignore */ }
}

async function saveDialpad() {
  dialpadBusy.value = true
  dialpadTestResult.value = null
  try {
    const body: Record<string, string> = { office_id: dialpadOfficeId.value.trim() }
    if (dialpadApiKey.value.trim()) body['api_key'] = dialpadApiKey.value.trim()
    await fetch('/api/dialpad/config', { method: 'PUT', headers: hdrs(), body: JSON.stringify(body) })
    dialpadApiKey.value = ''
    await loadDialpad()
  } finally { dialpadBusy.value = false }
}

async function testDialpad() {
  dialpadBusy.value = true
  try {
    const res = await fetch('/api/dialpad/config/test', { method: 'POST', headers: hdrs() })
    dialpadTestResult.value = await res.json()
    await loadDialpad()
  } finally { dialpadBusy.value = false }
}

async function clearDialpadKey() {
  if (!confirm('Remove the stored Dialpad API key?')) return
  dialpadBusy.value = true
  try {
    await fetch('/api/dialpad/config', { method: 'DELETE', headers: hdrs() })
    await loadDialpad()
  } finally { dialpadBusy.value = false }
}

// ─── Dialpad webhooks ───────────────────────────────────
interface DialpadWebhookConfig {
  configured: boolean
  secret_preview: string | null
  webhook_urls: { call: string; sms: string; generic: string }
  is_https?: boolean
}
const webhookConfig = ref<DialpadWebhookConfig | null>(null)
const newWebhookSecret = ref('')
const webhookBusy = ref(false)
const webhookCopied = ref('')

async function loadWebhookConfig() {
  try {
    const res = await fetch('/api/dialpad/webhook-config', { headers: hdrs() })
    if (res.ok) webhookConfig.value = await res.json()
  } catch { /* ignore */ }
}

async function rotateWebhookSecret() {
  if (webhookConfig.value?.configured && !confirm('Rotating invalidates Dialpad\'s existing subscription. Continue?')) return
  webhookBusy.value = true
  newWebhookSecret.value = ''
  try {
    const res = await fetch('/api/dialpad/webhook-secret/rotate', { method: 'POST', headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      newWebhookSecret.value = data.secret
    }
    await loadWebhookConfig()
  } finally { webhookBusy.value = false }
}

async function clearWebhookSecret() {
  if (!confirm('Remove the Dialpad webhook secret? Live events will stop until re-configured.')) return
  webhookBusy.value = true
  try {
    await fetch('/api/dialpad/webhook-secret', { method: 'DELETE', headers: hdrs() })
    newWebhookSecret.value = ''
    await loadWebhookConfig()
  } finally { webhookBusy.value = false }
}

async function copyText(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
    webhookCopied.value = key
    setTimeout(() => { if (webhookCopied.value === key) webhookCopied.value = '' }, 1500)
  } catch { /* ignore */ }
}

// ─── Dialpad subscription (auto-activate) ────────────────
interface WebhookSubStatus {
  subscribed: boolean
  webhook_id: string | null
  call_subscription_id: string | null
  sms_subscription_id: string | null
  call_subscription_error: string | null
  sms_subscription_error: string | null
  webhook_url: string
}
const subStatus = ref<WebhookSubStatus | null>(null)
const subBusy = ref(false)
const subResult = ref<string>('')

async function loadSubStatus() {
  try {
    const res = await fetch('/api/dialpad/webhook-subscription', { headers: hdrs() })
    if (res.ok) subStatus.value = await res.json()
  } catch { /* ignore */ }
}

async function activateSubscription() {
  subBusy.value = true
  subResult.value = ''
  try {
    const res = await fetch('/api/dialpad/webhook-subscription', { method: 'POST', headers: hdrs() })
    const body = await res.json()
    if (!res.ok) {
      subResult.value = `Failed: ${body.error || 'unknown'}${body.dialpad_body ? ` · Dialpad said: ${body.dialpad_body}` : ''}`
    } else {
      const parts = []
      if (body.call?.id) parts.push(`calls ✓`); else if (body.call?.error) parts.push(`calls ✗ (${body.call.status})`)
      if (body.sms?.id) parts.push(`sms ✓`); else if (body.sms?.error) parts.push(`sms ✗ (${body.sms.status})`)
      subResult.value = `Activated · ${parts.join(' · ')}`
    }
    await loadSubStatus()
  } catch (e) {
    subResult.value = `Failed: ${e instanceof Error ? e.message : String(e)}`
  } finally { subBusy.value = false }
}

async function deactivateSubscription() {
  if (!confirm('Revoke Dialpad subscriptions? Live events will stop.')) return
  subBusy.value = true
  subResult.value = ''
  try {
    await fetch('/api/dialpad/webhook-subscription', { method: 'DELETE', headers: hdrs() })
    subResult.value = 'Deactivated'
    await loadSubStatus()
  } finally { subBusy.value = false }
}

async function retrySms() {
  subBusy.value = true
  subResult.value = ''
  try {
    const res = await fetch('/api/dialpad/webhook-subscription/retry-sms', { method: 'POST', headers: hdrs() })
    const body = await res.json()
    if (body.ok) subResult.value = `SMS subscription created (${body.id})`
    else subResult.value = `Failed: ${body.error || 'unknown'}`
    await loadSubStatus()
  } finally { subBusy.value = false }
}

const probeResult = ref<string>('')
async function probeSubscription() {
  subBusy.value = true
  probeResult.value = ''
  try {
    const res = await fetch('/api/dialpad/webhook-subscription/probe', { headers: hdrs() })
    const body = await res.json()
    probeResult.value = JSON.stringify(body, null, 2)
  } finally { subBusy.value = false }
}

// Webhook deliveries viewer — shows the last N POSTs that hit our
// /api/webhooks/dialpad endpoint, including rejected-signature / missing-
// body ones, so we can tell "Dialpad didn't send" from "Dialpad sent but
// we rejected".
interface WebhookDelivery {
  id: number
  path: string
  method: string
  content_type: string | null
  body_preview: string | null
  signature_ok: number | null
  inferred_kind: string | null
  status_code: number
  error: string | null
  stored_event_id: number | null
  received_at: string
}
const deliveries = ref<WebhookDelivery[]>([])
const deliveriesBusy = ref(false)
async function loadWebhookDeliveries() {
  deliveriesBusy.value = true
  try {
    const res = await fetch('/api/dialpad/webhook-deliveries?limit=50', { headers: hdrs() })
    if (res.ok) {
      const body = await res.json()
      deliveries.value = body.rows || []
    }
  } finally { deliveriesBusy.value = false }
}

// ─── Dev mirror token (paste into local .env to replay prod events) ───
const mirrorToken = ref('')
const mirrorUrl = ref('')
const mirrorBusy = ref(false)
async function generateMirrorToken() {
  mirrorBusy.value = true
  try {
    const res = await fetch('/api/dialpad/dev-mirror-token', { method: 'POST', headers: hdrs() })
    if (res.ok) {
      const body = await res.json()
      mirrorToken.value = body.token
      mirrorUrl.value = body.mirror_url
    }
  } finally { mirrorBusy.value = false }
}

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

// ─── App Feedback triage ─────────────────────────────────
interface FeedbackRow {
  id: number
  user_id: number
  user_name: string | null
  user_email: string | null
  path: string
  category: string | null
  body: string
  status: string
  triaged_by: number | null
  triaged_by_name: string | null
  triaged_at: string | null
  triage_note: string | null
  created_at: string
}
const feedbackRows = ref<FeedbackRow[]>([])
const feedbackCounts = ref<Record<string, number>>({})
const feedbackFilter = ref<string>('new')

async function loadFeedback() {
  const q = feedbackFilter.value === 'all' ? '' : `?status=${feedbackFilter.value}`
  const res = await fetch(`/api/feedback${q}`, { headers: hdrs() })
  if (!res.ok) return
  const data = await res.json()
  feedbackRows.value = data.rows || []
  const counts: Record<string, number> = {}
  for (const c of (data.counts || [])) counts[c.status] = c.n
  feedbackCounts.value = counts
}

async function setFeedbackStatus(id: number, status: string) {
  await fetch(`/api/feedback/${id}`, {
    method: 'PATCH', headers: hdrs(), body: JSON.stringify({ status }),
  })
  await loadFeedback()
}

function fmtFeedbackTime(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── User-agent review ───────────────────────────────────
interface UserAgentRow {
  id: number
  user_id: number
  owner_name: string | null
  owner_email: string | null
  name: string
  objective: string
  llm: string
  monthly_token_cap: number
  tokens_used_month: number
  tier: string
  status: string
  department: string | null
  submission_note: string | null
  approved_by: number | null
  approved_at: string | null
  created_at: string
  updated_at: string
}
const agentRows = ref<UserAgentRow[]>([])
const agentCounts = ref<Record<string, number>>({})
const agentFilter = ref<string>('submitted')

async function loadUserAgents() {
  const q = agentFilter.value === 'all' ? '' : `?status=${agentFilter.value}`
  const res = await fetch(`/api/user-agents${q}`, { headers: hdrs() })
  if (!res.ok) return
  const data = await res.json()
  agentRows.value = data.rows || []
  const counts: Record<string, number> = {}
  for (const c of (data.counts || [])) counts[c.status] = c.n
  agentCounts.value = counts
}

async function approveAgent(id: number) {
  await fetch(`/api/user-agents/${id}/approve`, { method: 'POST', headers: hdrs() })
  await loadUserAgents()
}

async function rejectAgent(id: number) {
  const note = window.prompt('Reason for rejection (visible to owner):') || ''
  await fetch(`/api/user-agents/${id}/reject`, {
    method: 'POST', headers: hdrs(), body: JSON.stringify({ note }),
  })
  await loadUserAgents()
}

onMounted(async () => {
  if (!auth.user) await auth.fetchUser()
  if (!auth.isAdmin) {
    router.replace('/')
    return
  }
  try {
    await Promise.all([loadRoles(), loadUsers(), loadPermissions(), loadRecordFilters(), loadCaches(), loadFeedback(), loadUserAgents(), loadDepartments(), loadDialpad(), loadWebhookConfig(), loadSubStatus()])
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
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
          <TabsTrigger value="agent-review">Agent Review</TabsTrigger>
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
                    <TableHead>Departments</TableHead>
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
                      <div class="flex gap-2 flex-wrap items-center">
                        <Badge
                          v-for="r in u.roles"
                          :key="r"
                          :variant="r === 'admin' ? 'default' : 'secondary'"
                          class="text-xs"
                        >
                          {{ normalizeDisplayRole(r) }}
                        </Badge>
                        <span v-if="u.roles.length === 0" class="text-xs text-muted-foreground italic">
                          no roles
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div class="flex gap-2 flex-wrap items-center">
                        <Badge v-for="d in (u.departments || [])" :key="d.id" variant="outline" class="text-xs">
                          {{ d.name }}
                        </Badge>
                        <span v-if="!u.departments || u.departments.length === 0" class="text-xs text-muted-foreground italic">none</span>
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
                      <div class="flex items-center justify-end gap-2 flex-wrap">
                        <Button variant="ghost" size="sm" @click="openEditAccess(u)">
                          Edit access
                        </Button>
                        <Button variant="ghost" size="sm" @click="sendPasswordReset(u)">
                          Send reset
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

        <!-- ════════════ DEPARTMENTS TAB ════════════ -->
        <TabsContent value="departments" class="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Create Department</CardTitle>
              <CardDescription>Add a team or business unit. Users can belong to many; agents deploy to one.</CardDescription>
            </CardHeader>
            <CardContent>
              <form @submit.prevent="createDepartment" class="flex gap-3 items-end flex-wrap">
                <div class="space-y-2 w-48">
                  <Label for="dept-name">Name</Label>
                  <Input id="dept-name" v-model="newDeptName" placeholder="e.g. Solar Ops" maxlength="60" />
                </div>
                <div class="space-y-2 flex-1 min-w-[200px]">
                  <Label for="dept-desc">Description</Label>
                  <Input id="dept-desc" v-model="newDeptDesc" placeholder="What does this dept own?" />
                </div>
                <Button type="submit" :disabled="!newDeptName.trim()">Create</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All Departments</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead class="text-right">Members</TableHead>
                    <TableHead class="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="d in departments" :key="d.id">
                    <TableCell class="font-medium">{{ d.name }}</TableCell>
                    <TableCell class="text-xs text-muted-foreground">{{ d.description || '—' }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ d.user_count || 0 }}</TableCell>
                    <TableCell class="text-right">
                      <Button variant="ghost" size="sm" @click="deleteDepartment(d)">Delete</Button>
                    </TableCell>
                  </TableRow>
                  <TableRow v-if="departments.length === 0">
                    <TableCell colspan="4" class="text-center text-muted-foreground py-6">No departments yet.</TableCell>
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

        <!-- ════════════ FEEDBACK TAB ════════════ -->
        <TabsContent value="feedback" class="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>App Feedback Queue</CardTitle>
              <CardDescription>
                Everything submitted through the floating Feedback button. Triage to triaged → in_build → shipped,
                or dismiss. Chat with Claude to turn triaged items into build proposals.
              </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4">
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="s in ['new','triaged','in_build','shipped','dismissed','all']" :key="s"
                  class="inline-flex items-center gap-1.5 rounded-md border px-2.5 h-7 text-[11px] font-medium transition-colors capitalize"
                  :class="feedbackFilter === s ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
                  @click="feedbackFilter = s; loadFeedback()"
                >
                  {{ s.replace('_',' ') }}
                  <span v-if="s !== 'all' && feedbackCounts[s]" class="text-[10px] opacity-70">{{ feedbackCounts[s] }}</span>
                </button>
              </div>

              <div v-if="feedbackRows.length === 0" class="text-sm text-muted-foreground py-6 text-center">
                No feedback in this bucket.
              </div>

              <div v-else class="space-y-2">
                <div v-for="r in feedbackRows" :key="r.id" class="rounded-lg border bg-card p-3 space-y-2">
                  <div class="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                    <span class="font-mono bg-muted px-1.5 py-0.5 rounded">{{ r.path }}</span>
                    <span v-if="r.category" class="capitalize px-1.5 py-0.5 rounded bg-muted">{{ r.category }}</span>
                    <span>{{ r.user_name || r.user_email || `user ${r.user_id}` }}</span>
                    <span>·</span>
                    <span>{{ fmtFeedbackTime(r.created_at) }}</span>
                    <span class="ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
                      :class="r.status === 'new' ? 'bg-blue-100 text-blue-700'
                        : r.status === 'triaged' ? 'bg-amber-100 text-amber-700'
                        : r.status === 'in_build' ? 'bg-violet-100 text-violet-700'
                        : r.status === 'shipped' ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-muted text-muted-foreground'">
                      {{ r.status.replace('_',' ') }}
                    </span>
                  </div>
                  <p class="text-sm whitespace-pre-wrap">{{ r.body }}</p>
                  <div class="flex gap-1.5 flex-wrap pt-1">
                    <Button v-if="r.status !== 'triaged'"    size="sm" variant="outline" @click="setFeedbackStatus(r.id, 'triaged')">Triaged</Button>
                    <Button v-if="r.status !== 'in_build'"   size="sm" variant="outline" @click="setFeedbackStatus(r.id, 'in_build')">In Build</Button>
                    <Button v-if="r.status !== 'shipped'"    size="sm" variant="outline" @click="setFeedbackStatus(r.id, 'shipped')">Shipped</Button>
                    <Button v-if="r.status !== 'dismissed'"  size="sm" variant="outline" @click="setFeedbackStatus(r.id, 'dismissed')">Dismiss</Button>
                    <Button v-if="r.status !== 'new'"        size="sm" variant="ghost"   @click="setFeedbackStatus(r.id, 'new')">Reopen</Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ════════════ AGENT REVIEW TAB ════════════ -->
        <TabsContent value="agent-review" class="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>User Agent Review</CardTitle>
              <CardDescription>
                Submitted agents awaiting approval. Approving promotes the agent from the ollama-free tier
                (per-user cap) to the company tier (higher cap, shared company Ollama key).
              </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4">
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="s in ['submitted','approved','paused','retired','draft','all']" :key="s"
                  class="inline-flex items-center gap-1.5 rounded-md border px-2.5 h-7 text-[11px] font-medium transition-colors capitalize"
                  :class="agentFilter === s ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
                  @click="agentFilter = s; loadUserAgents()"
                >
                  {{ s }}
                  <span v-if="s !== 'all' && agentCounts[s]" class="text-[10px] opacity-70">{{ agentCounts[s] }}</span>
                </button>
              </div>

              <div v-if="agentRows.length === 0" class="text-sm text-muted-foreground py-6 text-center">
                No agents in this bucket.
              </div>

              <div v-else class="space-y-2">
                <div v-for="a in agentRows" :key="a.id" class="rounded-lg border bg-card p-3 space-y-2">
                  <div class="flex items-baseline gap-2 flex-wrap">
                    <p class="font-semibold">{{ a.name }}</p>
                    <span class="text-[11px] text-muted-foreground">by {{ a.owner_name || a.owner_email }}</span>
                    <span v-if="a.department" class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{{ a.department }}</span>
                    <span class="text-[10px] font-mono text-muted-foreground ml-auto">{{ a.llm }}</span>
                    <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
                      :class="a.status === 'submitted' ? 'bg-amber-100 text-amber-700'
                        : a.status === 'approved' ? 'bg-emerald-100 text-emerald-700'
                        : a.status === 'paused' ? 'bg-violet-100 text-violet-700'
                        : a.status === 'retired' ? 'bg-muted text-muted-foreground'
                        : 'bg-blue-100 text-blue-700'">
                      {{ a.status }}
                    </span>
                  </div>
                  <p class="text-sm whitespace-pre-wrap">{{ a.objective }}</p>
                  <p v-if="a.submission_note" class="text-[11px] text-muted-foreground italic">Note: {{ a.submission_note }}</p>
                  <p class="text-[10px] text-muted-foreground">
                    Tier: <span class="font-semibold">{{ a.tier }}</span> · Cap: {{ a.monthly_token_cap.toLocaleString() }} tok/mo · Used: {{ a.tokens_used_month.toLocaleString() }}
                  </p>
                  <div v-if="a.status === 'submitted'" class="flex gap-1.5 pt-1">
                    <Button size="sm" @click="approveAgent(a.id)">Approve → Company</Button>
                    <Button size="sm" variant="outline" @click="rejectAgent(a.id)">Reject → Draft</Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ════════════ QB SYNC TAB ════════════ -->
        <TabsContent value="qb-sync" class="grid gap-6">
          <!-- Data Caches -->
          <Card>
            <CardHeader>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <CardTitle>Data Caches</CardTitle>
                  <CardDescription>
                    Local SQLite mirrors of QuickBase data that power each dashboard.
                    Sync each cache individually, or refresh all at once.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="cachesLoading || Object.values(cacheBusy).some(Boolean)"
                  @click="refreshAllCaches"
                >
                  {{ Object.values(cacheBusy).some(Boolean) ? 'Syncing…' : 'Sync All' }}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dataset</TableHead>
                    <TableHead>Table</TableHead>
                    <TableHead class="text-right">Records</TableHead>
                    <TableHead>Last sync</TableHead>
                    <TableHead class="w-24"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="c in caches" :key="c.key">
                    <TableCell>
                      <p class="font-medium">{{ c.label }}</p>
                      <p class="text-xs text-muted-foreground">{{ c.description }}</p>
                      <p v-if="cacheError[c.key]" class="text-xs text-red-600 mt-1">{{ cacheError[c.key] }}</p>
                    </TableCell>
                    <TableCell class="font-mono text-xs text-muted-foreground">{{ c.table }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ c.total.toLocaleString() }}</TableCell>
                    <TableCell class="text-xs text-muted-foreground">{{ fmtCacheTime(c.last_refresh) }}</TableCell>
                    <TableCell class="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        :disabled="!!cacheBusy[c.key]"
                        @click="refreshDataCache(c)"
                      >
                        {{ cacheBusy[c.key] ? '…' : 'Sync' }}
                      </Button>
                    </TableCell>
                  </TableRow>
                  <TableRow v-if="caches.length === 0 && !cachesLoading">
                    <TableCell colspan="5" class="text-center text-muted-foreground py-6">No caches registered.</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <!-- Dialpad Integration -->
          <Card>
            <CardHeader>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <CardTitle>Dialpad</CardTitle>
                  <CardDescription>
                    Call analytics for the PC Dashboard. One org-wide API key; calls are pulled via the Dialpad Stats API.
                  </CardDescription>
                </div>
                <Badge v-if="dialpad?.connected" variant="secondary" class="shrink-0">Connected</Badge>
                <Badge v-else variant="outline" class="shrink-0">Not connected</Badge>
              </div>
            </CardHeader>
            <CardContent class="grid gap-4">
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="space-y-1.5">
                  <Label for="dp-key">API Key</Label>
                  <Input id="dp-key" type="password" v-model="dialpadApiKey"
                    :placeholder="dialpad?.key_preview ? `Current: ${dialpad.key_preview}` : 'Paste Dialpad API key'" />
                </div>
                <div class="space-y-1.5">
                  <Label for="dp-office">Office ID (optional)</Label>
                  <Input id="dp-office" v-model="dialpadOfficeId" placeholder="Numeric office_id for scoping" />
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" :disabled="dialpadBusy || (!dialpadApiKey.trim() && dialpadOfficeId === (dialpad?.office_id || ''))" @click="saveDialpad">
                  {{ dialpadBusy ? 'Saving…' : 'Save' }}
                </Button>
                <Button size="sm" variant="outline" :disabled="dialpadBusy || !dialpad?.connected" @click="testDialpad">
                  Test connection
                </Button>
                <Button size="sm" variant="ghost" :disabled="dialpadBusy || !dialpad?.connected" @click="clearDialpadKey">
                  Remove key
                </Button>
                <span v-if="dialpad?.last_tested_at" class="text-xs text-muted-foreground ml-auto">
                  Last test:
                  <span :class="dialpad.last_test_ok ? 'text-emerald-600' : 'text-red-600'">
                    {{ dialpad.last_test_ok ? 'OK' : 'failed' }}
                  </span>
                  · {{ fmtCacheTime(dialpad.last_tested_at) }}
                </span>
              </div>
              <div v-if="dialpadTestResult" class="text-xs" :class="dialpadTestResult.ok ? 'text-emerald-700' : 'text-red-600'">
                {{ dialpadTestResult.ok ? 'Connection OK.' : `Failed: ${dialpadTestResult.error || 'unknown error'}` }}
              </div>
              <div v-if="dialpad?.last_test_error && !dialpadTestResult" class="text-xs text-red-600">
                Last error: {{ dialpad.last_test_error }}
              </div>
              <p class="text-xs text-muted-foreground">
                After saving, sync <span class="font-medium">Dialpad Calls</span> in the Data Caches table above to pull the last 7 days of per-user call records.
              </p>
            </CardContent>
          </Card>

          <!-- Dialpad Webhooks (live events) -->
          <Card>
            <CardHeader>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <CardTitle>Dialpad Webhooks</CardTitle>
                  <CardDescription>
                    Live call + SMS events pushed from Dialpad into the Comms Hub. Paste the URL + secret into a Dialpad subscription (Settings → Developer → Webhooks) to activate.
                  </CardDescription>
                </div>
                <Badge v-if="webhookConfig?.configured" variant="secondary" class="shrink-0">Signed</Badge>
                <Badge v-else variant="outline" class="shrink-0">Not configured</Badge>
              </div>
            </CardHeader>
            <CardContent class="grid gap-4">
              <!-- URLs -->
              <div class="grid gap-1.5">
                <Label class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Webhook URLs</Label>
                <div v-for="(url, kind) in (webhookConfig?.webhook_urls || {})" :key="kind"
                  class="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs"
                >
                  <span class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground w-12 shrink-0">{{ kind }}</span>
                  <span class="font-mono truncate flex-1 min-w-0">{{ url }}</span>
                  <button class="text-[10px] text-muted-foreground hover:text-foreground shrink-0" @click="copyText(url, `url-${kind}`)">
                    {{ webhookCopied === `url-${kind}` ? 'Copied!' : 'Copy' }}
                  </button>
                </div>
              </div>

              <!-- One-time secret display after rotation -->
              <div v-if="newWebhookSecret" class="rounded-lg border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-3 space-y-2">
                <p class="text-xs font-medium text-amber-900 dark:text-amber-200">Save this secret now — it won't be shown again.</p>
                <div class="flex items-center gap-2 rounded-md bg-background px-2.5 py-1.5 text-xs">
                  <span class="font-mono truncate flex-1 min-w-0">{{ newWebhookSecret }}</span>
                  <button class="text-[10px] text-muted-foreground hover:text-foreground shrink-0" @click="copyText(newWebhookSecret, 'secret')">
                    {{ webhookCopied === 'secret' ? 'Copied!' : 'Copy' }}
                  </button>
                </div>
                <button class="text-[10px] text-muted-foreground hover:text-foreground" @click="newWebhookSecret = ''">Dismiss</button>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" :disabled="webhookBusy" @click="rotateWebhookSecret">
                  {{ webhookBusy ? '…' : (webhookConfig?.configured ? 'Rotate secret' : 'Generate secret') }}
                </Button>
                <Button size="sm" variant="ghost" :disabled="webhookBusy || !webhookConfig?.configured" @click="clearWebhookSecret">
                  Remove secret
                </Button>
                <span v-if="webhookConfig?.configured && webhookConfig.secret_preview" class="text-xs text-muted-foreground ml-auto">
                  Current: <span class="font-mono">{{ webhookConfig.secret_preview }}</span>
                </span>
              </div>

              <!-- https check: Dialpad rejects http URLs -->
              <div v-if="webhookConfig && webhookConfig.is_https === false" class="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-3 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                <p class="font-medium">Webhook URLs are being derived as <span class="font-mono">http://</span> — Dialpad requires <span class="font-mono">https</span>.</p>
                <p>On Railway, set <span class="font-mono">PUBLIC_BASE_URL</span> to your public origin (e.g. <span class="font-mono">https://qb-spa.up.railway.app</span>) and redeploy. Express now honors <span class="font-mono">X-Forwarded-Proto</span> too, so most Railway configs will auto-resolve.</p>
              </div>

              <!-- Activate: calls Dialpad's subscription API for us -->
              <div class="rounded-lg border bg-muted/20 p-3 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="min-w-0">
                    <p class="text-sm font-medium">Activation</p>
                    <p class="text-xs text-muted-foreground">
                      <template v-if="subStatus?.subscribed">
                        Subscribed ·
                        <span v-if="subStatus.call_subscription_id">call <span class="font-mono text-[10px]">{{ subStatus.call_subscription_id }}</span></span>
                        <span v-if="subStatus.sms_subscription_id"> · sms <span class="font-mono text-[10px]">{{ subStatus.sms_subscription_id }}</span></span>
                      </template>
                      <template v-else>Register a subscription with Dialpad so events start flowing.</template>
                    </p>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <Button v-if="!subStatus?.subscribed" size="sm" :disabled="subBusy || !webhookConfig?.configured" @click="activateSubscription">
                      {{ subBusy ? 'Activating…' : 'Activate' }}
                    </Button>
                    <Button v-else size="sm" variant="outline" :disabled="subBusy" @click="deactivateSubscription">
                      {{ subBusy ? '…' : 'Deactivate' }}
                    </Button>
                  </div>
                </div>
                <p v-if="subResult" class="text-xs" :class="subResult.startsWith('Failed') ? 'text-red-600' : 'text-emerald-700'">{{ subResult }}</p>
                <p v-if="!webhookConfig?.configured" class="text-[10px] text-muted-foreground">Generate a secret above before activating.</p>

                <!-- Sub-level statuses with retry for SMS -->
                <div v-if="subStatus?.subscribed" class="grid gap-1.5">
                  <div class="flex items-center gap-2 text-xs flex-wrap">
                    <span class="text-muted-foreground w-12 shrink-0">Call</span>
                    <span v-if="subStatus.call_subscription_id" class="font-mono text-[10px] truncate">{{ subStatus.call_subscription_id }}</span>
                    <span v-else class="text-red-600 text-[10px]">not active</span>
                    <span v-if="subStatus.call_subscription_error" class="text-[10px] text-red-600 truncate">· {{ subStatus.call_subscription_error }}</span>
                  </div>
                  <div class="flex items-center gap-2 text-xs flex-wrap">
                    <span class="text-muted-foreground w-12 shrink-0">SMS</span>
                    <span v-if="subStatus.sms_subscription_id" class="font-mono text-[10px] truncate">{{ subStatus.sms_subscription_id }}</span>
                    <span v-else class="text-amber-600 text-[10px]">not active</span>
                    <span v-if="subStatus.sms_subscription_error" class="text-[10px] text-red-600 min-w-0 flex-1 truncate" :title="subStatus.sms_subscription_error">· {{ subStatus.sms_subscription_error }}</span>
                    <button v-if="!subStatus.sms_subscription_id" class="text-[10px] text-primary hover:underline shrink-0 ml-auto" :disabled="subBusy" @click="retrySms">Retry SMS</button>
                  </div>
                  <div class="flex items-center gap-2 flex-wrap">
                    <button class="text-[10px] text-muted-foreground hover:text-foreground" :disabled="subBusy" @click="probeSubscription">Probe Dialpad status</button>
                    <button class="text-[10px] text-muted-foreground hover:text-foreground" :disabled="deliveriesBusy" @click="loadWebhookDeliveries">
                      {{ deliveriesBusy ? 'Loading…' : 'Recent deliveries' }}
                    </button>
                  </div>
                  <pre v-if="probeResult" class="text-[9px] leading-snug bg-muted/40 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-48">{{ probeResult }}</pre>

                  <!-- Delivery log table — condensed columns so it's scannable
                       on mobile. status_code + signature_ok tell the story. -->
                  <div v-if="deliveries.length > 0" class="rounded-md border bg-background">
                    <div class="divide-y max-h-64 overflow-y-auto">
                      <div v-for="d in deliveries" :key="d.id" class="px-2 py-1.5 flex items-start gap-2 text-[10px]">
                        <span class="font-mono tabular-nums text-muted-foreground shrink-0 w-10 text-right">{{ d.status_code }}</span>
                        <span class="shrink-0 w-14 truncate">
                          <span v-if="d.signature_ok === 1" class="text-emerald-600">sig ok</span>
                          <span v-else-if="d.signature_ok === 0" class="text-red-600">sig bad</span>
                          <span v-else class="text-muted-foreground">no sig</span>
                        </span>
                        <span class="shrink-0 w-14 truncate text-muted-foreground">{{ d.inferred_kind || '—' }}</span>
                        <div class="flex-1 min-w-0">
                          <p class="truncate"><span class="font-mono text-muted-foreground">{{ d.path }}</span></p>
                          <p v-if="d.error" class="text-red-600 truncate">{{ d.error }}</p>
                          <p v-else-if="d.body_preview" class="text-muted-foreground truncate">{{ d.body_preview }}</p>
                        </div>
                        <span class="shrink-0 text-muted-foreground tabular-nums">{{ fmtCacheTime(d.received_at) }}</span>
                      </div>
                    </div>
                  </div>
                  <p v-else-if="!deliveriesBusy && deliveries.length === 0" class="text-[10px] text-muted-foreground">Hit "Recent deliveries" to see the last 50 POSTs that reached our webhook endpoint.</p>
                </div>
              </div>

              <p class="text-xs text-muted-foreground">
                Activation creates a signed subscription in Dialpad pointing at <span class="font-mono">{{ subStatus?.webhook_url || '/api/webhooks/dialpad' }}</span>.
                If it fails, register manually via Dialpad's Developer Settings using the URLs + secret above (Dialpad signs each event as an HS256 JWT we verify on receipt).
              </p>

              <!-- Dev mirror — let local development see prod events without touching subscriptions -->
              <div class="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/10 p-3 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <div>
                    <p class="text-sm font-medium">Dev mirror token</p>
                    <p class="text-xs text-muted-foreground">Paste into a local <span class="font-mono">.env</span> so local dev sees prod webhook events in the Comms Hub.</p>
                  </div>
                  <Button size="sm" variant="outline" :disabled="mirrorBusy" @click="generateMirrorToken">
                    {{ mirrorBusy ? '…' : 'Generate token' }}
                  </Button>
                </div>
                <div v-if="mirrorToken" class="space-y-1.5">
                  <div class="rounded-md bg-background border px-2.5 py-1.5 text-[11px] font-mono break-all">DIALPAD_MIRROR_URL={{ mirrorUrl }}</div>
                  <div class="rounded-md bg-background border px-2.5 py-1.5 text-[11px] font-mono break-all">DIALPAD_MIRROR_TOKEN={{ mirrorToken }}</div>
                  <div class="flex items-center gap-2">
                    <button class="text-[10px] text-muted-foreground hover:text-foreground" @click="copyText(`DIALPAD_MIRROR_URL=${mirrorUrl}\nDIALPAD_MIRROR_TOKEN=${mirrorToken}`, 'mirror')">
                      {{ webhookCopied === 'mirror' ? 'Copied!' : 'Copy both' }}
                    </button>
                    <span class="text-[10px] text-muted-foreground">30-day expiry · restart local server after pasting</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

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

    <!-- Edit Access Dialog -->
    <Dialog v-model:open="accessDialog">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit access</DialogTitle>
          <DialogDescription v-if="accessUser">
            {{ accessUser.name }} &mdash; {{ accessUser.email }}
          </DialogDescription>
        </DialogHeader>

        <div class="grid gap-5 py-2">
          <p v-if="accessError" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {{ accessError }}
          </p>

          <div class="space-y-2">
            <Label for="access-role">Business role</Label>
            <select
              id="access-role"
              v-model="accessRole"
              class="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option v-for="roleName in basicRoleOptions" :key="roleName" :value="roleName">
                {{ roleName }}
              </option>
            </select>
          </div>

          <label class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
            <input
              type="checkbox"
              class="mt-1 h-4 w-4"
              :checked="accessKeepAdmin"
              @change="accessKeepAdmin = ($event.target as HTMLInputElement).checked"
            />
            <span class="grid gap-0.5">
              <span class="text-sm font-medium leading-none">Admin access</span>
              <span class="text-xs text-muted-foreground">Allows this user to manage users, roles, departments, and permissions.</span>
            </span>
          </label>

          <div class="space-y-3">
            <Label>Departments</Label>
            <div class="grid gap-2 max-h-[42vh] overflow-y-auto pr-1">
              <label
                v-for="d in departments"
                :key="d.id"
                class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
                :class="accessDeptIds.has(Number(d.id)) ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'"
              >
                <input
                  type="checkbox"
                  class="mt-1 h-4 w-4"
                  :checked="accessDeptIds.has(Number(d.id))"
                  @change="setAccessDepartment(Number(d.id), ($event.target as HTMLInputElement).checked)"
                />
                <span class="grid gap-0.5">
                  <span class="text-sm font-medium leading-none">{{ d.name }}</span>
                  <span class="text-xs text-muted-foreground">{{ d.description || 'No description' }}</span>
                </span>
              </label>
              <p v-if="departments.length === 0" class="text-sm text-muted-foreground py-4 text-center">
                No departments yet. Create departments before assigning them.
              </p>
            </div>
          </div>

          <!-- Alternate emails (cross-system matching) -->
          <div class="space-y-2">
            <Label>Alternate emails</Label>
            <p class="text-xs text-muted-foreground">
              Extra email addresses used to match this user across systems (Dialpad, QuickBase, Slack). Not used for login.
              Pick <span class="font-medium">Any system</span> to match everywhere, or scope to a specific integration.
            </p>

            <div v-if="altEmails.length > 0" class="grid gap-1">
              <div v-for="e in altEmails" :key="e.id"
                class="rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <span class="font-mono truncate flex-1 min-w-0">{{ e.email }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-card border font-medium shrink-0">{{ systemLabel(e.system) }}</span>
                  <button class="text-muted-foreground hover:text-destructive shrink-0" title="Remove" @click="removeAltEmail(e.id)">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                  </button>
                </div>
                <p v-if="e.label" class="text-[10px] text-muted-foreground truncate mt-0.5">{{ e.label }}</p>
              </div>
            </div>

            <div class="grid gap-2 sm:grid-cols-[1fr_auto_auto] rounded-lg border p-3 bg-card">
              <Input v-model="altEmailInput" placeholder="alt@example.com" type="email" class="h-8 text-xs" />
              <select v-model="altSystemInput" class="h-8 rounded-md border bg-background px-2 text-xs">
                <option v-for="opt in SYSTEM_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
              <Button size="sm" :disabled="altEmailBusy || !altEmailInput.trim()" @click="addAltEmail">
                {{ altEmailBusy ? '…' : 'Add' }}
              </Button>
              <Input v-model="altLabelInput" placeholder="Optional note (e.g., 'old work email')" class="h-8 text-xs sm:col-span-3" />
            </div>
            <p v-if="altEmailError" class="text-xs text-destructive">{{ altEmailError }}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="accessDialog = false">Cancel</Button>
          <Button :disabled="accessSaving" @click="saveUserAccess">{{ accessSaving ? 'Saving...' : 'Save access' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Password Reset Link Dialog -->
    <Dialog v-model:open="resetDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Password reset link</DialogTitle>
          <DialogDescription v-if="resetResult">
            Share this link with <span class="font-medium text-foreground">{{ resetResult.email }}</span>.
            They'll pick a new password and be signed in automatically.
          </DialogDescription>
        </DialogHeader>
        <div v-if="resetResult" class="grid gap-3 py-2">
          <div class="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all select-all">
            {{ resetResult.url }}
          </div>
          <p class="text-[11px] text-muted-foreground">
            Expires {{ new Date(resetResult.expires_at).toLocaleString() }}.
            Sending a new link invalidates this one.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="resetDialog = false">Close</Button>
          <Button @click="copyResetLink">{{ resetCopied ? 'Copied ✓' : 'Copy link' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  </div>
</template>
