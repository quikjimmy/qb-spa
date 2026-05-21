<script setup lang="ts">
// Scrolling ticker at the bottom of the scoreboard. Pure-black bar
// like a Nike "Just In" utility strip, single line of text scrolling
// continuously. Content is rendered twice so the loop is seamless.
//
// Items can be either persistent admin announcements (kind: 'admin')
// or ephemeral goal-hit celebrations (kind: 'celebration', shown in
// success-green).

import { computed } from 'vue'

export interface TickerItem {
  id: string
  text: string
  kind?: 'admin' | 'celebration'
}

const props = defineProps<{ items: TickerItem[] }>()

// Marquee speed: scale duration with content so longer lists scroll
// at a consistent pixels-per-second rate. ~80 chars/s feels right.
const duration = computed(() => {
  const charCount = props.items.reduce((sum, t) => sum + t.text.length, 0)
  const seconds = Math.max(20, Math.round(charCount / 4))
  return `${seconds}s`
})

const hasItems = computed(() => props.items.length > 0)
</script>

<template>
  <div v-if="hasItems" class="scoreboard-marquee" :style="{ '--marquee-duration': duration }">
    <!-- Stadium-style branded plate fixed at the left edge. Sits
         outside the scrolling track so it stays put while content
         passes behind it. -->
    <div class="scoreboard-marquee-brand">
      <img src="/img/Kin - Square Profile-blake-white.png" alt="Kin" />
    </div>
    <div class="scoreboard-marquee-track">
      <!-- Each copy renders the full list with separators between
           items. The track translates -50%, swapping the second copy
           in for the first, for a seamless loop. -->
      <span class="scoreboard-marquee-content">
        <template v-for="(item, i) in items" :key="item.id">
          <span v-if="i > 0" class="sep">★</span>
          <span :class="{ live: item.kind === 'celebration' }">{{ item.text }}</span>
        </template>
      </span>
      <span class="scoreboard-marquee-content" aria-hidden="true">
        <template v-for="(item, i) in items" :key="`${item.id}-dup`">
          <span v-if="i > 0" class="sep">★</span>
          <span :class="{ live: item.kind === 'celebration' }">{{ item.text }}</span>
        </template>
      </span>
    </div>
  </div>
</template>
