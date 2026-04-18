<script setup lang="ts">
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

const route = useRoute()

const routeLabels: Record<string, string> = {
  '/': 'Home',
  '/feed': 'Feed',
  '/projects': 'Projects',
  '/agents': 'Agents',
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
</script>

<template>
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset>
      <header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
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
      <main class="flex-1 overflow-auto p-6">
        <RouterView />
      </main>
    </SidebarInset>
  </SidebarProvider>
</template>
