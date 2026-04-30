<script setup lang="ts">
// Horizontal-scrolling KPI strip used by every milestone dashboard.
// Each tile has label / value / optional sub / tone / optional click
// handler. Mirrors the inline pattern in PtoDashboardView and
// InspxDashboardView so those can migrate over without changing
// anything visible.

interface KpiTile {
  /** Internal key — also passed to the click handler so the parent can drill. */
  key: string
  /** Display label, e.g. "Need INSPX". */
  label: string
  /** Headline value — already formatted by the caller (string or number). */
  value: string | number
  /** Optional sub-label under the value, e.g. "85% pass". */
  sub?: string
  /** Color tone — drives accent bar + value color. */
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'neutral'
  /** When true, render a card-styled tile that's clickable + emits click. */
  drill?: boolean
  /** Background tint variant — set 'danger-soft' for a tile that lives
   *  on a tinted bg-red-50 card (matches the existing "Need INSPX" tile). */
  bg?: 'card' | 'danger-soft'
}

defineProps<{ tiles: KpiTile[] }>()
const emit = defineEmits<{ drill: [key: string] }>()

// Tone → { accent bar bg, value text color }. Mirrors the inline
// classes used in InspxDashboardView so migrated views look identical.
const tones: Record<NonNullable<KpiTile['tone']>, { accent: string; value: string }> = {
  info:    { accent: 'bg-blue-500',    value: 'text-blue-600' },
  success: { accent: 'bg-emerald-500', value: 'text-emerald-600' },
  warning: { accent: 'bg-amber-500',   value: 'text-amber-600' },
  danger:  { accent: 'bg-red-500',     value: 'text-red-600' },
  teal:    { accent: 'bg-teal-500',    value: 'text-teal-600' },
  neutral: { accent: 'bg-foreground',  value: 'text-foreground' },
}

function bgClass(t: KpiTile): string {
  if (t.bg === 'danger-soft') return 'bg-red-50'
  return 'bg-card'
}
</script>

<template>
  <!-- Horizontally scrollable on mobile; wraps cleanly on desktop. -->
  <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
    <component
      v-for="t in tiles"
      :key="t.key"
      :is="t.drill ? 'button' : 'div'"
      :type="t.drill ? 'button' : undefined"
      class="flex-none rounded-xl px-3 py-2 w-[105px] sm:w-[115px] text-left transition-shadow"
      :class="[
        bgClass(t),
        t.drill ? 'hover:shadow-md active:scale-[0.97] cursor-pointer' : '',
      ]"
      @click="t.drill ? emit('drill', t.key) : null"
    >
      <div
        class="h-[3px] rounded-full -mt-0.5 mb-1"
        :class="tones[t.tone ?? 'neutral'].accent"
      />
      <p
        class="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider truncate"
        :class="t.bg === 'danger-soft' ? 'text-red-600' : 'text-muted-foreground'"
      >{{ t.label }}</p>
      <p
        class="text-lg sm:text-xl font-extrabold mt-0.5"
        :class="tones[t.tone ?? 'neutral'].value"
      >{{ t.value ?? 0 }}</p>
      <p v-if="t.sub" class="text-[10px] text-muted-foreground">{{ t.sub }}</p>
    </component>
  </div>
</template>

<style scoped>
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
