/**
 * The overlay root: menu, dialogs, toast stack, and the hover button.
 *
 * Rendered into the host's `shell.overlay` slot, which is the official
 * frame-wide floating layer. The layer is click-through, so every element here
 * opts back into pointer events; nothing blocks the application underneath.
 *
 * The hover `@` button and the inline rename editor are positioned absolutely
 * over the tree row they belong to, tracking it through scroll and re-render.
 *
 * @module dsh-file-extension/client/overlay
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'
import { ContextMenu, menuItemsFor } from './menu.jsx'
import { DeleteDialog, NewEntryDialog, OverwriteDialog, SaveAsDialog, UpdateDialog } from './dialogs.jsx'
import { findRow } from './controller.js'
import { ICON_AT_HTML } from './icons.jsx'

/**
 * Track one row's on-screen box, following scroll and layout changes.
 *
 * The box starts as `null` and is filled by a layout effect on mount. Callers
 * must treat the first `null` as "not measured yet" rather than "row gone";
 * `measureRow` below reports which it is.
 *
 * @param {string | null} path - the row's absolute path, or null.
 * @param {number} revision - bumped by the controller on any tree mutation.
 * @returns {{ left: number, top: number, width: number, height: number } | null} the box.
 */
function useRowBox(path, revision) {
  const [box, setBox] = useState(null)
  useLayoutEffect(() => {
    if (path === null) {
      setBox(null)
      return
    }
    const measure = () => {
      const row = findRow(path)
      if (row === null) {
        setBox(null)
        return
      }
      const rect = row.getBoundingClientRect()
      setBox((previous) => {
        if (
          previous !== null
          && previous.left === rect.left
          && previous.top === rect.top
          && previous.width === rect.width
          && previous.height === rect.height
        ) {
          return previous
        }
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      })
    }
    measure()
    // A capture-phase listener sees the tree's own scroll container without
    // needing its class name, and resize covers pane resizing.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [path, revision])
  return box
}

/**
 * The hover `@` button.
 *
 * The button is mounted *inside* the hovered row (the row is a positioned list
 * item once the plugin marks it), not in a fixed overlay. Mounting it outside
 * meant the button appeared under the pointer, the pointer then counted as
 * having left the row, the button unmounted, and the cycle repeated — the
 * flicker that made the button impossible to click. As a child of the row the
 * pointer never leaves the row, so the hover is stable and clicks land.
 *
 * @param {object} props - component props.
 * @param {{ path: string } | null} props.entry - the hovered row.
 * @param {number} props.revision - tree mutation counter.
 * @param {(entry: object) => void} props.onClick - run "add to conversation".
 * @param {(key: string) => string} props.t - translate.
 * @returns {null} the button is portal-mounted by an effect; nothing renders.
 */
function HoverAtButton({ entry, revision, onClick, t }) {
  const path = entry === null ? null : entry.path
  // Keep the click handler in a ref so a new closure does not tear the button
  // down and rebuild it; only a different hovered row does that.
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  const entryRef = useRef(entry)
  entryRef.current = entry
  void revision

  useEffect(() => {
    if (path === null) return undefined
    const row = findRow(path)
    if (row === null) return undefined

    // The row is a `li`; making it the offset parent keeps the button anchored
    // through scroll without measuring.
    row.style.position = 'relative'
    row.dataset.dfxHover = 'true'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dfx-row-at'
    button.dataset.visible = 'true'
    button.title = t('aria.atButton')
    button.setAttribute('aria-label', t('aria.atButton'))
    button.innerHTML = ICON_AT_HTML
    button.addEventListener('pointerdown', (event) => {
      // The row's own click opens the file; this button must not also open it.
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const current = entryRef.current
      clickRef.current(current === null ? { path } : current)
    })
    row.appendChild(button)
    return () => {
      button.remove()
      delete row.dataset.dfxHover
      row.style.removeProperty('position')
    }
    // Deliberately keyed only on the hovered path: the tree reuses the row
    // element for the same path, so rebuilding on every mutation is pure churn
    // and used to feed the observer loop that made the button flicker.
  }, [path, t])

  return null
}

/**
 * The inline rename editor, drawn over the row being renamed.
 *
 * A real input, focused and with the stem selected. It commits the typed name on
 * Enter **and on a click anywhere else** — the task's flow is "type the new name,
 * click another area, and the rename must have taken effect" — and dismisses on
 * Escape. It commits through the Host, then closes; the tree refreshes itself
 * through its own directory watch.
 *
 * @param {object} props - component props.
 * @param {{ path: string, name: string, kind: string }} props.entry - the target.
 * @param {number} props.revision - tree mutation counter.
 * @param {boolean} props.busy - true while the request is in flight.
 * @param {(name: string) => void} props.onCommit - accept.
 * @param {() => void} props.onCancel - dismiss.
 * @param {string | null} props.error - a message to show beneath.
 * @param {(key: string, vars?: object) => string} props.t - translate.
 * @returns {unknown} the editor, or null when its row is gone.
 */
function InlineRename({ entry, revision, busy, onCommit, onCancel, error, t }) {
  const box = useRowBox(entry.path, revision)
  const [value, setValue] = useState(entry.name)
  const inputRef = useRef(null)
  /**
   * A row is only "gone" after it has been looked for at least once and not
   * found. The box is `null` before the first layout effect runs, so treating a
   * null box as "gone" would cancel the editor before it ever rendered.
   */
  const [rowMissing, setRowMissing] = useState(false)

  /**
   * Whether this editor has already settled.
   *
   * Commit and dismissal are triggered by events that overlap — Enter blurs the
   * input, so `onBlur` fires after the keydown, and a click that dismisses is
   * also the blur that commits — so without a latch one rename would be sent
   * twice, or a commit would race a cancel.
   */
  const settledRef = useRef(false)

  /**
   * Settle the editor by committing the typed name.
   *
   * The name is read from the input element rather than from React state: state
   * lags behind a programmatic write, and committing the stale value would send
   * the file's current name — indistinguishable from "rename does nothing".
   * An unchanged or empty name simply closes the editor, so pressing Enter (or
   * clicking away) after no edit is not an error.
   */
  const settle = () => {
    if (settledRef.current) return
    settledRef.current = true
    const input = inputRef.current
    const live = input instanceof HTMLInputElement ? input.value : value
    const name = live.trim()
    if (name === '' || name === entry.name) {
      onCancel()
      return
    }
    setValue(name)
    onCommit(name)
  }

  /** Settle the editor by discarding the edit; a later blur must not commit. */
  const dismiss = () => {
    if (settledRef.current) return
    settledRef.current = true
    onCancel()
  }

  useEffect(() => {
    setValue(entry.name)
  }, [entry.name, entry.path])

  // Focus the input once it actually exists in the document. On the first render
  // the box is null and the component returns null, so the ref attaches only
  // after the layout effect reports a measured row.
  const focusedRef = useRef(false)
  useEffect(() => {
    const input = inputRef.current
    if (!(input instanceof HTMLInputElement)) return
    if (focusedRef.current) return
    focusedRef.current = true
    input.focus()
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }, [box, entry.name])

  useEffect(() => {
    if (box === null) {
      // Look once more: if the row is truly absent, close rather than float an
      // editor over unrelated content. Runs in an effect, never during render,
      // because a setState while rendering makes React drop the update.
      setRowMissing(findRow(entry.path) === null)
      return
    }
    setRowMissing(false)
  }, [box, entry.path])

  useEffect(() => {
    if (rowMissing) dismiss()
  }, [rowMissing])

  // The box is filled by a layout effect, so the first render has none. Waiting
  // one frame to render the input at a measured position is safer than reading
  // `box.left` before it exists.
  if (box === null) return null
  if (rowMissing) return null

  return jsx('input', {
    ref: inputRef,
    className: 'dfx-rename-input',
    value,
    disabled: busy,
    'aria-label': t('dialog.rename.label'),
    'data-invalid': error === null ? undefined : 'true',
    style: {
      left: `${String(box.left + 6)}px`,
      top: `${String(box.top + 1)}px`,
      width: `${String(Math.max(120, box.width - 12))}px`,
      height: `${String(Math.max(20, box.height - 2))}px`,
    },
    onChange: (event) => setValue(event.target.value),
    onBlur: () => {
      // Clicking anywhere else COMMITS the typed name. This is the behaviour the
      // task asks for ("输入新名字后点击其他区域，改名应完成并生效") and it is the
      // opposite of what this handler used to do: a blur called `onCancel`, so
      // typing a name and then clicking away silently discarded it, which is
      // exactly the "rename still does nothing" report.
      //
      // Two blurs must not settle the editor: one that arrives while the commit
      // is already in flight (focus moved for a reason the user did not choose),
      // and one caused by the row disappearing (the editor is unmounting, not
      // being dismissed).
      if (busy || rowMissing) return
      settle()
    },
    onKeyDown: (event) => {
      // A Chinese/Japanese IME uses Enter to confirm the composition; that
      // keydown must not commit the rename, or the first Enter after typing
      // CJK looks like "rename does nothing" (it commits the unedited IME
      // string or cancels outright).
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') {
        event.preventDefault()
        settle()
        return
      }
      if (event.key === 'Escape') {
        if (event.isComposing || event.keyCode === 229) return
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }
    },
    onPointerDown: (event) => event.stopPropagation(),
    onClick: (event) => event.stopPropagation(),
    onContextMenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
    },
  })
}

/**
 * The toast stack.
 *
 * @param {object} props - component props.
 * @param {readonly object[]} props.toasts - active toasts.
 * @returns {unknown} the stack, or null.
 */
function ToastStack({ toasts }) {
  if (toasts.length === 0) return null
  return jsx('div', {
    className: 'dfx-toast-stack',
    role: 'status',
    'aria-live': 'polite',
    children: toasts.map((toast) => jsx('div', {
      key: toast.id,
      className: 'dfx-toast',
      'data-level': toast.level,
      children: toast.text,
    })),
  })
}

/**
 * The overlay root component.
 *
 * @param {object} props - component props.
 * @param {object} props.controller - the plugin controller (store + actions).
 * @returns {unknown} the overlay.
 */
export function Overlay({ controller }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.get, controller.store.get)
  const t = controller.t

  const items = state.menu === null
    ? []
    : menuItemsFor({
      kind: state.menu.kind,
      canReveal: state.canReveal !== false,
      canAddToChat: controller.canAddToChat(),
      // The update verb is offered everywhere the menu is, so a user who cannot
      // reach another surface can still check for a new release.
      canUpdate: true,
    }).map((item) => (item.kind === 'separator'
      ? item
      : {
        ...item,
        label: t(item.labelKey),
        hint: item.hintKey === undefined ? undefined : t(item.hintKey),
      }))
  const onActivate = useCallback((item) => {
    controller.runMenuAction(item.action)
  }, [controller])

  const onMenuClose = useCallback(() => {
    controller.store.set({ menu: null })
  }, [controller])

  return jsx('div', {
    className: 'dfx-root',
    children: [
      state.menu === null
        ? null
        : jsx(ContextMenu, {
          key: 'menu',
          anchor: state.menu.anchor,
          items,
          onActivate,
          onClose: onMenuClose,
          t,
        }),
      state.dialog === null
        ? null
        : renderDialog(state, controller, t),
      jsx(HoverAtButton, {
        key: 'at',
        entry: state.hover,
        revision: state.revision,
        onClick: (entry) => controller.addToChat(entry),
        t,
      }),
      state.renaming === null
        ? null
        : jsx(InlineRename, {
          key: `rename-${state.renaming.path}`,
          entry: state.renaming,
          revision: state.revision,
          busy: state.busy,
          error: state.renameError,
          onCommit: (name) => controller.commitInlineRename(name),
          onCancel: () => controller.cancelInlineRename(),
          t,
        }),
      jsx(ToastStack, { key: 'toasts', toasts: state.toasts }),
    ],
  })
}

/**
 * Render the active dialog.
 *
 * @param {object} state - the plugin snapshot.
 * @param {object} controller - the plugin controller.
 * @param {(key: string, vars?: object) => string} t - translate.
 * @returns {unknown} the dialog element.
 */
function renderDialog(state, controller, t) {
  const dialog = state.dialog
  const entry = dialog.entry
  if (dialog.kind === 'delete') {
    return jsx(DeleteDialog, {
      entry,
      permanent: dialog.permanent === true,
      busy: state.busy,
      onConfirm: (permanent) => controller.confirmDelete(permanent),
      onCancel: () => controller.closeDialog(),
      t,
    })
  }
  if (dialog.kind === 'saveAs') {
    return jsx(SaveAsDialog, {
      entry,
      canWrite: dialog.canWrite === true,
      busy: state.busy,
      pickDirectory: (name) => controller.pickDirectory(name),
      onConfirm: (name, directory) => controller.confirmSaveAs(name, directory),
      onCancel: () => controller.closeDialog(),
      t,
    })
  }
  if (dialog.kind === 'overwrite') {
    return jsx(OverwriteDialog, {
      name: dialog.name,
      busy: state.busy,
      onConfirm: () => controller.confirmOverwrite(),
      onCancel: () => controller.closeDialog(),
      t,
    })
  }
  if (dialog.kind === 'create') {
    return jsx(NewEntryDialog, {
      kind: dialog.createKind,
      entry: dialog.entry,
      error: state.createError,
      busy: state.busy,
      onConfirm: (name) => controller.confirmCreate(name),
      onCancel: () => controller.closeDialog(),
      t,
    })
  }
  if (dialog.kind === 'update') {
    return jsx(UpdateDialog, {
      stage: dialog.stage,
      info: dialog.stage === 'ready' || dialog.stage === 'applying' ? dialog.info : (dialog.info ?? state.update),
      message: dialog.message ?? null,
      busy: state.updateBusy === true,
      onApply: () => controller.applyUpdate(),
      onRecheck: () => controller.checkUpdate(),
      onCancel: () => controller.closeDialog(),
      t,
    })
  }
  return null
}
