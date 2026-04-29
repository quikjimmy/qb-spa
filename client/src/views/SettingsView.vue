<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

type ProviderId = 'ollama' | 'anthropic' | 'openai'

interface ProviderKey {
  id: number
  provider: ProviderId
  label: string | null
  base_url: string | null
  is_default: boolean
  key_preview: string | null
  last_tested_at: string | null
  last_test_ok: boolean | null
  last_test_error: string | null
  last_test_models_count: number | null
  created_at: string
  updated_at: string
}

interface ProvidersResponse {
  providers: ProviderId[]
  keys: Record<ProviderId, ProviderKey[]>
}

const PROVIDER_META: Record<ProviderId, { label: string; description: string; defaultBaseUrl: string; needsBaseUrl: boolean }> = {
  ollama: {
    label: 'Ollama',
    description: 'Free tier available at ollama.com — sign up, generate an API key, paste it here.',
    defaultBaseUrl: 'https://ollama.com',
    needsBaseUrl: true,
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    description: 'Get a key at console.anthropic.com. You only pay for what you use.',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsBaseUrl: false,
  },
  openai: {
    label: 'OpenAI',
    description: 'Get a key at platform.openai.com/api-keys. You only pay for what you use.',
    defaultBaseUrl: 'https://api.openai.com',
    needsBaseUrl: false,
  },
}

const providers = ref<ProvidersResponse | null>(null)
const addingFor = ref<ProviderId | null>(null)
const draftKey = ref('')
const draftLabel = ref('')
const draftBaseUrl = ref('')
const addBusy = ref(false)
const addError = ref('')
const testingKeyId = ref<number | null>(null)

interface Department { id: number; name: string; description: string }
const myDepartments = ref<Department[]>([])

interface UsageSummary {
  month_to_date_cents: number
  counted_against_cap_cents: number
  cap_cents: number | null
  byok_bypasses_cap: boolean
  tokens_in: number
  tokens_out: number
  calls: number
  breakdown: {
    agent_runs_cents: number
    chatbot_byok_cents: number
    chatbot_platform_cents: number
    by_provider: Array<{ provider: string; cents: number; calls: number }>
  }
}
const usage = ref<UsageSummary | null>(null)

async function loadUsage() {
  const res = await fetch('/api/user-settings/usage', { headers: hdrs() })
  if (res.ok) usage.value = await res.json()
}

function fmtCents(c: number | null | undefined): string {
  if (c == null) return '—'
  return `$${(c / 100).toFixed(2)}`
}

const usagePct = computed(() => {
  if (!usage.value || !usage.value.cap_cents || usage.value.cap_cents <= 0) return null
  return Math.min(100, Math.round((usage.value.counted_against_cap_cents / usage.value.cap_cents) * 100))
})

const usageBarClass = computed(() => {
  if (usagePct.value == null) return 'bg-muted-foreground/30'
  if (usagePct.value >= 90) return 'bg-amber-500'
  if (usagePct.value >= 70) return 'bg-amber-400'
  return 'bg-emerald-500'
})

async function loadProviders() {
  const res = await fetch('/api/user-settings/providers', { headers: hdrs() })
  if (res.ok) providers.value = await res.json()
}

function startAdd(p: ProviderId) {
  addingFor.value = p
  draftKey.value = ''
  draftLabel.value = ''
  draftBaseUrl.value = PROVIDER_META[p].needsBaseUrl ? PROVIDER_META[p].defaultBaseUrl : ''
  addError.value = ''
}

function cancelAdd() {
  addingFor.value = null
  draftKey.value = ''
  draftLabel.value = ''
  draftBaseUrl.value = ''
  addError.value = ''
}

async function submitAdd() {
  if (!addingFor.value) return
  const provider = addingFor.value
  addBusy.value = true
  addError.value = ''
  try {
    const body: Record<string, unknown> = { api_key: draftKey.value.trim() }
    if (draftLabel.value.trim()) body.label = draftLabel.value.trim()
    if (PROVIDER_META[provider].needsBaseUrl && draftBaseUrl.value.trim()) body.base_url = draftBaseUrl.value.trim()
    const res = await fetch(`/api/user-settings/providers/${provider}/keys`, {
      method: 'POST', headers: hdrs(), body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { addError.value = data.error || `HTTP ${res.status}`; return }
    cancelAdd()
    await loadProviders()
  } finally { addBusy.value = false }
}

async function deleteKey(key: ProviderKey) {
  const name = key.label || PROVIDER_META[key.provider].label + ' key'
  if (!window.confirm(`Delete "${name}"?`)) return
  const res = await fetch(`/api/user-settings/providers/keys/${key.id}`, { method: 'DELETE', headers: hdrs() })
  if (res.ok) await loadProviders()
}

async function makeDefault(key: ProviderKey) {
  const res = await fetch(`/api/user-settings/providers/keys/${key.id}`, {
    method: 'PATCH', headers: hdrs(), body: JSON.stringify({ make_default: true }),
  })
  if (res.ok) await loadProviders()
}

async function testKey(key: ProviderKey) {
  testingKeyId.value = key.id
  try {
    await fetch(`/api/user-settings/providers/keys/${key.id}/test`, { method: 'POST', headers: hdrs() })
    await loadProviders()
  } finally { testingKeyId.value = null }
}

function statusBadge(key: ProviderKey): { label: string; cls: string } {
  if (key.last_test_ok === true) return { label: 'Connected', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' }
  if (key.last_test_ok === false) return { label: 'Last test failed', cls: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' }
  return { label: 'Untested', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' }
}

async function loadDepartments() {
  const res = await fetch('/api/user-settings/my-departments', { headers: hdrs() })
  if (res.ok) myDepartments.value = (await res.json()).departments || []
}

function fmtTime(iso: string | null) {
  if (!iso) return 'Never'
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

onMounted(() => { loadProviders(); loadDepartments(); loadUsage() })
</script>

<template>
  <div class="grid gap-6 max-w-3xl">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
      <p class="text-muted-foreground mt-1">Your AI usage, connections, and department membership.</p>
    </div>

    <!-- LLM usage this month -->
    <Card v-if="usage">
      <CardHeader>
        <div class="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>This month's AI usage</CardTitle>
            <CardDescription>
              Spend attributed to you across agents and in-app AI features. Resets on the 1st.
            </CardDescription>
          </div>
          <div class="text-right">
            <div class="text-2xl font-semibold tabular-nums">{{ fmtCents(usage.month_to_date_cents) }}</div>
            <div class="text-[11px] text-muted-foreground">{{ usage.calls.toLocaleString() }} calls</div>
          </div>
        </div>
      </CardHeader>
      <CardContent class="grid gap-4">
        <!-- Cap progress bar (only if a cap is set) -->
        <div v-if="usage.cap_cents" class="space-y-1.5">
          <div class="flex items-baseline justify-between text-xs">
            <span class="text-muted-foreground">
              {{ fmtCents(usage.counted_against_cap_cents) }} of {{ fmtCents(usage.cap_cents) }} cap
            </span>
            <span class="tabular-nums font-medium">{{ usagePct }}%</span>
          </div>
          <div class="h-1.5 rounded-full bg-muted overflow-hidden">
            <div class="h-full transition-all" :class="usageBarClass" :style="{ width: `${usagePct}%` }"></div>
          </div>
          <p v-if="usage.byok_bypasses_cap" class="text-[11px] text-muted-foreground">
            Calls using your own API key don't count against this cap.
          </p>
        </div>
        <p v-else class="text-xs text-muted-foreground">
          No spend cap set. An admin can set one in your account.
        </p>

        <!-- Breakdown -->
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div class="rounded-lg bg-muted/40 p-3">
            <div class="text-[10px] uppercase tracking-widest text-muted-foreground">Agents</div>
            <div class="text-base font-medium tabular-nums mt-0.5">{{ fmtCents(usage.breakdown.agent_runs_cents) }}</div>
          </div>
          <div class="rounded-lg bg-muted/40 p-3">
            <div class="text-[10px] uppercase tracking-widest text-muted-foreground">In-app (platform)</div>
            <div class="text-base font-medium tabular-nums mt-0.5">{{ fmtCents(usage.breakdown.chatbot_platform_cents) }}</div>
          </div>
          <div class="rounded-lg bg-muted/40 p-3">
            <div class="text-[10px] uppercase tracking-widest text-muted-foreground">In-app (your key)</div>
            <div class="text-base font-medium tabular-nums mt-0.5">{{ fmtCents(usage.breakdown.chatbot_byok_cents) }}</div>
          </div>
        </div>

        <div v-if="usage.breakdown.by_provider.length" class="flex flex-wrap gap-1.5">
          <Badge v-for="p in usage.breakdown.by_provider" :key="p.provider" variant="secondary" class="text-[11px]">
            {{ p.provider }} · {{ fmtCents(p.cents) }} · {{ p.calls }} call{{ p.calls === 1 ? '' : 's' }}
          </Badge>
        </div>
      </CardContent>
    </Card>

    <!-- AI provider keys (multi-provider, multi-key BYOK) -->
    <Card v-for="p in (providers?.providers || [])" :key="p">
      <CardHeader>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>{{ PROVIDER_META[p].label }}</CardTitle>
            <CardDescription>{{ PROVIDER_META[p].description }}</CardDescription>
          </div>
          <Button v-if="addingFor !== p" variant="outline" size="sm" @click="startAdd(p)">+ Add key</Button>
        </div>
      </CardHeader>
      <CardContent class="grid gap-3">
        <!-- Existing keys -->
        <div v-if="(providers?.keys?.[p] || []).length === 0 && addingFor !== p" class="text-sm text-muted-foreground">
          No keys yet.
        </div>

        <div v-for="key in (providers?.keys?.[p] || [])" :key="key.id"
          class="rounded-lg border bg-muted/20 p-3 grid gap-2"
        >
          <div class="flex items-baseline justify-between gap-2 flex-wrap">
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="font-medium text-sm">{{ key.label || 'Unnamed' }}</span>
              <span v-if="key.is_default" class="text-[10px] uppercase tracking-widest font-semibold text-emerald-700 dark:text-emerald-300">Default</span>
              <span class="font-mono text-xs text-muted-foreground truncate">{{ key.key_preview || '—' }}</span>
            </div>
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold" :class="statusBadge(key).cls">
              {{ statusBadge(key).label }}
            </span>
          </div>

          <div v-if="key.base_url" class="text-[11px] text-muted-foreground font-mono truncate">{{ key.base_url }}</div>

          <p v-if="key.last_tested_at" class="text-[11px] text-muted-foreground">
            Tested {{ fmtTime(key.last_tested_at) }}<span v-if="key.last_test_ok && key.last_test_models_count != null"> · {{ key.last_test_models_count }} models</span>
            <span v-else-if="key.last_test_error"> · {{ key.last_test_error }}</span>
          </p>

          <div class="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" :disabled="testingKeyId === key.id" @click="testKey(key)">
              {{ testingKeyId === key.id ? 'Testing…' : 'Test' }}
            </Button>
            <Button v-if="!key.is_default" size="sm" variant="ghost" @click="makeDefault(key)">Set as default</Button>
            <Button size="sm" variant="ghost" class="text-destructive ml-auto" @click="deleteKey(key)">Delete</Button>
          </div>
        </div>

        <!-- Add-key form -->
        <div v-if="addingFor === p" class="rounded-lg border-2 border-dashed bg-card p-3 grid gap-3">
          <div v-if="PROVIDER_META[p].needsBaseUrl" class="space-y-1.5">
            <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">Base URL</Label>
            <Input v-model="draftBaseUrl" :placeholder="PROVIDER_META[p].defaultBaseUrl" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">API Key</Label>
            <Input v-model="draftKey" type="password" autocomplete="new-password" placeholder="sk-..." />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">Label (optional)</Label>
            <Input v-model="draftLabel" placeholder="e.g., personal, work, side-project" />
          </div>
          <div class="flex gap-2 flex-wrap items-center">
            <Button :disabled="addBusy || !draftKey.trim()" @click="submitAdd">
              {{ addBusy ? 'Saving…' : 'Save key' }}
            </Button>
            <Button variant="ghost" :disabled="addBusy" @click="cancelAdd">Cancel</Button>
            <p v-if="addError" class="text-sm text-destructive">{{ addError }}</p>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Departments (read-only) -->
    <Card>
      <CardHeader>
        <CardTitle>Your departments</CardTitle>
        <CardDescription>
          Department membership is managed by an admin. Agents you build can be deployed to departments you belong to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="myDepartments.length === 0" class="text-sm text-muted-foreground">
          You aren't in any departments yet. Ask an admin to add you.
        </div>
        <div v-else class="flex flex-wrap gap-1.5">
          <Badge v-for="d in myDepartments" :key="d.id" variant="secondary" class="text-xs" :title="d.description">
            {{ d.name }}
          </Badge>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
