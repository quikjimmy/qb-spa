<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useTicketBadgesStore } from '@/stores/ticketBadges'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import {
  CollapsibleRoot as Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'reka-ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

const route = useRoute()
const auth = useAuthStore()
const ticketBadges = useTicketBadgesStore()

onMounted(() => ticketBadges.startPolling())

const initials = computed(() => {
  if (!auth.user?.name) return '?'
  return auth.user.name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
})

const navTop = [
  { label: 'Home', to: '/', icon: 'home' },
  { label: 'Feed', to: '/feed', icon: 'feed' },
]

const navBottom = [
  { label: 'Comms Hub', to: '/comms', icon: 'phone' },
  { label: 'Agent Ops', to: '/agents', icon: 'bot' },
  { label: 'Tickets', to: '/tickets', icon: 'ticket' },
]

const projectSubItems = [
  { label: 'All Projects', to: '/projects' },
  { label: 'PC Dashboard', to: '/projects/pc' },
  { label: 'Field', to: '/projects/field' },
  { label: 'Inspections', to: '/projects/inspections' },
  { label: 'PTO', to: '/projects/pto' },
]

const projectsOpen = computed(() => route.path.startsWith('/projects'))

const adminItems = [
  { label: 'Users & Roles', to: '/admin', icon: 'users' },
]

function isActive(path: string) {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}
</script>

<template>
  <Sidebar collapsible="icon">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" as-child>
            <RouterLink to="/">
              <img src="/img/Kin - Square Profile-white-black.png" alt="Kin Home" class="size-8 rounded-lg" />
              <div class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-semibold">Kin Home</span>
                <span class="truncate text-xs text-sidebar-foreground/60">Operations Portal</span>
              </div>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>Navigation</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <!-- Home, Feed -->
            <SidebarMenuItem v-for="item in navTop" :key="item.to">
              <SidebarMenuButton as-child :is-active="isActive(item.to)">
                <RouterLink :to="item.to">
                  <svg v-if="item.icon === 'home'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                  <svg v-if="item.icon === 'feed'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
                  <span>{{ item.label }}</span>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <!-- Projects (collapsible with sub-menu) -->
            <Collapsible as-child :default-open="projectsOpen">
              <SidebarMenuItem>
                <CollapsibleTrigger as-child>
                  <SidebarMenuButton :is-active="projectsOpen">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
                    <span class="flex-1">Projects</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-200" :class="projectsOpen ? 'rotate-90' : ''"><path d="m9 18 6-6-6-6"/></svg>
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem v-for="sub in projectSubItems" :key="sub.to">
                      <SidebarMenuSubButton as-child :is-active="route.path === sub.to">
                        <RouterLink :to="sub.to">{{ sub.label }}</RouterLink>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>

            <!-- Agents, Tickets -->
            <SidebarMenuItem v-for="item in navBottom" :key="item.to">
              <SidebarMenuButton as-child :is-active="isActive(item.to)">
                <RouterLink :to="item.to">
                  <svg v-if="item.icon === 'phone'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                  <svg v-if="item.icon === 'bot'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
                  <svg v-if="item.icon === 'ticket'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>
                  <span class="flex-1">{{ item.label }}</span>
                  <template v-if="item.to === '/tickets'">
                    <span class="inline-flex items-center gap-0.5 ml-auto">
                      <span
                        class="min-w-[18px] h-[18px] px-1 rounded-l-full text-[10px] font-bold inline-flex items-center justify-center"
                        :class="ticketBadges.overdue > 0 ? 'bg-red-500 text-white' : 'bg-sidebar-accent text-sidebar-foreground/40'"
                        title="Past due"
                      >{{ ticketBadges.overdue }}</span>
                      <span class="text-[8px] text-sidebar-foreground/20">|</span>
                      <span
                        class="min-w-[18px] h-[18px] px-1 rounded-r-full text-[10px] font-bold inline-flex items-center justify-center"
                        :class="ticketBadges.dueToday > 0 ? 'bg-amber-400 text-white' : 'bg-sidebar-accent text-sidebar-foreground/40'"
                        title="Due today"
                      >{{ ticketBadges.dueToday }}</span>
                    </span>
                  </template>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup v-if="auth.isAdmin">
        <SidebarGroupLabel>Admin</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem v-for="item in adminItems" :key="item.to">
              <SidebarMenuButton
                as-child
                :is-active="isActive(item.to)"
              >
                <RouterLink :to="item.to">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                  <span>{{ item.label }}</span>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <SidebarMenuButton size="lg" class="w-full">
                <Avatar class="h-8 w-8 rounded-lg">
                  <AvatarFallback class="rounded-lg text-xs">{{ initials }}</AvatarFallback>
                </Avatar>
                <div class="grid flex-1 text-left text-sm leading-tight">
                  <span class="truncate font-semibold">{{ auth.user?.name }}</span>
                  <span class="truncate text-xs text-muted-foreground">{{ auth.user?.email }}</span>
                </div>
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" class="w-56">
              <DropdownMenuItem disabled class="text-xs text-muted-foreground">
                {{ auth.user?.roles?.join(', ') || 'No roles' }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem as-child>
                <RouterLink to="/settings" class="cursor-pointer w-full">Settings</RouterLink>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem @click="auth.logout()">
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>

    <SidebarRail />
  </Sidebar>
</template>
