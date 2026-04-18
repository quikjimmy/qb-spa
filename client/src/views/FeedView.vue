<script setup lang="ts">
import { ref, inject, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const auth = useAuthStore()

interface MediaAttachment { id: number; url: string; thumbUrl: string; mediaType: 'image' | 'video'; width: number | null; height: number | null; durationSec: number | null }
interface Reaction { emoji: string; count: number; reacted: boolean }
interface FeedItem {
  id: number; qb_source: string; event_type: string; title: string; body: string
  actor_name: string; actor_email: string | null; project_id: number | null
  project_name: string | null; occurred_at: string; comment_count: number; reactions: Reaction[]
  media: MediaAttachment[]
}
interface Comment { id: number; user_name: string; body: string; created_at: string }
interface ActorBubble { actor_name: string; actor_email: string | null; activity_count: number; latest_activity: string }

const items = ref<FeedItem[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const hasMore = ref(true)
const total = ref(0)
const actors = ref<ActorBubble[]>([])
const selectedActor = ref<string | null>(null)

const expandedComments = ref<Set<number>>(new Set())
const commentsByItem = ref<Map<number, Comment[]>>(new Map())
const commentInput = ref<Map<number, string>>(new Map())
const postingComment = ref<Set<number>>(new Set())

function hdrs() { return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' } }

async function loadFeed(append = false) {
  if (!append) loading.value = true; else loadingMore.value = true
  const offset = append ? items.value.length : 0
  const params = new URLSearchParams({ limit: '20', offset: String(offset) })
  if (selectedActor.value) params.set('actor_name', selectedActor.value)
  try {
    const res = await fetch(`/api/feed?${params}`, { headers: hdrs() })
    const data = await res.json()
    if (append) items.value.push(...data.items)
    else { items.value = data.items; actors.value = data.actors }
    total.value = data.total; hasMore.value = items.value.length < data.total
  } finally { loading.value = false; loadingMore.value = false }
}

function selectActor(name: string) { selectedActor.value = selectedActor.value === name ? null : name; loadFeed(false) }
function clearActor() { selectedActor.value = null; loadFeed(false) }

async function toggleReaction(itemId: number, emoji: string) {
  const res = await fetch(`/api/feed/${itemId}/reactions`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ emoji }) })
  const data = await res.json()
  const item = items.value.find(i => i.id === itemId)
  if (!item) return
  const existing = item.reactions.find(r => r.emoji === emoji)
  if (data.action === 'added') { if (existing) { existing.count++; existing.reacted = true } else item.reactions.push({ emoji, count: 1, reacted: true }) }
  else if (existing) { existing.count--; existing.reacted = false; if (existing.count <= 0) item.reactions = item.reactions.filter(r => r.emoji !== emoji) }
}

async function toggleComments(itemId: number) {
  if (expandedComments.value.has(itemId)) { expandedComments.value.delete(itemId); return }
  expandedComments.value.add(itemId)
  if (!commentsByItem.value.has(itemId)) {
    const res = await fetch(`/api/feed/${itemId}/comments`, { headers: hdrs() })
    commentsByItem.value.set(itemId, (await res.json()).comments)
  }
}

async function postComment(itemId: number) {
  const body = commentInput.value.get(itemId)?.trim()
  if (!body) return
  postingComment.value.add(itemId)
  try {
    const res = await fetch(`/api/feed/${itemId}/comments`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ body }) })
    const data = await res.json()
    commentsByItem.value.set(itemId, [...(commentsByItem.value.get(itemId) || []), data.comment])
    commentInput.value.set(itemId, '')
    const item = items.value.find(i => i.id === itemId); if (item) item.comment_count++
  } finally { postingComment.value.delete(itemId) }
}

// Helpers
// Compose
const showCompose = ref(false)
const composeBody = ref('')
const composeFiles = ref<File[]>([])
const composePreviews = ref<string[]>([])
const posting = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const videoInputRef = ref<HTMLInputElement | null>(null)

function addFiles(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    if (composeFiles.value.length >= 10) break
    composeFiles.value.push(file)
    composePreviews.value.push(URL.createObjectURL(file))
  }
  input.value = ''
}

async function addVideo(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.[0]) return
  const file = input.files[0]

  // Client-side duration check
  const valid = await new Promise<boolean>((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => { URL.revokeObjectURL(video.src); resolve(video.duration <= 30) }
    video.onerror = () => { URL.revokeObjectURL(video.src); resolve(false) }
    video.src = URL.createObjectURL(file)
  })

  if (!valid) { alert('Video must be 30 seconds or less'); input.value = ''; return }
  composeFiles.value.push(file)
  composePreviews.value.push(URL.createObjectURL(file))
  input.value = ''
}

function removeFile(idx: number) {
  URL.revokeObjectURL(composePreviews.value[idx]!)
  composeFiles.value.splice(idx, 1)
  composePreviews.value.splice(idx, 1)
}

function cancelCompose() {
  composePreviews.value.forEach(url => URL.revokeObjectURL(url))
  composeBody.value = ''; composeFiles.value = []; composePreviews.value = []; showCompose.value = false
}

async function submitPost() {
  if (!composeBody.value.trim() && composeFiles.value.length === 0) return
  posting.value = true
  try {
    const fd = new FormData()
    fd.append('body', composeBody.value.trim())
    for (const file of composeFiles.value) fd.append('media', file)
    await fetch('/api/feed', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
      body: fd,
    })
    cancelCompose()
    await loadFeed(false)
  } finally { posting.value = false }
}

onUnmounted(() => composePreviews.value.forEach(url => URL.revokeObjectURL(url)))

const typeHero: Record<string, { gradient: string; icon: string }> = {
  milestone: { gradient: 'from-emerald-600 to-teal-500', icon: 'flag' },
  status_change: { gradient: 'from-blue-600 to-indigo-500', icon: 'sync' },
  note_added: { gradient: 'from-amber-500 to-orange-400', icon: 'note' },
  ticket_created: { gradient: 'from-rose-600 to-pink-500', icon: 'ticket' },
  task_event: { gradient: 'from-violet-600 to-purple-500', icon: 'task' },
  user_post: { gradient: 'from-slate-700 to-slate-600', icon: 'post' },
  agent_run: { gradient: 'from-cyan-600 to-blue-500', icon: 'agent' },
}
function getHero(t: string) { return typeHero[t] || { gradient: 'from-zinc-700 to-zinc-600', icon: '?' } }
function getInitials(name: string) { return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) }
function timeAgo(d: string) {
  if (!d) return ''
  const diff = Date.now() - new Date(d).getTime(); const m = Math.floor(diff / 60000)
  if (m < 1) return 'JUST NOW'; if (m < 60) return `${m}M AGO`
  const h = Math.floor(m / 60); if (h < 24) return `${h}H AGO`
  const days = Math.floor(h / 24); if (days < 7) return `${days}D AGO`
  // For date-only strings, parse as local to avoid UTC day shift
  const parsed = d.length === 10 ? new Date(d + 'T12:00:00') : new Date(d)
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}

const ingesting = ref(false)
async function runIngest() { ingesting.value = true; try { await fetch('/api/admin/feed/ingest', { method: 'POST', headers: hdrs() }); await loadFeed(false) } finally { ingesting.value = false } }

const registerRefresh = inject<(fn: () => Promise<void>) => void>('registerRefresh')
onMounted(() => { loadFeed(); registerRefresh?.(() => loadFeed(false)) })
</script>

<template>
  <div class="feed-page -mx-3 -my-4 sm:-m-6 min-h-screen">
    <div class="max-w-xl mx-auto px-4 sm:px-6 py-8 sm:py-12 lg:px-0">

      <!-- Header -->
      <header class="flex items-end justify-between mb-8 sm:mb-12">
        <div>
          <h1 class="text-[2.75rem] font-black tracking-tight leading-none">Feed</h1>
          <p class="text-feed-secondary text-sm mt-1">Curating the latest milestones and updates.</p>
        </div>
        <button v-if="auth.isAdmin" class="text-xs font-semibold text-feed-secondary hover:text-feed-text" :disabled="ingesting" @click="runIngest">
          {{ ingesting ? 'Syncing...' : 'Sync' }}
        </button>
      </header>

      <!-- Story Circles -->
      <div class="flex gap-4 overflow-x-auto pb-8 no-scrollbar scroll-smooth">
        <!-- All -->
        <button class="flex-none flex flex-col items-center gap-1.5 group cursor-pointer" @click="selectedActor ? clearActor() : null">
          <div class="w-[72px] h-[72px] rounded-full p-[3px] transition-transform group-hover:scale-105" :class="!selectedActor ? 'feed-sig-gradient' : 'bg-[#dbdddd]'">
            <div class="w-full h-full rounded-full bg-white flex items-center justify-center">
              <span class="text-sm font-bold" :class="!selectedActor ? 'feed-sig-text' : 'text-[#5a5c5c]'">All</span>
            </div>
          </div>
          <span class="text-[10px] font-semibold uppercase tracking-wider" :class="!selectedActor ? 'text-feed-text' : 'text-feed-secondary'">Everyone</span>
        </button>

        <button v-for="actor in actors" :key="actor.actor_name" class="flex-none flex flex-col items-center gap-1.5 group cursor-pointer" @click="selectActor(actor.actor_name)">
          <div class="w-[72px] h-[72px] rounded-full p-[3px] transition-transform group-hover:scale-105" :class="selectedActor === actor.actor_name ? 'feed-sig-gradient ring-2 ring-offset-2 ring-[#b6004f]' : 'feed-sig-gradient'">
            <div class="w-full h-full rounded-full bg-white p-0.5">
              <div class="w-full h-full rounded-full bg-[#e7e8e8] flex items-center justify-center">
                <span class="text-sm font-bold text-[#2d2f2f]">{{ getInitials(actor.actor_name) }}</span>
              </div>
            </div>
          </div>
          <span class="text-[10px] font-semibold uppercase tracking-wider w-16 text-center truncate" :class="selectedActor === actor.actor_name ? 'text-feed-text' : 'text-feed-secondary'">{{ actor.actor_name.split(' ')[0] }}</span>
        </button>
      </div>

      <!-- Compose: collapsed prompt -->
      <div v-if="!showCompose" class="mb-8 -mx-4 sm:mx-0">
        <div class="bg-white sm:rounded-3xl feed-soft-shadow overflow-hidden">
          <div class="p-4 flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-[#e7e8e8] flex items-center justify-center shrink-0">
              <span class="text-xs font-bold text-[#2d2f2f]">{{ getInitials(auth.user?.name || '?') }}</span>
            </div>
            <button class="flex-1 text-left text-sm text-[#acadad] hover:text-[#5a5c5c] transition-colors" @click="showCompose = true">
              What's happening?
            </button>
            <div class="flex items-center gap-2">
              <button class="size-9 rounded-full bg-[#f0f1f1] flex items-center justify-center text-[#5a5c5c] hover:text-[#b6004f] hover:bg-[#ff7196]/10 transition-colors active:scale-90" @click="showCompose = true; $nextTick(() => fileInputRef?.click())">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              </button>
              <button class="size-9 rounded-full bg-[#f0f1f1] flex items-center justify-center text-[#5a5c5c] hover:text-[#b6004f] hover:bg-[#ff7196]/10 transition-colors active:scale-90" @click="showCompose = true; $nextTick(() => videoInputRef?.click())">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Compose: expanded -->
      <div v-else class="mb-8 bg-white sm:rounded-3xl feed-soft-shadow -mx-4 sm:mx-0 overflow-hidden">
        <!-- Header bar -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[#f0f1f1]">
          <button class="text-sm font-semibold text-[#5a5c5c] hover:text-[#2d2f2f] transition-colors" @click="cancelCompose">Cancel</button>
          <p class="text-sm font-bold text-[#2d2f2f]">New Post</p>
          <button
            class="px-4 py-1.5 rounded-full text-sm font-bold text-white transition-all active:scale-95 disabled:opacity-30"
            style="background: linear-gradient(135deg, #B6004F 0%, #FF9742 100%)"
            :disabled="(!composeBody.trim() && composeFiles.length === 0) || posting"
            @click="submitPost"
          >{{ posting ? '...' : 'Share' }}</button>
        </div>

        <!-- Author + text -->
        <div class="p-4">
          <div class="flex gap-3">
            <div class="w-10 h-10 rounded-full bg-[#e7e8e8] flex items-center justify-center shrink-0">
              <span class="text-xs font-bold text-[#2d2f2f]">{{ getInitials(auth.user?.name || '?') }}</span>
            </div>
            <div class="flex-1 min-w-0 pt-1">
              <p class="text-sm font-bold text-[#2d2f2f]">{{ auth.user?.name }}</p>
              <textarea
                v-model="composeBody"
                placeholder="Share an update, milestone, or thought..."
                rows="4"
                class="w-full mt-2 text-[15px] leading-relaxed text-[#2d2f2f] bg-transparent border-0 outline-none resize-none placeholder:text-[#acadad]"
                autofocus
              />
            </div>
          </div>
        </div>

        <!-- Media previews -->
        <div v-if="composePreviews.length" class="px-4 pb-4">
          <div class="grid gap-1.5 rounded-3xl overflow-hidden" :class="composePreviews.length === 1 ? '' : 'grid-cols-2'">
            <div
              v-for="(preview, idx) in composePreviews" :key="idx"
              class="relative overflow-hidden bg-[#f0f1f1]"
              :class="[
                composePreviews.length === 1 ? 'aspect-[4/3] rounded-3xl' : 'aspect-square',
                composePreviews.length === 3 && idx === 0 ? 'col-span-2 aspect-video' : '',
              ]"
            >
              <video v-if="composeFiles[idx]?.type.startsWith('video/')" :src="preview" class="w-full h-full object-cover" playsinline muted />
              <img v-else :src="preview" class="w-full h-full object-cover" />
              <button
                class="absolute top-2 right-2 size-8 rounded-full bg-black/50 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/70 transition-colors active:scale-90"
                @click="removeFile(idx)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
              <div v-if="composeFiles[idx]?.type.startsWith('video/')" class="absolute bottom-2 left-2 flex items-center gap-1 bg-black/60 backdrop-blur-sm text-white text-[10px] px-2 py-0.5 rounded-full font-semibold">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Video
              </div>
            </div>
          </div>
        </div>

        <!-- Empty media prompt (when no media yet) -->
        <div v-if="!composePreviews.length" class="px-4 pb-4">
          <div class="rounded-3xl border-2 border-dashed border-[#e1e3e3] p-8 flex flex-col items-center justify-center gap-3 transition-colors hover:border-[#acadad] hover:bg-[#fafafa] cursor-pointer" @click="fileInputRef?.click()">
            <div class="size-12 rounded-full bg-[#f0f1f1] flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5a5c5c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            </div>
            <p class="text-sm text-[#5a5c5c] font-medium">Add photos or video</p>
            <p class="text-[11px] text-[#acadad]">Drag & drop or tap to browse</p>
          </div>
        </div>

        <!-- Footer: media buttons -->
        <div class="flex items-center gap-2 px-4 py-3 border-t border-[#f0f1f1]">
          <button class="size-9 rounded-full bg-[#f0f1f1] flex items-center justify-center text-[#5a5c5c] hover:text-[#b6004f] hover:bg-[#ff7196]/10 transition-colors active:scale-90" @click="fileInputRef?.click()" title="Add photos">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
          </button>
          <button class="size-9 rounded-full bg-[#f0f1f1] flex items-center justify-center text-[#5a5c5c] hover:text-[#b6004f] hover:bg-[#ff7196]/10 transition-colors active:scale-90" @click="videoInputRef?.click()" title="Add video (30s max)">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
          </button>
          <span class="text-[11px] text-[#acadad] ml-1">Photos · Video (30s max)</span>
        </div>

        <!-- Hidden file inputs -->
        <input ref="fileInputRef" type="file" accept="image/*" multiple class="hidden" @change="addFiles" />
        <input ref="videoInputRef" type="file" accept="video/mp4,video/webm,video/quicktime" class="hidden" @change="addVideo" />
      </div>

      <!-- Filter bar -->
      <div v-if="selectedActor" class="flex items-center gap-2 mb-6">
        <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#ff7196]/10 text-[#4d001d] text-xs font-semibold">
          {{ selectedActor }}
          <button @click="clearActor" class="hover:opacity-60"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        </span>
        <span class="text-xs text-feed-muted">{{ total }} items</span>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="space-y-12">
        <div v-for="i in 3" :key="i" class="bg-white rounded-3xl overflow-hidden feed-soft-shadow">
          <div class="p-4 flex items-center gap-3"><div class="w-10 h-10 rounded-full bg-[#e7e8e8] animate-pulse" /><div class="flex-1 space-y-1"><div class="h-3.5 w-24 rounded bg-[#e7e8e8] animate-pulse" /><div class="h-2.5 w-16 rounded bg-[#f0f1f1] animate-pulse" /></div></div>
          <div class="px-4"><div class="aspect-video rounded-3xl bg-[#f0f1f1] animate-pulse" /></div>
          <div class="p-5 space-y-2"><div class="h-3 w-48 rounded bg-[#e7e8e8] animate-pulse" /><div class="h-3 w-full rounded bg-[#f0f1f1] animate-pulse" /></div>
        </div>
      </div>

      <!-- Empty -->
      <div v-else-if="items.length === 0" class="text-center py-20">
        <p class="text-2xl font-black text-[#acadad]">No activity yet</p>
        <p v-if="auth.isAdmin" class="text-sm text-feed-muted mt-2">Sync from QB to populate the feed.</p>
      </div>

      <!-- Feed -->
      <div v-else class="space-y-12">
        <article v-for="item in items" :key="item.id" class="bg-white sm:rounded-3xl overflow-hidden feed-soft-shadow group -mx-4 sm:mx-0">

          <!-- Profile header -->
          <div class="p-4 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <button @click="selectActor(item.actor_name || 'System')" class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 overflow-hidden relative" :class="item.event_type === 'agent_run' ? 'bg-cyan-100' : 'bg-[#e7e8e8]'">
                <span class="text-xs font-bold" :class="item.event_type === 'agent_run' ? 'text-cyan-700' : 'text-[#2d2f2f]'">{{ item.event_type === 'agent_run' ? 'AI' : getInitials(item.actor_name || 'SY') }}</span>
              </button>
              <div>
                <button class="text-sm font-bold text-[#2d2f2f] hover:opacity-70" @click="selectActor(item.actor_name || 'System')">{{ item.actor_name || 'System' }}</button>
                <p class="text-[10px] text-[#5a5c5c] font-medium tracking-wide uppercase">{{ item.project_name || item.qb_source }}</p>
              </div>
            </div>
          </div>

          <!-- Hero content area (not for user posts) -->
          <div v-if="item.event_type !== 'user_post'" class="sm:px-4">
            <div class="sm:rounded-3xl overflow-hidden bg-gradient-to-br p-8 flex flex-col justify-center items-center text-center min-h-[180px] relative" :class="getHero(item.event_type).gradient">
              <p class="text-white/50 text-[10px] font-bold uppercase tracking-widest mb-3">{{ item.event_type.replace('_', ' ') }}</p>
              <h3 class="text-xl sm:text-2xl font-black text-white tracking-tight leading-tight">{{ item.title }}</h3>
              <p v-if="item.project_name" class="text-white/60 text-sm font-medium mt-2">#{{ item.project_id }} {{ item.project_name }}</p>
            </div>
          </div>

          <!-- Media gallery -->
          <div v-if="item.media?.length" class="sm:px-4">
            <div
              class="sm:rounded-3xl overflow-hidden grid"
              :class="item.media.length === 1 ? '' : 'grid-cols-2 gap-0.5'"
            >
              <template v-for="(m, idx) in item.media.slice(0, 4)" :key="m.id">
                <div
                  class="relative overflow-hidden bg-[#f0f1f1]"
                  :class="[
                    item.media.length === 1 ? 'aspect-video' : 'aspect-square',
                    item.media.length === 3 && idx === 0 ? 'col-span-2' : '',
                  ]"
                >
                  <video
                    v-if="m.mediaType === 'video'"
                    :src="m.url"
                    class="w-full h-full object-cover"
                    controls playsinline preload="none"
                  />
                  <img
                    v-else
                    :src="m.thumbUrl || m.url"
                    :alt="item.title"
                    class="w-full h-full object-cover"
                    loading="lazy"
                  />
                  <span v-if="m.mediaType === 'video'" class="absolute bottom-2 right-2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-semibold">
                    {{ m.durationSec ? Math.round(m.durationSec) + 's' : 'VIDEO' }}
                  </span>
                  <span v-if="idx === 3 && item.media.length > 4" class="absolute inset-0 bg-black/40 flex items-center justify-center text-white text-xl font-bold">
                    +{{ item.media.length - 4 }}
                  </span>
                </div>
              </template>
            </div>
          </div>

          <!-- Interaction bar -->
          <div class="p-5">
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-5">
                <!-- Heart -->
                <button
                  class="flex items-center gap-1.5 transition-transform active:scale-90"
                  :class="item.reactions.find(r => r.emoji === '❤️' && r.reacted) ? 'text-[#b6004f]' : 'text-[#5a5c5c] hover:text-[#b6004f]'"
                  @click="toggleReaction(item.id, '❤️')"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" :fill="item.reactions.find(r => r.emoji === '❤️' && r.reacted) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
                  <span v-if="item.reactions.find(r => r.emoji === '❤️')?.count" class="text-xs font-bold">{{ item.reactions.find(r => r.emoji === '❤️')?.count }}</span>
                </button>
                <!-- Comment -->
                <button class="flex items-center gap-1.5 transition-transform active:scale-90 text-[#5a5c5c] hover:text-[#b6004f]" @click="toggleComments(item.id)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
                  <span v-if="item.comment_count" class="text-xs font-bold">{{ item.comment_count }}</span>
                </button>
                    </div>
            </div>

            <!-- Caption (Instagram style) -->
            <div class="space-y-2">
              <p class="text-sm leading-relaxed text-[#2d2f2f]">
                <span class="font-bold">{{ item.actor_name || 'System' }}</span>
                {{ item.body && item.body !== item.title ? ' ' + item.body : '' }}
              </p>

              <!-- Comment preview -->
              <button v-if="item.comment_count > 0 && !expandedComments.has(item.id)" class="text-xs text-[#5a5c5c] italic" @click="toggleComments(item.id)">
                See all {{ item.comment_count }} comment{{ item.comment_count > 1 ? 's' : '' }}
              </button>

              <!-- Timestamp -->
              <p class="text-[10px] text-[#acadad] font-bold uppercase tracking-tight mt-4">{{ timeAgo(item.occurred_at) }}</p>
            </div>
          </div>

          <!-- Comments -->
          <div v-if="expandedComments.has(item.id)" class="bg-[#f6f6f6] px-5 py-3">
            <div v-for="c in commentsByItem.get(item.id)" :key="c.id" class="py-2">
              <p class="text-xs text-[#5a5c5c]"><span class="font-bold text-[#2d2f2f]">{{ c.user_name }}</span> {{ c.body }}</p>
              <p class="text-[10px] text-[#acadad] mt-0.5">{{ timeAgo(c.created_at) }}</p>
            </div>
            <div class="flex gap-2 pt-2 pb-1">
              <Input
                :model-value="commentInput.get(item.id) || ''"
                @update:model-value="(v: string | number) => commentInput.set(item.id, String(v))"
                @keydown.enter="postComment(item.id)"
                placeholder="Add a comment..."
                class="text-sm h-9 bg-white border-0 rounded-xl focus-visible:ring-1 focus-visible:ring-[#acadad]/30"
              />
              <button
                class="text-sm font-bold feed-sig-text shrink-0 px-2 disabled:opacity-30"
                :disabled="!commentInput.get(item.id)?.trim() || postingComment.has(item.id)"
                @click="postComment(item.id)"
              >Post</button>
            </div>
          </div>
        </article>
      </div>

      <!-- Load more -->
      <div v-if="hasMore && !loading && items.length > 0" class="flex justify-center py-10">
        <button class="px-6 py-3 rounded-full bg-[#e1e3e3] text-sm font-semibold text-[#2d2f2f] hover:bg-[#dbdddd] active:scale-95" :disabled="loadingMore" @click="loadFeed(true)">
          {{ loadingMore ? 'Loading...' : 'Load more' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.feed-page {
  background: #f6f6f6;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}
.feed-sig-gradient { background: linear-gradient(135deg, #B6004F 0%, #FF9742 100%); }
.feed-sig-text { background: linear-gradient(135deg, #B6004F, #FF9742); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.feed-soft-shadow { box-shadow: 0px 20px 40px rgba(45, 47, 47, 0.06); }
.feed-secondary { color: #5a5c5c; }
.feed-text { color: #2d2f2f; }
.feed-muted { color: #757777; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
