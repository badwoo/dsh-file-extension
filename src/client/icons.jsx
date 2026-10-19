/**
 * Inline SVG icons for the menu and the hover button.
 *
 * Drawn to match the host's own 16px stroke icons: 16px box, 1.5 stroke, round
 * caps, `currentColor` fill so the surrounding token colour applies. Kept local
 * because a plugin must not load host Client packages as modules.
 *
 * @module dsh-file-extension/client/icons
 */

import { jsx } from 'react/jsx-runtime'

/**
 * One stroked path inside a 16px box.
 *
 * @param {{ children: unknown, extra?: Record<string, unknown> }} props - path children.
 * @returns {unknown} the svg element.
 */
function Icon({ children, ...extra }) {
  return jsx('svg', {
    viewBox: '0 0 16 16',
    width: 16,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...extra,
    children,
  })
}

/** Folder with a magnifier: reveal in the OS file manager. */
export function IconReveal() {
  return Icon({
    children: [
      jsx('path', { key: 'a', d: 'M1.8 4.2a1 1 0 0 1 1-1h3.1l1.3 1.6h6a1 1 0 0 1 1 1v1.4' }),
      jsx('path', { key: 'b', d: 'M1.8 4.2v7.6a1 1 0 0 0 1 1h5' }),
      jsx('circle', { key: 'c', cx: 11.1, cy: 10.6, r: 2.3 }),
      jsx('path', { key: 'd', d: 'm12.9 12.4 1.5 1.5' }),
    ],
  })
}

/** At sign: add to conversation. */
export function IconAt() {
  return Icon({
    children: [
      jsx('circle', { key: 'a', cx: 8, cy: 8, r: 3 }),
      jsx('path', { key: 'b', d: 'M11 8v1.2a1.9 1.9 0 0 0 3.8 0V8a6.8 6.8 0 1 0-2.6 5.4' }),
    ],
  })
}

/** A window with an arrow: open in a new tab. */
export function IconNewTab() {
  return Icon({
    children: [
      jsx('path', { key: 'a', d: 'M13.2 9v3.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1H7' }),
      jsx('path', { key: 'b', d: 'M9.6 2.2h4.2v4.2' }),
      jsx('path', { key: 'c', d: 'M13.4 2.6 7.6 8.4' }),
    ],
  })
}

/** A downward arrow into a tray: save as. */
export function IconSaveAs() {
  return Icon({
    children: [
      jsx('path', { key: 'a', d: 'M8 2.2v6.4' }),
      jsx('path', { key: 'b', d: 'm5.4 6.2 2.6 2.6 2.6-2.6' }),
      jsx('path', { key: 'c', d: 'M2.6 10.4v2a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4v-2' }),
    ],
  })
}

/** Two overlapping sheets: copy path. */
export function IconCopy() {
  return Icon({
    children: [
      jsx('rect', { key: 'a', x: 5.6, y: 5.6, width: 8.2, height: 8.2, rx: 1.4 }),
      jsx('path', { key: 'b', d: 'M10.4 5.6V3.6a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4v5.4a1.4 1.4 0 0 0 1.4 1.4h2' }),
    ],
  })
}

/** A pencil: rename. */
export function IconRename() {
  return Icon({
    children: [
      jsx('path', { key: 'a', d: 'M10.9 2.5a1.6 1.6 0 0 1 2.3 2.3L5.7 12.3l-3 .8.8-3z' }),
      jsx('path', { key: 'b', d: 'm9.6 3.8 2.3 2.3' }),
    ],
  })
}

/** A waste bin: delete. */
export function IconTrash() {
  return Icon({
    children: [
      jsx('path', { key: 'a', d: 'M2.6 4.2h10.8' }),
      jsx('path', { key: 'b', d: 'M6.2 4.2V2.9a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.3' }),
      jsx('path', { key: 'c', d: 'M3.9 4.2v8.5a1 1 0 0 0 1 1h6.2a1 1 0 0 0 1-1V4.2' }),
      jsx('path', { key: 'd', d: 'M6.6 7v4M9.4 7v4' }),
    ],
  })
}

/** A folder: the directory variant of the delete row. */
export function IconFolder() {
  return Icon({
    children: jsx('path', {
      d: 'M1.9 4.3a1 1 0 0 1 1-1h2.9l1.3 1.6h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z',
    }),
  })
}

/** An arrow turning back: restore from recycle bin, used in the delete body. */
export function IconRestore() {
  return Icon({
    children: [
      jsx('path', { key: 'a', d: 'M3.1 6.4a5.1 5.1 0 1 1 1.3 5.2' }),
      jsx('path', { key: 'b', d: 'M3.1 2.9v3.5h3.5' }),
    ],
  })
}
