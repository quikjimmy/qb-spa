// Location access for field capture.
//
// Location is what ties a photo to a site, so getting permission has to be
// easy to grant and easy to recover from. Three rules learned the hard way:
//
//  1. Never cold-prompt on page load. A permission dialog with no explanation
//     gets denied, and a denial is sticky — the browser won't ask again, so
//     one bad first impression costs you location for that origin forever.
//     Ask only after the user has been told why, from a real tap.
//  2. A denial is recoverable, but only through browser/OS settings. The UI
//     has to say how, per platform, because nothing in the page can re-prompt.
//  3. Geolocation requires a secure context. Over plain http on a LAN IP the
//     API is simply absent — that is NOT a permission problem, and telling the
//     user to "allow location" there sends them somewhere with no answer.
import { ref, computed, onBeforeUnmount } from 'vue'

export type LocationState =
  | 'unsupported'   // no geolocation API at all
  | 'insecure'      // http:// on a non-localhost origin — API unusable
  | 'prompt'        // can ask
  | 'granted'
  | 'denied'
  | 'error'

export interface Fix {
  lat: number
  lng: number
  accuracy: number
  at: number
}

/** Accuracy worse than this is too coarse to trust against a 300m geofence. */
export const COARSE_ACCURACY_M = 150

export function useGeolocation() {
  const state = ref<LocationState>('prompt')
  const fix = ref<Fix | null>(null)
  const error = ref('')
  const requesting = ref(false)

  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator
  // localhost is treated as secure by browsers; a LAN IP over http is not.
  const secure = typeof window !== 'undefined' ? window.isSecureContext : true

  if (!supported) state.value = 'unsupported'
  else if (!secure) state.value = 'insecure'

  const coarse = computed(() => !!fix.value && fix.value.accuracy > COARSE_ACCURACY_M)
  const usable = computed(() => state.value === 'granted' && !!fix.value)

  /** Read the permission without triggering a prompt, where supported. */
  async function refreshPermission(): Promise<void> {
    if (state.value === 'unsupported' || state.value === 'insecure') return
    if (!('permissions' in navigator)) return
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName })
      if (status.state === 'granted') {
        state.value = 'granted'
        // Already granted: fetching a fix won't show a dialog.
        if (!fix.value) void request({ silent: true })
      } else if (status.state === 'denied') {
        state.value = 'denied'
      } else if (state.value !== 'granted') {
        state.value = 'prompt'
      }
      status.onchange = () => { void refreshPermission() }
    } catch {
      // Safari has historically not supported querying geolocation here.
    }
  }

  function request(opts: { silent?: boolean } = {}): Promise<Fix | null> {
    if (!supported) { state.value = 'unsupported'; return Promise.resolve(null) }
    if (!secure) { state.value = 'insecure'; return Promise.resolve(null) }

    requesting.value = true
    error.value = ''
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          fix.value = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? 0,
            at: pos.timestamp,
          }
          state.value = 'granted'
          requesting.value = false
          resolve(fix.value)
        },
        err => {
          requesting.value = false
          if (err.code === err.PERMISSION_DENIED) {
            state.value = 'denied'
            error.value = 'Location permission was denied.'
          } else if (err.code === err.POSITION_UNAVAILABLE) {
            state.value = 'error'
            error.value = 'Location unavailable — no GPS or network fix.'
          } else if (err.code === err.TIMEOUT) {
            state.value = 'error'
            error.value = 'Timed out getting a location fix.'
          } else {
            state.value = 'error'
            error.value = opts.silent ? '' : 'Could not get your location.'
          }
          resolve(null)
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
      )
    })
  }

  // Keep improving the fix while the form is open: the first reading is often
  // a coarse network estimate that GPS then sharpens.
  let watchId: number | null = null
  function startWatch(): void {
    if (!supported || !secure || watchId != null) return
    watchId = navigator.geolocation.watchPosition(
      pos => {
        const next: Fix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 0,
          at: pos.timestamp,
        }
        // Only replace when it's genuinely better, so a bad sample can't
        // undo a good one.
        if (!fix.value || next.accuracy <= fix.value.accuracy) fix.value = next
        state.value = 'granted'
      },
      () => { /* keep whatever fix we already have */ },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 30_000 },
    )
  }

  function stopWatch(): void {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null }
  }

  // Someone who leaves to flip the setting in Settings should come back to a
  // working form, not a stale denial.
  function onVisible(): void {
    if (document.visibilityState === 'visible') void refreshPermission()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible)
  }

  onBeforeUnmount(() => {
    stopWatch()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  })

  return {
    state, fix, error, requesting, coarse, usable,
    supported, secure,
    request, refreshPermission, startWatch, stopWatch,
  }
}

/** Platform-specific recovery steps. Nothing in the page can re-prompt after a
 *  denial, so the only honest help is telling them where the setting lives. */
export function recoverySteps(): string[] {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const iOS = /iPad|iPhone|iPod/.test(ua)
  const android = /Android/.test(ua)

  if (iOS) {
    return [
      'Tap the “AA” or ⓘ icon in the Safari address bar → Website Settings → Location → Allow',
      'If it stays blocked: iOS Settings → Privacy & Security → Location Services → Safari Websites → While Using the App',
      'Also make sure Location Services is on for Camera, so photos carry GPS',
    ]
  }
  if (android) {
    return [
      'Tap the padlock in the address bar → Permissions → Location → Allow',
      'If it stays blocked: Android Settings → Apps → Chrome → Permissions → Location',
    ]
  }
  return [
    'Click the padlock (or ⓘ) in the address bar → Location → Allow',
    'Reload the page after changing it',
  ]
}
