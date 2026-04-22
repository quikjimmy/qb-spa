<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const message = ref('')
const suggestions = ref<string[]>([])
const tasks = ref<Array<Record<string, unknown>>>([])
const ari = ref<Record<string, unknown> | null>(null)
const running = ref(false)
const result = ref<Record<string, unknown> | null>(null)

async function load() {
  const res = await fetch('/api/agent-org/ari/workspace', { headers: hdrs() })
  if (res.ok) {
    const data = await res.json()
    ari.value = data.ari || null
    suggestions.value = data.suggestions || []
    tasks.value = data.tasks || []
  }
}

async function submit() {
  if (!message.value.trim()) return
  running.value = true
  try {
    const res = await fetch('/api/agent-org/ari/route', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ message: message.value }),
    })
    result.value = await res.json()
  } finally { running.value = false }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>{{ ari?.name || 'Ari' }}</CardTitle>
        <CardDescription>{{ ari?.objective || 'Production front door for Project Coordinators workflows.' }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="flex flex-wrap gap-2">
          <Button v-for="item in suggestions" :key="item" type="button" variant="outline" size="sm" class="h-7 text-[11px]" @click="message = item">
            {{ item }}
          </Button>
        </div>
        <textarea
          v-model="message"
          class="min-h-[120px] w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Ask Ari for help with a Project Coordinator workflow."
        />
        <div class="flex items-center gap-2">
          <Button class="h-8 text-xs" :disabled="running || !message.trim()" @click="submit">
            {{ running ? 'Routing...' : 'Route Request' }}
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Approved Worker Patterns</CardTitle>
        <CardDescription>Ari can only route to approved production tasks.</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-2">
        <div v-for="task in tasks" :key="String(task.id)" class="rounded-lg border px-3 py-2">
          <p class="text-sm font-medium">{{ task.role_name }} · {{ task.name }}</p>
          <p class="text-[11px] text-muted-foreground capitalize">{{ task.task_type }}</p>
        </div>
      </CardContent>
    </Card>

    <Card v-if="result">
      <CardHeader>
        <CardTitle>Latest Routing Result</CardTitle>
      </CardHeader>
      <CardContent>
        <pre class="whitespace-pre-wrap break-words text-xs">{{ JSON.stringify(result, null, 2) }}</pre>
      </CardContent>
    </Card>
  </div>
</template>

