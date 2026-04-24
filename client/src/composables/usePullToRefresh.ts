import { ref, onMounted, onUnmounted, type Ref } from 'vue'

// Pull-to-refresh with defensive activation:
//  - Dead zone: ignore the first 24px of drag so micro-scrolls and finger
//    jitter never produce a visible indicator.
//  - Vertical intent required: drag must be visibly more vertical than
//    horizontal before we "commit" to pulling (rejects swipe-back gestures
//    and horizontal-strip scrolling).
//  - Drag resistance: 0.4 ratio (down from 0.5) so the user has to pull
//    further to trigger — makes accidental triggers feel unnatural.
//  - Higher trigger threshold: 110px (from 60) so a light tug doesn't fire.
//  - If the user scrolls *away* from the top mid-gesture, abort.
export function usePullToRefresh(
  scrollEl: Ref<HTMLElement | null>,
  onRefresh: () => Promise<void>,
) {
  const pullDistance = ref(0)
  const isRefreshing = ref(false)
  const TRIGGER = 110     // px of visible pull needed to fire
  const DEAD_ZONE = 24    // px of raw drag before the gesture counts as a pull
  const RESISTANCE = 0.4  // visible pull = raw drag × resistance

  let startY = 0
  let startX = 0
  let pulling = false     // gesture started from the top
  let committed = false   // gesture has passed the dead zone + vertical check

  function reset() {
    pulling = false
    committed = false
    pullDistance.value = 0
  }

  function onTouchStart(e: TouchEvent) {
    if (isRefreshing.value) return
    const el = scrollEl.value
    if (!el || el.scrollTop > 0) return
    // Multi-touch (pinch/zoom) shouldn't start a pull.
    if (e.touches.length !== 1) return
    startY = e.touches[0]!.clientY
    startX = e.touches[0]!.clientX
    pulling = true
    committed = false
    pullDistance.value = 0
  }

  function onTouchMove(e: TouchEvent) {
    if (!pulling) return
    // Additional touch points arriving mid-gesture — abort, likely pinch.
    if (e.touches.length !== 1) { reset(); return }
    const dy = e.touches[0]!.clientY - startY
    const dx = e.touches[0]!.clientX - startX

    // Upward movement: not a pull. Let native scroll handle it.
    if (dy < 0) { reset(); return }

    // Abort if the user drifted horizontally more than vertically — this
    // catches horizontal-strip scrolling (filter chips) and swipe-back.
    if (!committed && Math.abs(dx) > Math.abs(dy)) { reset(); return }

    // Dead zone — suppress any visual feedback until the user has clearly
    // committed to pulling down.
    if (dy < DEAD_ZONE) return

    committed = true
    // Require vertical dominance throughout the commit, not just at start.
    if (Math.abs(dx) > Math.abs(dy) * 0.8) { reset(); return }

    // If the scroll container scrolled away from the top mid-gesture
    // (finger kept still while page kept moving), stop.
    const el = scrollEl.value
    if (el && el.scrollTop > 0) { reset(); return }

    const effective = (dy - DEAD_ZONE) * RESISTANCE
    pullDistance.value = Math.min(effective, TRIGGER * 1.3)
  }

  async function onTouchEnd() {
    if (!pulling) return
    const shouldFire = committed && pullDistance.value >= TRIGGER && !isRefreshing.value
    pulling = false
    committed = false
    if (shouldFire) {
      isRefreshing.value = true
      pullDistance.value = TRIGGER
      try { await onRefresh() }
      finally {
        isRefreshing.value = false
        pullDistance.value = 0
      }
    } else {
      pullDistance.value = 0
    }
  }

  function onTouchCancel() { reset() }

  onMounted(() => {
    const el = scrollEl.value
    if (!el) return
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchCancel)
  })

  onUnmounted(() => {
    const el = scrollEl.value
    if (!el) return
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
    el.removeEventListener('touchcancel', onTouchCancel)
  })

  return { pullDistance, isRefreshing }
}
