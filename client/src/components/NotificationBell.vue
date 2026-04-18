<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

const auth = useAuthStore()
const router = useRouter()

interface Notification {
  id: number
  type: string
  title: string
  body: string | null
  link: string | null
  is_read: number
  created_at: string
}

const notifications = ref<Notification[]>([])
const unreadCount = ref(0)
const open = ref(false)
let pollInterval: ReturnType<typeof setInterval> | null = null

function hdrs() {
  return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
}

async function fetchUnreadCount() {
  if (!auth.token) return
  try {
    const res = await fetch('/api/notifications/unread-count', { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      unreadCount.value = data.count
    }
  } catch { /* silent */ }
}

async function fetchNotifications() {
  if (!auth.token) return
  try {
    const res = await fetch('/api/notifications?limit=15', { headers: hdrs() })
    if (res.ok) {
      const data = await res.json()
      notifications.value = data.notifications
      unreadCount.value = data.unreadCount
    }
  } catch { /* silent */ }
}

async function markRead(id: number) {
  await fetch(`/api/notifications/${id}/read`, { method: 'PUT', headers: hdrs() })
  const item = notifications.value.find(n => n.id === id)
  if (item && !item.is_read) {
    item.is_read = 1
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  }
}

async function markAllRead() {
  await fetch('/api/notifications/read-all', { method: 'PUT', headers: hdrs() })
  notifications.value.forEach(n => { n.is_read = 1 })
  unreadCount.value = 0
}

function handleClick(notif: Notification) {
  markRead(notif.id)
  if (notif.link) {
    router.push(notif.link)
    open.value = false
  }
}

function onOpen(isOpen: boolean) {
  open.value = isOpen
  if (isOpen) fetchNotifications()
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const typeIcon: Record<string, string> = {
  info: 'text-blue-500',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
  agent: 'text-purple-500',
}

onMounted(() => {
  fetchUnreadCount()
  pollInterval = setInterval(fetchUnreadCount, 30000)
})

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval)
})
</script>

<template>
  <DropdownMenu @update:open="onOpen">
    <DropdownMenuTrigger as-child>
      <button class="relative inline-flex items-center justify-center size-9 rounded-md hover:bg-accent transition-colors">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        <!-- Red badge -->
        <span
          v-if="unreadCount > 0"
          class="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none"
        >
          {{ unreadCount > 99 ? '99+' : unreadCount }}
        </span>
      </button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-80 p-0">
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b">
        <p class="text-sm font-semibold">Notifications</p>
        <button
          v-if="unreadCount > 0"
          class="text-xs text-primary hover:underline"
          @click="markAllRead"
        >
          Mark all read
        </button>
      </div>

      <!-- List -->
      <div class="max-h-80 overflow-y-auto">
        <div v-if="notifications.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">
          No notifications
        </div>
        <button
          v-for="notif in notifications"
          :key="notif.id"
          class="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors flex gap-3 items-start border-b last:border-0"
          :class="!notif.is_read ? 'bg-primary/5' : ''"
          @click="handleClick(notif)"
        >
          <!-- Unread dot -->
          <span
            class="mt-1.5 size-2 rounded-full shrink-0"
            :class="!notif.is_read ? 'bg-red-500' : 'bg-transparent'"
          />
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <p class="text-sm font-medium truncate" :class="!notif.is_read ? 'text-foreground' : 'text-muted-foreground'">
                {{ notif.title }}
              </p>
              <span class="text-[10px] text-muted-foreground shrink-0">{{ timeAgo(notif.created_at) }}</span>
            </div>
            <p v-if="notif.body" class="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {{ notif.body }}
            </p>
          </div>
        </button>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
