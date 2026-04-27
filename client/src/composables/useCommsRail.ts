// Module-level state for the Comms Live Hub rail. Shared between the
// topbar toggle (in AppLayout) and the rail component itself, so opening
// from any page persists across navigation.
import { ref, watch } from 'vue'

const STORAGE_KEY = 'comms.rail'
const DEFAULT_WIDTH = 380
const MIN_WIDTH = 300
const MAX_WIDTH = 640

interface Persisted { open: boolean; width: number }

function load(): Persisted {
  if (typeof localStorage === 'undefined') return { open: false, width: DEFAULT_WIDTH }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { open: false, width: DEFAULT_WIDTH }
    const p = JSON.parse(raw) as Partial<Persisted>
    return {
      open: !!p.open,
      width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(p.width) || DEFAULT_WIDTH)),
    }
  } catch { return { open: false, width: DEFAULT_WIDTH } }
}

const initial = load()
const open = ref(initial.open)
const width = ref(initial.width)

watch([open, width], ([o, w]) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: o, width: w })) } catch { /* ignore */ }
})

export function useCommsRail() {
  return {
    open,
    width,
    toggle: () => { open.value = !open.value },
    setOpen: (v: boolean) => { open.value = v },
    setWidth: (w: number) => { width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)) },
    MIN_WIDTH,
    MAX_WIDTH,
  }
}
