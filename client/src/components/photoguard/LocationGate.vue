<script setup lang="ts">
// Compact location indicator.
//
// Deliberately a single line, not a banner. The geofence anchors on the
// project's own coordinates from Quickbase, so device location is a secondary
// signal — it fills in provenance for photos whose EXIF has been stripped.
// Getting it is worth one quiet nudge, not a card that pushes the actual work
// off screen. Tapping expands the recovery steps, since a denial can only be
// undone in browser/OS settings.
import { computed, ref } from 'vue'
import { recoverySteps, type LocationState, type Fix } from '@/lib/geolocation'

const props = defineProps<{
  state: LocationState
  fix: Fix | null
  error: string
  requesting: boolean
  coarse: boolean
}>()

const emit = defineEmits<{ (e: 'request'): void }>()

const expanded = ref(false)

const label = computed(() => {
  switch (props.state) {
    case 'granted':
      return props.coarse
        ? `Location rough (~${Math.round(props.fix?.accuracy ?? 0)}m)`
        : `Location on (~${Math.round(props.fix?.accuracy ?? 0)}m)`
    case 'prompt': return 'Location off'
    case 'denied': return 'Location blocked'
    case 'insecure': return 'Location unavailable on http'
    case 'unsupported': return 'Location not supported'
    default: return 'Location unavailable'
  }
})

const dotClass = computed(() => {
  if (props.state === 'granted') return props.coarse ? 'bg-amber-500' : 'bg-emerald-500'
  if (props.state === 'prompt') return 'bg-slate-300'
  return 'bg-amber-500'
})

const textClass = computed(() => {
  if (props.state === 'granted' && !props.coarse) return 'text-emerald-600'
  if (props.state === 'prompt') return 'text-muted-foreground'
  return 'text-amber-600'
})

// Only a live prompt can be resolved in-page; everything else needs settings.
const canAsk = computed(() =>
  props.state === 'prompt' || props.state === 'error' ||
  (props.state === 'granted' && props.coarse))

const canExplain = computed(() => props.state === 'denied' || props.state === 'insecure')
</script>

<template>
  <div class="min-w-0">
    <p class="flex flex-wrap items-center gap-1.5 text-[11px]" :class="textClass">
      <span class="inline-block size-1.5 rounded-full flex-none" :class="dotClass" />
      <span>{{ label }}</span>

      <button
        v-if="canAsk" type="button" :disabled="requesting"
        class="underline underline-offset-2 font-medium disabled:opacity-50"
        @click="emit('request')"
      >{{ requesting ? 'checking…' : state === 'prompt' ? 'turn on' : 'retry' }}</button>

      <button
        v-else-if="canExplain" type="button"
        class="underline underline-offset-2 font-medium"
        @click="expanded = !expanded"
      >{{ expanded ? 'hide' : 'why?' }}</button>

      <span v-if="state !== 'granted'" class="text-muted-foreground">
        · photos still upload, just unverified
      </span>
    </p>

    <div v-if="expanded && state === 'denied'" class="mt-1.5 rounded-lg border bg-card p-2.5">
      <p class="text-[11px] text-muted-foreground">
        The browser won't ask again — it has to be changed in settings:
      </p>
      <ol class="mt-1 grid gap-0.5 list-decimal list-inside">
        <li v-for="(s, i) in recoverySteps()" :key="i" class="text-[11px] text-muted-foreground">{{ s }}</li>
      </ol>
      <button
        type="button" class="mt-1.5 text-[11px] underline underline-offset-2 font-medium"
        @click="emit('request')"
      >Check again</button>
    </div>

    <div v-else-if="expanded && state === 'insecure'" class="mt-1.5 rounded-lg border bg-card p-2.5">
      <p class="text-[11px] text-muted-foreground">
        Browsers only expose location over <code>https://</code> (or localhost), and this
        page is plain <code>http://</code> — no setting can enable it here. It works
        normally in production. Photos taken with the camera may still carry their own
        GPS tag; each tile shows whether it did.
      </p>
    </div>
  </div>
</template>
