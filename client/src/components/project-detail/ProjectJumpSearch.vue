<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

interface Hit {
  record_id: number
  customer_name: string
  customer_address?: string | null
  status?: string | null
}

const auth = useAuthStore()
const router = useRouter()

const open = ref(false)
const q = ref('')
const hits = ref<Hit[]>([])
const loading = ref(false)
const cursor = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
let debounceId: ReturnType<typeof setTimeout> | null = null

function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

async function runSearch(query: string) {
  if (!query.trim()) { hits.value = []; loading.value = false; return }
  loading.value = true
  try {
    const url = `/api/projects?q=${encodeURIComponent(query)}&limit=10`
    const res = await fetch(url, { headers: hdrs() })
    if (!res.ok) { hits.value = []; return }
    const data = await res.json()
    const rows = (data.projects ?? data.rows ?? data.items ?? []) as Hit[]
    hits.value = rows
    cursor.value = 0
  } finally {
    loading.value = false
  }
}

watch(q, v => {
  if (debounceId) clearTimeout(debounceId)
  debounceId = setTimeout(() => runSearch(v), 200)
})

function show() {
  open.value = true
  q.value = ''
  hits.value = []
  cursor.value = 0
  nextTick(() => inputEl.value?.focus())
}

function hide() {
  open.value = false
}

function pick(h: Hit) {
  hide()
  router.push({ name: 'project-detail', params: { id: String(h.record_id) } })
}

function onKeydown(e: KeyboardEvent) {
  // Cmd/Ctrl+K toggles palette globally
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    open.value ? hide() : show()
    return
  }
  if (!open.value) return
  if (e.key === 'Escape') { e.preventDefault(); hide(); return }
  if (e.key === 'ArrowDown') { e.preventDefault(); cursor.value = Math.min(cursor.value + 1, hits.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cursor.value = Math.max(cursor.value - 1, 0) }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const h = hits.value[cursor.value]
    if (h) pick(h)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const placeholder = computed(() => 'Search projects, customers, addresses…')

defineExpose({ show, hide })
</script>

<template>
  <!-- Trigger button — lives in the topbar -->
  <button
    class="inline-flex items-center gap-2 h-8 px-2.5 rounded-md text-xs text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
    :title="'Jump to project (⌘K)'"
    aria-label="Jump to project"
    @click="show"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
      <path d="M20 20L17 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span class="hidden md:inline">Jump to project</span>
    <span class="hidden md:inline-flex items-center gap-0.5 ml-1 px-1 py-px rounded text-[10px] font-medium border border-border text-muted-foreground bg-background/60">
      <kbd class="font-sans">⌘</kbd><kbd class="font-sans">K</kbd>
    </span>
  </button>

  <!-- Palette overlay -->
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to project"
      @click.self="hide"
    >
      <div class="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]" @click="hide" />
      <div class="relative w-full max-w-[560px] bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div class="flex items-center gap-2.5 px-4 py-3 border-b border-slate-100">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="text-slate-400">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
            <path d="M20 20L17 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <input
            ref="inputEl"
            v-model="q"
            type="text"
            inputmode="search"
            autocomplete="off"
            :placeholder="placeholder"
            class="flex-1 outline-none text-[14px] text-slate-900 placeholder:text-slate-400 bg-transparent"
          />
          <kbd class="text-[10px] text-slate-400 font-sans">esc</kbd>
        </div>

        <div class="max-h-[60vh] overflow-y-auto">
          <div v-if="loading" class="px-4 py-6 text-center text-sm text-slate-400">Searching…</div>
          <ul v-else-if="hits.length" role="listbox" class="py-1">
            <li
              v-for="(h, i) in hits"
              :key="h.record_id"
              role="option"
              :aria-selected="cursor === i"
              class="px-4 py-2.5 cursor-pointer flex items-baseline gap-3 transition-colors"
              :class="cursor === i ? 'bg-teal-50' : 'hover:bg-slate-50'"
              @mouseenter="cursor = i"
              @click="pick(h)"
            >
              <div class="flex-1 min-w-0">
                <div class="text-[14px] font-medium text-slate-900 truncate">{{ h.customer_name }}</div>
                <div class="text-[12px] text-slate-500 truncate">
                  {{ h.customer_address || '—' }}
                  <span class="ml-1 text-slate-400">·</span>
                  <span class="text-slate-400">#{{ h.record_id }}</span>
                </div>
              </div>
              <span v-if="h.status" class="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">{{ h.status }}</span>
            </li>
          </ul>
          <div v-else-if="q" class="px-4 py-6 text-center text-sm text-slate-400">
            No projects match "{{ q }}". Try a name, address, or project number.
          </div>
          <div v-else class="px-4 py-6 text-center text-sm text-slate-400">
            Type a name, address, or project number.
          </div>
        </div>

        <div class="flex items-center gap-3 px-4 py-2 border-t border-slate-100 text-[10.5px] text-slate-400">
          <span><kbd class="font-sans text-slate-500">↑ ↓</kbd> navigate</span>
          <span><kbd class="font-sans text-slate-500">↵</kbd> open</span>
          <span><kbd class="font-sans text-slate-500">esc</kbd> close</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
