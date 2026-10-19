/**
 * The plugin controller: the action layer behind the overlay.
 *
 * It owns the shared store, talks to the Host routes, drives the sidebar service
 * for "open in tab", and drives the composer's `inputActions` for "add to
 * conversation". The React overlay reads this object; nothing here renders.
 *
 * @module dsh-file-extension/client/controller-actions
 */

import { api, hostCapabilities, invalidateCapabilities } from './api.js'
import { attachRowObservers, baseName, dirName, mentionFor, relativeTo } from './controller.js'
import { createStore } from './store.js'

/** How long one toast stays on screen, in milliseconds. */
const TOAST_MS = 2600

/**
 * Create the controller.
 *
 * @param {object} deps - injected services.
 * @param {(key: string, vars?: object) => string} deps.t - namespace-bound translate.
 * @param {() => object | undefined} deps.sidebar - the right Sidebar service.
 * @param {() => object | undefined} deps.composer - the composer facade for the on-screen Session.
 * @param {() => Promise<string | null>} deps.pickDirectory - native directory picker.
 * @param {(address: string) => void} deps.openResource - open a resource in a new tab.
 * @param {() => string | undefined} deps.workspaceRoot - the on-screen workspace root.
 * @returns {object} the controller.
 */
export function createController(deps) {
  const { t } = deps
  const store = createStore({
    /** The open context menu, or null. */
    menu: null,
    /** The hovered row entry, or null. */
    hover: null,
    /** The active dialog descriptor, or null. */
    dialog: null,
    /** The entry being renamed inline, or null. */
    renaming: null,
    /** A rename validation message shown under the inline editor. */
    renameError: null,
    /** Visible toasts. */
    toasts: [],
    /** True while a Host request is in flight. */
    busy: false,
    /** Bumped whenever the tree mutates, so overlays re-measure. */
    revision: 0,
    /** Host capabilities, once read. */
    capabilities: null,
  })

  let toastSeq = 0
  const timers = new Set()

  /**
   * Show one transient message.
   *
   * @param {string} text - the message.
   * @param {'info' | 'success' | 'error'} [level] - severity.
   */
  const toast = (text, level = 'info') => {
    toastSeq += 1
    const id = toastSeq
    const next = [...store.get().toasts, { id, text, level }]
    store.set({ toasts: next })
    const timer = setTimeout(() => {
      timers.delete(timer)
      store.set({ toasts: store.get().toasts.filter((entry) => entry.id !== id) })
    }, TOAST_MS)
    timers.add(timer)
  }

  /** Remove every pending toast timer; called on unload. */
  const dispose = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  /**
   * Translate a Host failure into a sentence.
   *
   * @param {{ code: string, message: string, details?: object }} failure - the Host failure.
   * @returns {string} the sentence.
   */
  const describeFailure = (failure) => {
    const code = String(failure.code ?? '')
    const reason = failure.details?.reason
    if (code.endsWith('/invalid-name') && typeof reason === 'string') {
      return t(`error.${reason}`)
    }
    if (code.endsWith('/already-exists')) return t('error.alreadyExists')
    if (code.endsWith('/not-found')) return t('error.notFound')
    if (code.endsWith('/not-regular-file')) return t('error.notRegularFile')
    if (code.endsWith('/not-directory')) return t('error.notDirectory')
    if (code.endsWith('/outside-workspace')) return t('error.outsideWorkspace')
    if (code.endsWith('/too-large')) return t('error.tooLarge')
    if (code.endsWith('/unsupported')) return t('error.unsupported')
    if (/permission|denied/i.test(String(failure.message))) return t('error.permission')
    return t('error.operationFailed', { message: failure.message })
  }

  /**
   * Load the Host capabilities once, refreshing the snapshot when they arrive.
   *
   * @returns {Promise<object | null>} the capabilities.
   */
  const ensureCapabilities = async () => {
    const known = store.get().capabilities
    if (known !== null) return known
    const value = await hostCapabilities()
    if (value !== null) store.set({ capabilities: value })
    return value
  }

  /** Whether a composer is available to receive a mention. */
  const canAddToChat = () => deps.composer() !== undefined

  /**
   * Copy text to the clipboard, with a fallback for browsers that refuse the
   * async API outside a secure context.
   *
   * @param {string} text - the text.
   * @returns {Promise<boolean>} whether it was copied.
   */
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }
  }

  /**
   * Insert an `@path` mention at the composer caret without disturbing the rest
   * of the draft.
   *
   * @param {object} entry - the row entry.
   * @returns {boolean} whether the mention was inserted.
   */
  const addToChat = (entry) => {
    const composer = deps.composer()
    if (composer === undefined) {
      toast(t('menu.addToChat.disabled'), 'error')
      return false
    }
    const relative = relativeTo(entry.path, deps.workspaceRoot())
    const mention = mentionFor(relative)
    const span = composer.captureInsertion()
    // A space before the token keeps it a separate mention when the caret sits
    // directly after other text.
    const draft = composer.state?.getSnapshot?.()?.draft
    const needsSpace = typeof draft === 'string' && draft.length > 0 && !/[\s]$/u.test(draft.slice(0, span?.offset ?? draft.length))
    const ok = composer.insertText(`${needsSpace ? ' ' : ''}${mention}`, span)
    if (!ok) {
      toast(t('toast.addedToChatFailed'), 'error')
      return false
    }
    toast(t('toast.addedToChat'), 'success')
    return true
  }

  /**
   * Open one file in a new sidebar tab, falling back to a browser tab.
   *
   * @param {object} entry - the row entry.
   */
  const openInTab = (entry) => {
    try {
      deps.openResource(entry.path)
    } catch (error) {
      toast(t('toast.openFailed'), 'error')
      console.error('[dsh-file-extension] open in tab failed:', error)
    }
  }

  /**
   * Reveal one path in the operating system's file manager.
   *
   * Uses the deployment's own reveal action, so desktop and web agree on what is
   * possible; a host that cannot reveal answers `false` and the row is disabled
   * instead of erroring.
   *
   * @param {object} entry - the row entry.
   */
  const reveal = async (entry) => {
    try {
      const ok = await deps.reveal(entry.path)
      if (!ok) toast(t('toast.revealFailed'), 'error')
    } catch (error) {
      toast(t('toast.revealFailed'), 'error')
      console.error('[dsh-file-extension] reveal failed:', error)
    }
  }

  /**
   * Run one context-menu action.
   *
   * @param {string} action - the action id.
   */
  const runMenuAction = async (action) => {
    const menu = store.get().menu
    store.set({ menu: null })
    if (menu === null) return
    const entry = { path: menu.path, name: menu.name, kind: menu.kind }
    switch (action) {
      case 'reveal':
        await reveal(entry)
        return
      case 'addToChat':
        addToChat(entry)
        return
      case 'openInTab':
        openInTab(entry)
        return
      case 'copyAbsolutePath': {
        const ok = await copyText(entry.path)
        toast(ok ? t('toast.pathCopied') : t('toast.copyFailed'), ok ? 'success' : 'error')
        return
      }
      case 'copyRelativePath': {
        const relative = relativeTo(entry.path, deps.workspaceRoot())
        const ok = await copyText(relative)
        toast(ok ? t('toast.pathCopied') : t('toast.copyFailed'), ok ? 'success' : 'error')
        return
      }
      case 'rename':
        store.set({ dialog: { kind: 'rename', entry }, renameError: null })
        return
      case 'delete':
        await openDeleteDialog(entry)
        return
      case 'saveAs':
        await openSaveAsDialog(entry)
        return
      default:
        return
    }
  }

  /**
   * Open the delete confirmation, worded for the mode that will actually run.
   *
   * @param {object} entry - the row entry.
   */
  const openDeleteDialog = async (entry) => {
    const capabilities = await ensureCapabilities()
    const trashSupported = capabilities?.trash?.supported === true
    store.set({
      dialog: {
        kind: 'delete',
        entry,
        permanent: !trashSupported,
      },
    })
  }

  /**
   * Open the save-as dialog.
   *
   * @param {object} entry - the row entry.
   */
  const openSaveAsDialog = async (entry) => {
    const capabilities = await ensureCapabilities()
    const info = await api.stat(entry.path, deps.sessionId())
    const bytes = info.ok ? Number(info.value.bytes ?? 0) : undefined
    store.set({
      dialog: {
        kind: 'saveAs',
        entry: { ...entry, bytes },
        canWrite: capabilities?.saveAs === 'directory-picker',
      },
    })
  }

  /** Close the active dialog. */
  const closeDialog = () => {
    store.set({ dialog: null, busy: false })
  }

  /**
   * Confirm a deletion.
   *
   * @param {boolean} permanent - whether to delete permanently.
   */
  const confirmDelete = async (permanent) => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'delete') return
    store.set({ busy: true })
    const result = await api.remove(dialog.entry.path, permanent ? 'permanent' : 'trash', deps.sessionId())
    if (result.ok) {
      store.set({ dialog: null, busy: false })
      toast(permanent ? t('toast.deletePermanent') : t('toast.deleteTrashed'), 'success')
      // A trashed preview must not keep showing content that is gone.
      deps.closePreview(dialog.entry.path)
      return
    }
    if (result.details?.trashUnavailable === true) {
      // The recycle bin turned out to be unreachable: re-ask with the red
      // warning rather than silently deleting anything.
      invalidateCapabilities()
      store.set({
        busy: false,
        capabilities: null,
        dialog: { kind: 'delete', entry: dialog.entry, permanent: true },
      })
      return
    }
    store.set({ busy: false })
    toast(describeFailure(result), 'error')
  }

  /**
   * Confirm a rename from the dialog.
   *
   * @param {string} name - the new name.
   */
  const confirmRename = async (name) => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'rename') return
    store.set({ busy: true })
    const result = await api.rename(dialog.entry.path, name, deps.sessionId())
    if (result.ok) {
      store.set({ dialog: null, busy: false })
      toast(t('toast.renameSuccess', { name }), 'success')
      deps.afterMutation()
      return
    }
    store.set({ busy: false })
    toast(describeFailure(result), 'error')
  }

  /** Start an inline rename on the row that opened the menu. */
  const startInlineRename = (entry) => {
    store.set({ renaming: { path: entry.path, name: entry.name, kind: entry.kind }, renameError: null })
  }

  /** Abandon the inline rename. */
  const cancelInlineRename = () => {
    store.set({ renaming: null, renameError: null, busy: false })
  }

  /**
   * Commit an inline rename.
   *
   * @param {string} name - the new name.
   */
  const commitInlineRename = async (name) => {
    const renaming = store.get().renaming
    if (renaming === null) return
    store.set({ busy: true, renameError: null })
    const result = await api.rename(renaming.path, name, deps.sessionId())
    if (result.ok) {
      store.set({ renaming: null, busy: false })
      toast(t('toast.renameSuccess', { name }), 'success')
      deps.afterMutation()
      return
    }
    // Keep the editor open with the reason, so the user can correct the name.
    store.set({ busy: false, renameError: describeFailure(result) })
  }

  /**
   * Choose the save-as destination with the platform's directory picker.
   *
   * @param {string} suggestedName - the name to start from.
   * @returns {Promise<string | null>} the chosen directory.
   */
  const pickDirectory = (suggestedName) => deps.pickDirectory(suggestedName)

  /**
   * Write the save-as copy.
   *
   * @param {string} name - the destination file name.
   * @param {string | null} directory - the destination directory.
   */
  const confirmSaveAs = async (name, directory) => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'saveAs') return
    store.set({ busy: true })
    const canWrite = dialog.canWrite === true

    if (!canWrite) {
      // Browser fallback: fetch bounded bytes and let the browser download them.
      const result = await api.download(dialog.entry.path, deps.sessionId())
      store.set({ busy: false })
      if (!result.ok) {
        toast(t('toast.saveAsFailed', { message: describeFailure(result) }), 'error')
        return
      }
      deps.download(result.value.name, result.value.data)
      store.set({ dialog: null })
      toast(t('toast.savedAs', { path: result.value.name }), 'success')
      return
    }

    const result = await api.copy(
      dialog.entry.path,
      { directory, name, overwrite: false },
      deps.sessionId(),
    )
    if (result.ok) {
      store.set({ dialog: null, busy: false })
      toast(t('toast.savedAs', { path: result.value.path }), 'success')
      deps.afterMutation()
      return
    }
    if (result.details?.name !== undefined || result.code.endsWith('/already-exists')) {
      // Ask before replacing; the Host never overwrites on its own.
      store.set({ busy: false, dialog: { kind: 'overwrite', name, directory, entry: dialog.entry } })
      return
    }
    store.set({ busy: false })
    toast(t('toast.saveAsFailed', { message: describeFailure(result) }), 'error')
  }

  /** Replace an existing file at the save-as destination after confirmation. */
  const confirmOverwrite = async () => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'overwrite') return
    store.set({ busy: true })
    const result = await api.copy(
      dialog.entry.path,
      { directory: dialog.directory, name: dialog.name, overwrite: true },
      deps.sessionId(),
    )
    store.set({ busy: false })
    if (result.ok) {
      store.set({ dialog: null })
      toast(t('toast.savedAs', { path: result.value.path }), 'success')
      deps.afterMutation()
      return
    }
    toast(t('toast.saveAsFailed', { message: describeFailure(result) }), 'error')
  }

  /**
   * Open the context menu for one row.
   *
   * @param {object} entry - the row entry.
   * @param {MouseEvent} event - the triggering event.
   */
  const openMenu = (entry, event) => {
    store.set({
      menu: {
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        anchor: { x: event.clientX, y: event.clientY },
      },
    })
  }

  /**
   * Install the document listeners that find rows.
   *
   * @returns {() => void} the disposer.
   */
  const attach = () => attachRowObservers({
    onContextMenu: (entry, event) => {
      void ensureCapabilities()
      openMenu(entry, event)
    },
    onHoverChange: (entry) => {
      // A rename in progress owns its row; a hover button over it would fight
      // the input for the same pixels.
      const renaming = store.get().renaming
      if (renaming !== null && entry !== null && renaming.path === entry.path) {
        store.set({ hover: null })
        return
      }
      store.set({ hover: entry })
    },
    onRowRemoved: () => {
      store.set({ revision: store.get().revision + 1 })
    },
    onTreeMutated: () => {
      store.set({ revision: store.get().revision + 1 })
    },
  })

  return {
    store,
    t,
    attach,
    dispose,
    runMenuAction,
    addToChat,
    openMenu,
    canAddToChat,
    ensureCapabilities,
    closeDialog,
    confirmDelete,
    confirmRename,
    startInlineRename,
    cancelInlineRename,
    commitInlineRename,
    pickDirectory,
    confirmSaveAs,
    confirmOverwrite,
  }
}
