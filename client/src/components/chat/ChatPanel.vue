<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import ProjectStatusBadge from '@/components/project-detail/ProjectStatusBadge.vue'
import ModelPicker from '@/components/chat/ModelPicker.vue'

interface Thread {
  id: number
  title: string
  project_id: number | null
  project_name: string | null
  space_id: number | null
  space_name: string | null
  preferred_provider: string | null
  preferred_model: string | null
  archived: boolean
  created_at: string
  updated_at: string
  last_message_at: string | null
}

interface Message {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  provider: string | null
  model: string | null
  tokens_in: number
  tokens_out: number
  cost_cents: number
  used_own_key: boolean
  error: string | null
  created_at: string
}

interface ProjectHit {
  record_id: number
  customer_name: string | null
  status: string | null
  state: string | null
}

const props = withDefaults(defineProps<{
  threadId: number | null
  defaultSpaceId?: number | null
  allowProjectPicker?: boolean
  // Compact mode trims chrome for embedding in side panels.
  compact?: boolean
}>(), {
  defaultSpaceId: null,
  allowProjectPicker: true,
  compact: false,
})

const emit = defineEmits<{
  (e: 'thread-created', thread: Thread): void
  (e: 'thread-updated', thread: Thread): void
}>()

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

const activeThread = ref<Thread | null>(null)
const messages = ref<Message[]>([])
const composerText = ref('')
const sending = ref(false)
const sendError = ref('')
const messagesScroll = ref<HTMLElement | null>(null)

// Project picker state
const projectPickerOpen = ref(false)
const projectQuery = ref('')
const projectResults = ref<ProjectHit[]>([])
const projectSearching = ref(false)
const projectHighlight = ref(0)
const projectQueryEl = ref<HTMLInputElement | null>(null)
let projectSearchTimer: number | null = null

async function loadThread(id: number) {
  try {
    const res = await fetch(`/api/chat/threads/${id}`, { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      activeThread.value = data.thread
      messages.value = data.messages || []
      await nextTick()
      scrollToBottom()
    }
  } catch { /* ignore */ }
}

watch(() => props.threadId, (id) => {
  if (id == null) {
    activeThread.value = null
    messages.value = []
    return
  }
  // If the parent's threadId now matches what we already have locally
  // (typical after our own attach/send flow created the thread), don't
  // refetch — we already have the freshest state.
  if (activeThread.value && activeThread.value.id === id) return
  loadThread(id)
}, { immediate: true })

async function ensureThreadExists(): Promise<Thread | null> {
  if (activeThread.value) return activeThread.value
  const body: Record<string, unknown> = {}
  if (props.defaultSpaceId != null) body.space_id = props.defaultSpaceId
  const res = await fetch('/api/chat/threads', {
    method: 'POST', headers: hdrs(), body: JSON.stringify(body),
  })
  if (!res.ok) return null
  const t = await res.json() as Thread
  activeThread.value = t
  emit('thread-created', t)
  return t
}

async function sendMessage() {
  if (!composerText.value.trim() || sending.value) return

  const thread = await ensureThreadExists()
  if (!thread) return

  const text = composerText.value.trim()
  const optimisticUser: Message = {
    id: -Date.now(),
    role: 'user',
    content: text,
    provider: null, model: null, tokens_in: 0, tokens_out: 0, cost_cents: 0, used_own_key: false, error: null,
    created_at: new Date().toISOString(),
  }
  messages.value.push(optimisticUser)
  composerText.value = ''
  sendError.value = ''
  sending.value = true
  await nextTick()
  scrollToBottom()

  try {
    const res = await fetch(`/api/chat/threads/${thread.id}/messages`, {
      method: 'POST', headers: hdrs(),
      body: JSON.stringify({ content: text }),
    })
    const data = await res.json()
    messages.value = messages.value.filter(m => m.id !== optimisticUser.id)
    if (data.user_message) messages.value.push(data.user_message)
    if (data.assistant_message) messages.value.push(data.assistant_message)
    if (data.thread) {
      activeThread.value = data.thread
      emit('thread-updated', data.thread)
    }
    if (!data.ok) sendError.value = data.error || 'Send failed'
    await nextTick()
    scrollToBottom()
  } catch (e) {
    sendError.value = e instanceof Error ? e.message : 'Send failed'
    messages.value = messages.value.filter(m => m.id !== optimisticUser.id)
  } finally { sending.value = false }
}

// ─── Slash commands ──────────────────
// Composer text starting with `/` is intercepted as a command. v1: just /model.
// Designed so additional commands (/clear, /system, etc.) drop in as new cases.
const modelPickerOpen = ref(false)

function tryRunSlashCommand(): boolean {
  const raw = composerText.value.trim()
  if (!raw.startsWith('/')) return false
  const [cmd] = raw.split(/\s+/)
  if (cmd === '/model') {
    modelPickerOpen.value = true
    composerText.value = ''
    return true
  }
  return false
}

async function applyModelPick(sel: { provider: 'anthropic' | 'openai' | 'ollama'; model: string }) {
  const thread = await ensureThreadExists()
  if (!thread) return
  const res = await fetch(`/api/chat/threads/${thread.id}`, {
    method: 'PATCH', headers: hdrs(),
    body: JSON.stringify({ preferred_provider: sel.provider, preferred_model: sel.model }),
  })
  if (res.ok) {
    const updated = await res.json() as Thread
    activeThread.value = updated
    emit('thread-updated', updated)
  }
}

function onComposerKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    if (tryRunSlashCommand()) return
    sendMessage()
  }
}

function scrollToBottom() {
  const el = messagesScroll.value
  if (el) el.scrollTop = el.scrollHeight
}

// ─── Project picker ──────────────────
function searchProjects(q: string) {
  if (projectSearchTimer) window.clearTimeout(projectSearchTimer)
  projectSearchTimer = window.setTimeout(async () => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { projectResults.value = []; projectHighlight.value = 0; return }
    projectSearching.value = true
    try {
      const res = await fetch(`/api/chat/projects/search?q=${encodeURIComponent(trimmed)}`, { headers: hdrs() })
      if (res.ok) {
        const data = await res.json()
        projectResults.value = data.projects || []
        projectHighlight.value = 0
      }
    } finally { projectSearching.value = false }
  }, 180)
}

watch(projectQuery, (v) => searchProjects(v))

function openPicker() {
  projectPickerOpen.value = true
  projectQuery.value = ''
  projectResults.value = []
  projectHighlight.value = 0
  nextTick(() => projectQueryEl.value?.focus())
}

function closePicker() {
  projectPickerOpen.value = false
  projectQuery.value = ''
  projectResults.value = []
}

function onPickerKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { closePicker(); return }
  if (!projectResults.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    projectHighlight.value = (projectHighlight.value + 1) % projectResults.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    projectHighlight.value = (projectHighlight.value - 1 + projectResults.value.length) % projectResults.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const pick = projectResults.value[projectHighlight.value]
    if (pick) attachProject(pick)
  }
}

async function attachProject(p: ProjectHit) {
  // Two phases: ensure a thread exists, then PATCH the project onto it.
  // We *defer the parent emit* until after PATCH so the parent doesn't update
  // activeThreadId mid-flow and trigger our own watch to stale-reload the
  // pre-PATCH thread state on top of the about-to-arrive PATCH response.
  const wasNew = !activeThread.value
  let thread = activeThread.value
  if (!thread) {
    const createRes = await fetch('/api/chat/threads', {
      method: 'POST', headers: hdrs(),
      body: props.defaultSpaceId != null
        ? JSON.stringify({ space_id: props.defaultSpaceId })
        : '{}',
    })
    if (!createRes.ok) { closePicker(); return }
    thread = await createRes.json() as Thread
    activeThread.value = thread
  }
  const res = await fetch(`/api/chat/threads/${thread.id}`, {
    method: 'PATCH', headers: hdrs(),
    body: JSON.stringify({ project_id: p.record_id }),
  })
  if (res.ok) {
    const updated = await res.json() as Thread
    activeThread.value = updated
    // Single emit at the end with final state — wasNew distinguishes path.
    emit(wasNew ? 'thread-created' : 'thread-updated', updated)
  }
  closePicker()
}

async function clearProject() {
  if (!activeThread.value) return
  const res = await fetch(`/api/chat/threads/${activeThread.value.id}`, {
    method: 'PATCH', headers: hdrs(),
    body: JSON.stringify({ project_id: null }),
  })
  if (res.ok) {
    const updated = await res.json() as Thread
    activeThread.value = updated
    emit('thread-updated', updated)
  }
}

function fmtCost(cents: number): string {
  if (cents === 0) return ''
  if (cents < 1) return '<$0.01'
  return `$${(cents / 100).toFixed(cents < 10 ? 3 : 2)}`
}

const totalCost = computed(() => messages.value.reduce((sum, m) => sum + (m.cost_cents || 0), 0))

// Suggested prompts: project-aware when a project is attached.
const suggestedPrompts = computed(() => {
  if (activeThread.value?.project_name) {
    return [
      `Summarize where this project is right now.`,
      `What's blocking this project from moving forward?`,
      `Draft a one-sentence customer update I could send.`,
    ]
  }
  return [
    'Summarize the projects on hold and what\'s blocking them.',
    'Which PCs have the most overdue tickets right now?',
    'Help me draft a status update for a customer.',
  ]
})

// Show the project chip only for non-space threads. Spaces have a fixed,
// implicit project context shown by the panel's outer chrome instead.
const showProjectChip = computed(() => !activeThread.value?.space_id)

onMounted(() => {
  if (props.threadId == null) {
    // Empty/new state — nothing to load.
  }
})

// Lets the parent open the model picker (e.g., user clicks the model name in the chat header).
defineExpose({ openModelPicker: () => { modelPickerOpen.value = true } })
</script>

<template>
  <div class="flex flex-col h-full min-h-0 bg-gradient-to-br from-background via-background to-muted/30">
    <!-- Messages scroll region -->
    <div ref="messagesScroll" class="flex-1 overflow-y-auto min-h-0">
      <div :class="compact ? 'px-4 py-4 space-y-4' : 'max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5'">

        <!-- Empty state -->
        <div v-if="!activeThread || messages.length === 0" class="py-10 sm:py-16 text-center space-y-5">
          <div class="inline-flex items-center justify-center size-12 rounded-2xl bg-gradient-to-br from-foreground/10 to-foreground/5">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-foreground/70"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div class="space-y-1.5">
            <h2 class="text-lg font-semibold tracking-tight">
              {{ activeThread?.space_name ? `Chat Bot — ${activeThread.space_name}` : 'How can I help?' }}
            </h2>
            <p class="text-sm text-muted-foreground max-w-md mx-auto">
              <template v-if="activeThread?.space_name">Ask anything about this project — context is already attached.</template>
              <template v-else>Ask anything, or attach a project for context-aware answers grounded in its data.</template>
            </p>
          </div>
          <div class="flex flex-col gap-2 max-w-md mx-auto">
            <button v-for="(p, i) in suggestedPrompts" :key="i"
              @click="composerText = p"
              class="text-left text-sm px-4 py-3 rounded-xl bg-foreground/[0.03] hover:bg-foreground/[0.06] transition-colors text-foreground/80"
            >
              {{ p }}
            </button>
          </div>
        </div>

        <!-- Message thread -->
        <template v-else>
          <div v-for="m in messages" :key="m.id"
            class="flex"
            :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div class="max-w-[85%] sm:max-w-[80%]">
              <div
                class="px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words"
                :class="m.role === 'user'
                  ? 'bg-foreground text-background rounded-br-md'
                  : m.error
                    ? 'bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-bl-md'
                    : 'bg-gradient-to-br from-card to-muted/40 rounded-bl-md'"
              >{{ m.content }}</div>
              <div v-if="m.role === 'assistant' && (m.provider || m.cost_cents > 0)"
                class="mt-1 px-1 text-[10px] text-muted-foreground/70 tabular-nums flex items-center gap-1.5"
              >
                <span v-if="m.provider">{{ m.provider }}{{ m.model ? ` · ${m.model.replace(/^claude-/, '')}` : '' }}</span>
                <span v-if="m.cost_cents > 0">· {{ fmtCost(m.cost_cents) }}</span>
                <span v-if="m.used_own_key" class="text-emerald-600 dark:text-emerald-400">· your key</span>
              </div>
            </div>
          </div>

          <!-- Typing indicator -->
          <div v-if="sending" class="flex justify-start">
            <div class="px-4 py-3 rounded-2xl rounded-bl-md bg-gradient-to-br from-card to-muted/40">
              <div class="flex gap-1.5">
                <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 0ms"></span>
                <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 150ms"></span>
                <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 300ms"></span>
              </div>
            </div>
          </div>
        </template>

        <p v-if="sendError" class="text-xs text-destructive text-center">{{ sendError }}</p>
      </div>
    </div>

    <!-- Composer -->
    <footer class="bg-card/30 backdrop-blur-sm shrink-0">
      <div :class="compact ? 'px-4 pt-3 pb-4' : 'max-w-3xl mx-auto px-4 sm:px-6 pt-3 pb-4 sm:pb-5'">

        <!-- Project context chip / picker trigger (only for general threads) -->
        <div v-if="showProjectChip" class="flex items-center gap-2 mb-2 flex-wrap">
          <button v-if="activeThread?.project_name"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-foreground/[0.06] hover:bg-foreground/[0.1] text-xs font-medium transition-colors group"
            @click="clearProject"
            title="Remove project context"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
            <span class="max-w-[200px] truncate">{{ activeThread.project_name }}</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="ml-0.5 opacity-50 group-hover:opacity-100 transition-opacity"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>

          <button v-else-if="allowProjectPicker"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-muted-foreground hover:bg-foreground/[0.04] transition-colors"
            @click="openPicker"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            Add project context
          </button>
        </div>

        <!-- Slash command hint — only shown when composer starts with `/` -->
        <div v-if="composerText.startsWith('/')" class="mb-1.5 px-2 py-1.5 rounded-lg bg-foreground/[0.04] flex items-center gap-2 text-[11px] text-muted-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="m9 18 6-6-6-6"/></svg>
          <span class="font-mono">/model</span>
          <span>— pick which AI model handles this thread</span>
          <span class="ml-auto"><kbd class="px-1.5 py-0.5 rounded bg-foreground/10 font-mono text-[10px]">↵</kbd> to run</span>
        </div>

        <!-- Composer textarea -->
        <div class="relative rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06] focus-within:ring-foreground/15 transition-shadow">
          <textarea
            v-model="composerText"
            @keydown="onComposerKey"
            :placeholder="activeThread?.space_name
              ? `Ask about ${activeThread.space_name}…`
              : activeThread?.project_name
                ? `Ask about ${activeThread.project_name}…`
                : 'Ask anything…'"
            rows="1"
            class="w-full resize-none bg-transparent px-4 pt-3.5 pb-12 text-sm placeholder:text-muted-foreground/60 focus:outline-none max-h-48"
            :style="{ minHeight: '52px' }"
          />
          <div class="absolute bottom-2 right-2 flex items-center gap-2">
            <button
              @click="sendMessage"
              :disabled="!composerText.trim() || sending"
              class="inline-flex items-center justify-center size-9 rounded-xl transition-all"
              :class="composerText.trim() && !sending
                ? 'bg-foreground text-background hover:opacity-90'
                : 'bg-foreground/10 text-foreground/40 cursor-not-allowed'"
              :title="sending ? 'Sending…' : 'Send'"
            >
              <svg v-if="!sending" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7M12 19V5"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            </button>
          </div>
        </div>
        <p v-if="!compact && totalCost > 0" class="text-[10px] text-muted-foreground/60 mt-1.5 text-center tabular-nums">
          {{ fmtCost(totalCost) }} this thread
        </p>
      </div>
    </footer>

    <!-- Project picker (Teleport so it floats above any container) -->
    <Teleport to="body">
      <div v-if="projectPickerOpen"
        class="fixed inset-0 z-[60] flex items-start sm:items-center justify-center p-3 sm:p-6 pt-[10vh] sm:pt-[12vh] bg-foreground/30 backdrop-blur-md"
        @click.self="closePicker"
        @keydown="onPickerKey"
      >
        <div class="w-full max-w-xl rounded-2xl bg-card shadow-[0_30px_80px_-20px_rgba(0,0,0,0.45)] ring-1 ring-foreground/10 overflow-hidden flex flex-col max-h-[70vh]">
          <div class="px-5 pt-5 pb-1">
            <div class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Attach project</div>
            <p class="text-xs text-muted-foreground/70 mt-0.5">Ground this conversation in a project's data and milestones.</p>
          </div>

          <div class="px-5 pt-3 pb-3">
            <div class="relative">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                ref="projectQueryEl"
                v-model="projectQuery"
                @keydown="onPickerKey"
                placeholder="Search customer name or project ID…"
                class="w-full h-11 rounded-xl bg-foreground/[0.04] pl-10 pr-3 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:bg-foreground/[0.06] transition-colors"
              />
            </div>
          </div>

          <div class="flex-1 overflow-y-auto px-2 pb-2 min-h-[140px]">
            <div v-if="projectQuery.length < 2" class="flex flex-col items-center justify-center py-10 px-6 text-center">
              <div class="size-10 rounded-2xl bg-foreground/[0.04] flex items-center justify-center mb-3">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground/70"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
              </div>
              <p class="text-sm text-muted-foreground">Start typing to find a project.</p>
              <p class="text-[11px] text-muted-foreground/60 mt-1">Search by customer name or project ID.</p>
            </div>

            <div v-else-if="projectSearching" class="py-6 text-center text-xs text-muted-foreground">
              <span class="inline-flex gap-1.5">
                <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 0ms"></span>
                <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 120ms"></span>
                <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 240ms"></span>
              </span>
            </div>

            <div v-else-if="projectResults.length === 0" class="py-10 px-6 text-center">
              <p class="text-sm text-muted-foreground">No projects match "<span class="font-medium text-foreground/80">{{ projectQuery }}</span>".</p>
              <p class="text-[11px] text-muted-foreground/60 mt-1">Try a partial name or the QuickBase record ID.</p>
            </div>

            <button v-else v-for="(p, idx) in projectResults" :key="p.record_id"
              @click="attachProject(p)"
              @mouseenter="projectHighlight = idx"
              class="w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 transition-colors"
              :class="projectHighlight === idx ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]'"
            >
              <div class="shrink-0 size-9 rounded-full bg-gradient-to-br from-foreground/[0.08] to-foreground/[0.04] flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-foreground/60"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium truncate">{{ p.customer_name || `Project ${p.record_id}` }}</div>
                <div class="text-[11px] text-muted-foreground/80 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span class="font-mono tabular-nums">#{{ p.record_id }}</span>
                  <span v-if="p.state" class="text-muted-foreground/50">·</span>
                  <span v-if="p.state">{{ p.state }}</span>
                  <span v-if="p.status" class="ml-auto"><ProjectStatusBadge :status="p.status" /></span>
                </div>
              </div>
            </button>
          </div>

          <div class="px-5 py-2.5 border-t border-foreground/[0.06] bg-foreground/[0.02] flex items-center justify-between text-[10px] text-muted-foreground/70">
            <div class="flex items-center gap-3">
              <span class="hidden sm:inline-flex items-center gap-1"><kbd class="px-1.5 py-0.5 rounded bg-foreground/10 font-mono text-[10px]">↑↓</kbd> navigate</span>
              <span class="hidden sm:inline-flex items-center gap-1"><kbd class="px-1.5 py-0.5 rounded bg-foreground/10 font-mono text-[10px]">↵</kbd> select</span>
              <span class="inline-flex items-center gap-1"><kbd class="px-1.5 py-0.5 rounded bg-foreground/10 font-mono text-[10px]">esc</kbd> close</span>
            </div>
            <span v-if="projectResults.length" class="tabular-nums">{{ projectResults.length }} match{{ projectResults.length === 1 ? '' : 'es' }}</span>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Model picker (opens via /model slash command or external trigger) -->
    <ModelPicker
      :open="modelPickerOpen"
      :current-provider="activeThread?.preferred_provider"
      :current-model="activeThread?.preferred_model"
      @close="modelPickerOpen = false"
      @pick="applyModelPick"
    />
  </div>
</template>

<style scoped>
textarea {
  field-sizing: content;
}
</style>
