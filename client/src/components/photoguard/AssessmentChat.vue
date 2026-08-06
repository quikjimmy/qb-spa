<script setup lang="ts">
// Ask questions about an assessment.
//
// Grounded in what's already on record — descriptions, verdicts, coverage
// findings — so it answers "which planes are covered?" without re-analysing
// anything. When a question is about one photo the image is attached and the
// model looks again.
//
// The conversation is stored per survey, not per session: a reviewer's
// question and the answer are part of the record, and the next person should
// see them.
import { computed, nextTick, ref, watch } from 'vue'
import { authHeaders } from '@/lib/photoguard'

const props = defineProps<{
  scope: 'submission' | 'task'
  scopeId: number
  /** When set, the question is asked about this photo and its image is sent. */
  photoId?: number | null
  photoLabel?: string | null
  compact?: boolean
}>()

interface Msg {
  id: number
  role: 'user' | 'assistant'
  content: string
  photo_id: number | null
  author: string | null
  created_at: string
}

const messages = ref<Msg[]>([])
const question = ref('')
const busy = ref(false)
const error = ref('')
const listEl = ref<HTMLElement | null>(null)

const suggestions = computed(() => props.photoId
  ? ['Why did this one fail?', 'What would make this photo acceptable?']
  : [
      'What are the most serious gaps?',
      'Which required photos are missing?',
      'Does the equipment match the design?',
    ])

async function load() {
  try {
    const r = await fetch(`/api/photoguard/chat/${props.scope}/${props.scopeId}`, { headers: authHeaders() })
    if (r.ok) messages.value = (await r.json() as { messages: Msg[] }).messages
  } catch { /* chat is additive; failing to load it shouldn't break the drawer */ }
}
watch(() => [props.scope, props.scopeId], load, { immediate: true })

async function scrollDown() {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

async function send(q?: string) {
  const text = (q ?? question.value).trim()
  if (!text || busy.value) return
  busy.value = true
  error.value = ''
  question.value = ''
  // Optimistic, so the question appears the moment it's asked.
  messages.value = [...messages.value, {
    id: -Date.now(), role: 'user', content: text,
    photo_id: props.photoId ?? null, author: 'You', created_at: new Date().toISOString(),
  }]
  void scrollDown()
  try {
    const r = await fetch(`/api/photoguard/chat/${props.scope}/${props.scopeId}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text, photoId: props.photoId ?? null }),
    })
    const data = await r.json() as { error?: string; messages?: Msg[] }
    if (!r.ok) throw new Error(data.error || `Failed (${r.status})`)
    if (data.messages) messages.value = data.messages
    void scrollDown()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not get an answer'
  } finally {
    busy.value = false
  }
}

/** Photo citations like [photo 214] are the grounding — make them visible. */
function segments(content: string): Array<{ text: string; cite: boolean }> {
  const out: Array<{ text: string; cite: boolean }> = []
  const re = /\[photo\s+(\d+)\]/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    if (m.index > last) out.push({ text: content.slice(last, m.index), cite: false })
    out.push({ text: `photo ${m[1]}`, cite: true })
    last = m.index + m[0].length
  }
  if (last < content.length) out.push({ text: content.slice(last), cite: false })
  return out
}
</script>

<template>
  <div class="grid gap-2 min-w-0">
    <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
      Ask about {{ photoId ? 'this photo' : 'this assessment' }}
    </p>

    <div
      v-if="messages.length"
      ref="listEl"
      class="grid gap-2 max-h-64 overflow-y-auto pr-1"
    >
      <div v-for="m in messages" :key="m.id" class="min-w-0">
        <p class="text-[10px] text-muted-foreground">
          {{ m.role === 'user' ? (m.author || 'Reviewer') : 'PhotoGuard AI' }}
          <span v-if="m.photo_id" class="text-sky-600">· about photo {{ m.photo_id }}</span>
        </p>
        <p
          class="text-[12px] leading-relaxed rounded-lg px-2.5 py-1.5"
          :class="m.role === 'user' ? 'bg-muted' : 'bg-card border'"
        >
          <template v-for="(seg, i) in segments(m.content)" :key="i">
            <span
              v-if="seg.cite"
              class="px-1 rounded bg-sky-100 text-sky-700 text-[11px] font-medium whitespace-nowrap"
            >{{ seg.text }}</span>
            <span v-else>{{ seg.text }}</span>
          </template>
        </p>
      </div>
    </div>

    <p v-if="busy" class="text-[11px] text-muted-foreground">Thinking…</p>
    <p v-if="error" class="text-[11px] text-rose-600">{{ error }}</p>

    <!-- Starters, so the first use isn't a blank box -->
    <div v-if="!messages.length && !busy" class="flex flex-wrap gap-1.5">
      <button
        v-for="s in suggestions" :key="s" type="button"
        class="px-2 py-0.5 rounded-full border text-[10px] font-medium bg-card hover:bg-muted cursor-pointer transition-colors"
        @click="send(s)"
      >{{ s }}</button>
    </div>

    <form class="flex gap-1.5 min-w-0" @submit.prevent="send()">
      <input
        v-model="question" type="text" :disabled="busy"
        :placeholder="photoId ? `Ask about ${photoLabel || 'this photo'}…` : 'Ask about this survey…'"
        :aria-label="photoId ? 'Ask about this photo' : 'Ask about this assessment'"
        class="flex-1 min-w-0 rounded-full border bg-background px-3 py-1.5 text-[12px]"
      />
      <button
        type="submit" :disabled="busy || !question.trim()"
        class="flex-none px-3 py-1.5 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground cursor-pointer transition-colors disabled:opacity-40"
      >Ask</button>
    </form>

    <p v-if="!compact" class="text-[10px] text-muted-foreground">
      Answers come from the assessments on record and cite the photos they rely on.
      It will say when the record doesn't answer something.
    </p>
  </div>
</template>
