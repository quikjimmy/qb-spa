import { ref, onMounted, onUnmounted, type Ref } from 'vue'

export function usePullToRefresh(
  scrollEl: Ref<HTMLElement | null>,
  onRefresh: () => Promise<void>,
) {
  const pullDistance = ref(0)
  const isRefreshing = ref(false)
  const threshold = 60

  let startY = 0
  let pulling = false

  function onTouchStart(e: TouchEvent) {
    if (!scrollEl.value || scrollEl.value.scrollTop > 0) return
    startY = e.touches[0]!.clientY
    pulling = true
  }

  function onTouchMove(e: TouchEvent) {
    if (!pulling) return
    const diff = e.touches[0]!.clientY - startY
    if (diff < 0) { pulling = false; pullDistance.value = 0; return }
    pullDistance.value = Math.min(diff * 0.5, threshold * 1.5)
  }

  async function onTouchEnd() {
    if (!pulling) return
    pulling = false
    if (pullDistance.value >= threshold && !isRefreshing.value) {
      isRefreshing.value = true
      pullDistance.value = threshold
      try { await onRefresh() }
      finally { isRefreshing.value = false }
    }
    pullDistance.value = 0
  }

  onMounted(() => {
    const el = scrollEl.value
    if (!el) return
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
  })

  onUnmounted(() => {
    const el = scrollEl.value
    if (!el) return
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
  })

  return { pullDistance, isRefreshing }
}
