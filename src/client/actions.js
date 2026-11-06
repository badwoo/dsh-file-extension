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
 * How long a clipboard answer stays usable, in milliseconds.
 *
 * The menu is synchronous and opens on right click, which can be followed by the
 * same user opening it again one second later. Re-reading the OS clipboard on
 * every open would spawn a helper process per click on Windows; never re-reading
 * it would leave the paste row enabled long after the clipboard was emptied. A
 * short window is the compromise, and every explicit action invalidates it.
 */
const CLIPBOARD_CACHE_MS = 2000

/**
 * Owner of an `@` reference chip produced by this plugin.
 *
 * This is the official `@` source's registered name in `dsh-client-ui-reference`.
 * Naming it here (rather than registering our own source) is deliberate: the
 * official source already owns the click behaviour and the send-path codec, so a
 * chip we insert previews the file through the official path and serializes
 * exactly like one the user picked from the official menu. A source name that is
 * NOT in the roster would not throw — it would silently leave the chip
 * unclickable AND block the composer from ever sending, so the official name is
 * the only safe value here.
 */
const OFFICIAL_REFERENCE_SOURCE = 'reference'

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
 * @param {(entry: object, reference: object, span: object) => boolean} deps.insertReference - write an atomic `@` reference chip into the on-screen composer.
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
    /** A creation validation message shown under the new-entry prompt. */
    createError: null,
    /** Visible toasts. */
    toasts: [],
    /** True while a Host request is in flight. */
    busy: false,
    /** The pending update check result, or null while none has been read. */
    update: null,
    /** True while the update check or apply is running. */
    updateBusy: false,
    /** Bumped whenever the tree mutates, so overlays re-measure. */
    revision: 0,
    /** Host capabilities, once read. */
    capabilities: null,
    /**
     * Whether the deployment can reveal a path in a file manager.
     * `null` until the session Remote has answered, so a menu that opens before
     * the answer arrives does not wrongly disable the row.
     */
    canReveal: null,
    /**
     * Whether the host has an operating system clipboard that can carry files.
     *
     * Starts `false`, not `null`: the menu builder is synchronous and has no way
     * to wait for a probe, so the safe reading of "not known yet" is "no". A menu
     * that opens before the answer arrives therefore shows the clipboard verbs
     * disabled with a reason, and the overlay enables them once the probe lands a
     * moment later. The alternative — optimistically enabled — would render an
     * action that only fails when clicked.
     */
    clipboardSupported: false,
    /** Whether that clipboard currently holds files, so "Paste Here" can run. */
    clipboardHasFiles: false,
    /** The host's own explanation when the clipboard is unusable, or null. */
    clipboardReason: null,
    /** A refusal shown inline in the transfer dialog. */
    transferError: null,
  })

  let toastSeq = 0
  const timers = new Set()
  /** The one in-flight capabilities read, shared by concurrent callers. */
  let capabilitiesInFlight
  /** The last clipboard answer, cached briefly; see CLIPBOARD_CACHE_MS. */
  let clipboardCache = null
  /** The one in-flight clipboard read, shared by concurrent callers. */
  let clipboardInFlight

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
    // The two clipboard refusals carry a real reason from the host; that is more
    // useful than the generic sentence, but the code still selects the sentence
    // so a host that returns no reason still reads correctly.
    if (code.endsWith('/clipboard-empty')) return t('error.clipboardEmpty')
    if (code.endsWith('/clipboard-unavailable')) return t('error.clipboardUnavailable')
    if (code.endsWith('/self-nested')) return t('error.selfNested')
    if (/permission|denied/i.test(String(failure.message))) return t('error.permission')
    return t('error.operationFailed', { message: failure.message })
  }

  /**
   * Read both host capabilities and the reveal answer, caching each for the
   * page. Both reads resolve before returning, so a caller can read the snapshot
   * straight after awaiting this.
   *
   * A failed read leaves its slot `null` and is retried on the next call, so a
   * transient failure does not permanently disable a row.
   *
   * @returns {Promise<void>} settles once the snapshot is current.
   */
  const ensureCapabilities = async () => {
    // A single in-flight call serves concurrent callers: two menu opens racing
    // must not both fetch.
    if (capabilitiesInFlight === undefined) {
      const known = store.get().capabilities
      const revealKnown = store.get().canReveal
      capabilitiesInFlight = Promise.all([
        known === null ? hostCapabilities() : null,
        revealKnown === null && typeof deps.canReveal === 'function' ? deps.canReveal() : null,
      ]).then(([host, reveal]) => {
        const patch = {}
        if (host !== null && host !== undefined) patch.capabilities = host
        if (reveal !== null && reveal !== undefined) patch.canReveal = reveal
        if (Object.keys(patch).length > 0) store.set(patch)
      }).finally(() => {
        capabilitiesInFlight = undefined
      })
    }
    await capabilitiesInFlight
  }

  /** Whether a composer is available to receive a mention. */
  const canAddToChat = () => deps.composer() !== undefined

  /**
   * Drop the cached clipboard answer so the next probe re-reads the host.
   *
   * Called after every action that could have changed the clipboard, so a paste
   * that just ran cannot leave a stale "clipboard holds files" behind.
   */
  const invalidateClipboard = () => {
    clipboardCache = null
  }

  /**
   * Probe the host clipboard and publish the answer into the store.
   *
   * Deliberately NOT awaited by the menu: `menuItemsFor` is a synchronous pure
   * function and cannot wait, so it reads whatever the store already says and
   * the overlay re-renders when this settles. Returned as a promise for the
   * callers that genuinely do need the answer first (`pasteFrom`).
   *
   * A failed read is not an error to report: a host with no OS clipboard is a
   * normal outcome (headless, or a browser session on another machine), and it
   * is answered by disabling the rows with the host's own reason.
   *
   * @param {boolean} [force] - ignore the cached answer and re-read.
   * @returns {Promise<{ supported: boolean, files: string[], text: string | null, reason: string | null }>} the answer.
   */
  const clipboardState = async (force = false) => {
    const now = Date.now()
    if (!force && clipboardCache !== null && now - clipboardCache.at < CLIPBOARD_CACHE_MS) {
      return clipboardCache.value
    }
    if (clipboardInFlight !== undefined) return clipboardInFlight

    clipboardInFlight = api.clipboardRead().then((result) => {
      if (!result.ok) {
        // The route itself failed. That is still "no usable clipboard" from the
        // page's point of view, and treating it as anything else would enable a
        // verb that cannot work.
        const value = {
          supported: false,
          files: [],
          text: null,
          reason: describeFailure(result),
        }
        clipboardCache = { at: Date.now(), value }
        return value
      }
      const payload = result.value ?? {}
      const files = Array.isArray(payload.files)
        ? payload.files.filter((entry) => typeof entry === 'string' && entry !== '')
        : []
      const value = {
        supported: payload.supported === true,
        files,
        text: typeof payload.text === 'string' ? payload.text : null,
        reason: typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : null,
      }
      clipboardCache = { at: Date.now(), value }
      return value
    }).finally(() => {
      clipboardInFlight = undefined
    })

    const value = await clipboardInFlight
    store.set({
      clipboardSupported: value.supported,
      clipboardHasFiles: value.supported && value.files.length > 0,
      clipboardReason: value.reason,
    })
    return value
  }

  /**
   * The synchronous clipboard answer the menu builder reads.
   *
   * Never awaits: it returns the last known snapshot and kicks off a refresh in
   * the background when the cache has expired. The menu renders from the
   * snapshot it has, which is why the store's initial value is the pessimistic
   * one.
   *
   * @returns {{ supported: boolean, hasFiles: boolean, reason: string | null }} the snapshot.
   */
  const clipboardHasFiles = () => {
    const state = store.get()
    void clipboardState()
    return {
      supported: state.clipboardSupported === true,
      hasFiles: state.clipboardSupported === true && state.clipboardHasFiles === true,
      reason: state.clipboardReason,
    }
  }

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
   * Insert the file as an atomic `@` reference chip in the composer.
   *
   * This is where the "add to conversation" behaviour actually lives, and it is
   * deliberately NOT `insertText('@path', span)`.
   *
   * Why: the composer is a Lexical editor, and `insertText` inserts an ordinary
   * TEXT node. The `@` highlight the user sees is a scan-derived decoration that
   * only matches short lexicon names — a full path never matches it — so raw text
   * would stay plain and unclickable. Worse, writing a literal `@` leaves the
   * caret inside a live `@` token, which is what re-opens the official completion
   * menu: that menu (and the Tab press needed to accept its first row) is exactly
   * the behaviour the user reported as wrong.
   *
   * `insertReference` instead writes a real chip NODE, which is highlighted by
   * construction, carries the canonical serialized mention into the prompt, and is
   * routable to an owner that opens the file. The official `@` source is named
   * `reference`, so the chip's owner is the official one: clicking it runs the
   * official preview behaviour, no plugin code required. Because a node — not a
   * token — is inserted, the completion menu never opens, so there is nothing to
   * confirm with Tab. A chip has no "selected" intermediate state by design
   * (`isKeyboardSelectable` is false upstream), and it is already the live
   * highlighted end state the moment it lands.
   *
   * @param {object} entry - the row entry.
   * @returns {boolean} whether the chip was inserted.
   */
  const addToChat = (entry) => {
    const composer = deps.composer()
    if (composer === undefined) {
      toast(t('menu.addToChat.disabled'), 'error')
      return false
    }
    const relative = relativeTo(entry.path, deps.workspaceRoot())
    const mention = mentionFor(relative, entry.kind)
    if (mention === null) {
      // The path has no valid mention spelling (a quote or a control character);
      // inserting it would produce a token the parser reads differently.
      toast(t('menu.addToChat.disabled'), 'error')
      return false
    }

    const span = composer.captureInsertion()
    const inserted = deps.insertReference(entry, {
      source: OFFICIAL_REFERENCE_SOURCE,
      // A directory is referenced with its trailing slash, which is how the
      // grammar tells folder from file, and is what makes a folder chip a folder.
      ref: mention,
      label: entry.kind === 'directory' ? `${baseName(entry.path)}/` : baseName(entry.path),
      appearance: entry.kind === 'directory' ? 'folder' : 'file',
      clipboardText: mention,
    }, span)

    if (!inserted) {
      // Fall back to plain text ONLY as a last resort, so the user's intent is
      // not lost when the reference route is refused (for example while a
      // submission is in flight). The mention is then inserted as characters.
      const text = composer.insertText(`${mention} `, composer.captureInsertion())
      if (!text) {
        toast(t('toast.mentionFailed'), 'error')
        return false
      }
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
   * Open the "copy to" dialog for one entry.
   *
   * The destination is chosen inside the dialog rather than before it opens: an
   * empty native picker is a silent no-op when the user cancels, and a dialog
   * that appears only after a picker closes gives the user nowhere to type a path
   * when the picker itself fails. The dialog also asks for the collision mode,
   * which has no sensible default to assume silently.
   *
   * @param {object} entry - the row entry (a file OR a directory).
   */
  const openCopyToDialog = async (entry) => {
    await ensureCapabilities()
    store.set({
      dialog: {
        kind: 'transfer',
        direction: 'copyTo',
        sources: [{ path: entry.path, name: entry.name, kind: entry.kind }],
        destination: '',
        // The same capability the save-as flow uses: without the native picker
        // the user can still type a path, so this only controls the button.
        canPick: store.get().capabilities?.saveAs === 'directory-picker',
      },
      transferError: null,
    })
  }

  /**
   * Write the "copy to" transfer.
   *
   * @param {string} destination - the destination folder.
   * @param {'rename' | 'overwrite' | 'skip'} collision - how to resolve a clash.
   */
  const confirmCopyTo = async (destination, collision) => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'transfer' || dialog.direction !== 'copyTo') return
    const sources = dialog.sources ?? []
    if (sources.length === 0) return
    store.set({ busy: true, transferError: null })
    const result = await api.copyOut(
      sources.map((source) => source.path),
      { destination, collision },
      deps.sessionId(),
    )
    store.set({ busy: false })
    if (!result.ok) {
      const message = describeFailure(result)
      // Keep the dialog open on a refusal: the destination is usually the thing
      // to correct, and closing would make the user re-enter everything.
      store.set({ transferError: message })
      return
    }
    const value = result.value ?? {}
    const copied = Array.isArray(value.copied) ? value.copied : []
    const skipped = Array.isArray(value.skipped) ? value.skipped : []
    store.set({ dialog: null, transferError: null })
    if (copied.length === 0) {
      // Nothing was written, so "copied 0 items" would be a false success.
      const reason = skipped[0]?.reason
      toast(
        typeof reason === 'string'
          ? t('toast.copyOutFailed', { message: reason })
          : t('toast.transferNothing'),
        'error',
      )
      return
    }
    toast(t('toast.copiedOut', {
      count: String(copied.length),
      path: typeof value.destination === 'string' ? value.destination : destination,
    }), 'success')
    if (skipped.length > 0) toast(t('toast.transferSkipped', { count: String(skipped.length) }), 'error')
    deps.afterMutation()
  }

  /**
   * Put one entry on the operating system clipboard as a file drop list.
   *
   * This is the outward half of the clipboard feature and is NOT the same verb as
   * "copy to": nothing is copied anywhere. The path goes on the OS clipboard so
   * the user can paste it themselves in Explorer or Finder, which is what makes
   * the plugin usable for the "get this file out of the workspace" flow without
   * a destination dialog.
   *
   * @param {object} entry - the row entry.
   */
  const copyFiles = async (entry) => {
    // The non-forced read reuses the answer the menu open already fetched, so
    // this does not spawn a second host process just to re-confirm support.
    const state = await clipboardState()
    if (!state.supported) {
      toast(t('toast.clipboardUnavailable', {
        message: state.reason ?? t('error.clipboardUnavailable'),
      }), 'error')
      return
    }
    const result = await api.clipboardWrite([entry.path])
    // The clipboard just changed, so the cached answer is wrong either way.
    invalidateClipboard()
    if (!result.ok) {
      toast(t('toast.copyOutFailed', { message: describeFailure(result) }), 'error')
      return
    }
    const written = Number(result.value?.written ?? 0)
    if (!Number.isFinite(written) || written < 1) {
      // The Host answered ok but wrote nothing; claiming success would be a lie.
      toast(t('toast.copyFailed'), 'error')
      return
    }
    toast(t('toast.copiedToClipboard'), 'success')
    // Re-probe: pasteFrom's row should become enabled now that files are there.
    void clipboardState(true)
  }

  /**
   * Read the clipboard and open the "paste here" dialog for one directory.
   *
   * The read happens first and outside the dialog, because an empty clipboard is
   * not something the dialog can resolve — the user has to go and copy something.
   * Reporting it as a toast is the honest outcome, and it is what keeps the
   * confirmation dialog from ever listing zero entries.
   *
   * @param {object} entry - the directory row (or the root menu's synthesized entry).
   */
  const openPasteFromDialog = async (entry) => {
    await ensureCapabilities()
    const state = await clipboardState(true)
    if (!state.supported) {
      toast(t('toast.clipboardUnavailable', {
        message: state.reason ?? t('error.clipboardUnavailable'),
      }), 'error')
      return
    }
    if (state.files.length === 0) {
      toast(t('toast.clipboardEmpty'), 'error')
      return
    }
    store.set({
      dialog: {
        kind: 'transfer',
        direction: 'pasteFrom',
        // The clipboard gives absolute paths and nothing else, so the name is
        // derived locally purely for display.
        sources: state.files.map((path) => ({ path, name: baseName(path), kind: 'file' })),
        destination: entry.path,
        canPick: store.get().capabilities?.saveAs === 'directory-picker',
      },
      transferError: null,
    })
  }

  /**
   * Write the "paste here" transfer.
   *
   * `sourcePaths` is passed explicitly rather than letting the Host re-read the
   * clipboard: the user confirmed a specific list, and the clipboard could have
   * changed between the dialog opening and the button being pressed. What they
   * saw is what gets pasted.
   *
   * @param {string} directory - the destination folder.
   * @param {'rename' | 'overwrite' | 'skip'} collision - how to resolve a clash.
   */
  const confirmPasteFrom = async (directory, collision) => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'transfer' || dialog.direction !== 'pasteFrom') return
    const sources = dialog.sources ?? []
    if (sources.length === 0) return
    store.set({ busy: true, transferError: null })
    const result = await api.pasteIn(
      directory,
      { sourcePaths: sources.map((source) => source.path), collision },
      deps.sessionId(),
    )
    store.set({ busy: false })
    if (!result.ok) {
      const code = String(result.code ?? '')
      const message = code.endsWith('/self-nested') ? t('error.selfNested') : describeFailure(result)
      store.set({ transferError: message })
      return
    }
    const value = result.value ?? {}
    const copied = Array.isArray(value.copied) ? value.copied : []
    const skipped = Array.isArray(value.skipped) ? value.skipped : []
    store.set({ dialog: null, transferError: null })
    if (copied.length === 0) {
      // Nothing was written. Reporting "pasted 0 items" as a success would be a
      // lie, and the per-entry reason is the only honest thing to show.
      const reason = skipped[0]?.reason
      toast(
        typeof reason === 'string'
          ? t('toast.pasteFailed', { message: reason })
          : t('toast.transferNothing'),
        'error',
      )
      return
    }
    toast(t('toast.pastedIn', {
      count: String(copied.length),
      path: typeof value.directory === 'string' ? value.directory : directory,
    }), 'success')
    if (skipped.length > 0) toast(t('toast.transferSkipped', { count: String(skipped.length) }), 'error')
    // The tree's own watches usually notice, but a bump re-measures the overlays
    // that track a row and makes the new entries appear immediately.
    deps.afterMutation()
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
      case 'copyTo':
        await openCopyToDialog(entry)
        return
      case 'copyFiles':
        await copyFiles(entry)
        return
      case 'pasteFrom':
        await openPasteFromDialog(entry)
        return
      case 'rename':
        // The task calls for in-place editing, so the row itself becomes an
        // input rather than a modal opening over it.
        startInlineRename(entry)
        return
      case 'newFile':
        openCreateDialog('file', entry)
        return
      case 'newFolder':
        openCreateDialog('directory', entry)
        return
      case 'update':
        await checkUpdate()
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
   * Open the "new file" / "new folder" prompt for a directory.
   *
   * The parent is the row's own directory for a folder row, and the workspace root
   * for the root menu — they arrive on the entry's `path` either way, so the two
   * surfaces share one code path.
   *
   * @param {'file' | 'directory'} kind - what to create.
   * @param {object} entry - the containing entry (its path is the parent).
   */
  const openCreateDialog = (kind, entry) => {
    store.set({
      dialog: {
        kind: 'create',
        createKind: kind,
        entry: { path: entry.path, name: entry.name, kind: entry.kind },
      },
      createError: null,
    })
  }

  /**
   * Create the entry the prompt names.
   *
   * @param {string} name - the new entry's name.
   */
  const confirmCreate = async (name) => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'create') return
    store.set({ busy: true, createError: null })
    const result = await api.create(dialog.entry.path, name, dialog.createKind, deps.sessionId())
    if (result.ok) {
      store.set({ dialog: null, busy: false })
      toast(t('toast.created', { name: result.value.name ?? name }), 'success')
      deps.afterMutation()
      return
    }
    // Keep the prompt open with the reason so the user can correct the name.
    store.set({ busy: false, createError: describeFailure(result) })
  }

  /**
   * Read the installed and the available version, and open the update dialog.
   *
   * The dialog opens immediately in a "checking" state and is filled when the
   * Host answers: a click that appears to do nothing for a second is worse than
   * one that visibly says it is asking.
   */
  const checkUpdate = async (options = {}) => {
    store.set({ dialog: { kind: 'update', stage: 'checking' }, updateBusy: true })
    const result = await api.updateCheck(options)
    store.set({ updateBusy: false })
    if (!result.ok) {
      store.set({ dialog: { kind: 'update', stage: 'error', message: describeFailure(result) } })
      return
    }
    // A Host that answered with `checked: false` did not settle the question —
    // it reports why GitHub could not be consulted. That is an ERROR state, not
    // "up to date": rendering it as the latter told the user the opposite of the
    // truth and hid the network failure they needed to act on.
    if (result.value.checked === false || result.value.error !== undefined) {
      const message = String(result.value.error ?? t('dialog.update.failed', { message: '' }))
      store.set({
        update: result.value,
        dialog: { kind: 'update', stage: 'error', info: result.value, message },
      })
      return
    }
    // Versions that could not be compared are also not an answer. Reachable when
    // the release tag is not semver, in which case `checked` is false and has
    // already been handled above; kept as a guard for a future Host.
    if (result.value.hasUpdate === null) {
      store.set({
        update: result.value,
        dialog: { kind: 'update', stage: 'error', info: result.value, message: String(result.value.note ?? '') },
      })
      return
    }
    store.set({
      update: result.value,
      dialog: { kind: 'update', stage: 'ready', info: result.value },
    })
  }

  /**
   * Install the newest release of this plugin.
   *
   * The Host decides what "update" can mean in this deployment: where it can
   * delegate to the plugin manager it does, and where it cannot it answers with
   * the exact command to run. Both outcomes are reported verbatim, because
   * claiming an update that did not happen would leave the user running old code.
   */
  const applyUpdate = async () => {
    const dialog = store.get().dialog
    if (dialog === null || dialog.kind !== 'update') return
    store.set({ updateBusy: true, dialog: { kind: 'update', stage: 'applying', info: dialog.info } })
    const result = await api.updateApply(deps.sessionId())
    store.set({ updateBusy: false })
    if (!result.ok) {
      const message = describeFailure(result)
      store.set({ dialog: { kind: 'update', stage: 'error', message }, updateBusy: false })
      toast(t('toast.updateApplyFailed', { message }), 'error')
      return
    }
    const value = result.value ?? {}
    // `manualCommand` is present whenever the Host could not install the change
    // itself — including every refusal — so it is the one honest marker of "the
    // profile was not updated". Reporting success on a refusal is the exact
    // failure this dialog exists to avoid.
    if (value.applied !== true) {
      store.set({ dialog: { kind: 'update', stage: 'manual', info: value } })
      return
    }
    store.set({ dialog: { kind: 'update', stage: 'done', info: value } })
    toast(value.restartRequired === true ? t('toast.updateRestart') : t('toast.updateApplied'), 'success')
  }

  /**
   * Open the delete confirmation, worded for the mode that will actually run.
   *
   * @param {object} entry - the row entry.
   */
  const openDeleteDialog = async (entry) => {
    await ensureCapabilities()
    // Read the snapshot after the await: `null` trash means the answer has not
    // arrived yet, and opening a "permanent" dialog on a guess is worse than
    // assuming the ordinary bin and correcting it if the delete is refused.
    const trashSupported = store.get().capabilities?.trash?.supported === true
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
    await ensureCapabilities()
    const info = await api.stat(entry.path, deps.sessionId())
    const bytes = info.ok ? Number(info.value.bytes ?? 0) : undefined
    // The directory picker plus the Host write is the desktop/self-hosted path;
    // anywhere else the dialog falls back to a browser download.
    const canWrite = store.get().capabilities?.saveAs === 'directory-picker'
    store.set({
      dialog: {
        kind: 'saveAs',
        // The source's folder is the natural default destination, and it is the
        // value the editable field starts from.
        entry: { ...entry, bytes, suggestedDirectory: dirName(entry.path) },
        canWrite,
      },
    })
  }

  /** Close the active dialog. */
  const closeDialog = () => {
    // The inline transfer error belongs to the dialog that owned it, so it is
    // cleared with it; a stale refusal reappearing on the next dialog would be
    // blamed on the wrong action.
    store.set({ dialog: null, busy: false, transferError: null })
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
      // warning rather than silently deleting anything. The cached capability is
      // dropped so the next menu open re-probes, and a permanent fallback that is
      // disabled by configuration surfaces as an error instead.
      invalidateCapabilities()
      const allowPermanent = result.details?.disabled === true ? false : true
      if (!allowPermanent) {
        store.set({ busy: false, capabilities: null })
        toast(t('error.unsupported'), 'error')
        return
      }
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

  /** Start an inline rename on the row that opened the menu. */
  const startInlineRename = (entry) => {
    // A hover button over the row being renamed would fight the input for the
    // same pixels, so it is cleared at the same time.
    store.set({
      renaming: { path: entry.path, name: entry.name, kind: entry.kind },
      renameError: null,
      menu: null,
      hover: null,
    })
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
   * Open the context menu for a row.
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
   * Open the context menu for the blank area of the project root.
   *
   * The root has no row, so the "entry" here is synthesized from the tree's own
   * published root: `kind: 'root'` selects the reduced menu (creation only), and
   * the path is what a created entry's parent will be.
   *
   * @param {MouseEvent} event - the triggering event.
   * @param {string} root - the absolute workspace root.
   */
  const openBlankMenu = (event, root) => {
    store.set({
      menu: {
        path: root,
        name: baseName(root),
        kind: 'root',
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
      // Kicked off, never awaited: the menu must open on this tick. The rows
      // render disabled from the current snapshot and enable themselves when the
      // answer lands and the store update re-renders the overlay.
      void clipboardState()
      openMenu(entry, event)
    },
    onBlankContextMenu: (event, root) => {
      void clipboardState()
      openBlankMenu(event, root)
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
    openBlankMenu,
    canAddToChat,
    ensureCapabilities,
    closeDialog,
    confirmDelete,
    startInlineRename,
    cancelInlineRename,
    commitInlineRename,
    pickDirectory,
    confirmSaveAs,
    confirmOverwrite,
    confirmCreate,
    checkUpdate,
    applyUpdate,
    clipboardState,
    clipboardHasFiles,
    invalidateClipboard,
    confirmCopyTo,
    confirmPasteFrom,
  }
}
