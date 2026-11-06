/**
 * The file-extension wire contract, shared verbatim by the Host manifest
 * (`ctx.typert.register`) and the Client contribution (`ctx.remote.$mount`).
 *
 * Only metadata and small JSON values cross this boundary. File bytes never do
 * except for an explicit `readForDownload` on the browser-download fallback,
 * which is bounded and refused above `maxDownloadBytes`.
 *
 * @module dsh-file-extension/contract
 */

/** Wire namespace and Cordis service key for the Host half. */
export const SERVICE_KEY = 'fileExtension'

/** Maximum bytes the browser-download fallback will carry over the wire. */
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024

/** Names of every Remote method, as the Client mounts them. */
export const METHOD_NAMES = [
  'capabilities',
  'stat',
  'rename',
  'remove',
  'copyTo',
  'pickSaveDirectory',
  'readForDownload',
  'clipboardRead',
  'clipboardWrite',
  'copyOut',
  'pasteIn',
]

/**
 * Build the invocation descriptors the Host registers and the Client mounts.
 *
 * `src-json` codecs are used deliberately: this package ships prebuilt
 * JavaScript with no TypeScript schema generation step, and `src-json` is the
 * documented conservative marker for exactly that case. Every payload is plain
 * JSON, so nothing is lost.
 *
 * @returns {readonly object[]} descriptors in `InvocationDescriptor` shape.
 */
export function createInvocationDescriptors() {
  const json = { mode: 'src-json' }
  const describe = (method, parameters) => ({
    id: `dsh-file-extension#fileExtension/${method}`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: json,
  })

  const pathParam = {
    name: 'path',
    wire: 'path',
    source: 'json',
    codec: json,
  }

  return Object.freeze([
    describe('capabilities', []),
    describe('stat', [pathParam]),
    describe('rename', [pathParam, { name: 'name', wire: 'name', source: 'json', codec: json }]),
    describe('remove', [pathParam, { name: 'options', wire: 'options', source: 'json', codec: json }]),
    describe('copyTo', [pathParam, { name: 'options', wire: 'options', source: 'json', codec: json }]),
    describe('pickSaveDirectory', [
      { name: 'suggestedName', wire: 'suggestedName', source: 'json', codec: json },
    ]),
    describe('readForDownload', [
      pathParam,
      { name: 'options', wire: 'options', source: 'json', codec: json },
    ]),
    describe('clipboardRead', []),
    describe('clipboardWrite', [
      { name: 'paths', wire: 'paths', source: 'json', codec: json },
    ]),
    describe('copyOut', [
      { name: 'paths', wire: 'paths', source: 'json', codec: json },
      { name: 'options', wire: 'options', source: 'json', codec: json },
    ]),
    describe('pasteIn', [
      { name: 'directory', wire: 'directory', source: 'json', codec: json },
      { name: 'options', wire: 'options', source: 'json', codec: json },
    ]),
  ])
}

/**
 * The Typert package manifest for this Host face.
 *
 * @returns {object} the manifest object `ctx.typert.register` accepts.
 */
export function createTypertManifest() {
  return {
    package: 'dsh-file-extension',
    face: 'host',
    schemas: [],
    model: {
      services: [
        {
          key: SERVICE_KEY,
          exportName: 'FileExtensionRuntime',
          description:
            'Filesystem operations for the right Sidebar file tree: reveal capability, rename, recycle-bin delete, and save-as copies.',
          tags: [],
          members: METHOD_NAMES.map((name) => ({
            kind: 'method',
            name,
            signature: `${name}(...)`,
          })),
          types: [],
        },
      ],
      events: [],
      objects: [],
    },
    invocations: createInvocationDescriptors(),
  }
}

/**
 * Stable failure codes this plugin returns. Callers branch on `code`, never on
 * message text, matching the Harness Remote convention.
 */
export const FAILURE_CODES = Object.freeze({
  notFound: 'file-extension/not-found',
  notRegularFile: 'file-extension/not-regular-file',
  notDirectory: 'file-extension/not-directory',
  alreadyExists: 'file-extension/already-exists',
  invalidName: 'file-extension/invalid-name',
  outsideWorkspace: 'file-extension/outside-workspace',
  tooLarge: 'file-extension/too-large',
  unsupported: 'file-extension/unsupported',
  operationFailed: 'file-extension/operation-failed',
  cancelled: 'file-extension/cancelled',
  updateUnavailable: 'file-extension/update-unavailable',
  updateFailed: 'file-extension/update-failed',
  restartRequired: 'file-extension/restart-required',
  clipboardEmpty: 'file-extension/clipboard-empty',
  clipboardUnavailable: 'file-extension/clipboard-unavailable',
  selfNested: 'file-extension/self-nested',
})

/**
 * The one place requirement 2 deliberately crosses the workspace fence, and the
 * rule that keeps it from becoming a general filesystem API for the page.
 *
 * Every pre-existing route is fenced: a request can only ever touch a path
 * inside the Session's own workspace. Copying "to another place on the computer"
 * cannot work under that rule, so it is relaxed for exactly two directions and
 * tightened in every other respect:
 *
 *  - **copy out** (`copyOut`): the SOURCE must still be inside the workspace, so
 *    the page can never use this route to read a file it was not already
 *    allowed to read. The DESTINATION is free-form, because that is the feature.
 *  - **paste in** (`pasteIn`): the DESTINATION must be inside the workspace, so
 *    the page cannot write anywhere else. The SOURCE comes from the operating
 *    system clipboard, which the user themselves populated.
 *
 * The four clipboard/transfer routes additionally require the request to come
 * from the host machine's own loopback connection, matching the existing
 * `update-apply` rule. This is not redundant with the path fences above: the
 * clipboard is a HOST-WIDE resource that holds whatever the user last copied in
 * any application, so reading or writing it is a machine-wide side effect rather
 * than a workspace-scoped one. A remote browser session must not be able to
 * inspect the host's clipboard, trigger a copy onto it, or use either transfer
 * direction to move data off a machine it is not running on.
 */
export const CROSS_FENCE_ROUTES = Object.freeze([
  'copyOut',
  'pasteIn',
  'clipboardRead',
  'clipboardWrite',
])

/** Largest number of entries one clipboard operation may carry. */
export const MAX_CLIPBOARD_ENTRIES = 200

/**
 * How a cross-fence transfer resolves a name collision at the destination.
 *
 * `rename` is the default and is what a file manager's paste does: the newcomer
 * becomes `name (2).ext` rather than silently replacing something. `overwrite`
 * and `skip` remain explicit caller choices.
 */
export const COLLISION_MODES = Object.freeze(['rename', 'overwrite', 'skip'])

/**
 * Characters Windows forbids in a file name, plus the reserved device names.
 * Validated on every platform so a workspace stays portable.
 */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * Validate a proposed single-segment file name.
 *
 * @param {unknown} name - candidate name.
 * @returns {string | null} a failure reason key, or null when the name is usable.
 */
export function validateFileName(name) {
  if (typeof name !== 'string') return 'invalid'
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return 'empty'
  if (INVALID_NAME_CHARS.test(trimmed)) return 'invalidCharacters'
  if (trimmed.length > 255) return 'tooLong'
  // A trailing dot or space is silently stripped by Windows and produces a
  // name the user did not ask for, so refuse it rather than surprise them.
  if (/[. ]$/.test(trimmed)) return 'trailingDotOrSpace'
  const stem = trimmed.split('.')[0].toLowerCase()
  if (RESERVED_NAMES.has(stem)) return 'reservedName'
  return null
}

/**
 * Split a file name into its stem and extension, treating a leading dot as part
 * of the stem so `.gitignore` has no extension.
 *
 * @param {string} name - file name.
 * @returns {{ stem: string, extension: string }} the parts.
 */
export function splitFileName(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, extension: '' }
  return { stem: name.slice(0, dot), extension: name.slice(dot) }
}

/**
 * Build the default copy name for "Save as": `name-copy.ext` in English and
 * `name-副本.ext` in Chinese, following the active locale's copy word.
 *
 * @param {string} name - original file name.
 * @param {string} copyWord - localized copy marker, without separators.
 * @returns {string} the suggested file name.
 */
export function buildCopyName(name, copyWord) {
  const { stem, extension } = splitFileName(name)
  return `${stem}-${copyWord}${extension}`
}

/**
 * Build the nth collision-free name for `name`, the way a file manager does.
 *
 * `report.txt` -> `report (2).txt` -> `report (3).txt`. The extension is kept
 * attached so double-clicking still opens with the right application, and a
 * dotfile (`.gitignore`) is treated as all-stem so it does not become
 * ` (2).gitignore`.
 *
 * @param {string} name - the requested name.
 * @param {number} copyIndex - 2 for the first duplicate, 3 for the next, and so on.
 * @returns {string} the candidate name.
 */
export function withCopyIndex(name, copyIndex) {
  const { stem, extension } = splitFileName(name)
  return `${stem} (${String(copyIndex)})${extension}`
}

/**
 * Normalize a caller-supplied list of absolute paths.
 *
 * Returns the accepted paths plus, for each rejected one, the reason — so the
 * Client can render "3 of 5 copied" instead of failing the whole operation
 * because one entry vanished between listing and copying.
 *
 * This does NOT test containment: each direction applies its own fence rule.
 *
 * @param {unknown} value - the caller's `paths`.
 * @param {number} [limit] - maximum accepted entries.
 * @returns {{ accepted: string[], rejected: { path: string, reason: string }[] }} the split.
 */
export function normalizePathList(value, limit = MAX_CLIPBOARD_ENTRIES) {
  const accepted = []
  const rejected = []
  if (!Array.isArray(value)) {
    return { accepted, rejected: [{ path: '', reason: 'notAList' }] }
  }
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      rejected.push({ path: '', reason: 'invalid' })
      continue
    }
    const trimmed = candidate.trim()
    if (accepted.includes(trimmed)) continue
    if (accepted.length >= limit) {
      rejected.push({ path: trimmed, reason: 'tooMany' })
      continue
    }
    accepted.push(trimmed)
  }
  return { accepted, rejected }
}
