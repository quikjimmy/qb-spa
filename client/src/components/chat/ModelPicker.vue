<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

interface ModelOption { id: string; label: string; tier?: string }
interface ProviderGroup {
  provider: 'anthropic' | 'openai' | 'ollama'
  provider_label: string
  using_own_key: boolean
  models: ModelOption[]
}

const props = defineProps<{
  open: boolean
  // Currently active model (so we can mark it)
  currentProvider?: string | null
  currentModel?: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', sel: { provider: ProviderGroup['provider']; model: string }): void
}>()

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

const providers = ref<ProviderGroup[]>([])
const loading = ref(false)
const query = ref('')
const queryEl = ref<HTMLInputElement | null>(null)
const highlight = ref(0)

interface FlatRow { provider: ProviderGroup['provider']; provider_label: string; using_own_key: boolean; model: ModelOption }

const flatList = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  for (const grp of providers.value) {
    for (const m of grp.models) {
      out.push({ provider: grp.provider, provider_label: grp.provider_label, using_own_key: grp.using_own_key, model: m })
    }
  }
  return out
})

const filtered = computed<FlatRow[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return flatList.value
  return flatList.value.filter(r =>
    r.model.id.toLowerCase().includes(q) ||
    r.model.label.toLowerCase().includes(q) ||
    r.provider_label.toLowerCase().includes(q)
  )
})

async function load() {
  loading.value = true
  try {
    const res = await fetch('/api/chat/models', { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      providers.value = data.providers || []
    }
  } finally { loading.value = false }
}

watch(() => props.open, (open) => {
  if (open) {
    query.value = ''
    highlight.value = 0
    load()
    nextTick(() => queryEl.value?.focus())
  }
})

function pick(row: FlatRow) {
  emit('pick', { provider: row.provider, model: row.model.id })
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { emit('close'); return }
  if (!filtered.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlight.value = (highlight.value + 1) % filtered.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlight.value = (highlight.value - 1 + filtered.value.length) % filtered.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const row = filtered.value[highlight.value]
    if (row) pick(row)
  }
}

function isActive(row: FlatRow): boolean {
  return props.currentProvider === row.provider && props.currentModel === row.model.id
}

function tierBadge(tier?: string): { label: string; cls: string } | null {
  if (!tier) return null
  if (tier === 'fast') return { label: 'Fast', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' }
  if (tier === 'balanced') return { label: 'Balanced', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' }
  if (tier === 'powerful') return { label: 'Powerful', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300' }
  return { label: tier, cls: 'bg-foreground/[0.06] text-foreground/70' }
}

onMounted(() => { if (props.open) load() })
</script>

<template>
  <Teleport to="body">
    <div v-if="open"
      class="fixed inset-0 z-[60] flex items-start sm:items-center justify-center p-3 sm:p-6 pt-[10vh] sm:pt-[12vh] bg-foreground/30 backdrop-blur-md"
      @click.self="emit('close')"
      @keydown="onKey"
    >
      <div class="w-full max-w-xl rounded-2xl bg-card shadow-[0_30px_80px_-20px_rgba(0,0,0,0.45)] ring-1 ring-foreground/10 overflow-hidden flex flex-col max-h-[70vh]">
        <div class="px-5 pt-5 pb-1">
          <div class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Choose model</div>
          <p class="text-xs text-muted-foreground/70 mt-0.5">Pick which AI model handles this thread. Persists across messages until you change it again.</p>
        </div>

        <div class="px-5 pt-3 pb-3">
          <div class="relative">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              ref="queryEl"
              v-model="query"
              @keydown="onKey"
              placeholder="Filter models…"
              class="w-full h-11 rounded-xl bg-foreground/[0.04] pl-10 pr-3 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:bg-foreground/[0.06] transition-colors"
            />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto px-2 pb-2 min-h-[140px]">
          <div v-if="loading" class="py-6 text-center text-xs text-muted-foreground">
            <span class="inline-flex gap-1.5">
              <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 0ms"></span>
              <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 120ms"></span>
              <span class="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style="animation-delay: 240ms"></span>
            </span>
          </div>

          <div v-else-if="flatList.length === 0" class="py-10 px-6 text-center">
            <p class="text-sm text-muted-foreground">No providers configured.</p>
            <p class="text-[11px] text-muted-foreground/60 mt-1">Add an API key in <RouterLink to="/settings" class="underline underline-offset-2">Settings</RouterLink> to unlock models.</p>
          </div>

          <div v-else-if="filtered.length === 0" class="py-10 px-6 text-center">
            <p class="text-sm text-muted-foreground">No models match "<span class="font-medium text-foreground/80">{{ query }}</span>".</p>
          </div>

          <button v-else v-for="(row, idx) in filtered" :key="`${row.provider}:${row.model.id}`"
            @click="pick(row)"
            @mouseenter="highlight = idx"
            class="w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 transition-colors"
            :class="highlight === idx ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]'"
          >
            <div class="shrink-0 size-9 rounded-lg bg-gradient-to-br from-foreground/[0.08] to-foreground/[0.04] flex items-center justify-center">
              <span class="text-[9px] uppercase tracking-widest font-semibold text-foreground/50">{{ row.provider.slice(0, 3) }}</span>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2">
                <div class="text-sm font-medium truncate">{{ row.model.label }}</div>
                <span v-if="isActive(row)" class="text-[10px] uppercase tracking-widest font-semibold text-emerald-700 dark:text-emerald-300 shrink-0">Active</span>
              </div>
              <div class="text-[11px] text-muted-foreground/80 mt-0.5 flex items-center gap-1.5 flex-wrap">
                <span>{{ row.provider_label }}</span>
                <span class="text-muted-foreground/50">·</span>
                <span class="font-mono">{{ row.model.id }}</span>
                <span v-if="!row.using_own_key" class="text-muted-foreground/50">· platform</span>
                <span v-else class="text-emerald-600 dark:text-emerald-400">· your key</span>
              </div>
            </div>
            <span v-if="tierBadge(row.model.tier)" class="ml-auto inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium" :class="tierBadge(row.model.tier)!.cls">
              {{ tierBadge(row.model.tier)!.label }}
            </span>
          </button>
        </div>

        <div class="px-5 py-2.5 border-t border-foreground/[0.06] bg-foreground/[0.02] flex items-center justify-between text-[10px] text-muted-foreground/70">
          <div class="flex items-center gap-3">
            <span class="hidden sm:inline-flex items-center gap-1"><kbd class="px-1.5 py-0.5 rounded bg-foreground/10 font-mono text-[10px]">↑↓</kbd> navigate</span>
            <span class="hidden sm:inline-flex items-center gap-1"><kbd class="px-1.5 py-0.5 rounded bg-foreground/10 font-mono text-[10px]">↵</kbd> select</span>
            <span class="inline-flex items-center gap-1"><kbd class="px-1.5 py-0.5 rounded bg-foreground/10 font-mono text-[10px]">esc</kbd> close</span>
          </div>
          <span v-if="filtered.length" class="tabular-nums">{{ filtered.length }} model{{ filtered.length === 1 ? '' : 's' }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
