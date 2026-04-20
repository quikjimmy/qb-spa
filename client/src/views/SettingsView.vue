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

interface OllamaConfig {
  connected: boolean
  base_url: string
  key_preview: string | null
  last_tested_at: string | null
  last_test_ok: boolean | null
  last_test_error: string | null
  last_test_models_count: number | null
}

const ollama = ref<OllamaConfig | null>(null)
const baseUrl = ref('')
const newKey = ref('')
const savingKey = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; models?: string[]; error?: string } | null>(null)

interface Department { id: number; name: string; description: string }
const myDepartments = ref<Department[]>([])

async function loadOllama() {
  const res = await fetch('/api/user-settings/ollama', { headers: hdrs() })
  if (res.ok) {
    ollama.value = await res.json()
    baseUrl.value = ollama.value!.base_url
  }
}

async function saveOllama() {
  savingKey.value = true
  testResult.value = null
  try {
    const body: Record<string, string> = { base_url: baseUrl.value.trim() }
    if (newKey.value.trim()) body.api_key = newKey.value.trim()
    const res = await fetch('/api/user-settings/ollama', {
      method: 'PUT', headers: hdrs(), body: JSON.stringify(body),
    })
    if (res.ok) {
      ollama.value = await res.json()
      newKey.value = ''
    }
  } finally { savingKey.value = false }
}

async function clearKey() {
  if (!window.confirm('Clear your Ollama API key?')) return
  const res = await fetch('/api/user-settings/ollama', { method: 'DELETE', headers: hdrs() })
  if (res.ok) { ollama.value = await res.json() }
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const res = await fetch('/api/user-settings/ollama/test', { method: 'POST', headers: hdrs() })
    const data = await res.json()
    testResult.value = data
    // re-load config so last-tested fields update
    await loadOllama()
  } finally { testing.value = false }
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

const testBadge = computed(() => {
  if (!ollama.value) return null
  if (ollama.value.last_test_ok === true) return { label: 'Connected', cls: 'bg-emerald-100 text-emerald-700' }
  if (ollama.value.last_test_ok === false) return { label: 'Last test failed', cls: 'bg-red-100 text-red-700' }
  if (ollama.value.connected) return { label: 'Key saved, not tested', cls: 'bg-amber-100 text-amber-700' }
  return { label: 'Not configured', cls: 'bg-muted text-muted-foreground' }
})

onMounted(() => { loadOllama(); loadDepartments() })
</script>

<template>
  <div class="grid gap-6 max-w-3xl">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
      <p class="text-muted-foreground mt-1">Your Ollama connection and department membership.</p>
    </div>

    <!-- Ollama connection -->
    <Card>
      <CardHeader>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Ollama connection</CardTitle>
            <CardDescription>
              Your personal Ollama cloud API key powers agents in the <span class="font-semibold">ollama-free</span> tier.
              Approved agents switch to the company key — yours is never shared or used by anyone else.
            </CardDescription>
          </div>
          <span v-if="testBadge" class="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold" :class="testBadge.cls">
            {{ testBadge.label }}
          </span>
        </div>
      </CardHeader>
      <CardContent class="grid gap-4">
        <div class="grid sm:grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">Base URL</Label>
            <Input v-model="baseUrl" placeholder="https://ollama.com" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[10px] uppercase tracking-widest text-muted-foreground">API Key</Label>
            <div class="flex gap-2">
              <Input v-model="newKey" type="password" autocomplete="new-password"
                :placeholder="ollama?.connected ? `Current: ${ollama.key_preview} · enter to replace` : 'Paste your Ollama API key'" />
              <Button v-if="ollama?.connected" type="button" variant="outline" size="icon" :title="'Clear key'" @click="clearKey">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </Button>
            </div>
          </div>
        </div>

        <div class="flex gap-2 flex-wrap">
          <Button :disabled="savingKey" @click="saveOllama">{{ savingKey ? 'Saving…' : 'Save' }}</Button>
          <Button variant="outline" :disabled="!ollama?.connected || testing" @click="testConnection">
            {{ testing ? 'Testing…' : 'Test Connection' }}
          </Button>
        </div>

        <!-- Test result -->
        <div v-if="testResult" class="rounded-md border p-3 text-sm"
          :class="testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300' : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300'">
          <div v-if="testResult.ok" class="space-y-1">
            <p class="font-medium">✓ Connection works.</p>
            <p v-if="testResult.models && testResult.models.length">
              Models visible: <span class="font-mono text-xs">{{ testResult.models.join(', ') }}</span>
            </p>
          </div>
          <div v-else class="space-y-1">
            <p class="font-medium">✗ {{ testResult.error || 'Failed' }}</p>
          </div>
        </div>

        <!-- Last-test meta -->
        <p v-if="ollama?.last_tested_at" class="text-[11px] text-muted-foreground">
          Last tested {{ fmtTime(ollama.last_tested_at) }}.
          <span v-if="ollama.last_test_ok && ollama.last_test_models_count != null">{{ ollama.last_test_models_count }} models visible.</span>
          <span v-else-if="ollama.last_test_error">{{ ollama.last_test_error }}</span>
        </p>
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
