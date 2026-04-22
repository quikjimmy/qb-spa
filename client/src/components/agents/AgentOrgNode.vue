<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'

defineOptions({ name: 'AgentOrgNode' })

interface RoleNode {
  id: number
  name: string
  slug: string
  objective: string
  execution_mode: string
  department?: string | null
  status: string
  pending_approvals?: number
  latest_run?: { status?: string; created_at?: string } | null
  children?: RoleNode[]
}

const props = defineProps<{
  role: RoleNode
  selectedRoleId?: number | null
}>()

const emit = defineEmits<{
  (e: 'select', role: RoleNode): void
}>()

const runStatus = computed(() => String(props.role.latest_run?.status || 'idle'))
const isRunning = computed(() => ['queued', 'running'].includes(runStatus.value))
const hasIssue = computed(() => ['failed', 'approval_pending'].includes(runStatus.value) || Number(props.role.pending_approvals || 0) > 0)

function toneClass(): string {
  if (isRunning.value) return 'border-sky-400 bg-sky-50'
  if (hasIssue.value) return 'border-amber-400 bg-amber-50'
  if (props.role.status !== 'active') return 'border-muted bg-muted/40'
  return 'border-border bg-background'
}
</script>

<template>
  <div class="agent-org-node">
    <button
      type="button"
      class="agent-node-card"
      :class="[toneClass(), selectedRoleId === role.id ? 'ring-2 ring-primary' : '']"
      @click="emit('select', role)"
    >
      <span class="flex items-start justify-between gap-2">
        <span class="min-w-0 text-left">
          <span class="block truncate text-sm font-semibold">{{ role.name }}</span>
          <span class="block truncate text-[11px] text-muted-foreground">{{ role.department || 'Production' }}</span>
        </span>
        <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" :class="isRunning ? 'bg-sky-500' : hasIssue ? 'bg-amber-500' : 'bg-emerald-500'" />
      </span>
      <span class="mt-2 flex flex-wrap gap-1">
        <Badge variant="secondary" class="text-[10px] capitalize">{{ role.execution_mode }}</Badge>
        <Badge variant="secondary" class="text-[10px] capitalize">{{ runStatus }}</Badge>
      </span>
      <span class="mt-2 line-clamp-2 text-left text-[11px] leading-snug text-muted-foreground">{{ role.objective }}</span>
    </button>

    <div v-if="role.children?.length" class="agent-node-children">
      <AgentOrgNode
        v-for="child in role.children"
        :key="child.id"
        :role="child"
        :selected-role-id="selectedRoleId"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.agent-org-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 180px;
}

.agent-node-card {
  width: 180px;
  min-height: 126px;
  border: 1px solid;
  border-radius: 8px;
  padding: 12px;
  text-align: left;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}

.agent-node-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgb(15 23 42 / 0.08);
}

.agent-node-children {
  position: relative;
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: center;
  padding-top: 28px;
}

.agent-node-children::before {
  content: "";
  position: absolute;
  top: 10px;
  left: 50%;
  height: 18px;
  border-left: 1px solid hsl(var(--border));
}

.agent-node-children > .agent-org-node {
  position: relative;
}

.agent-node-children > .agent-org-node::before {
  content: "";
  position: absolute;
  top: -18px;
  left: 50%;
  width: calc(100% + 16px);
  border-top: 1px solid hsl(var(--border));
}

.agent-node-children > .agent-org-node:first-child::before {
  left: 50%;
  width: calc(50% + 8px);
}

.agent-node-children > .agent-org-node:last-child::before {
  right: 50%;
  left: auto;
  width: calc(50% + 8px);
}

.agent-node-children > .agent-org-node:only-child::before {
  width: 0;
}

@media (max-width: 720px) {
  .agent-org-node {
    align-items: stretch;
    min-width: 100%;
  }

  .agent-node-card {
    width: 100%;
  }

  .agent-node-children {
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
    padding-left: 16px;
    border-left: 1px solid hsl(var(--border));
  }

  .agent-node-children::before,
  .agent-node-children > .agent-org-node::before {
    display: none;
  }
}
</style>
