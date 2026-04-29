<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import ProjectHome from '@/components/chat/ProjectHome.vue'
import ChatHeaderMeta from '@/components/chat/ChatHeaderMeta.vue'
import ContextPreview from '@/components/chat/ContextPreview.vue'

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

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

interface RateSnapshot {
  tokens_remaining: number | null
  tokens_limit: number | null
  requests_remaining: number | null
  requests_limit: number | null
  reset_at: string | null
  used_own_key: boolean
  updated_at: string
}
interface Quota {
  cap_cents: number | null
  spent_cents: number
  cap_pct_used: number | null
  byok_bypasses_cap: boolean
  providers: Record<string, RateSnapshot>
}

interface Space {
  id: number
  project_id: number
  name: string
  thread_count: number
  created_at: string
  last_used_at: string | null
}

const threads = ref<Thread[]>([])
const spaces = ref<Space[]>([])
const quota = ref<Quota | null>(null)
const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null)
const contextPreviewOpen = ref(false)

// Right-pane state machine: project (ProjectHome), thread (ChatPanel), or null (welcome).
const activeThreadId = ref<number | null>(null)
const activeSpaceId = ref<number | null>(null)
const mobileDrawerOpen = ref(false)

const generalThreads = computed(() => threads.value.filter(t => !t.space_id))
const threadsBySpace = computed(() => {
  const map = new Map<number, Thread[]>()
  for (const t of threads.value) {
    if (t.space_id) {
      if (!map.has(t.space_id)) map.set(t.space_id, [])
      map.get(t.space_id)!.push(t)
    }
  }
  return map
})

async function loadAll() {
  const [tRes, sRes, qRes] = await Promise.all([
    fetch('/api/chat/threads', { headers: hdrs() }),
    fetch('/api/chat/spaces', { headers: hdrs() }),
    fetch('/api/chat/quota', { headers: hdrs() }),
  ])
  if (tRes.ok) threads.value = (await tRes.json()).threads || []
  if (sRes.ok) spaces.value = (await sRes.json()).spaces || []
  if (qRes.ok) quota.value = await qRes.json()
}

async function refreshQuota() {
  const r = await fetch('/api/chat/quota', { headers: hdrs() })
  if (r.ok) quota.value = await r.json()
}

function openModelPickerFromHeader() {
  // The ChatPanel exposes openModelPicker — call it to open the same modal
  // the /model slash command uses, so the header click and the slash command
  // share one code path.
  chatPanelRef.value?.openModelPicker?.()
}

// One-click project navigation: opens the project's home page in the right pane.
function selectProject(s: Space) {
  activeSpaceId.value = s.id
  activeThreadId.value = null
  mobileDrawerOpen.value = false
}

function selectThread(t: Thread) {
  activeThreadId.value = t.id
  activeSpaceId.value = t.space_id
  mobileDrawerOpen.value = false
}

function selectGeneral() {
  // No project, no thread — empty welcome state for a fresh general chat.
  activeSpaceId.value = null
  activeThreadId.value = null
}

async function newThread(spaceId: number | null = null) {
  const body: Record<string, unknown> = {}
  if (spaceId != null) body.space_id = spaceId
  const res = await fetch('/api/chat/threads', { method: 'POST', headers: hdrs(), body: JSON.stringify(body) })
  if (res.ok) {
    const t = await res.json() as Thread
    threads.value = [t, ...threads.value]
    activeThreadId.value = t.id
    activeSpaceId.value = t.space_id
    mobileDrawerOpen.value = false
  }
}

async function deleteThread(t: Thread) {
  if (!window.confirm(`Delete "${t.title}"? This can't be undone.`)) return
  await fetch(`/api/chat/threads/${t.id}`, { method: 'DELETE', headers: hdrs() })
  threads.value = threads.value.filter(x => x.id !== t.id)
  if (activeThreadId.value === t.id) {
    activeThreadId.value = null
  }
}

async function deleteSpace(s: Space) {
  if (!window.confirm(`Delete the "${s.name}" project? All ${s.thread_count} thread${s.thread_count === 1 ? '' : 's'} in it will be removed.`)) return
  await fetch(`/api/chat/spaces/${s.id}`, { method: 'DELETE', headers: hdrs() })
  await loadAll()
  if (activeSpaceId.value === s.id) {
    activeThreadId.value = null
    activeSpaceId.value = null
  }
}

function onThreadCreated(t: Thread) {
  threads.value = [t, ...threads.value.filter(x => x.id !== t.id)]
  activeThreadId.value = t.id
  activeSpaceId.value = t.space_id
  if (t.space_id && !spaces.value.find(s => s.id === t.space_id)) loadAll()
}

function onThreadUpdated(t: Thread) {
  const idx = threads.value.findIndex(x => x.id === t.id)
  if (idx >= 0) threads.value[idx] = t
  else threads.value = [t, ...threads.value]
  threads.value.sort((a, b) => (b.last_message_at || b.created_at).localeCompare(a.last_message_at || a.created_at))
  if (t.space_id && !spaces.value.find(s => s.id === t.space_id)) loadAll()
  activeSpaceId.value = t.space_id
  // Refresh quota — the just-completed message updates rate-limit snapshots and spend.
  refreshQuota()
}

function fmtRelativeTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const activeThread = computed(() => threads.value.find(t => t.id === activeThreadId.value) || null)
const activeSpace = computed(() => spaces.value.find(s => s.id === activeSpaceId.value) || null)
const activeSpaceThreads = computed(() => activeSpaceId.value ? (threadsBySpace.value.get(activeSpaceId.value) || []) : [])

// Right-pane mode: 'thread' | 'project' | 'welcome'
const paneMode = computed<'thread' | 'project' | 'welcome'>(() => {
  if (activeThreadId.value) return 'thread'
  if (activeSpaceId.value) return 'project'
  return 'welcome'
})

onMounted(loadAll)
</script>

<template>
  <div class="-mx-3 sm:-mx-6 -my-4 sm:-my-6 h-[calc(100dvh-3.5rem)] flex overflow-hidden bg-gradient-to-br from-background via-background to-muted/30">

    <!-- Sidebar (desktop only) -->
    <aside class="hidden md:flex flex-col w-72 lg:w-80 shrink-0 bg-card/40 backdrop-blur-sm">
      <div class="p-4 flex items-center justify-between gap-2">
        <div>
          <div class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Chat Bot</div>
          <div class="text-xs text-muted-foreground/70 mt-0.5">{{ spaces.length }} project{{ spaces.length === 1 ? '' : 's' }} · {{ generalThreads.length }} chat{{ generalThreads.length === 1 ? '' : 's' }}</div>
        </div>
        <Button size="sm" @click="newThread()" class="shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          New
        </Button>
      </div>

      <div class="flex-1 overflow-y-auto px-2 pb-3 space-y-5">

        <!-- Projects section -->
        <div v-if="spaces.length > 0" class="space-y-1">
          <div class="px-3 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Projects</div>
          <div v-for="s in spaces" :key="s.id" class="group relative">
            <button
              @click="selectProject(s)"
              class="w-full text-left px-3 py-2 rounded-xl flex items-center gap-2.5 transition-colors"
              :class="activeSpaceId === s.id && !activeThreadId
                ? 'bg-foreground/[0.08]'
                : 'hover:bg-foreground/[0.04]'"
            >
              <div class="shrink-0 size-7 rounded-full bg-gradient-to-br from-foreground/[0.08] to-foreground/[0.04] flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-foreground/60"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">{{ s.name }}</div>
                <div class="text-[10px] text-muted-foreground/70">{{ s.thread_count }} chat{{ s.thread_count === 1 ? '' : 's' }}</div>
              </div>
            </button>
            <!-- Per-row quick actions: + new chat, delete -->
            <div class="absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                @click.stop="newThread(s.id)"
                class="size-7 rounded-lg bg-card/80 backdrop-blur-sm hover:bg-foreground/[0.08] text-muted-foreground hover:text-foreground inline-flex items-center justify-center transition-colors"
                title="New chat in this project"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              </button>
              <button
                @click.stop="deleteSpace(s)"
                class="size-7 rounded-lg bg-card/80 backdrop-blur-sm hover:bg-destructive/10 text-muted-foreground/60 hover:text-destructive inline-flex items-center justify-center transition-colors"
                title="Delete project"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- General conversations section -->
        <div class="space-y-1">
          <div class="px-3 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Conversations</div>
          <div v-if="generalThreads.length === 0" class="px-3 py-2 text-xs text-muted-foreground/70">No general chats yet.</div>
          <button
            v-for="t in generalThreads" :key="t.id"
            @click="selectThread(t)"
            class="group w-full text-left rounded-xl px-3 py-2.5 transition-all"
            :class="activeThreadId === t.id
              ? 'bg-foreground/[0.08]'
              : 'hover:bg-foreground/[0.04]'"
          >
            <div class="flex items-baseline justify-between gap-2">
              <div class="text-sm font-medium truncate flex-1 min-w-0">{{ t.title }}</div>
              <div class="text-[10px] text-muted-foreground tabular-nums shrink-0">{{ fmtRelativeTime(t.last_message_at || t.created_at) }}</div>
            </div>
          </button>
        </div>

      </div>
    </aside>

    <!-- Right pane -->
    <main class="flex-1 flex flex-col min-w-0">
      <!-- Header bar — always rendered so the hamburger and "back" affordance
           are always reachable from any view (welcome / project / thread). -->
      <header class="flex items-center gap-2 px-4 sm:px-6 py-3 bg-card/30 backdrop-blur-sm shrink-0">
        <Sheet v-model:open="mobileDrawerOpen">
          <SheetTrigger as-child>
            <button class="md:hidden inline-flex items-center justify-center size-9 rounded-lg hover:bg-foreground/5 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M4 6h16M4 18h16"/></svg>
            </button>
          </SheetTrigger>
          <SheetContent side="left" class="w-[300px] p-0 flex flex-col">
            <SheetHeader class="p-4">
              <SheetTitle>Chat Bot</SheetTitle>
            </SheetHeader>
            <div class="px-3 pb-3">
              <Button size="sm" class="w-full" @click="newThread()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                New chat
              </Button>
            </div>
            <div class="flex-1 overflow-y-auto px-2 pb-3 space-y-4">
              <div v-if="spaces.length > 0">
                <div class="px-3 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Projects</div>
                <button v-for="s in spaces" :key="s.id"
                  @click="selectProject(s)"
                  class="w-full text-left px-3 py-2 rounded-lg flex items-center gap-2"
                  :class="activeSpaceId === s.id ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]'"
                >
                  <span class="text-sm font-medium truncate flex-1">{{ s.name }}</span>
                  <span class="text-[10px] text-muted-foreground">{{ s.thread_count }}</span>
                </button>
              </div>
              <div>
                <div class="px-3 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Conversations</div>
                <button v-for="t in generalThreads" :key="t.id"
                  @click="selectThread(t)"
                  class="w-full text-left rounded-lg px-3 py-2"
                  :class="activeThreadId === t.id ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]'"
                >
                  <div class="text-sm font-medium truncate">{{ t.title }}</div>
                  <div class="text-[10px] text-muted-foreground tabular-nums">{{ fmtRelativeTime(t.last_message_at || t.created_at) }}</div>
                </button>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <!-- Back button — only when inside a thread or project, not on welcome -->
        <button v-if="paneMode === 'thread' && activeThread?.space_id"
          @click="selectProject({ id: activeThread.space_id!, project_id: activeThread.project_id!, name: activeThread.space_name || '', thread_count: 0, created_at: '', last_used_at: null })"
          class="inline-flex items-center justify-center size-9 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Back to project home"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <button v-else-if="paneMode === 'thread'"
          @click="selectGeneral"
          class="inline-flex items-center justify-center size-9 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Back to Chat Bot home"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <button v-else-if="paneMode === 'project'"
          @click="selectGeneral"
          class="inline-flex items-center justify-center size-9 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Back to Chat Bot home"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>

        <!-- Adaptive title -->
        <div class="flex-1 min-w-0">
          <template v-if="paneMode === 'thread' && activeThread">
            <div class="text-sm font-semibold tracking-tight truncate">{{ activeThread.title }}</div>
            <div v-if="activeThread.space_name" class="text-[11px] text-muted-foreground/80 truncate flex items-center gap-1 mt-0.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
              <span>{{ activeThread.space_name }}</span>
            </div>
          </template>
          <template v-else-if="paneMode === 'project' && activeSpace">
            <div class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Project</div>
            <div class="text-sm font-semibold tracking-tight truncate">{{ activeSpace.name }}</div>
          </template>
          <template v-else>
            <div class="text-sm font-semibold tracking-tight truncate">Chat Bot</div>
            <div class="text-[11px] text-muted-foreground/70 truncate mt-0.5">Ask anything, or pick a project</div>
          </template>
        </div>

        <!-- Model + quota ring (thread mode only) -->
        <ChatHeaderMeta
          v-if="paneMode === 'thread'"
          :preferred-provider="activeThread?.preferred_provider ?? null"
          :preferred-model="activeThread?.preferred_model ?? null"
          :quota="quota"
          @open-picker="openModelPickerFromHeader"
        />

        <!-- Debug: see exact system prompt sent to model (admin only) -->
        <button v-if="paneMode === 'thread' && auth.isAdmin"
          @click="contextPreviewOpen = true"
          class="inline-flex items-center justify-center size-9 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Show context sent to model (debug)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        </button>

        <!-- Trailing action: delete (thread mode only) -->
        <button v-if="paneMode === 'thread' && activeThread"
          class="inline-flex items-center justify-center size-9 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors text-muted-foreground shrink-0"
          title="Delete conversation"
          @click="deleteThread(activeThread)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </header>

      <!-- Project home: shown when a Project is selected but no thread is active -->
      <div v-if="paneMode === 'project' && activeSpace" class="flex-1 min-h-0">
        <ProjectHome
          :space="activeSpace"
          :threads="activeSpaceThreads"
          @pick-thread="selectThread"
          @new-chat="newThread(activeSpace.id)"
        />
      </div>

      <!-- Single ChatPanel for thread + welcome (no remount on mode flip → preserves picker state during attach flow) -->
      <div v-else class="flex-1 min-h-0">
        <ChatPanel
          ref="chatPanelRef"
          :thread-id="activeThreadId"
          :default-space-id="activeSpaceId"
          @thread-created="onThreadCreated"
          @thread-updated="onThreadUpdated"
        />
      </div>
    </main>

    <!-- Admin-only debug: shows the exact system prompt the model received -->
    <ContextPreview
      v-if="auth.isAdmin"
      :open="contextPreviewOpen"
      :thread-id="activeThreadId"
      @close="contextPreviewOpen = false"
    />
  </div>
</template>
