<script setup lang="ts">
import { ref, provide, watch } from 'vue'
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
import { useDialpadLive, unlockAudio } from '@/lib/dialpadLive'

// Initialize the singleton Dialpad live connection at the app shell level
// so ringing alerts pop no matter which view is active. useDialpadLive()
// is idempotent — if a child component also calls it, they share one SSE.
useDialpadLive()
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
    <SidebarInset>
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
        <div class="ml-auto">
          <NotificationBell />
        </div>
      </header>
      <main ref="mainEl" class="flex-1 overflow-auto px-3 py-4 sm:p-6 relative">
        <!-- Pull-to-refresh indicator -->
        <div
          v-if="pullDistance > 0 || isRefreshing"
          class="flex justify-center py-2 transition-all duration-200 -mt-4 sm:-mt-6 mb-2"
          :style="{ transform: `translateY(${Math.min(pullDistance, 60)}px)`, opacity: Math.min(pullDistance / 40, 1) }"
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
  </SidebarProvider>
</template>
