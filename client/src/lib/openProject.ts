import type { Router } from 'vue-router'

// Modifier-aware project opener. Plain left-click pushes through Vue
// Router (SPA nav, no full reload). Cmd / Ctrl / Shift / middle-click
// open the project detail in a new tab so the click feels like every
// other link in the browser.
//
// Use from any non-anchor element (table rows, list items, FABs).
// For real `<a href>` cards, prefer the native link approach so
// right-click "Open in new tab" also works — this helper only matches
// modifier-key behavior, not the right-click context menu.
export function openProjectWithEvent(router: Router, rid: number | string, e?: MouseEvent | null): void {
  const route = { name: 'project-detail' as const, params: { id: String(rid) } }
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
    e.preventDefault()
    const href = router.resolve(route).href
    window.open(href, '_blank', 'noopener,noreferrer')
    return
  }
  router.push(route)
}
