/**
 * The DOM binding layer.
 *
 * The official file tree exposes no row-level extension point, so this module
 * attaches to the two semantic data attributes the tree does publish:
 *
 *   <li data-files-entry="file|directory|other" data-files-path="<absolute>">
 *
 * and to `<aside data-sidebar-right-session="<sessionId>">` for the Session the
 * panel is showing. Those three attributes are the entire coupling surface, and
 * they are named once here so a future rename is a one-line change.
 *
 * Everything this module adds lives in the plugin's own React overlay; the only
 * DOM it writes into the host tree is the inline rename input, which must sit
 * exactly over the row it edits.
 *
 * @module dsh-file-extension/client/controller
 */

/** The official tree's row attribute: `file`, `directory`, or `other`. */
const ROW_SELECTOR = '[data-files-entry][data-files-path]'

/** The official panel's Session marker. */
const SESSION_SELECTOR = '[data-sidebar-right-session]'

/**
 * Find the file row that contains a node, if any.
 *
 * @param {EventTarget | null} target - the event target.
 * @returns {HTMLElement | null} the `<li>` row, or null outside the tree.
 */
export function rowOf(target) {
  if (!(target instanceof Element)) return null
  const row = target.closest(ROW_SELECTOR)
  return row instanceof HTMLElement ? row : null
}

/**
 * Read the entry a row describes.
 *
 * @param {HTMLElement} row - a row matched by {@link rowOf}.
 * @returns {{ path: string, kind: 'file' | 'directory' | 'other', name: string, row: HTMLElement } | null} the entry.
 */
export function entryOf(row) {
  const path = row.dataset.filesPath
  if (typeof path !== 'string' || path === '') return null
  const kind = row.dataset.filesEntry
  if (kind !== 'file' && kind !== 'directory' && kind !== 'other') return null
  return { path, kind, name: baseName(path), row }
}

/**
 * The Session the right panel is currently showing.
 *
 * @param {HTMLElement} row - a row inside the panel.
 * @returns {string | undefined} the Session id.
 */
export function sessionOf(row) {
  const owner = row.closest(SESSION_SELECTOR)
  const id = owner?.getAttribute('data-sidebar-right-session')
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Last path segment, handling both separators because a Windows Host reports
 * backslashes and the tree joins with `/`.
 *
 * @param {string} path - absolute path.
 * @returns {string} the entry name.
 */
export function baseName(path) {
  const normalized = path.replace(/[\\/]+$/, '')
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return cut < 0 ? normalized : normalized.slice(cut + 1)
}

/**
 * Parent directory of one path, preserving the path's own separator style.
 *
 * @param {string} path - absolute path.
 * @returns {string} the parent directory.
 */
export function dirName(path) {
  const normalized = path.replace(/[\\/]+$/, '')
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (cut <= 0) return normalized
  return normalized.slice(0, cut)
}

/**
 * Path relative to the workspace root, using `/` separators like the tree does.
 *
 * @param {string} path - absolute path.
 * @param {string | undefined} root - absolute workspace root.
 * @returns {string} the relative path, or the absolute one when it is outside.
 */
export function relativeTo(path, root) {
  if (typeof root !== 'string' || root === '') return path
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedPath === normalizedRoot) return ''
  const prefix = `${normalizedRoot}/`
  if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length)
  return normalizedPath
}

/**
 * Build an `@` mention token for a path.
 *
 * Follows the harness's own mention grammar: a bare `@path` when the path has
 * no spaces, and a quoted `@"path"` when it does.
 *
 * @param {string} path - the path to reference, already workspace-relative.
 * @returns {string} the mention text.
 */
export function mentionFor(path) {
  return /[\s"]/u.test(path) ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`
}

/**
 * Attach the row observers to the document.
 *
 * Returns a disposer that removes every listener and observer it installed, so
 * plugin unload leaves no trace.
 *
 * @param {object} handlers - callbacks the controller raises.
 * @param {(entry: object, event: MouseEvent) => void} handlers.onContextMenu - right click on a row.
 * @param {(entry: object | null) => void} handlers.onHoverChange - the row under the pointer, or null.
 * @param {(entry: object) => void} handlers.onRowRemoved - a row that had an inline editor disappeared.
 * @param {() => void} handlers.onTreeMutated - the tree changed (used to reposition overlays).
 * @returns {() => void} the disposer.
 */
export function attachRowObservers(handlers) {
  /** The row currently under the pointer, so hover changes are edge-triggered. */
  let hovered = null

  const onMouseOver = (event) => {
    const row = rowOf(event.target)
    const entry = row === null ? null : entryOf(row)
    const key = entry === null ? null : entry.path
    const previousKey = hovered === null ? null : hovered.path
    if (key === previousKey) return
    hovered = entry
    handlers.onHoverChange(entry)
  }

  const onMouseOut = (event) => {
    // Only clear when the pointer leaves the row entirely; moving between the
    // row's own children must not flicker the button.
    const row = rowOf(event.target)
    if (row === null || hovered === null) return
    const next = event.relatedTarget
    if (next instanceof Node && row.contains(next)) return
    hovered = null
    handlers.onHoverChange(null)
  }

  const onContextMenu = (event) => {
    const row = rowOf(event.target)
    if (row === null) return
    const entry = entryOf(row)
    if (entry === null) return
    // The tree has no menu of its own, but suppressing the native menu is what
    // keeps the two from ever appearing together.
    event.preventDefault()
    event.stopPropagation()
    handlers.onContextMenu(entry, event)
  }

  const onScroll = () => {
    handlers.onTreeMutated()
  }

  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('mouseout', onMouseOut, true)
  document.addEventListener('contextmenu', onContextMenu, true)
  // Capture-phase scroll catches the tree's own scroll container without
  // knowing its class name.
  document.addEventListener('scroll', onScroll, true)

  // The tree re-renders as directories load and watches fire; overlays that
  // track a row must follow it, and an inline editor whose row vanished must
  // close rather than float over unrelated content.
  const observer = new MutationObserver(() => {
    handlers.onTreeMutated()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-files-path'] })

  return () => {
    document.removeEventListener('mouseover', onMouseOver, true)
    document.removeEventListener('mouseout', onMouseOut, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('scroll', onScroll, true)
    observer.disconnect()
  }
}

/**
 * Find the row for one path, when it is currently rendered.
 *
 * @param {string} path - absolute path.
 * @returns {HTMLElement | null} the row.
 */
export function findRow(path) {
  for (const candidate of document.querySelectorAll(ROW_SELECTOR)) {
    if (candidate instanceof HTMLElement && candidate.dataset.filesPath === path) return candidate
  }
  return null
}
