<script setup lang="ts">
import { computed } from 'vue'
import SectionCard from './SectionCard.vue'

export interface AttentionItem {
  sev: 'warn' | 'info' | 'soft'
  icon: string
  title: string
  who?: string
  age?: string
  href?: string
}

const props = defineProps<{ items: AttentionItem[] }>()

const sevBg: Record<string, string> = { warn: '#fef3c7', info: '#dbeafe', soft: '#f1f5f9' }
const sevFg: Record<string, string> = { warn: '#92400e', info: '#1d4ed8', soft: '#334155' }

const visible = computed(() => props.items)
</script>

<template>
  <SectionCard title="What needs attention" :count="visible.length" no-padding>
    <div class="px-4 pb-3">
      <div
        v-for="(it, i) in visible"
        :key="i"
        class="flex items-start gap-2.5 py-2.5"
        :class="i < visible.length - 1 ? 'border-b' : ''"
        style="border-color: #e6dfd6;"
      >
        <div
          class="size-7 rounded-lg flex items-center justify-center text-sm shrink-0"
          :style="{ background: sevBg[it.sev], color: sevFg[it.sev] }"
        >{{ it.icon }}</div>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-medium text-slate-900 leading-snug">{{ it.title }}</div>
          <div v-if="it.who || it.age" class="text-[11px] text-slate-500 mt-0.5">
            {{ [it.who, it.age].filter(Boolean).join(' · ') }}
          </div>
        </div>
        <a
          v-if="it.href"
          :href="it.href"
          class="text-teal-700 font-medium text-xs hover:underline shrink-0 cursor-pointer"
        >Open →</a>
      </div>
      <div v-if="!visible.length" class="text-xs text-slate-500 py-3 text-center">
        Nothing needs attention right now.
      </div>
    </div>
  </SectionCard>
</template>
