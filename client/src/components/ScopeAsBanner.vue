<script setup lang="ts">
// Persistent banner that shows when an admin is currently "View-as"
// scoped to a department. Pairs with ScopeAsDepartment in the header.
// Always visible across the app so an admin doesn't forget they're in
// a scoped session (which would otherwise feel like a permissions bug).
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const exiting = ref(false)

async function exit() {
  if (exiting.value) return
  exiting.value = true
  try {
    await auth.clearScope()
    window.location.reload()
  } finally {
    exiting.value = false
  }
}
</script>

<template>
  <div
    v-if="auth.isScoped && auth.scope"
    class="sticky top-14 z-30 flex items-center justify-between gap-2 px-4 py-1.5 text-[11px] bg-amber-100 text-amber-900 border-b border-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:border-amber-900/50"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-2 min-w-0">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
      <span class="truncate">
        <span class="font-semibold">Viewing as {{ auth.scope.role || auth.scope.departmentName }}</span>
        <span class="hidden sm:inline"> — admin bypass is off. Server enforces {{ auth.scope.role ? 'this role' : "this department's permissions" }} only.</span>
      </span>
    </div>
    <button
      type="button"
      class="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium bg-amber-200 hover:bg-amber-300 dark:bg-amber-900/60 dark:hover:bg-amber-900 transition-colors cursor-pointer"
      :disabled="exiting"
      @click="exit"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Exit
    </button>
  </div>
</template>
