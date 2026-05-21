<script setup lang="ts">
// Inline SVG sparkline for the last six weeks of a goal.
// Plots the actuals as a connected polyline + a horizontal target line.
// No ECharts — we want this to render fast across many cards in a TV
// poll loop and to stay visually quiet (Nike: chrome restraint).

import { computed } from 'vue'

interface Props {
  values: number[]
  target: number
  // 'count' draws against target; 'empty_bucket' colors any non-zero red.
  kind?: 'count' | 'empty_bucket'
  width?: number
  height?: number
  // Highlight the trailing point (current week).
  highlightCurrent?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  kind: 'count',
  width: 280,
  height: 56,
  highlightCurrent: true,
})

const padding = 4

const scale = computed(() => {
  const max = Math.max(props.target, ...props.values, 1)
  const w = props.width - padding * 2
  const h = props.height - padding * 2
  const stepX = props.values.length > 1 ? w / (props.values.length - 1) : 0
  return { max, w, h, stepX }
})

function pointAt(i: number, v: number): { x: number; y: number } {
  const { max, h, stepX } = scale.value
  const x = padding + i * stepX
  const y = padding + h - (v / max) * h
  return { x, y }
}

const polyPoints = computed(() =>
  props.values.map((v, i) => {
    const p = pointAt(i, v)
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
  }).join(' ')
)

const targetY = computed(() => {
  if (props.kind !== 'count' || props.target <= 0) return null
  const { max, h } = scale.value
  return padding + h - (props.target / max) * h
})

const lastPoint = computed(() => {
  if (props.values.length === 0) return null
  return pointAt(props.values.length - 1, props.values[props.values.length - 1] ?? 0)
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${props.width} ${props.height}`"
    :width="props.width"
    :height="props.height"
    role="img"
    aria-label="6-week trend"
  >
    <!-- Hairline floor baseline -->
    <line
      :x1="padding" :x2="props.width - padding"
      :y1="props.height - padding" :y2="props.height - padding"
      stroke="var(--sb-hairline-soft)" stroke-width="1"
    />
    <!-- Target line, only on count-style goals -->
    <line
      v-if="targetY !== null"
      :x1="padding" :x2="props.width - padding"
      :y1="targetY" :y2="targetY"
      stroke="var(--sb-hairline)" stroke-width="1" stroke-dasharray="2 3"
    />
    <!-- The walk -->
    <polyline
      :points="polyPoints"
      fill="none"
      stroke="var(--sb-ink)"
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <!-- Trailing point — current week -->
    <circle
      v-if="lastPoint && props.highlightCurrent"
      :cx="lastPoint.x" :cy="lastPoint.y" r="4"
      fill="var(--sb-ink)"
    />
  </svg>
</template>
