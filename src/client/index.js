/**
 * dsh-file-extension — Client half.
 *
 * Registers three things, each inside `ctx.effect` so unload removes it:
 *
 *  1. the locale dictionaries,
 *  2. the overlay into `shell.overlay` (menu, dialogs, toasts, hover button),
 *  3. a hidden probe into `conversation.input.dock` that captures the composer's
 *     `inputActions` and the Session's workspace root for the on-screen Session.
 *
 * The document listeners that locate file rows are attached through the
 * controller's own disposer.
 *
 * @module dsh-file-extension/client
 */

import { createElement, useEffect } from 'react'
import { createController } from './actions.js'
import { NS, en, zh } from './locales.js'
import { Overlay } from './overlay.jsx'
import { CSS } from './styles.js'

/** Services this half needs; the plugin stays parked without them.
 *
 * `remote.session` is its own service: the generated Session Remote namespace is
 * a nested Cordis service under `remote`, and reading it without declaring it
 * fails with "cannot get property without inject". The same applies to
 * `remote.directoryPicker`. */
export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.session',
  'remote.directoryPicker',
  'sessions',
  'sidebarRight',
]

/** Composer facades and workspace roots by Session, captured by the dock probe. */
const composers = new Map()
const workspaceRoots = new Map()

/**
 * A fallback for the frame's Session selector, so the probe always calls a hook
 * at the same position. The framework supplies `useSessions` for this slot, but
 * calling it conditionally would make the hook order depend on a prop; this
 * keeps the call count constant instead.
 *
 * @returns {undefined} no Session snapshot is available.
 */
const useNoSessions = () => undefined

/**
 * The hidden composer probe.
 *
 * It renders nothing; it exists only to receive the session-scoped standard
 * props, which is where `inputActions` and `useSessions` live. One instance
 * mounts per visible Session and publishes its facade while mounted.
 *
 * `useSessions` is a hook, so it is called during render — that is exactly what
 * a slot component is for — and the result is published to the side map through
 * an effect. Calling it inside an effect is invalid (React #321), which is what
 * made the workspace root (and with it "copy relative path") silently fail.
 *
 * The facade is registered on mount and removed on unmount rather than assigned
 * during render: React may render a component without committing it (StrictMode
 * double render, a suspended boundary), and a render-time write would leave a
 * facade behind for a Session that never actually mounted.
 *
 * @param {object} props - session-scoped slot props.
 * @returns {null} nothing.
 */
function ComposerProbe({ sessionId, inputActions, useSessions }) {
  const key = String(sessionId)

  // Subscribe to the smallest slice of the Session snapshot: its workspace root.
  // The hook runs during render, unconditionally, so hook order stays constant.
  const readSessions = typeof useSessions === 'function' ? useSessions : useNoSessions
  const cwd = readSessions((sessions) => sessions.byId[key]?.cwd)

  useEffect(() => {
    composers.set(key, inputActions)
    return () => {
      // Only clear this Session's entry, and only while it is still ours: a
      // remount can publish the next facade before this cleanup runs.
      if (composers.get(key) === inputActions) composers.delete(key)
    }
  }, [key, inputActions])

  useEffect(() => {
    if (typeof cwd === 'string' && cwd !== '') workspaceRoots.set(key, cwd)
    else workspaceRoots.delete(key)
  }, [key, cwd])

  return null
}

/**
 * Install the Client half.
 *
 * @param {object} ctx - owning Cordis context.
 */
export function apply(ctx) {
  // Dictionaries first: every other registration may translate immediately.
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-file-extension: dictionaries')
  const t = ctx.locale.bind(NS)

  const slots = ctx.get('slots')
  if (slots === undefined) return

  // The plugin's own stylesheet, removed when the plugin unloads.
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-file-extension'
    tag.dataset.pluginCss = 'dsh-file-extension/client.css'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-file-extension: styles')

  /**
   * Resolve the on-screen Session id from the sidebar service, falling back to
   * the DOM marker the panel publishes.
   *
   * @returns {string | undefined} the Session id.
   */
  const sessionId = () => {
    const mounted = ctx.get('sidebarRight')?.mounted?.getSnapshot?.()
    if (typeof mounted === 'string' && mounted !== '') return mounted
    const marker = document.querySelector('[data-sidebar-right-session]')
    const id = marker?.getAttribute('data-sidebar-right-session')
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * The workspace root of the on-screen Session, published by the composer
   * probe from the same Session snapshot the official file tree reads.
   *
   * @returns {string | undefined} the absolute root.
   */
  const workspaceRoot = () => {
    const id = sessionId()
    if (id === undefined) return undefined
    return workspaceRoots.get(id)
  }

  /**
   * The composer facade for the on-screen Session.
   *
   * @returns {object | undefined} `inputActions`.
   */
  const composer = () => {
    const id = sessionId()
    if (id === undefined) return undefined
    return composers.get(id)
  }

  /**
   * Reveal one path in the operating system's file manager through the
   * deployment's own Session Remote, which is the only supported channel.
   *
   * @param {string} path - absolute path.
   * @returns {Promise<boolean>} whether the host accepted it.
   */
  const reveal = async (path) => {
    const session = ctx.get('remote.session')
    if (session?.openWorkspacePath === undefined) return false
    const result = await session.openWorkspacePath({ path, action: 'reveal' })
    return result?.ok === true
  }

  /**
   * Open a file address in a new right-Sidebar tab.
   *
   * @param {string} path - absolute path.
   */
  const openResource = (path) => {
    const id = sessionId()
    const sidebar = ctx.get('sidebarRight')
    if (id === undefined || sidebar === undefined) throw new Error('no sidebar to open into')
    const address = fileAddress(id, path, workspaceRoot())
    sidebar.openResource(address)
  }

  /**
   * Close a preview tab whose content is a path that was just deleted.
   *
   * @param {string} path - the deleted absolute path.
   */
  const closePreview = (path) => {
    const id = sessionId()
    const sidebar = ctx.get('sidebarRight')
    if (id === undefined || sidebar === undefined) return
    const address = fileAddress(id, path, workspaceRoot())
    try {
      const tabs = sidebar.tabsIn(id) ?? []
      for (const tab of tabs) {
        if (tab?.contentId === address) sidebar.closeIn(id, tab.id)
      }
    } catch {
      // Closing is best-effort: a failed close must not fail the deletion.
    }
  }

  /**
   * Choose a save-as directory with the platform's native picker.
   *
   * @returns {Promise<string | null>} the chosen directory.
   */
  const pickDirectory = async () => {
    try {
      const picker = ctx.get('remote.directoryPicker')
      if (picker?.pick === undefined) return null
      const result = await picker.pick()
      return result?.ok === true ? (result.value ?? null) : null
    } catch {
      return null
    }
  }

  /**
   * Hand bytes to the browser's own download flow.
   *
   * @param {string} name - the file name.
   * @param {string} base64 - the file content.
   */
  const download = (name, base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const blob = new Blob([bytes])
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Revoke on the next task so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  /**
   * Whether the deployment can reveal a path in a file manager.
   *
   * The answer is a property of the serving host, read once per page from the
   * Session Remote that owns the gesture.
   *
   * @returns {Promise<boolean>} whether reveal is available.
   */
  let revealAvailable
  const canReveal = async () => {
    if (revealAvailable !== undefined) return revealAvailable
    try {
      const session = ctx.get('remote.session')
      const result = await session?.canOpenWorkspacePath?.()
      revealAvailable = result?.ok === true && result.value === true
    } catch {
      revealAvailable = false
    }
    return revealAvailable
  }

  const controller = createController({
    t,
    sessionId,
    workspaceRoot,
    composer,
    reveal,
    canReveal,
    openResource,
    closePreview,
    pickDirectory,
    download,
    afterMutation: () => {
      // The tree refreshes itself through its own directory watches; bumping the
      // revision only re-measures the overlays that track a row.
      const { store } = controller
      store.set({ revision: store.get().revision + 1 })
    },
  })

  // The document listeners are the plugin's only DOM coupling; they are removed
  // with the plugin.
  ctx.effect(() => controller.attach(), 'dsh-file-extension: row listeners')

  // The overlay: one entry in the official frame-wide floating layer.
  slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'dsh-file-extension',
    order: 60,
    locale: NS,
  }, () => createElement(Overlay, { controller })))

  // The composer probe: one entry per Session, capturing `inputActions` and the
  // workspace root.
  slots.inject('conversation.input.dock', () => slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-file-extension-composer',
    order: 90,
    locale: NS,
  }, ComposerProbe))

  ctx.effect(() => () => {
    controller.dispose()
    composers.clear()
    workspaceRoots.clear()
  }, 'dsh-file-extension: teardown')
}

/**
 * Build a `dsh-resource://file/session/<sessionId>/<path>` address.
 *
 * Implemented locally rather than importing the harness's path helper, because a
 * Client plugin must not load host Client packages as modules; the grammar is
 * fixed and published.
 *
 * @param {string} sessionId - authorizing Session.
 * @param {string} path - absolute path.
 * @param {string | undefined} root - workspace root, used to prefer a relative path.
 * @returns {string} the address.
 */
export function fileAddress(sessionId, path, root) {
  const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
  let target = path.replace(/\\/g, '/')
  if (typeof root === 'string' && root !== '') {
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
    if (target === normalizedRoot) target = ''
    else if (target.startsWith(`${normalizedRoot}/`)) target = target.slice(normalizedRoot.length + 1)
  }
  target = target.replace(/^(?:\.\/)+/, '')
  const encoded = target.split('/').map(encodeSegment).join('/')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`
}
