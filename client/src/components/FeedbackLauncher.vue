<script setup lang="ts">
import { ref, computed } from 'vue'
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
    <button
      type="button"
      class="pointer-events-auto fixed bottom-4 right-4 z-50 inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl transition-all px-3.5 h-10 text-xs font-semibold active:scale-95"
      :title="'Send feedback about ' + route.path"
      @click="open = true"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Feedback
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
