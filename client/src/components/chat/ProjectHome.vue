<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import ProjectStatusBadge from '@/components/project-detail/ProjectStatusBadge.vue'

interface Space {
  id: number
  project_id: number
  name: string
  thread_count: number
  created_at: string
  last_used_at: string | null
}

interface Thread {
  id: number
  title: string
  space_id: number | null
  space_name: string | null
  created_at: string
  last_message_at: string | null
}

interface ProjectPreview {
  record_id: number
  customer_name: string | null
  status: string | null
  state: string | null
  system_size_kw: number | null
  sales_date: string | null
  coordinator: string | null
  closer: string | null
  lender: string | null
}

const props = defineProps<{
  space: Space
  threads: Thread[]
}>()

const emit = defineEmits<{
  (e: 'pick-thread', t: Thread): void
  (e: 'new-chat'): void
}>()

const auth = useAuthStore()
function hdrs() { return { Authorization: `Bearer ${auth.token}` } }

const project = ref<ProjectPreview | null>(null)

async function loadProject() {
  if (!props.space?.project_id) return
  try {
    const res = await fetch(`/api/chat/projects/${props.space.project_id}`, { headers: hdrs() })
    if (res.ok) project.value = await res.json()
  } catch { /* ignore — context block just won't render */ }
}

watch(() => props.space?.project_id, loadProject)
onMounted(loadProject)

const sortedThreads = computed(() =>
  [...props.threads].sort((a, b) =>
    (b.last_message_at || b.created_at).localeCompare(a.last_message_at || a.created_at)
  )
)

function fmtRelative(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

</script>

<template>
  <div class="h-full overflow-y-auto bg-gradient-to-br from-background via-background to-muted/30">
    <div class="max-w-3xl mx-auto px-4 sm:px-8 py-8 sm:py-12 space-y-8">

      <!-- Slim metadata row — outer chrome already shows the project name as title -->
      <header class="flex items-baseline justify-between gap-3 flex-wrap">
        <div class="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          <span class="font-mono tabular-nums">#{{ space.project_id }}</span>
          <span v-if="project?.state">· {{ project.state }}</span>
          <span v-if="project?.system_size_kw">· {{ project.system_size_kw }} kW</span>
        </div>
        <RouterLink :to="`/projects/${space.project_id}`" class="text-xs text-foreground/60 hover:text-foreground underline underline-offset-2">
          Open project page →
        </RouterLink>
      </header>

      <!-- Project context block -->
      <section v-if="project" class="rounded-2xl bg-card/60 backdrop-blur-sm p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <div class="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Status</div>
          <div class="mt-1.5">
            <ProjectStatusBadge :status="project.status" dot />
          </div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Coordinator</div>
          <div class="text-sm mt-1.5 truncate">{{ project.coordinator || '—' }}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Closer</div>
          <div class="text-sm mt-1.5 truncate">{{ project.closer || '—' }}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Lender</div>
          <div class="text-sm mt-1.5 truncate">{{ project.lender || '—' }}</div>
        </div>
      </section>

      <!-- New chat CTA + threads -->
      <section class="space-y-3">
        <div class="flex items-baseline justify-between">
          <h2 class="text-sm font-semibold tracking-wide">Conversations</h2>
          <span class="text-[11px] text-muted-foreground/70 tabular-nums">{{ sortedThreads.length }} thread{{ sortedThreads.length === 1 ? '' : 's' }}</span>
        </div>

        <!-- New chat tile (always first, prominent) -->
        <button
          @click="emit('new-chat')"
          class="w-full text-left p-5 rounded-2xl bg-gradient-to-br from-foreground to-foreground/85 text-background hover:opacity-95 transition-opacity flex items-center gap-4 group"
        >
          <div class="shrink-0 size-10 rounded-xl bg-background/15 flex items-center justify-center group-hover:bg-background/25 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-base">Start a new chat</div>
            <div class="text-xs opacity-70 mt-0.5">Project context is automatically attached.</div>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all shrink-0"><path d="m9 18 6-6-6-6"/></svg>
        </button>

        <!-- Existing threads -->
        <div v-if="sortedThreads.length === 0" class="text-center py-10 text-sm text-muted-foreground">
          No conversations yet. Start one above.
        </div>
        <button
          v-for="t in sortedThreads" :key="t.id"
          @click="emit('pick-thread', t)"
          class="w-full text-left p-4 rounded-2xl bg-card/40 hover:bg-foreground/[0.04] transition-colors flex items-center gap-3 group"
        >
          <div class="shrink-0 size-9 rounded-full bg-gradient-to-br from-foreground/[0.08] to-foreground/[0.04] flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-foreground/60"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium truncate">{{ t.title }}</div>
            <div class="text-[11px] text-muted-foreground/80 mt-0.5 tabular-nums">{{ fmtRelative(t.last_message_at || t.created_at) }}</div>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground/40 group-hover:text-foreground/60 group-hover:translate-x-0.5 transition-all shrink-0"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </section>

    </div>
  </div>
</template>
