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
import { DeleteDialog, OverwriteDialog, RenameDialog, SaveAsDialog } from './dialogs.jsx'
import { findRow } from './controller.js'
import { IconAt } from './icons.jsx'

/**
 * Track one row's on-screen box, following scroll and layout changes.
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
 * The hover `@` button, drawn over the hovered row.
 *
 * It is absolutely positioned rather than injected into the row so the file name
 * keeps its full width and its own ellipsis behaviour.
 *
 * @param {object} props - component props.
 * @param {{ path: string } | null} props.entry - the hovered row.
 * @param {number} props.revision - tree mutation counter.
 * @param {(entry: object) => void} props.onClick - run "add to conversation".
 * @param {(key: string) => string} props.t - translate.
 * @returns {unknown} the button, or null.
 */
function HoverAtButton({ entry, revision, onClick, t }) {
  const box = useRowBox(entry === null ? null : entry.path, revision)
  if (entry === null || box === null) return null
  return jsx('button', {
    type: 'button',
    className: 'dfx-row-at',
    'data-visible': 'true',
    title: t('aria.atButton'),
    'aria-label': t('aria.atButton'),
    style: {
      left: `${String(box.left + box.width - 28)}px`,
      top: `${String(box.top + box.height / 2 - 11)}px`,
    },
    onPointerDown: (event) => {
      // The row's own click opens the file; this button must not also open it.
      event.preventDefault()
      event.stopPropagation()
    },
    onClick: (event) => {
      event.preventDefault()
      event.stopPropagation()
      onClick(entry)
    },
    children: jsx(IconAt, {}),
  })
}

/**
 * The inline rename editor, drawn over the row being renamed.
 *
 * A real input, focused and with the stem selected, so Enter/Escape behave as
 * the task requires. It commits through the Host, then closes; the tree
 * refreshes itself through its own directory watch.
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

  useEffect(() => {
    setValue(entry.name)
  }, [entry.name, entry.path])

  useEffect(() => {
    const input = inputRef.current
    if (!(input instanceof HTMLInputElement)) return
    input.focus()
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }, [entry.name])

  if (box === null) {
    // The row vanished (collapsed directory, refresh): close instead of
    // floating an editor over unrelated content.
    onCancel()
    return null
  }

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
      // A click elsewhere is a cancel, matching the tree's own click behaviour.
      if (!busy) onCancel()
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const name = value.trim()
        if (name === '' || name === entry.name) {
          onCancel()
          return
        }
        onCommit(name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
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
      canReveal: state.capabilities?.reveal !== false,
      canAddToChat: controller.canAddToChat(),
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
  if (dialog.kind === 'rename') {
    return jsx(RenameDialog, {
      entry,
      busy: state.busy,
      onConfirm: (name) => controller.confirmRename(name),
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
  return null
}
