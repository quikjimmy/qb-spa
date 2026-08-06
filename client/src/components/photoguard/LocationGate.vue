<script setup lang="ts">
// Location permission banner.
//
// Explains why location is wanted, asks from a real tap, and — when it's been
// denied or is unavailable — says exactly how to fix it instead of leaving a
// dead "location off" label on screen. Capture is never blocked by this;
// photos without location get a warning, not a rejection.
import { computed } from 'vue'
import { recoverySteps, type LocationState, type Fix } from '@/lib/geolocation'

const props = defineProps<{
  state: LocationState
  fix: Fix | null
  error: string
  requesting: boolean
  coarse: boolean
}>()

const emit = defineEmits<{ (e: 'request'): void }>()

// Granted with a good fix needs no banner — just a quiet confirmation line.
const quiet = computed(() => props.state === 'granted' && !!props.fix && !props.coarse)

const tone = computed(() => {
  if (props.state === 'granted') return props.coarse ? 'amber' : 'emerald'
  if (props.state === 'prompt') return 'sky'
  return 'amber'
})

const toneClass = computed(() => ({
  emerald: 'border-emerald-300',
  amber: 'border-amber-300',
  sky: 'border-sky-300',
}[tone.value] ?? ''))

const steps = computed(() => recoverySteps())
</script>

<template>
  <!-- Happy path: one line, no nagging. -->
  <p v-if="quiet" class="text-[11px] text-emerald-600">
    Location on · accurate to ~{{ Math.round(fix!.accuracy) }}m
  </p>

  <div v-else class="rounded-xl border bg-card p-3 min-w-0" :class="toneClass">
    <!-- Not yet asked -->
    <template v-if="state === 'prompt'">
      <p class="text-sm font-medium">Turn on location</p>
      <p class="mt-1 text-[12px] text-muted-foreground">
        Photos get stamped with where they were taken, so office staff can confirm
        the work happened at the right address — and so you're not asked to go back
        and prove it later.
      </p>
      <button
        type="button" :disabled="requesting"
        class="mt-2 px-3 py-2 rounded-full border text-[11px] font-medium bg-foreground text-background border-foreground disabled:opacity-50"
        @click="emit('request')"
      >{{ requesting ? 'Asking…' : 'Enable location' }}</button>
    </template>

    <!-- Granted but the fix is too coarse to trust -->
    <template v-else-if="state === 'granted' && coarse">
      <p class="text-sm font-medium text-amber-600">Location is rough</p>
      <p class="mt-1 text-[12px] text-muted-foreground">
        Accurate to about {{ Math.round(fix?.accuracy ?? 0) }}m, which is too vague to
        confirm you're at the property. Step outside if you can — it usually sharpens
        within a few seconds.
      </p>
      <button
        type="button" :disabled="requesting"
        class="mt-2 px-3 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted disabled:opacity-50"
        @click="emit('request')"
      >{{ requesting ? 'Retrying…' : 'Try again' }}</button>
    </template>

    <!-- Denied — the page cannot re-prompt, so give directions -->
    <template v-else-if="state === 'denied'">
      <p class="text-sm font-medium text-amber-600">Location is blocked</p>
      <p class="mt-1 text-[12px] text-muted-foreground">
        Your browser won't ask again, so it has to be changed in settings:
      </p>
      <ol class="mt-1.5 grid gap-1 list-decimal list-inside">
        <li v-for="(s, i) in steps" :key="i" class="text-[11px] text-muted-foreground">{{ s }}</li>
      </ol>
      <button
        type="button" :disabled="requesting"
        class="mt-2 px-3 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted disabled:opacity-50"
        @click="emit('request')"
      >Check again</button>
      <p class="mt-1.5 text-[11px] text-muted-foreground">
        You can keep working — photos will just be flagged as unverified.
      </p>
    </template>

    <!-- http:// on a LAN IP: not a permission problem at all -->
    <template v-else-if="state === 'insecure'">
      <p class="text-sm font-medium text-amber-600">Location needs a secure connection</p>
      <p class="mt-1 text-[12px] text-muted-foreground">
        This page is on plain <code>http://</code>, and browsers only allow location over
        <code>https://</code> (or on localhost). No setting will enable it here.
      </p>
      <p class="mt-1 text-[11px] text-muted-foreground">
        Photos taken with the camera may still carry their own GPS tag — each tile
        shows whether it did.
      </p>
    </template>

    <template v-else-if="state === 'unsupported'">
      <p class="text-sm font-medium text-amber-600">This device can't share location</p>
      <p class="mt-1 text-[12px] text-muted-foreground">
        Photos will be accepted but flagged as unverified.
      </p>
    </template>

    <!-- Transient failure -->
    <template v-else>
      <p class="text-sm font-medium text-amber-600">Couldn't get your location</p>
      <p class="mt-1 text-[12px] text-muted-foreground">
        {{ error || 'No GPS or network fix available right now.' }}
      </p>
      <button
        type="button" :disabled="requesting"
        class="mt-2 px-3 py-1.5 rounded-full border text-[11px] font-medium bg-card hover:bg-muted disabled:opacity-50"
        @click="emit('request')"
      >{{ requesting ? 'Retrying…' : 'Try again' }}</button>
    </template>
  </div>
</template>
