/**
 * A minimal observable store for the plugin's own UI state.
 *
 * Deliberately tiny: the plugin needs one shared snapshot for the menu, the
 * hover button, the dialogs, and the toast stack, and nothing else. It is read
 * through `useSyncExternalStore`, so React owns re-rendering and there is no
 * second state system in the page.
 *
 * @module dsh-file-extension/client/store
 */

/**
 * Create one observable store.
 *
 * @param {object} initial - the starting state.
 * @returns {{ get: () => object, set: (patch: object) => void, subscribe: (listener: () => void) => () => void }} the store.
 */
export function createStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch }
      // Bail out on an identical snapshot so React skips the re-render; every
      // patch is shallow, so reference equality per key is the right test.
      let changed = false
      for (const key of Object.keys(patch)) {
        if (!Object.is(state[key], next[key])) {
          changed = true
          break
        }
      }
      if (!changed) return
      state = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Format a byte count the way a person reads it.
 *
 * @param {number} bytes - the size.
 * @returns {string} a short human form, for example `1.4 MB`.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}
