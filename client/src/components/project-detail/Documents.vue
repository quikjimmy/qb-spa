<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import SectionCard from './SectionCard.vue'

interface Props { projectRid: number }
const props = defineProps<Props>()

interface Attachment {
  record_id: number
  project_rid: number
  date_created: string | null
  file_name: string | null
  file_blob: string | null
  link_url: string | null
  attachment_type: string | null
  display_image: number | null
  related_note: number | null
  related_survey: number | null
  related_sales_task_submission: number | null
  related_sales_task: number | null
  related_ticket: number | null
  related_interconnection: number | null
  related_permit: number | null
}

interface LinkPreview { image: string | null; title: string | null; site: string | null; favicon: string | null }

const auth = useAuthStore()
const items = ref<Attachment[]>([])
const loading = ref(true)
const errorMsg = ref('')
const filter = ref<string>('all')
const search = ref<string>('')

// Per-link preview cache, keyed by URL. Each row only fetches once.
const previews = ref<Record<string, LinkPreview>>({})

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/attachments?project_id=${props.projectRid}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    items.value = (data.items as Attachment[]) ?? []
    // Kick off lazy preview fetches for any external link rows
    for (const a of items.value) {
      if (a.link_url && !previews.value[a.link_url]) fetchPreview(a.link_url)
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
async function fetchPreview(url: string) {
  // Mark as in-flight so duplicate rows don't re-trigger
  previews.value[url] = { image: null, title: null, site: null, favicon: null }
  try {
    const r = await fetch(`/api/attachments/preview?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!r.ok) return
    const data = await r.json() as LinkPreview
    previews.value[url] = data
  } catch { /* swallow — leave fallback empty */ }
}

onMounted(load)
watch(() => props.projectRid, load)

function fmtDate(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function ext(name: string | null | undefined): string {
  if (!name) return ''
  const m = name.match(/\.([a-zA-Z0-9]+)$/)
  return (m?.[1] ?? '').toLowerCase()
}

function isImage(a: Attachment): boolean {
  if (a.display_image === 1) return true
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext(a.file_name))
}

function fileTypeLabel(a: Attachment): string {
  const e = ext(a.file_name)
  if (!e) return 'FILE'
  return e.toUpperCase()
}

const QB_REALM = 'kin.quickbase.com'
function attachmentHref(a: Attachment): string {
  // External link wins — it's the actual content. Otherwise open the QB
  // attachment record so the user can click the file there (browser auth
  // handles the download).
  if (a.link_url) return a.link_url
  return `https://${QB_REALM}/db/br9kwm8ke?a=dr&rid=${a.record_id}`
}

// Referral Agents have no Quickbase access — for internal attachments (which
// only have a QB-record link) render the row as plain text (no href) rather
// than a click-through into QB. External document links still open normally.
function rowHref(a: Attachment): string | undefined {
  if (auth.isReferralAgent && !a.link_url) return undefined
  return attachmentHref(a)
}

function isExternal(a: Attachment): boolean {
  return !!a.link_url && !a.file_name
}

function domainOf(url: string | null | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// Filter chips — derived from the attachment_type values present in the data.
const types = computed<string[]>(() => {
  const counts = new Map<string, number>()
  for (const a of items.value) {
    const t = (a.attachment_type ?? '').trim()
    if (!t) continue
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
  return sorted
})

const filtered = computed<Attachment[]>(() => {
  const q = search.value.trim().toLowerCase()
  return items.value.filter(a => {
    if (filter.value !== 'all' && (a.attachment_type ?? '') !== filter.value) return false
    if (q) {
      const hay = `${a.file_name ?? ''} ${a.attachment_type ?? ''} ${a.link_url ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

// Show context badge if attachment is linked through a related entity
// (Permit, NEM, Survey, Note, Ticket, Sales Task) rather than directly to
// the project. Helps explain why the file is here.
function relatedContext(a: Attachment): string {
  if (a.related_permit) return 'Permit'
  if (a.related_interconnection) return 'NEM'
  if (a.related_survey) return 'Survey'
  if (a.related_note) return 'Note'
  if (a.related_ticket) return 'Ticket'
  if (a.related_sales_task_submission) return 'Sales Task'
  if (a.related_sales_task) return 'Sales Task'
  return ''
}
</script>

<template>
  <SectionCard title="Documents" :count="items.length" no-padding>
    <!-- Toolbar: filter chips + search -->
    <div v-if="items.length" class="px-4 pb-2 flex flex-col gap-1.5">
      <div class="flex items-center gap-1.5 overflow-x-auto" style="scrollbar-width: none;">
        <button
          type="button"
          class="rounded-full px-2.5 py-1 font-medium text-[11px] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          :class="filter === 'all' ? 'bg-teal-700 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'"
          @click="filter = 'all'"
        >All</button>
        <button
          v-for="t in types"
          :key="t"
          type="button"
          class="rounded-full px-2.5 py-1 font-medium text-[11px] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          :class="filter === t ? 'bg-teal-700 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'"
          @click="filter = t"
        >{{ t }}</button>
      </div>
      <input
        v-model="search"
        type="search"
        inputmode="search"
        placeholder="Search documents…"
        class="h-7 px-2.5 text-[12px] rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-transparent"
      />
    </div>

    <!-- States -->
    <div v-if="loading" class="px-4 pb-4 text-[12px] text-slate-400">Loading documents…</div>
    <div v-else-if="errorMsg" class="px-4 pb-4 text-[12px] text-rose-600">{{ errorMsg }}</div>
    <div v-else-if="!items.length" class="px-4 pb-4 text-[12px] text-slate-400">No documents on this project.</div>
    <div v-else-if="!filtered.length" class="px-4 pb-4 text-[12px] text-slate-400">No documents match this filter.</div>

    <!-- List -->
    <ul v-else class="px-4 pb-3.5 divide-y" style="--tw-divide-opacity:1; border-color:#e6dfd6;">
      <li
        v-for="a in filtered"
        :key="a.record_id"
        class="py-2.5"
      >
        <a
          :href="rowHref(a)"
          target="_blank"
          rel="noopener"
          class="flex items-center gap-3 group"
          :class="rowHref(a) ? 'cursor-pointer' : 'cursor-default'"
          :title="(a.link_url || a.file_name) ?? 'Document'"
        >
          <!-- Thumbnail / type chip -->
          <div class="size-9 rounded-md bg-slate-50 flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-slate-100">
            <!-- External link with og:image preview -->
            <img
              v-if="a.link_url && previews[a.link_url]?.image"
              :src="previews[a.link_url]!.image!"
              :alt="previews[a.link_url]!.title ?? domainOf(a.link_url)"
              class="size-full object-cover"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <!-- Favicon fallback for any link without an og:image -->
            <img
              v-else-if="a.link_url"
              :src="previews[a.link_url]?.favicon ?? `https://www.google.com/s2/favicons?domain=${domainOf(a.link_url)}&sz=64`"
              :alt="domainOf(a.link_url)"
              class="size-5 object-contain"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <!-- Internal file: file-extension chip (image thumbnails would
                 require a server-side QB file proxy, deferred for now) -->
            <span v-else class="text-[9px] font-bold tracking-wider text-slate-500">{{ fileTypeLabel(a) }}</span>
          </div>

          <div class="flex-1 min-w-0">
            <div class="text-[13px] text-slate-800 group-hover:text-teal-700 truncate">
              <template v-if="a.link_url">
                {{ previews[a.link_url]?.title || a.file_name || domainOf(a.link_url) }}
              </template>
              <template v-else>
                {{ a.file_name || `Attachment #${a.record_id}` }}
              </template>
            </div>
            <div class="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500">
              <span v-if="a.link_url" class="truncate text-slate-400">{{ domainOf(a.link_url) }}</span>
              <span v-if="a.attachment_type" class="truncate">{{ a.attachment_type }}</span>
              <span v-if="relatedContext(a)" class="text-[10px] uppercase tracking-wider px-1 py-px rounded bg-slate-100 text-slate-500 shrink-0">
                {{ relatedContext(a) }}
              </span>
              <span class="ml-auto tabular-nums text-slate-400 shrink-0">{{ fmtDate(a.date_created) }}</span>
            </div>
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" class="text-slate-300 group-hover:text-teal-600 shrink-0">
            <path d="M14 4H20V10M20 4L10 14M19 14V19C19 19.6 18.6 20 18 20H5C4.4 20 4 19.6 4 19V6C4 5.4 4.4 5 5 5H10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </a>
      </li>
    </ul>
  </SectionCard>
</template>
