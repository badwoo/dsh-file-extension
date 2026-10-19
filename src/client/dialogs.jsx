/**
 * The plugin's dialogs: delete confirmation, save-as, and overwrite.
 *
 * Each is a small controlled component rendered into the plugin's overlay. They
 * share one shell so focus handling, Escape, and the button row behave the same
 * everywhere. Rename is deliberately absent: it is an inline editor over the row
 * rather than a modal, so it lives in `overlay.jsx`.
 *
 * @module dsh-file-extension/client/dialogs
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { formatBytes } from './store.js'

/**
 * Trap focus inside a dialog and restore it on close.
 *
 * @param {import('react').RefObject<HTMLElement>} ref - the dialog element.
 * @param {() => void} onCancel - Escape handler.
 */
function useDialogBehavior(ref, onCancel) {
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const previouslyFocused = document.activeElement
    const focusable = () => [...element.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter((node) => node instanceof HTMLElement)

    // Focus the first sensible control: an input when there is one, so typing
    // starts immediately, otherwise the primary action.
    const first = element.querySelector('input:not(:disabled)')
    if (first instanceof HTMLElement) {
      first.focus()
      if (first instanceof HTMLInputElement) first.select()
    } else {
      const candidates = focusable()
      const primary = element.querySelector('[data-primary="true"], [data-danger="true"]')
      const target = primary instanceof HTMLElement ? primary : candidates[0]
      target?.focus()
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const candidates = focusable()
      if (candidates.length === 0) return
      const firstNode = candidates[0]
      const lastNode = candidates[candidates.length - 1]
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault()
        lastNode.focus()
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault()
        firstNode.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [onCancel, ref])
}

/**
 * Shared dialog frame.
 *
 * @param {object} props - component props.
 * @param {string} props.title - heading text.
 * @param {unknown} props.children - body content.
 * @param {unknown} props.actions - the button row.
 * @param {() => void} props.onCancel - backdrop dismissal.
 * @returns {unknown} the dialog.
 */
function Dialog({ title, children, actions, onCancel }) {
  const ref = useRef(null)
  useDialogBehavior(ref, onCancel)
  return jsx('div', {
    className: 'dfx-dialog-backdrop',
    onPointerDown: (event) => {
      if (event.target === event.currentTarget) onCancel()
    },
    children: jsx('div', {
      ref,
      className: 'dfx-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onContextMenu: (event) => event.preventDefault(),
      children: [
        jsx('h2', { key: 'title', className: 'dfx-dialog-title', children: title }),
        ...children,
        jsx('div', { key: 'actions', className: 'dfx-dialog-actions', children: actions }),
      ],
    }),
  })
}

/**
 * Confirm a deletion, wording the body by the mode that will actually run.
 *
 * @param {object} props - component props.
 * @param {{ name: string, path: string, kind: string }} props.entry - the target.
 * @param {boolean} props.permanent - true when the recycle bin is unavailable.
 * @param {boolean} props.busy - true while the request is in flight.
 * @param {(permanent: boolean) => void} props.onConfirm - accept.
 * @param {() => void} props.onCancel - dismiss.
 * @param {(key: string, vars?: object) => string} props.t - translate.
 * @returns {unknown} the dialog.
 */
export function DeleteDialog({ entry, permanent, busy, onConfirm, onCancel, t }) {
  const isDirectory = entry.kind === 'directory'
  const bodyKey = permanent
    ? (isDirectory ? 'dialog.delete.bodyPermanentDirectory' : 'dialog.delete.bodyPermanent')
    : (isDirectory ? 'dialog.delete.bodyDirectory' : 'dialog.delete.body')
  return jsx(Dialog, {
    title: t('dialog.delete.title', { name: entry.name }),
    onCancel,
    children: [
      jsx('p', {
        key: 'body',
        className: 'dfx-dialog-body',
        'data-danger': permanent ? 'true' : undefined,
        children: t(bodyKey),
      }),
      jsx('code', { key: 'path', className: 'dfx-dialog-path', children: entry.path }),
    ],
    actions: [
      jsx('button', {
        key: 'cancel',
        type: 'button',
        className: 'dfx-button',
        disabled: busy,
        onClick: onCancel,
        children: t('dialog.cancel'),
      }),
      jsx('button', {
        key: 'confirm',
        type: 'button',
        className: 'dfx-button',
        'data-danger': 'true',
        'data-primary': permanent ? undefined : 'true',
        disabled: busy,
        onClick: () => onConfirm(permanent),
        children: permanent ? t('dialog.delete.confirmPermanent') : t('dialog.delete.confirm'),
      }),
    ],
  })
}

/**
 * Rename one entry, validating locally so the common mistakes never reach the
 * Host. The Host still validates: this is convenience, not the guard.
 *
 * @param {object} props - component props.
 * @param {{ name: string, path: string }} props.entry - the target.
 * @param {boolean} props.busy - true while the request is in flight.
 * @param {(name: string) => void} props.onConfirm - accept.
 * @param {() => void} props.onCancel - dismiss.
 * @param {(key: string, vars?: object) => string} props.t - translate.
 * @returns {unknown} the dialog.
 */
/**
 * Save a copy: name plus destination folder.
 *
 * When the Host can write to disk, the destination is chosen with the platform's
 * own directory picker and the copy is written by the Host. When it cannot, the
 * same dialog falls back to a browser download, saying so.
 *
 * @param {object} props - component props.
 * @param {{ name: string, path: string, bytes?: number }} props.entry - the source.
 * @param {boolean} props.canWrite - whether the Host can write to disk.
 * @param {boolean} props.busy - true while the request is in flight.
 * @param {(directory: string) => Promise<string | null>} props.pickDirectory - native picker.
 * @param {(name: string, directory: string | null) => void} props.onConfirm - accept.
 * @param {() => void} props.onCancel - dismiss.
 * @param {(key: string, vars?: object) => string} props.t - translate.
 * @returns {unknown} the dialog.
 */
export function SaveAsDialog({ entry, canWrite, busy, pickDirectory, onConfirm, onCancel, t }) {
  const [name, setName] = useState(entry.name)
  const [directory, setDirectory] = useState(null)
  const [error, setError] = useState(null)
  const [picking, setPicking] = useState(false)

  const choose = useCallback(async () => {
    setPicking(true)
    try {
      const picked = await pickDirectory(entry.name)
      if (picked !== null) setDirectory(picked)
    } finally {
      setPicking(false)
    }
  }, [entry.name, pickDirectory])

  const submit = useCallback(() => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setError(t('error.empty'))
      return
    }
    setError(null)
    onConfirm(trimmed, directory)
  }, [directory, name, onConfirm, t])

  const oversized = typeof entry.bytes === 'number' && entry.bytes > 32 * 1024 * 1024

  return jsx(Dialog, {
    title: t('dialog.saveAs.title'),
    onCancel,
    children: [
      jsx('div', {
        key: 'name',
        className: 'dfx-dialog-field',
        children: [
          jsx('label', { key: 'label', className: 'dfx-dialog-label', children: t('dialog.saveAs.name') }),
          jsx('input', {
            key: 'input',
            className: 'dfx-input',
            value: name,
            'data-invalid': error === null ? undefined : 'true',
            disabled: busy,
            onChange: (event) => {
              setName(event.target.value)
              setError(null)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            },
          }),
        ],
      }),
      canWrite
        ? jsx('div', {
          key: 'directory',
          className: 'dfx-dialog-field',
          children: [
            jsx('label', { key: 'label', className: 'dfx-dialog-label', children: t('dialog.saveAs.directory') }),
            jsx('div', {
              key: 'row',
              className: 'dfx-dialog-row',
              children: [
                jsx('input', {
                  key: 'input',
                  className: 'dfx-input',
                  value: directory ?? '',
                  readOnly: true,
                  placeholder: t('dialog.saveAs.directory'),
                }),
                jsx('button', {
                  key: 'choose',
                  type: 'button',
                  className: 'dfx-button',
                  disabled: busy || picking,
                  onClick: choose,
                  children: t('dialog.saveAs.choose'),
                }),
              ],
            }),
          ],
        })
        : jsx('p', {
          key: 'hint',
          className: 'dfx-dialog-body',
          children: t('dialog.saveAs.downloadHint'),
        }),
      oversized
        ? jsx('p', {
          key: 'size',
          className: 'dfx-dialog-body',
          children: t('dialog.saveAs.tooLarge', { size: formatBytes(entry.bytes) }),
        })
        : null,
      jsx('div', { key: 'error', className: 'dfx-dialog-hint', children: error ?? '' }),
    ],
    actions: [
      jsx('button', {
        key: 'cancel',
        type: 'button',
        className: 'dfx-button',
        disabled: busy,
        onClick: onCancel,
        children: t('dialog.cancel'),
      }),
      jsx('button', {
        key: 'confirm',
        type: 'button',
        className: 'dfx-button',
        'data-primary': 'true',
        disabled: busy || (canWrite && directory === null),
        onClick: submit,
        children: canWrite ? t('dialog.saveAs.confirm') : t('dialog.saveAs.download'),
      }),
    ],
  })
}

/**
 * A confirmation for replacing an existing file at the save-as destination.
 *
 * @param {object} props - component props.
 * @param {string} props.name - the clashing file name.
 * @param {boolean} props.busy - true while the request is in flight.
 * @param {() => void} props.onConfirm - accept.
 * @param {() => void} props.onCancel - dismiss.
 * @param {(key: string, vars?: object) => string} props.t - translate.
 * @returns {unknown} the dialog.
 */
export function OverwriteDialog({ name, busy, onConfirm, onCancel, t }) {
  return jsx(Dialog, {
    title: t('dialog.saveAs.title'),
    onCancel,
    children: jsx('p', {
      key: 'body',
      className: 'dfx-dialog-body',
      'data-danger': 'true',
      children: t('dialog.saveAs.overwrite', { name }),
    }),
    actions: [
      jsx('button', {
        key: 'cancel',
        type: 'button',
        className: 'dfx-button',
        disabled: busy,
        onClick: onCancel,
        children: t('dialog.cancel'),
      }),
      jsx('button', {
        key: 'confirm',
        type: 'button',
        className: 'dfx-button',
        'data-danger': 'true',
        disabled: busy,
        onClick: onConfirm,
        children: t('dialog.saveAs.confirm'),
      }),
    ],
  })
}
