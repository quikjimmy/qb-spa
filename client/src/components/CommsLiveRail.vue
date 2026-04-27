<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useCommsRail } from '@/composables/useCommsRail'
import { useDialpadLive } from '@/lib/dialpadLive'
import DialpadLivePanel from '@/components/DialpadLivePanel.vue'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'

// Floating "Live Hub" rail. On desktop it's a resizable right-side
// sidebar that sticks across page navigation. On mobile it slides up
// from the bottom as a sheet, triggered by a floating phone button.
//
// State (open + width) is persisted in localStorage via useCommsRail so
// the user's preference survives reloads.

const { open, width, toggle, setWidth, MIN_WIDTH, MAX_WIDTH } = useCommsRail()
const { visibleEvents } = useDialpadLive()

// Live event count for the FAB badge so the user knows there's something
// happening even when the rail is collapsed.
const eventCount = computed(() => visibleEvents.value.length)

// Mobile breakpoint matches Tailwind's `md`. Below this we render as a
// bottom sheet; above we render as a side rail.
const isMobile = ref(false)
function syncBreakpoint() {
  isMobile.value = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
}
let mq: MediaQueryList | null = null
onMounted(() => {
  syncBreakpoint()
  if (typeof window !== 'undefined') {
    mq = window.matchMedia('(max-width: 767px)')
    mq.addEventListener('change', syncBreakpoint)
  }
})
onBeforeUnmount(() => {
  if (mq) mq.removeEventListener('change', syncBreakpoint)
})

// Desktop resize — drag the left edge of the rail to resize. We commit
// width updates through the composable so they persist.
const dragging = ref(false)
let startX = 0
let startW = 0
function onResizeMove(e: MouseEvent) {
  if (!dragging.value) return
  const delta = startX - e.clientX  // moving left grows the rail
  setWidth(startW + delta)
}
function onResizeUp() {
  dragging.value = false
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeUp)
  document.body.style.userSelect = ''
}
function startResize(e: MouseEvent) {
  dragging.value = true
  startX = e.clientX
  startW = width.value
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeUp)
}
</script>

<template>
  <Teleport to="body">
    <!-- Desktop side rail -->
    <aside
      v-if="!isMobile && open"
      class="fixed top-0 right-0 bottom-0 z-[90] bg-background border-l shadow-2xl flex flex-col"
      :style="{ width: width + 'px' }"
    >
      <!-- Resize grip on the left edge -->
      <div
        class="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize group"
        @mousedown.prevent="startResize"
      >
        <div class="w-px h-full mx-auto bg-border group-hover:bg-primary transition-colors" :class="dragging ? 'bg-primary' : ''" />
      </div>

      <header class="px-3 py-2.5 border-b flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <component :is="DtIconPhone" class="w-4 h-4 text-primary shrink-0" />
          <p class="text-sm font-semibold truncate">Live Hub</p>
          <span v-if="eventCount > 0" class="text-[10px] tabular-nums text-muted-foreground">· {{ eventCount }}</span>
        </div>
        <button
          class="size-7 rounded-md hover:bg-muted flex items-center justify-center"
          title="Close"
          @click="toggle"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-3 min-h-0">
        <DialpadLivePanel />
      </div>

      <p class="px-3 py-1.5 border-t text-[10px] text-muted-foreground bg-muted/20">
        Drag the left edge to resize · {{ MIN_WIDTH }}–{{ MAX_WIDTH }}px
      </p>
    </aside>

    <!-- Mobile bottom sheet -->
    <template v-if="isMobile">
      <!-- Backdrop -->
      <div
        v-if="open"
        class="fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm"
        @click="toggle"
      />
      <!-- Sheet -->
      <div
        v-if="open"
        class="fixed left-0 right-0 bottom-0 z-[90] bg-background rounded-t-2xl shadow-2xl flex flex-col max-h-[80vh]"
      >
        <!-- Drag handle (visual only — tap header to close) -->
        <div class="flex justify-center pt-2 pb-1">
          <div class="w-10 h-1 rounded-full bg-muted" />
        </div>
        <header class="px-3 py-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <component :is="DtIconPhone" class="w-4 h-4 text-primary shrink-0" />
            <p class="text-sm font-semibold truncate">Live Hub</p>
            <span v-if="eventCount > 0" class="text-[10px] tabular-nums text-muted-foreground">· {{ eventCount }}</span>
          </div>
          <button
            class="size-8 rounded-md hover:bg-muted flex items-center justify-center"
            title="Close"
            @click="toggle"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>
        <div class="flex-1 overflow-y-auto p-3 min-h-0">
          <DialpadLivePanel />
        </div>
      </div>

      <!-- Floating action button — hidden when sheet is open -->
      <button
        v-if="!open"
        class="fixed bottom-4 right-4 z-[70] size-14 rounded-full bg-primary text-primary-foreground shadow-lg active:scale-95 transition-transform flex items-center justify-center"
        title="Open Live Hub"
        @click="toggle"
      >
        <component :is="DtIconPhone" class="w-6 h-6" />
        <span
          v-if="eventCount > 0"
          class="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-sky-500 text-[10px] font-bold tabular-nums flex items-center justify-center ring-2 ring-background"
        >{{ eventCount > 99 ? '99+' : eventCount }}</span>
      </button>
    </template>
  </Teleport>
</template>
