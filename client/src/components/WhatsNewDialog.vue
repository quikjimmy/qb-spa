<script setup lang="ts">
// Daily "What's New" wrap-up. Fetches unseen published changelog entries
// once per app load; if any exist, shows a stepper dialog — centered card
// on desktop, bottom sheet on mobile. Closing by ANY path (Done, Skip,
// Esc, backdrop) marks everything seen server-side so it never re-nags,
// on this device or any other.

import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

interface Entry {
  id: number
  publish_date: string
  category: 'new' | 'improved' | 'fixed' | string
  title: string
  body: string
  path: string | null
  requested_by: string | null
}

const auth = useAuthStore()
const router = useRouter()

const entries = ref<Entry[]>([])
const open = ref(false)
const step = ref(0)

const CATEGORY_META: Record<string, { label: string; chip: string }> = {
  new:      { label: 'New',      chip: 'bg-sky-500/10 text-sky-600' },
  improved: { label: 'Improved', chip: 'bg-violet-500/10 text-violet-600' },
  fixed:    { label: 'Fixed',    chip: 'bg-emerald-500/10 text-emerald-600' },
}
function catMeta(c: string) { return CATEGORY_META[c] || CATEGORY_META['improved']! }

const current = computed(() => entries.value[step.value])
const dateLine = computed(() => {
  const d = entries.value[0]?.publish_date
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
})

async function load() {
  if (!auth.token) return
  try {
    const res = await fetch('/api/changelog/unseen', { headers: { Authorization: `Bearer ${auth.token}` } })
    if (!res.ok) return
    const data = await res.json() as { entries: Entry[] }
    if (data.entries.length > 0) {
      entries.value = data.entries
      // Small delay so the app shell paints first — the dialog should feel
      // like a greeting, not a roadblock.
      setTimeout(() => { open.value = true }, 600)
    }
  } catch { /* non-fatal — never block the app over the changelog */ }
}

// Closing always marks seen — a skipped wrap-up should never come back.
async function close() {
  open.value = false
  try {
    await fetch('/api/changelog/seen', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    })
  } catch { /* ignore */ }
}

function next() {
  if (step.value < entries.value.length - 1) step.value++
  else close()
}
function back() { if (step.value > 0) step.value-- }

function seeIt() {
  const path = current.value?.path
  close()
  if (path) router.push(path)
}
function viewAll() {
  close()
  router.push('/whats-new')
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') close()
  if (e.key === 'ArrowRight') next()
  if (e.key === 'ArrowLeft') back()
}

onMounted(() => {
  load()
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="wn-fade">
      <div
        v-if="open && current"
        class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
      >
        <!-- Backdrop — click closes (and marks seen). -->
        <div class="absolute inset-0 bg-black/40 backdrop-blur-[2px]" @click="close" />

        <!-- Panel: bottom sheet on mobile, centered card on sm+. -->
        <div class="relative w-full sm:max-w-md bg-card rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden wn-panel">
          <!-- Mobile grab handle -->
          <div class="sm:hidden pt-2 flex justify-center">
            <div class="h-1 w-9 rounded-full bg-muted-foreground/25" />
          </div>

          <div class="px-5 pt-4 pb-2 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">What's New</p>
              <p class="text-sm font-semibold mt-0.5">
                {{ dateLine }}
                <span class="text-muted-foreground font-normal"> · {{ entries.length }} update{{ entries.length === 1 ? '' : 's' }}</span>
              </p>
            </div>
            <button
              class="text-xs text-muted-foreground hover:text-foreground shrink-0 px-2 py-1 -mr-2"
              @click="close"
            >Skip</button>
          </div>

          <!-- Current entry -->
          <div class="px-5 py-3 min-h-[120px]">
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" :class="catMeta(current.category).chip">
              {{ catMeta(current.category).label }}
            </span>
            <h3 class="mt-2 text-[15px] font-semibold leading-snug">{{ current.title }}</h3>
            <p v-if="current.body" class="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{{ current.body }}</p>
            <p v-if="current.requested_by" class="mt-2.5 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Requested by <span class="font-semibold text-foreground">{{ current.requested_by }}</span>
            </p>
          </div>

          <!-- Footer: dots + nav. 44px touch targets on the primary actions. -->
          <div class="px-5 pb-4 sm:pb-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 flex items-center gap-2">
            <div class="flex items-center gap-1.5 mr-auto" aria-hidden="true">
              <button
                v-for="(_, i) in entries" :key="i"
                class="size-1.5 rounded-full transition-colors"
                :class="i === step ? 'bg-foreground' : 'bg-muted-foreground/25'"
                @click="step = i"
              />
            </div>
            <button
              v-if="step > 0"
              class="h-11 px-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              @click="back"
            >Back</button>
            <button
              v-if="current.path"
              class="h-11 px-4 rounded-lg text-xs font-semibold bg-muted hover:bg-muted/70 transition-colors"
              @click="seeIt"
            >See it →</button>
            <button
              class="h-11 px-5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
              @click="next"
            >{{ step < entries.length - 1 ? 'Next' : 'Done' }}</button>
          </div>

          <div class="px-5 pb-3 sm:pb-4 text-center sm:text-left">
            <button class="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2" @click="viewAll">
              View all updates
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.wn-fade-enter-active, .wn-fade-leave-active { transition: opacity 200ms ease; }
.wn-fade-enter-active .wn-panel, .wn-fade-leave-active .wn-panel { transition: transform 240ms ease; }
.wn-fade-enter-from, .wn-fade-leave-to { opacity: 0; }
.wn-fade-enter-from .wn-panel, .wn-fade-leave-to .wn-panel { transform: translateY(16px); }
@media (prefers-reduced-motion: reduce) {
  .wn-fade-enter-active, .wn-fade-leave-active,
  .wn-fade-enter-active .wn-panel, .wn-fade-leave-active .wn-panel { transition: none; }
}
</style>
