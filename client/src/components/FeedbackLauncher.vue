<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const route = useRoute()
const auth = useAuthStore()

const open = ref(false)
const category = ref<'bug' | 'idea' | 'question' | ''>('')
const body = ref('')
const submitting = ref(false)
const justSent = ref(false)

// Minimized state — when collapsed, the launcher shrinks to a tiny
// edge tab (vertical pill on the right edge) that can be tapped to
// re-expand. Persisted in localStorage so the user's preference
// survives reloads.
const STORAGE_KEY = 'feedback.minimized'
const minimized = ref<boolean>(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1')
watch(minimized, (v) => {
  try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0') } catch { /* ignore */ }
})
function minimize() { minimized.value = true }
function restore() { minimized.value = false }

const canShow = computed(() => {
  if (!auth.token) return false
  const hidden = ['/login', '/register', '/invite']
  return !hidden.some(p => route.path.startsWith(p))
})

async function submit() {
  if (!body.value.trim() || submitting.value) return
  submitting.value = true
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: route.fullPath,
        category: category.value || null,
        body: body.value,
      }),
    })
    if (res.ok) {
      justSent.value = true
      body.value = ''
      category.value = ''
      setTimeout(() => { open.value = false; justSent.value = false }, 900)
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="canShow" class="pointer-events-none">
    <!-- Full launcher: pill button bottom-right with an inline ✕ to
         minimize. Click the pill body to open the dialog; click ✕ to
         collapse to the edge tab. -->
    <div
      v-if="!minimized"
      class="pointer-events-auto fixed bottom-4 right-4 z-50 inline-flex items-stretch rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl transition-all overflow-hidden"
    >
      <button
        type="button"
        class="inline-flex items-center gap-1.5 pl-3.5 pr-2.5 h-10 text-xs font-semibold active:scale-95 transition-transform"
        :title="'Send feedback about ' + route.path"
        @click="open = true"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Feedback
      </button>
      <button
        type="button"
        class="inline-flex items-center justify-center w-7 border-l border-primary-foreground/20 hover:bg-primary-foreground/10 active:bg-primary-foreground/20 transition-colors"
        title="Minimize"
        aria-label="Minimize feedback"
        @click="minimize"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <!-- Minimized state: thin vertical pill anchored to the right
         edge, mid-height, with rotated label. Tap to restore. The
         goal is "out of the way but discoverable" — tiny enough not
         to obstruct content, visible enough to find when needed. -->
    <button
      v-else
      type="button"
      class="pointer-events-auto fixed right-0 top-1/2 -translate-y-1/2 z-50 bg-primary text-primary-foreground shadow-lg hover:shadow-xl active:scale-95 transition-all rounded-l-md py-2.5 px-1.5"
      title="Show feedback launcher"
      aria-label="Show feedback launcher"
      @click="restore"
    >
      <span class="text-[10px] font-semibold uppercase tracking-widest [writing-mode:vertical-rl] [text-orientation:mixed]">Feedback</span>
    </button>

    <Dialog v-model:open="open">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            About <span class="font-mono">{{ route.fullPath }}</span>.
            Admins review this.
          </DialogDescription>
        </DialogHeader>

        <div class="grid gap-3">
          <div class="flex gap-1.5">
            <button
              v-for="c in (['bug','idea','question'] as const)" :key="c"
              type="button"
              class="flex-1 h-8 rounded-md border text-xs font-medium transition-colors capitalize"
              :class="category === c ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
              @click="category = category === c ? '' : c"
            >{{ c }}</button>
          </div>

          <div class="space-y-1.5">
            <Label for="feedback-body" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">What's on your mind?</Label>
            <textarea
              id="feedback-body"
              v-model="body"
              rows="5"
              :disabled="submitting"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
              placeholder="What did you try? What were you expecting? Anything specific to this screen?"
              @keydown.ctrl.enter="submit"
              @keydown.meta.enter="submit"
            />
            <p class="text-[10px] text-muted-foreground">⌘/Ctrl+Enter to send</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="open = false" :disabled="submitting">Cancel</Button>
          <Button
            :disabled="!body.trim() || submitting"
            @click="submit"
          >
            {{ justSent ? 'Sent ✓' : submitting ? 'Sending…' : 'Send' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
