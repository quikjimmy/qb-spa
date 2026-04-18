<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

const auth = useAuthStore()

// ─── Types ───────────────────────────────────────────────

interface Reaction { emoji: string; count: number; reacted: boolean }

interface FeedItem {
  id: number
  qb_source: string
  event_type: string
  title: string
  body: string
  actor_name: string
  actor_email: string | null
  project_id: number | null
  project_name: string | null
  occurred_at: string
  comment_count: number
  reactions: Reaction[]
}

interface Comment {
  id: number; user_name: string; body: string; created_at: string
}

interface ActorBubble {
  actor_name: string; actor_email: string | null; activity_count: number; latest_activity: string
}

// ─── State ───────────────────────────────────────────────

const items = ref<FeedItem[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const hasMore = ref(true)
const total = ref(0)
const actors = ref<ActorBubble[]>([])
const eventTypes = ref<Array<{ event_type: string }>>([])
const selectedActor = ref<string | null>(null)
const filterType = ref('')

const expandedComments = ref<Set<number>>(new Set())
const commentsByItem = ref<Map<number, Comment[]>>(new Map())
const commentInput = ref<Map<number, string>>(new Map())
const postingComment = ref<Set<number>>(new Set())

const quickReactions = ['👍', '🔥', '👀', '✅', '⚠️', '❤️']

// ─── API ─────────────────────────────────────────────────

function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

async function loadFeed(append = false) {
  if (!append) loading.value = true
  else loadingMore.value = true
  const offset = append ? items.value.length : 0
  const params = new URLSearchParams({ limit: '20', offset: String(offset) })
  if (selectedActor.value) params.set('actor_name', selectedActor.value)
  if (filterType.value) params.set('event_type', filterType.value)

  try {
    const res = await fetch(`/api/feed?${params}`, { headers: hdrs() })
    const data = await res.json()
    if (append) items.value.push(...data.items)
    else { items.value = data.items; actors.value = data.actors; eventTypes.value = data.eventTypes }
    total.value = data.total
    hasMore.value = items.value.length < data.total
  } finally { loading.value = false; loadingMore.value = false }
}

function selectActor(name: string) {
  selectedActor.value = selectedActor.value === name ? null : name
  loadFeed(false)
}

function clearFilters() { selectedActor.value = null; filterType.value = ''; loadFeed(false) }

async function toggleReaction(itemId: number, emoji: string) {
  const res = await fetch(`/api/feed/${itemId}/reactions`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ emoji }) })
  const data = await res.json()
  const item = items.value.find(i => i.id === itemId)
  if (!item) return
  const existing = item.reactions.find(r => r.emoji === emoji)
  if (data.action === 'added') {
    if (existing) { existing.count++; existing.reacted = true }
    else item.reactions.push({ emoji, count: 1, reacted: true })
  } else if (existing) {
    existing.count--; existing.reacted = false
    if (existing.count <= 0) item.reactions = item.reactions.filter(r => r.emoji !== emoji)
  }
}

async function toggleComments(itemId: number) {
  if (expandedComments.value.has(itemId)) { expandedComments.value.delete(itemId); return }
  expandedComments.value.add(itemId)
  if (!commentsByItem.value.has(itemId)) {
    const res = await fetch(`/api/feed/${itemId}/comments`, { headers: hdrs() })
    const data = await res.json()
    commentsByItem.value.set(itemId, data.comments)
  }
}

async function postComment(itemId: number) {
  const body = commentInput.value.get(itemId)?.trim()
  if (!body) return
  postingComment.value.add(itemId)
  try {
    const res = await fetch(`/api/feed/${itemId}/comments`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ body }) })
    const data = await res.json()
    const existing = commentsByItem.value.get(itemId) || []
    commentsByItem.value.set(itemId, [...existing, data.comment])
    commentInput.value.set(itemId, '')
    const item = items.value.find(i => i.id === itemId)
    if (item) item.comment_count++
  } finally { postingComment.value.delete(itemId) }
}

// ─── Helpers ─────────────────────────────────────────────

const typeConfig: Record<string, { label: string; accent: string }> = {
  milestone: { label: 'Milestone', accent: 'bg-emerald-500/10 text-emerald-700' },
  status_change: { label: 'Status Update', accent: 'bg-blue-500/10 text-blue-700' },
  note_added: { label: 'Note', accent: 'bg-amber-500/10 text-amber-700' },
  ticket_created: { label: 'Ticket', accent: 'bg-rose-500/10 text-rose-700' },
  task_event: { label: 'Field Task', accent: 'bg-violet-500/10 text-violet-700' },
}
function getType(t: string) { return typeConfig[t] || { label: t, accent: 'bg-zinc-100 text-zinc-500' } }

function getInitials(name: string) { return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) }

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const ingesting = ref(false)
async function runIngest() {
  ingesting.value = true
  try { await fetch('/api/admin/feed/ingest', { method: 'POST', headers: hdrs() }); await loadFeed(false) }
  finally { ingesting.value = false }
}

onMounted(() => loadFeed())
</script>

<template>
  <!-- Feed page uses its own surface color, scoped -->
  <div class="feed-surface -m-6 min-h-screen">
    <div class="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">

      <!-- Header -->
      <header class="mb-8 sm:mb-12 flex items-end justify-between">
        <div>
          <h1 class="text-3xl sm:text-[2.75rem] font-black tracking-tight leading-none">Feed</h1>
          <p class="text-sm text-[#5a5c5c] mt-1.5">What's happening across operations.</p>
        </div>
        <button
          v-if="auth.isAdmin"
          class="text-xs font-semibold text-[#5a5c5c] hover:text-[#2d2f2f] transition-colors"
          :disabled="ingesting"
          @click="runIngest"
        >{{ ingesting ? 'Syncing...' : 'Sync from QB' }}</button>
      </header>

      <!-- ═══ Story Bubbles ═══ -->
      <div class="mb-8 sm:mb-12 -mx-4 sm:-mx-6 px-4 sm:px-6">
        <div class="flex gap-5 overflow-x-auto pb-4 no-scrollbar scroll-smooth">
          <!-- All -->
          <button class="flex-none flex flex-col items-center gap-1.5 group" @click="selectedActor ? clearFilters() : null">
            <div
              class="w-[68px] h-[68px] sm:w-[72px] sm:h-[72px] rounded-full p-[3px] transition-transform group-hover:scale-105"
              :class="!selectedActor ? 'feed-gradient' : 'bg-[#dbdddd]'"
            >
              <div class="w-full h-full rounded-full bg-white flex items-center justify-center">
                <span class="text-base font-bold" :class="!selectedActor ? 'text-[#b6004f]' : 'text-[#5a5c5c]'">All</span>
              </div>
            </div>
            <span class="text-[10px] font-semibold uppercase tracking-[0.05em]" :class="!selectedActor ? 'text-[#2d2f2f]' : 'text-[#5a5c5c]'">Everyone</span>
          </button>

          <!-- Actor bubbles -->
          <button
            v-for="actor in actors" :key="actor.actor_name"
            class="flex-none flex flex-col items-center gap-1.5 group"
            @click="selectActor(actor.actor_name)"
          >
            <div class="relative">
              <div
                class="w-[68px] h-[68px] sm:w-[72px] sm:h-[72px] rounded-full p-[3px] transition-transform group-hover:scale-105"
                :class="selectedActor === actor.actor_name ? 'feed-gradient ring-2 ring-offset-2 ring-[#b6004f]' : 'feed-gradient'"
              >
                <div class="w-full h-full rounded-full bg-white p-[2px]">
                  <div class="w-full h-full rounded-full bg-[#e7e8e8] flex items-center justify-center">
                    <span class="text-sm font-bold text-[#2d2f2f]">{{ getInitials(actor.actor_name) }}</span>
                  </div>
                </div>
              </div>
              <span
                v-if="actor.activity_count > 0"
                class="absolute -bottom-0.5 -right-0.5 min-w-[20px] h-[20px] px-1 rounded-full bg-[#b6004f] text-white text-[10px] font-bold flex items-center justify-center border-2 border-white"
              >{{ actor.activity_count > 99 ? '99+' : actor.activity_count }}</span>
            </div>
            <span class="text-[10px] font-semibold uppercase tracking-[0.05em] w-16 text-center truncate" :class="selectedActor === actor.actor_name ? 'text-[#2d2f2f]' : 'text-[#5a5c5c]'">
              {{ actor.actor_name.split(' ')[0] }}
            </span>
          </button>
        </div>
      </div>

      <!-- Filter pill row -->
      <div v-if="selectedActor || filterType" class="flex items-center gap-2 mb-6">
        <span v-if="selectedActor" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#ff7196]/10 text-[#4d001d] text-xs font-semibold">
          {{ selectedActor }}
          <button @click="selectedActor = null; loadFeed(false)" class="hover:opacity-60">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </span>
        <span class="text-xs text-[#757777]">{{ total.toLocaleString() }} items</span>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="space-y-12">
        <div v-for="i in 4" :key="i" class="bg-white rounded-2xl overflow-hidden feed-shadow">
          <div class="p-6 flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-[#e7e8e8] animate-pulse" />
            <div class="space-y-1.5 flex-1"><div class="h-3.5 w-28 rounded bg-[#e7e8e8] animate-pulse" /><div class="h-2.5 w-20 rounded bg-[#f0f1f1] animate-pulse" /></div>
          </div>
          <div class="aspect-[16/9] bg-[#f0f1f1] animate-pulse" />
          <div class="p-6 space-y-2"><div class="h-3 w-40 rounded bg-[#e7e8e8] animate-pulse" /><div class="h-3 w-full rounded bg-[#f0f1f1] animate-pulse" /></div>
        </div>
      </div>

      <!-- Empty -->
      <div v-else-if="items.length === 0" class="text-center py-20">
        <p class="text-2xl font-black text-[#acadad]">No activity yet</p>
        <p v-if="auth.isAdmin" class="text-sm text-[#757777] mt-2">Sync from QB to populate the feed.</p>
      </div>

      <!-- ═══ Feed Cards ═══ -->
      <div v-else class="space-y-10 sm:space-y-16">
        <article v-for="item in items" :key="item.id" class="group">
          <div class="bg-white rounded-2xl overflow-hidden feed-shadow transition-transform duration-300 hover:scale-[1.005]">

            <!-- Profile header -->
            <div class="flex items-center justify-between p-5 sm:p-6">
              <div class="flex items-center gap-3">
                <button @click="selectActor(item.actor_name || 'System')" class="shrink-0">
                  <Avatar class="size-10 ring-1 ring-[#e7e8e8]">
                    <AvatarFallback class="text-xs font-bold bg-[#f0f1f1] text-[#2d2f2f]">
                      {{ getInitials(item.actor_name || 'SY') }}
                    </AvatarFallback>
                  </Avatar>
                </button>
                <div>
                  <button class="text-sm font-bold text-[#2d2f2f] hover:opacity-70 transition-opacity" @click="selectActor(item.actor_name || 'System')">
                    {{ item.actor_name || 'System' }}
                  </button>
                  <p class="text-[0.6875rem] uppercase tracking-[0.05em] font-medium text-[#757777]">
                    {{ item.project_name || item.qb_source }}
                  </p>
                </div>
              </div>
              <span
                class="px-3 py-1 text-[0.6875rem] font-bold rounded-full uppercase tracking-[0.05em]"
                :class="getType(item.event_type).accent"
              >{{ getType(item.event_type).label }}</span>
            </div>

            <!-- Content body -->
            <div class="px-5 sm:px-6 pb-3">
              <p class="text-[15px] font-semibold text-[#2d2f2f] leading-snug">{{ item.title }}</p>
              <p v-if="item.body && item.body !== item.title" class="text-sm text-[#5a5c5c] leading-relaxed mt-1.5 line-clamp-3">
                {{ item.body }}
              </p>
              <p v-if="item.project_name" class="mt-2">
                <span class="text-xs font-semibold text-[#757777] bg-[#f0f1f1] px-2.5 py-1 rounded-full">
                  #{{ item.project_id }} {{ item.project_name }}
                </span>
              </p>
            </div>

            <!-- Reactions display -->
            <div v-if="item.reactions.length" class="px-5 sm:px-6 pb-2 flex gap-1.5 flex-wrap">
              <button
                v-for="r in item.reactions" :key="r.emoji"
                class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors"
                :class="r.reacted ? 'bg-[#ff7196]/10 text-[#4d001d]' : 'bg-[#f0f1f1] text-[#5a5c5c] hover:bg-[#e7e8e8]'"
                @click="toggleReaction(item.id, r.emoji)"
              >
                <span>{{ r.emoji }}</span>
                <span class="font-semibold">{{ r.count }}</span>
              </button>
            </div>

            <!-- Action bar -->
            <div class="px-5 sm:px-6 py-3 flex items-center justify-between">
              <div class="flex items-center gap-1">
                <button
                  v-for="emoji in quickReactions" :key="emoji"
                  class="size-8 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95"
                  :class="item.reactions.find(r => r.emoji === emoji && r.reacted) ? 'bg-[#ff7196]/10' : 'hover:bg-[#f0f1f1]'"
                  @click="toggleReaction(item.id, emoji)"
                >{{ emoji }}</button>
              </div>
              <div class="flex items-center gap-4">
                <button
                  class="text-[#5a5c5c] hover:text-[#2d2f2f] transition-colors flex items-center gap-1"
                  @click="toggleComments(item.id)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
                  <span v-if="item.comment_count" class="text-xs font-semibold">{{ item.comment_count }}</span>
                </button>
              </div>
            </div>

            <!-- Timestamp -->
            <div class="px-5 sm:px-6 pb-4">
              <p class="text-[0.6875rem] uppercase tracking-[0.05em] font-medium text-[#acadad]">{{ timeAgo(item.occurred_at) }}</p>
            </div>

            <!-- Comments panel -->
            <div v-if="expandedComments.has(item.id)" class="bg-[#f6f6f6]">
              <div v-if="commentsByItem.get(item.id)?.length" class="divide-y divide-[#e7e8e8]/60">
                <div v-for="comment in commentsByItem.get(item.id)" :key="comment.id" class="px-5 sm:px-6 py-3 flex gap-3">
                  <Avatar class="size-7 shrink-0">
                    <AvatarFallback class="text-[10px] font-bold bg-[#e7e8e8] text-[#2d2f2f]">{{ getInitials(comment.user_name) }}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p class="text-xs"><span class="font-bold text-[#2d2f2f]">{{ comment.user_name }}</span> <span class="text-[#acadad] ml-1">{{ timeAgo(comment.created_at) }}</span></p>
                    <p class="text-sm text-[#2d2f2f] mt-0.5">{{ comment.body }}</p>
                  </div>
                </div>
              </div>
              <div class="px-5 sm:px-6 py-3 flex gap-2">
                <Input
                  :model-value="commentInput.get(item.id) || ''"
                  @update:model-value="(v: string | number) => commentInput.set(item.id, String(v))"
                  @keydown.enter="postComment(item.id)"
                  placeholder="Add a comment..."
                  class="text-sm h-9 bg-white border-0 focus-visible:ring-1 focus-visible:ring-[#acadad]/30"
                />
                <Button
                  size="sm"
                  class="feed-gradient-btn text-white border-0 font-semibold"
                  :disabled="!commentInput.get(item.id)?.trim() || postingComment.has(item.id)"
                  @click="postComment(item.id)"
                >Post</Button>
              </div>
            </div>
          </div>
        </article>
      </div>

      <!-- Load more -->
      <div v-if="hasMore && !loading && items.length > 0" class="flex justify-center py-10">
        <button
          class="px-6 py-3 rounded-full bg-[#e1e3e3] text-sm font-semibold text-[#2d2f2f] hover:bg-[#dbdddd] transition-colors active:scale-95"
          :disabled="loadingMore"
          @click="loadFeed(true)"
        >{{ loadingMore ? 'Loading...' : 'Load more' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Feed-specific design tokens — doesn't affect the rest of the app */
.feed-surface {
  background: #f6f6f6;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}

.feed-gradient {
  background: linear-gradient(135deg, #B6004F 0%, #FF9742 100%);
}

.feed-gradient-btn {
  background: linear-gradient(135deg, #B6004F 0%, #FF9742 100%);
}
.feed-gradient-btn:hover {
  opacity: 0.9;
}

.feed-shadow {
  box-shadow: 0px 20px 40px rgba(45, 47, 47, 0.06);
}

.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
