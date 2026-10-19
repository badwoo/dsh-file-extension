/**
 * The file context menu.
 *
 * A self-drawn menu, never the native one: it follows the host theme tokens,
 * supports arrow-key navigation, closes on outside click or Escape, and flips
 * itself back inside the viewport at every edge.
 *
 * @module dsh-file-extension/client/menu
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import {
  IconAt,
  IconCopy,
  IconFolder,
  IconNewFile,
  IconNewFolder,
  IconNewTab,
  IconRename,
  IconReveal,
  IconSaveAs,
  IconTrash,
  IconUpdate,
} from './icons.jsx'

/** Gap kept between the menu and the viewport edge, in pixels. */
const VIEWPORT_MARGIN = 8

/**
 * Compute a position that keeps the menu fully on screen.
 *
 * @param {{ x: number, y: number }} anchor - the pointer position.
 * @param {{ width: number, height: number }} size - the measured menu size.
 * @returns {{ left: number, top: number }} the clamped position.
 */
export function clampToViewport(anchor, size) {
  const maxLeft = window.innerWidth - size.width - VIEWPORT_MARGIN
  const maxTop = window.innerHeight - size.height - VIEWPORT_MARGIN
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(anchor.x, maxLeft)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.y, maxTop)),
  }
}

/**
 * The menu itself.
 *
 * @param {object} props - component props.
 * @param {{ x: number, y: number }} props.anchor - where the pointer was.
 * @param {readonly object[]} props.items - the rows to render.
 * @param {(item: object) => void} props.onActivate - run one row.
 * @param {() => void} props.onClose - dismiss the menu.
 * @param {(text: string) => string} props.t - namespace-bound translate.
 * @returns {unknown} the menu element.
 */
export function ContextMenu({ anchor, items, onActivate, onClose, t }) {
  const ref = useRef(null)
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y })
  const [activeIndex, setActiveIndex] = useState(-1)

  /** Indices a keyboard user can land on: disabled rows are skipped. */
  const navigable = items
    .map((item, index) => (item.disabled === true || item.kind === 'separator' ? -1 : index))
    .filter((index) => index >= 0)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPosition(clampToViewport(anchor, { width: rect.width, height: rect.height }))
  }, [anchor])

  useEffect(() => {
    const element = ref.current
    element?.focus()

    const onPointerDown = (event) => {
      if (element !== null && event.target instanceof Node && element.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (navigable.length === 0) return
        const current = navigable.indexOf(activeIndex)
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = current < 0
          ? (step > 0 ? navigable[0] : navigable[navigable.length - 1])
          : navigable[(current + step + navigable.length) % navigable.length]
        setActiveIndex(next)
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        if (navigable.length === 0) return
        setActiveIndex(event.key === 'Home' ? navigable[0] : navigable[navigable.length - 1])
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (activeIndex < 0) return
        event.preventDefault()
        const item = items[activeIndex]
        if (item !== undefined && item.disabled !== true) onActivate(item)
      }
    }
    // Capture phase so the page's own shortcut handlers never see these keys
    // while a menu owns them.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [activeIndex, items, navigable, onActivate, onClose])

  const rows = items.map((item, index) => {
    if (item.kind === 'separator') {
      return jsx('div', { key: `sep-${String(index)}`, className: 'dfx-menu-separator', role: 'separator' })
    }
    const disabled = item.disabled === true
    const Icon = item.icon
    return jsx('button', {
      key: item.id,
      type: 'button',
      role: 'menuitem',
      className: 'dfx-menu-item',
      // A stable hook for tests and for any future automation: menu labels are
      // localized, so matching on text is not a reliable way to address a row.
      // `data-dfx-update` is carried by the one row that starts an update check.
      'data-dfx-action': item.id,
      ...(item.id === 'update' ? { 'data-dfx-update': 'true' } : {}),
      'data-active': activeIndex === index ? 'true' : 'false',
      'data-danger': item.danger === true ? 'true' : undefined,
      'aria-disabled': disabled ? 'true' : undefined,
      title: item.hint ?? undefined,
      onMouseEnter: () => setActiveIndex(disabled ? -1 : index),
      onClick: (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (disabled) return
        onActivate(item)
      },
      children: [
        jsx('span', { key: 'icon', className: 'dfx-menu-icon', children: jsx(Icon, {}) }),
        jsx('span', { key: 'label', className: 'dfx-menu-label', children: item.label }),
        item.shortcut === undefined
          ? null
          : jsx('span', { key: 'shortcut', className: 'dfx-menu-shortcut', children: item.shortcut }),
      ],
    })
  })

  return jsx('div', {
    ref,
    className: 'dfx-menu',
    role: 'menu',
    tabIndex: -1,
    'aria-label': t('aria.menu'),
    style: { left: `${String(position.left)}px`, top: `${String(position.top)}px` },
    onContextMenu: (event) => event.preventDefault(),
    children: rows,
  })
}

/**
 * Build the menu rows for one entry.
 *
 * Kept outside the component so the same definition drives both the menu and
 * any future command surface.
 *
 * A **directory** row gains the two creation verbs, and a **root** menu (the
 * blank area of the project tree, which has no row of its own) is the directory
 * menu with the row-only verbs dropped: there is no entry to reveal, rename,
 * copy or delete, but "new file/folder here" is exactly what that area means.
 * The update verb is appended to every menu, so it is reachable from anywhere in
 * the tree rather than only from a file.
 *
 * @param {object} options - the situation.
 * @param {'file' | 'directory' | 'other' | 'root'} options.kind - the entry kind.
 * @param {boolean} options.canReveal - whether the host can open a file manager.
 * @param {boolean} options.canAddToChat - whether a composer is available.
 * @param {boolean} [options.canUpdate] - whether an update check can run.
 * @returns {readonly object[]} the rows.
 */
export function menuItemsFor({ kind, canReveal, canAddToChat, canUpdate = false }) {
  const isRoot = kind === 'root'
  const isDirectory = kind === 'directory'
  const items = []

  if (isRoot) {
    items.push({
      id: 'newFile',
      icon: IconNewFile,
      labelKey: 'menu.newFile',
      action: 'newFile',
    })
    items.push({
      id: 'newFolder',
      icon: IconNewFolder,
      labelKey: 'menu.newFolder',
      action: 'newFolder',
    })
  } else {
    items.push({
      id: 'reveal',
      icon: IconReveal,
      labelKey: 'menu.reveal',
      hintKey: 'menu.reveal.disabled',
      disabled: !canReveal,
      action: 'reveal',
    })
    if (isDirectory) {
      // Creation comes first for a folder: it is what a right click on a folder
      // is usually for, and the menu's own ordering should say so.
      items.push({
        id: 'newFile',
        icon: IconNewFile,
        labelKey: 'menu.newFile',
        action: 'newFile',
      })
      items.push({
        id: 'newFolder',
        icon: IconNewFolder,
        labelKey: 'menu.newFolder',
        action: 'newFolder',
      })
    } else {
      items.push({
        id: 'addToChat',
        icon: IconAt,
        labelKey: 'menu.addToChat',
        hintKey: 'menu.addToChat.disabled',
        disabled: !canAddToChat,
        action: 'addToChat',
      })
      items.push({
        id: 'openInTab',
        icon: IconNewTab,
        labelKey: 'menu.openInTab',
        action: 'openInTab',
      })
      items.push({
        id: 'saveAs',
        icon: IconSaveAs,
        labelKey: 'menu.saveAs',
        action: 'saveAs',
      })
    }
    items.push({ kind: 'separator' })
    items.push({
      id: 'copyAbsolutePath',
      icon: IconCopy,
      labelKey: 'menu.copyAbsolutePath',
      action: 'copyAbsolutePath',
    })
    items.push({
      id: 'copyRelativePath',
      icon: IconCopy,
      labelKey: 'menu.copyRelativePath',
      action: 'copyRelativePath',
    })
    items.push({ kind: 'separator' })
    items.push({
      id: 'rename',
      icon: IconRename,
      labelKey: 'menu.rename',
      action: 'rename',
    })
    items.push({
      id: 'delete',
      icon: isDirectory ? IconFolder : IconTrash,
      labelKey: isDirectory ? 'menu.deleteDirectory' : 'menu.delete',
      action: 'delete',
      danger: true,
    })
  }

  if (canUpdate) {
    items.push({ kind: 'separator' })
    items.push({
      id: 'update',
      icon: IconUpdate,
      labelKey: 'menu.update',
      action: 'update',
    })
  }
  return items
}
