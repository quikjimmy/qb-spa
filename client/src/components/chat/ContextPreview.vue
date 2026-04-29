<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{
  open: boolean
  threadId: number | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

const loading = ref(false)
const systemText = ref('')
const errorText = ref('')

async function load() {
  if (!props.threadId) return
  loading.value = true
  errorText.value = ''
  systemText.value = ''
  try {
    const r = await fetch(`/api/chat/threads/${props.threadId}/context-preview`, { headers: hdrs() })
    if (r.ok) {
      const data = await r.json()
      systemText.value = data.system || ''
    } else {
      errorText.value = `HTTP ${r.status}`
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : 'Failed to load'
  } finally { loading.value = false }
}

watch(() => props.open, (open) => { if (open) load() })

async function copyToClipboard() {
  try {
    await navigator.clipboard.writeText(systemText.value)
  } catch { /* ignore */ }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open"
      class="fixed inset-0 z-[60] flex items-start sm:items-center justify-center p-3 sm:p-6 pt-[8vh] sm:pt-[10vh] bg-foreground/30 backdrop-blur-md"
      @click.self="emit('close')"
      @keydown.esc="emit('close')"
    >
      <div class="w-full max-w-2xl rounded-2xl bg-card shadow-[0_30px_80px_-20px_rgba(0,0,0,0.45)] ring-1 ring-foreground/10 overflow-hidden flex flex-col max-h-[80vh]">
        <div class="px-5 pt-5 pb-3 flex items-baseline justify-between gap-3">
          <div>
            <div class="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Debug — system prompt</div>
            <p class="text-xs text-muted-foreground/70 mt-0.5">Exactly what the AI model received before generating its reply. Use this to diagnose hallucinations.</p>
          </div>
          <button
            @click="copyToClipboard"
            class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium hover:bg-foreground/[0.06] transition-colors text-muted-foreground hover:text-foreground"
            title="Copy to clipboard"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            Copy
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-5 pb-5">
          <div v-if="loading" class="py-10 text-center text-xs text-muted-foreground">Loading…</div>
          <div v-else-if="errorText" class="py-10 text-center text-xs text-destructive">{{ errorText }}</div>
          <pre v-else class="text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words bg-foreground/[0.03] rounded-xl p-4 text-foreground/85">{{ systemText }}</pre>
        </div>

        <div class="px-5 py-2.5 border-t border-foreground/[0.06] bg-foreground/[0.02] flex items-center justify-between text-[10px] text-muted-foreground/70">
          <span>Visible to admins only.</span>
          <button @click="emit('close')" class="px-2 py-0.5 rounded hover:bg-foreground/[0.06] transition-colors">Close</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
