<script setup lang="ts">
import { ref, provide, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRoute } from 'vue-router'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import AppSidebar from '@/components/AppSidebar.vue'
import NotificationBell from '@/components/NotificationBell.vue'
import FeedbackLauncher from '@/components/FeedbackLauncher.vue'
import GlobalIncomingCallAlert from '@/components/GlobalIncomingCallAlert.vue'
import CommsLiveRail from '@/components/CommsLiveRail.vue'
import { useDialpadLive, unlockAudio } from '@/lib/dialpadLive'
import { useCommsRail } from '@/composables/useCommsRail'
import DtIconPhone from '@dialpad/dialtone-icons/vue3/phone'

// Initialize the singleton Dialpad live connection at the app shell level
// so ringing alerts pop no matter which view is active. useDialpadLive()
// is idempotent — if a child component also calls it, they share one SSE.
const { visibleEvents } = useDialpadLive()
const { open: railOpen, toggle: toggleRail, width: railWidth } = useCommsRail()

// Track desktop vs mobile so we only reserve right-side padding for the
// rail on screens where it renders as a side rail (md+). Mobile renders
// it as a bottom sheet that floats above content with no offset needed.
const isDesktop = ref(false)
function syncBp() {
  isDesktop.value = typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
}
let mq: MediaQueryList | null = null
onMounted(() => {
  syncBp()
  if (typeof window !== 'undefined') {
    mq = window.matchMedia('(min-width: 768px)')
    mq.addEventListener('change', syncBp)
  }
})
onBeforeUnmount(() => {
  if (mq) mq.removeEventListener('change', syncBp)
})
const railPadding = computed(() => (railOpen.value && isDesktop.value ? `${railWidth.value}px` : '0px'))
// Browsers require a user gesture before the audio context can start. Any
// click anywhere in the shell unlocks it once.
function unlockOnFirstGesture() {
  unlockAudio()
  window.removeEventListener('click', unlockOnFirstGesture)
  window.removeEventListener('keydown', unlockOnFirstGesture)
}
window.addEventListener('click', unlockOnFirstGesture)
window.addEventListener('keydown', unlockOnFirstGesture)
import { usePullToRefresh } from '@/composables/usePullToRefresh'

const route = useRoute()
const mainEl = ref<HTMLElement | null>(null)

const routeLabels: Record<string, string> = {
  '/': 'Home',
  '/feed': 'Feed',
  '/projects': 'Projects',
  '/projects/inspections': 'Inspections',
  '/projects/pto': 'PTO',
  '/projects/pc': 'PC Dashboard',
  '/projects/field': 'Field',
  '/agents': 'Agent Ops',
  '/tickets': 'Tickets',
  '/admin': 'Admin',
}

function getBreadcrumbs() {
  const path = route.path
  if (path === '/') return [{ label: 'Home', href: '' }]

  const segments = path.split('/').filter(Boolean)
  const crumbs: Array<{ label: string; href: string }> = []

  let built = ''
  for (const seg of segments) {
    built += `/${seg}`
    crumbs.push({
      label: routeLabels[built] || seg.charAt(0).toUpperCase() + seg.slice(1),
      href: built,
    })
  }
  return crumbs
}

// Pull-to-refresh: each view registers its refresh fn
let registeredRefresh: (() => Promise<void>) | null = null

function registerRefresh(fn: () => Promise<void>) {
  registeredRefresh = fn
}

// Clear on route change
watch(() => route.path, () => { registeredRefresh = null })

provide('registerRefresh', registerRefresh)

const { pullDistance, isRefreshing } = usePullToRefresh(mainEl, async () => {
  if (registeredRefresh) await registeredRefresh()
})
</script>

<template>
  <SidebarProvider>
    <AppSidebar />
    <!-- When the desktop Live Hub rail is open we reserve space on the
         right so it doesn't overlap content. Bottom sheet on mobile sits
         above the layout and doesn't need this offset. -->
    <SidebarInset
      class="transition-[padding] duration-200"
      :style="{ paddingRight: railPadding }"
    >
      <header class="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b px-4 bg-background">
        <SidebarTrigger class="-ml-1" />
        <Separator orientation="vertical" class="mr-2 h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            <template v-for="(crumb, i) in getBreadcrumbs()" :key="crumb.href">
              <BreadcrumbSeparator v-if="i > 0" />
              <BreadcrumbItem>
                <BreadcrumbLink v-if="i < getBreadcrumbs().length - 1" :href="crumb.href">
                  {{ crumb.label }}
                </BreadcrumbLink>
                <BreadcrumbPage v-else>{{ crumb.label }}</BreadcrumbPage>
              </BreadcrumbItem>
            </template>
          </BreadcrumbList>
        </Breadcrumb>
        <div class="ml-auto flex items-center gap-1">
          <!-- Live Hub toggle — sits next to the bell on every breakpoint
               so the mobile entry point doesn't collide with the feedback
               FAB. Badge shows current live event count so users have an
               at-a-glance "is something happening?" cue. -->
          <button
            class="relative inline-flex items-center justify-center size-8 rounded-md transition-colors"
            :class="railOpen ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
            :title="railOpen ? 'Close Live Hub' : 'Open Live Hub'"
            @click="toggleRail"
          >
            <component :is="DtIconPhone" class="w-4 h-4" />
            <span
              v-if="visibleEvents.length > 0 && !railOpen"
              class="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full bg-sky-500 text-white text-[9px] font-bold tabular-nums flex items-center justify-center ring-2 ring-background"
            >{{ visibleEvents.length > 99 ? '99+' : visibleEvents.length }}</span>
          </button>
          <NotificationBell />
        </div>
      </header>
      <main ref="mainEl" class="flex-1 overflow-auto px-3 py-4 sm:p-6 relative">
        <!-- Pull-to-refresh indicator. Opacity ramps up only after the
             dead zone (handled in the composable) — by the time the user
             sees the spinner appearing, the pull has clearly started. -->
        <div
          v-if="pullDistance > 0 || isRefreshing"
          class="flex justify-center py-2 transition-all duration-200 -mt-4 sm:-mt-6 mb-2 pointer-events-none"
          :style="{ transform: `translateY(${Math.min(pullDistance, 80)}px)`, opacity: Math.min(pullDistance / 90, 1) }"
        >
          <div class="size-6 rounded-full border-2 border-muted-foreground/30 border-t-foreground" :class="isRefreshing ? 'animate-spin' : ''" />
        </div>
        <RouterView />
      </main>
    </SidebarInset>
    <FeedbackLauncher />
    <!-- Sits above everything else; inner component is absent until a live
         ringing event arrives, so zero cost on render when idle. -->
    <GlobalIncomingCallAlert />
    <!-- Persistent Live Hub — desktop right rail, mobile bottom sheet.
         Toggled via the topbar phone button (desktop) or floating FAB
         (mobile). Hidden by default until the user opens it. -->
    <CommsLiveRail />
  </SidebarProvider>
</template>
