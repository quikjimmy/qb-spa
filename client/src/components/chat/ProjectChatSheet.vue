<script setup lang="ts">
// Self-contained "chat about this project" sheet. Mirrors the /chat full-page
// UX: open → land on the project's home (threads list + new chat CTA) → pick
// or create → chat. Encapsulates all the space/thread/quota wiring so any view
// that has a project record_id can drop in a chat launcher without re-stitching
// the plumbing. Used by the full ProjectDetailView and the bump-out
// ProjectDetailDialog.
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import ProjectHome from '@/components/chat/ProjectHome.vue'
import ChatHeaderMeta from '@/components/chat/ChatHeaderMeta.vue'
import ContextPreview from '@/components/chat/ContextPreview.vue'

interface ChatThread { id: number; title: string; project_id: number | null; project_name: string | null; space_id: number | null; space_name: string | null; preferred_provider: string | null; preferred_model: string | null; archived: boolean; created_at: string; updated_at: string; last_message_at: string | null }
interface ChatSpace { id: number; project_id: number; name: string; thread_count: number; created_at: string; last_used_at: string | null }
interface RateSnapshot { tokens_remaining: number | null; tokens_limit: number | null; requests_remaining: number | null; requests_limit: number | null; reset_at: string | null; used_own_key: boolean; updated_at: string }
interface ChatQuota { cap_cents: number | null; spent_cents: number; cap_pct_used: number | null; byok_bypasses_cap: boolean; providers: Record<string, RateSnapshot> }

const props = defineProps<{
  /** When true, the sheet is open. Use with v-model:open. */
  open: boolean
  projectId: number
  projectName?: string | null
}>()
const emit = defineEmits<{ 'update:open': [v: boolean] }>()

const auth = useAuthStore()

const chatSpace = ref<ChatSpace | null>(null)
const chatThreads = ref<ChatThread[]>([])
const chatActiveThreadId = ref<number | null>(null)
const chatQuota = ref<ChatQuota | null>(null)
const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null)
const chatContextPreviewOpen = ref(false)

function chatHdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

function setOpen(v: boolean) { emit('update:open', v) }

async function refreshChatQuota() {
  const r = await fetch('/api/chat/quota', { headers: chatHdrs() })
  if (r.ok) chatQuota.value = await r.json()
}

function openChatModelPicker() { chatPanelRef.value?.openModelPicker?.() }

// Load the project's chat space + threads. Runs each time the sheet opens so a
// freshly-targeted project replaces any stale space from a prior open.
async function loadSpace() {
  chatActiveThreadId.value = null
  chatSpace.value = null
  chatThreads.value = []
  refreshChatQuota()
  try {
    const sRes = await fetch(`/api/chat/spaces/from-project/${props.projectId}`, { method: 'POST', headers: chatHdrs() })
    if (sRes.ok) chatSpace.value = await sRes.json()
    if (chatSpace.value) {
      const tRes = await fetch(`/api/chat/threads?space_id=${chatSpace.value.id}`, { headers: chatHdrs() })
      if (tRes.ok) {
        const data = await tRes.json()
        chatThreads.value = data.threads || []
      }
    }
  } catch { /* swallow */ }
}

watch(() => props.open, (v) => { if (v) loadSpace() })

async function chatNewThread() {
  if (!chatSpace.value) return
  const res = await fetch('/api/chat/threads', {
    method: 'POST', headers: chatHdrs(),
    body: JSON.stringify({ space_id: chatSpace.value.id }),
  })
  if (res.ok) {
    const t = await res.json() as ChatThread
    chatThreads.value = [t, ...chatThreads.value]
    chatActiveThreadId.value = t.id
  }
}

function chatPickThread(t: { id: number }) { chatActiveThreadId.value = t.id }
function chatBackToHome() { chatActiveThreadId.value = null }

function onChatThreadCreated(t: ChatThread) {
  chatThreads.value = [t, ...chatThreads.value.filter(x => x.id !== t.id)]
  chatActiveThreadId.value = t.id
}

function onChatThreadUpdated(t: ChatThread) {
  const idx = chatThreads.value.findIndex(x => x.id === t.id)
  if (idx >= 0) chatThreads.value[idx] = t
  chatThreads.value.sort((a, b) => (b.last_message_at || b.created_at).localeCompare(a.last_message_at || a.created_at))
  refreshChatQuota()
}

const chatActiveThread = computed(() => chatThreads.value.find(t => t.id === chatActiveThreadId.value) || null)
</script>

<template>
  <Sheet :open="open" @update:open="setOpen">
    <SheetContent side="right" class="w-full sm:max-w-md md:max-w-lg p-0 flex flex-col gap-0">
      <!-- Slim header — when on a thread, "← Back" returns to project home -->
      <div class="flex items-center gap-2 px-4 py-3 bg-card/40 backdrop-blur-sm shrink-0">
        <button v-if="chatActiveThreadId"
          @click="chatBackToHome"
          class="inline-flex items-center justify-center size-8 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Back to project home"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <img src="/img/ai-chat-icon.png" alt="" class="size-8 shrink-0" aria-hidden="true" />
        <div class="flex-1 min-w-0">
          <div class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Chat Bot</div>
          <div class="text-sm font-medium truncate">
            {{ chatActiveThreadId ? (chatActiveThread?.title || 'New chat') : (chatSpace?.name || projectName || 'Project') }}
          </div>
        </div>
        <ChatHeaderMeta
          v-if="chatActiveThreadId"
          :preferred-provider="chatActiveThread?.preferred_provider ?? null"
          :preferred-model="chatActiveThread?.preferred_model ?? null"
          :quota="chatQuota"
          :compact="true"
          @open-picker="openChatModelPicker"
        />
        <button v-if="chatActiveThreadId && auth.isAdmin"
          @click="chatContextPreviewOpen = true"
          class="inline-flex items-center justify-center size-8 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Show context sent to model (debug)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        </button>
      </div>

      <!-- Body: ProjectHome when no thread, ChatPanel when in a thread -->
      <div v-if="!chatActiveThreadId && chatSpace" class="flex-1 min-h-0">
        <ProjectHome
          :space="chatSpace"
          :threads="chatThreads"
          @pick-thread="chatPickThread"
          @new-chat="chatNewThread"
        />
      </div>
      <div v-else class="flex-1 min-h-0">
        <ChatPanel
          ref="chatPanelRef"
          :thread-id="chatActiveThreadId"
          :default-space-id="chatSpace?.id ?? null"
          :allow-project-picker="false"
          :compact="true"
          @thread-created="onChatThreadCreated"
          @thread-updated="onChatThreadUpdated"
        />
      </div>
    </SheetContent>
  </Sheet>

  <!-- Admin-only debug: shows the exact system prompt the model received -->
  <ContextPreview
    v-if="auth.isAdmin"
    :open="chatContextPreviewOpen"
    :thread-id="chatActiveThreadId"
    @close="chatContextPreviewOpen = false"
  />
</template>
