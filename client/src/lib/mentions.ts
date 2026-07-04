// Shared @mention machinery for note/reply composers and note display.
// Server-side validation lives in feed.ts resolveMentionInputs — the
// client only tracks WHICH directory entries were picked and sends
// {type, id} pairs; names in text are never trusted on the wire.
import { ref, computed, type Ref } from 'vue'

export interface MentionTarget { type: 'user' | 'department'; id: number; name: string; member_count?: number }

export const MENTION_TAIL = /@([\w][\w .'-]{0,30})?$/

// Display heuristic for text that only exists as plain "@First Last" in
// QB: color "@Capitalized" tokens of one or two words.
const MENTION_DISPLAY_RE = /@[A-Z][a-zA-Z'’-]*(?: [A-Z][a-zA-Z'’-]*)?/g

export interface MentionSeg { text: string; mention: boolean }

export function mentionSegs(text: string): MentionSeg[] {
  const out: MentionSeg[] = []
  let last = 0
  let m: RegExpExecArray | null
  MENTION_DISPLAY_RE.lastIndex = 0
  while ((m = MENTION_DISPLAY_RE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), mention: false })
    out.push({ text: m[0], mention: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false })
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Composable: wire a text ref to the @-mention picker.
 *  - call `detect()` on the input's @input event
 *  - render `matches` while `open` is true; call `apply(t)` on pick
 *  - send `active()` as the POST `mentions` payload
 *  - `liveMentions` / `segments` drive pill highlighting */
export function useMentions(text: Ref<string>, getAuthHeaders: () => Record<string, string>) {
  const targets = ref<MentionTarget[]>([])
  let loaded = false
  async function ensureTargets() {
    if (loaded) return
    loaded = true
    try {
      const res = await fetch('/api/feed/mention-targets', { headers: getAuthHeaders() })
      if (!res.ok) { loaded = false; return }
      const data = await res.json()
      targets.value = [
        ...(data.departments || []).map((d: { id: number; name: string; member_count: number }) =>
          ({ type: 'department' as const, id: d.id, name: d.name, member_count: d.member_count })),
        ...(data.users || []).map((u: { id: number; name: string }) =>
          ({ type: 'user' as const, id: u.id, name: u.name })),
      ]
    } catch { loaded = false }
  }

  const open = ref(false)
  const query = ref('')
  const tracked = ref<MentionTarget[]>([])

  const matches = computed(() => {
    if (!open.value) return []
    const q = query.value.toLowerCase()
    return targets.value.filter(t => t.name.toLowerCase().includes(q)).slice(0, 6)
  })

  function detect() {
    const t = text.value
    const m = MENTION_TAIL.exec(t)
    if (m && (m.index === 0 || /\s/.test(t[m.index - 1] ?? ' '))) {
      open.value = true
      query.value = (m[1] || '').trim()
      ensureTargets()
    } else {
      open.value = false
    }
  }

  function apply(t: MentionTarget) {
    text.value = text.value.replace(MENTION_TAIL, `@${t.name} `)
    if (!tracked.value.some(x => x.type === t.type && x.id === t.id)) tracked.value.push(t)
    open.value = false
  }

  // Only mentions whose @Name survived edits to the final text.
  const liveMentions = computed(() =>
    tracked.value.filter(t => text.value.includes(`@${t.name}`))
  )
  function active(): Array<{ type: string; id: number }> {
    return liveMentions.value.map(t => ({ type: t.type, id: t.id }))
  }

  // Segments for the composer's highlight mirror — exact (picked names
  // only), unlike the display heuristic above.
  const segments = computed<MentionSeg[]>(() => {
    const t = text.value
    const names = liveMentions.value.map(x => x.name).sort((a, b) => b.length - a.length)
    if (!names.length) return [{ text: t, mention: false }]
    const pattern = new RegExp(`@(?:${names.map(escapeRe).join('|')})`, 'g')
    const out: MentionSeg[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(t))) {
      if (m.index > last) out.push({ text: t.slice(last, m.index), mention: false })
      out.push({ text: m[0], mention: true })
      last = m.index + m[0].length
    }
    if (last < t.length) out.push({ text: t.slice(last), mention: false })
    return out
  })

  function reset() {
    tracked.value = []
    open.value = false
    query.value = ''
  }

  return { open, matches, detect, apply, active, liveMentions, segments, reset }
}
