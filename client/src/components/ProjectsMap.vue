<script setup lang="ts">
// Leaflet map of filtered projects. PV vs Battery-Only shown as two pin colors.
// Hover a pin for the customer name; click to open (emits `select` with the rid).
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

interface MapPoint {
  record_id: number; customer_name: string; customer_address: string
  status: string; lat: number; lng: number; battery_only: number
  problemActive?: boolean; problemText?: string
  scheduledActive?: boolean; scheduledText?: string
}
const props = defineProps<{ points: MapPoint[] }>()
const emit = defineEmits<{ (e: 'select', rid: number): void }>()

// Blue is reserved for the "My Location" pin (#3b82f6), so project pins avoid it.
const PV_COLOR = '#64748b'        // slate — the neutral baseline project
const BATTERY_COLOR = '#14b8a6'   // teal (matches the battery-only button)
const PROBLEM_COLOR = '#f59e0b'   // amber — needs attention
const SCHEDULED_COLOR = '#16a34a' // green — scheduled today/tomorrow

const el = ref<HTMLDivElement | null>(null)
let map: L.Map | null = null
let markers: L.LayerGroup | null = null

// ── My Location (browser geolocation via Leaflet) ──
const locating = ref(false)
const locateError = ref('')
let userMarker: L.CircleMarker | null = null
let userCircle: L.Circle | null = null
function locateMe() {
  if (!map) return
  locateError.value = ''
  locating.value = true
  map.locate({ setView: true, maxZoom: 14, enableHighAccuracy: true, timeout: 10000 })
}

function esc(s: string) {
  return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

function render() {
  if (!map) return
  markers?.remove()
  markers = L.layerGroup().addTo(map)
  const latlngs: L.LatLngExpression[] = []
  // Draw overlay pins (problem/scheduled) last so they sit on top of healthy ones.
  const flagged = (p: MapPoint) => Number(!!p.problemActive || !!p.scheduledActive)
  const ordered = [...props.points].sort((a, b) => flagged(a) - flagged(b))
  for (const p of ordered) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    const isProb = !!p.problemActive, isSched = !!p.scheduledActive
    // Problem = amber; scheduled = green; both = amber fill + green ring (the
    // "do it while you're nearby" target). Otherwise the base PV/battery color.
    const fill = isProb ? PROBLEM_COLOR : isSched ? SCHEDULED_COLOR : (p.battery_only ? BATTERY_COLOR : PV_COLOR)
    const stroke = isProb && isSched ? SCHEDULED_COLOR : isProb ? '#b45309' : isSched ? '#166534' : '#ffffff'
    const m = L.circleMarker([p.lat, p.lng], {
      radius: (isProb || isSched) ? 7 : 6,
      weight: (isProb && isSched) ? 3 : (isProb || isSched) ? 2 : 1.5,
      color: stroke, fillColor: fill, fillOpacity: 0.9,
    })
    const bits: string[] = []
    if (isProb && p.problemText) bits.push(`⚠ ${p.problemText}`)
    if (isSched && p.scheduledText) bits.push(`📅 ${p.scheduledText}`)
    const label = `${esc(p.customer_name)}${p.battery_only ? ' · Battery-Only' : ''}${bits.length ? ` · ${esc(bits.join(' · '))}` : ''}`
    m.bindTooltip(label, { direction: 'top', opacity: 0.95 })
    m.on('click', () => emit('select', p.record_id))
    m.addTo(markers)
    latlngs.push([p.lat, p.lng])
  }
  if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs), { padding: [36, 36], maxZoom: 13 })
}

onMounted(() => {
  if (!el.value) return
  map = L.map(el.value, { preferCanvas: true }).setView([39.5, -98.35], 4) // US center fallback
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map)
  map.on('locationfound', (e: L.LocationEvent) => {
    locating.value = false
    if (!map) return
    userMarker?.remove(); userCircle?.remove()
    userCircle = L.circle(e.latlng, { radius: e.accuracy, color: '#3b82f6', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.1, interactive: false }).addTo(map)
    userMarker = L.circleMarker(e.latlng, { radius: 7, weight: 3, color: '#ffffff', fillColor: '#3b82f6', fillOpacity: 1 }).addTo(map)
    userMarker.bindTooltip('You are here', { direction: 'top' })
  })
  map.on('locationerror', (e: L.ErrorEvent) => {
    locating.value = false
    locateError.value = /denied/i.test(e.message) ? 'Location permission denied' : 'Couldn’t get your location'
    window.setTimeout(() => { locateError.value = '' }, 4000)
  })
  render()
})
watch(() => props.points, () => render())
onBeforeUnmount(() => { map?.remove(); map = null; markers = null })
</script>

<template>
  <div class="relative w-full h-full">
    <div ref="el" class="w-full h-full" />
    <!-- My Location -->
    <button type="button" title="My location" @click="locateMe"
      class="absolute top-3 right-3 z-[1000] size-9 rounded-full bg-card/95 backdrop-blur shadow-lg ring-1 ring-foreground/10 flex items-center justify-center hover:bg-card cursor-pointer transition-colors">
      <svg :class="locating ? 'animate-pulse text-blue-600' : 'text-foreground/70'" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/></svg>
    </button>
    <div v-if="locateError" class="absolute top-14 right-3 z-[1000] rounded-md bg-rose-600 text-white text-[11px] px-2.5 py-1 shadow-lg">{{ locateError }}</div>
    <div class="absolute bottom-3 left-3 z-[1000] rounded-lg bg-card/95 backdrop-blur px-3 py-2 shadow-lg ring-1 ring-foreground/10 text-xs space-y-1 pointer-events-none">
      <div class="flex items-center gap-1.5"><span class="size-2.5 rounded-full" :style="{ background: PV_COLOR }" />PV</div>
      <div class="flex items-center gap-1.5"><span class="size-2.5 rounded-full" :style="{ background: BATTERY_COLOR }" />Battery-Only</div>
      <div class="flex items-center gap-1.5"><span class="size-2.5 rounded-full ring-2 ring-[#b45309]" :style="{ background: PROBLEM_COLOR }" />Needs attention</div>
      <div class="flex items-center gap-1.5"><span class="size-2.5 rounded-full ring-2 ring-[#166534]" :style="{ background: SCHEDULED_COLOR }" />Scheduled soon</div>
    </div>
  </div>
</template>
