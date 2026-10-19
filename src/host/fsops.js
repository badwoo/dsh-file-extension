/**
 * Filesystem operations behind the file context menu.
 *
 * Every function validates its inputs, refuses to escape the session workspace,
 * and returns a discriminated outcome instead of throwing across the wire: the
 * Client renders `code`-based messages, never raw exceptions.
 *
 * @module dsh-file-extension/fsops
 */

import { access, constants, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { FAILURE_CODES, validateFileName } from './contract.js'
import { deletePermanently, moveToTrash } from './trash.js'

/**
 * Build one failure outcome.
 *
 * @param {string} code - stable failure code.
 * @param {string} message - human diagnostic.
 * @param {Record<string, unknown>} [details] - structured extras.
 * @returns {{ ok: false, code: string, message: string, details: Record<string, unknown> }} the failure.
 */
export function failure(code, message, details = {}) {
  return { ok: false, code, message, details }
}

/**
 * Build one success outcome.
 *
 * @param {Record<string, unknown>} value - the payload.
 * @returns {{ ok: true, value: Record<string, unknown> }} the success.
 */
export function success(value = {}) {
  return { ok: true, value }
}

/**
 * Whether a candidate path stays inside a workspace root.
 *
 * Comparison is case-insensitive on Windows and macOS, which is what those
 * filesystems actually do, so a differently-cased path is not a false refusal.
 *
 * An absent root is NOT treated as "no fence": the callers now refuse a request
 * whose Session could not be resolved before reaching here, and allowing an
 * undefined root would silently reopen that hole if a caller ever regressed.
 *
 * @param {string} root - absolute workspace root.
 * @param {string} candidate - absolute candidate path.
 * @returns {boolean} true when the candidate is the root or inside it.
 */
export function isInside(root, candidate) {
  if (root === undefined || root === null || root === '') return false
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const left = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  const right = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate
  if (left === right) return true
  const prefix = left.endsWith(sep) ? left : `${left}${sep}`
  return right.startsWith(prefix)
}

/**
 * Read metadata for one path.
 *
 * @param {string} path - absolute path.
 * @param {string} [workspaceRoot] - root the path must stay inside.
 * @returns {Promise<object>} the outcome with `kind`, `bytes`, and `mtime`.
 */
export async function statPath(path, workspaceRoot) {
  if (typeof path !== 'string' || path.trim() === '') {
    return failure(FAILURE_CODES.notFound, 'a path is required')
  }
  const absolute = resolve(path)
  if (!isInside(workspaceRoot, absolute)) {
    return failure(FAILURE_CODES.outsideWorkspace, 'the path is outside the session workspace')
  }
  try {
    const info = await stat(absolute)
    const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    return success({
      path: absolute,
      name: basename(absolute),
      parent: dirname(absolute),
      kind,
      bytes: info.size,
      mtime: info.mtimeMs,
    })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return failure(FAILURE_CODES.notFound, 'the file no longer exists', { path: absolute })
    }
    return failure(FAILURE_CODES.operationFailed, String(error?.message ?? error), { path: absolute })
  }
}

/**
 * Rename one entry in place, keeping it in the same directory.
 *
 * @param {string} path - absolute path of the entry.
 * @param {string} name - the new single-segment name.
 * @param {string} [workspaceRoot] - root the entry must stay inside.
 * @returns {Promise<object>} the outcome with the new path.
 */
export async function renamePath(path, name, workspaceRoot) {
  const current = await statPath(path, workspaceRoot)
  if (!current.ok) return current

  const problem = validateFileName(name)
  if (problem !== null) {
    return failure(FAILURE_CODES.invalidName, `the name is not usable: ${problem}`, { reason: problem })
  }

  const target = join(dirname(current.value.path), name.trim())
  if (target === current.value.path) {
    // A no-op rename is a success: the user confirmed the same name.
    return success({ path: target, name: basename(target), unchanged: true })
  }
  if (!isInside(workspaceRoot, target)) {
    return failure(FAILURE_CODES.outsideWorkspace, 'the target is outside the session workspace')
  }

  try {
    await access(target, constants.F_OK)
    return failure(FAILURE_CODES.alreadyExists, 'an entry with that name already exists', {
      name,
      path: target,
    })
  } catch {
    // Absent, which is what a rename needs.
  }

  try {
    await rename(current.value.path, target)
    return success({ path: target, name: basename(target), previousPath: current.value.path })
  } catch (error) {
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), {
      path: current.value.path,
      name,
    })
  }
}

/**
 * Create one new file or directory inside a directory.
 *
 * Used by the tree's "New File" / "New Folder" actions, which are offered on a
 * directory row and on the blank area of the project root. The parent is fenced
 * like every other operation, and the name is validated as a single path segment
 * — so a name can neither escape the directory nor the workspace.
 *
 * An existing target is refused rather than overwritten: the HTTP surface has no
 * confirmation step for creation, and silently truncating a file the user meant
 * to keep would be the one irreversible mistake available here.
 *
 * @param {string} directory - absolute path of the containing directory.
 * @param {{ name?: string, kind?: 'file' | 'directory' }} options - what to create.
 * @param {string} [workspaceRoot] - root the directory must stay inside.
 * @returns {Promise<object>} the outcome with the created path.
 */
export async function createPath(directory, options = {}, workspaceRoot) {
  const kind = options?.kind === 'directory' ? 'directory' : 'file'
  const name = typeof options?.name === 'string' ? options.name.trim() : ''

  const problem = validateFileName(name)
  if (problem !== null) {
    return failure(FAILURE_CODES.invalidName, `the name is not usable: ${problem}`, { reason: problem })
  }
  if (typeof directory !== 'string' || directory.trim() === '') {
    return failure(FAILURE_CODES.notFound, 'a containing directory is required')
  }

  const parent = resolve(directory)
  if (!isInside(workspaceRoot, parent)) {
    return failure(FAILURE_CODES.outsideWorkspace, 'the directory is outside the session workspace')
  }

  try {
    const info = await stat(parent)
    if (!info.isDirectory()) {
      return failure(FAILURE_CODES.notDirectory, 'the target is not a directory', { directory: parent })
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return failure(FAILURE_CODES.notFound, 'the directory no longer exists', { directory: parent })
    }
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { directory: parent })
  }

  // `validateFileName` rejects both separators, so `name` is one segment and the
  // join cannot leave `parent`; the fence re-check is still cheap insurance.
  const target = join(parent, name)
  if (!isInside(workspaceRoot, target)) {
    return failure(FAILURE_CODES.outsideWorkspace, 'the target is outside the session workspace')
  }

  try {
    await access(target, constants.F_OK)
    return failure(FAILURE_CODES.alreadyExists, 'an entry with that name already exists', {
      name,
      path: target,
    })
  } catch {
    // Absent, which is what creation needs.
  }

  try {
    if (kind === 'directory') {
      // Non-recursive: the parent was just checked, and a partial tree is worse
      // than a refusal.
      await mkdir(target)
    } else {
      // `wx` refuses an existing target, so a file created between the check
      // above and this write cannot be clobbered.
      await writeFile(target, '', { flag: 'wx' })
    }
    return success({ path: target, name, parent, kind })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return failure(FAILURE_CODES.alreadyExists, 'an entry with that name already exists', {
        name,
        path: target,
      })
    }
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { path: target, name })
  }
}

/**
 * Delete one entry, preferring the recycle bin.
 *
 * The recycle bin is attempted first; only when it demonstrably could not run
 * does the caller get a `trashUnavailable` outcome to confirm a permanent
 * delete against.
 *
 * @param {string} path - absolute path of the entry.
 * @param {{ mode?: 'trash' | 'permanent' }} options - the deletion mode.
 * @param {string} [workspaceRoot] - root the entry must stay inside.
 * @returns {Promise<object>} the outcome naming what actually happened.
 */
export async function removePath(path, options = {}, workspaceRoot) {
  const current = await statPath(path, workspaceRoot)
  if (!current.ok) return current

  const mode = options?.mode === 'permanent' ? 'permanent' : 'trash'

  if (mode === 'permanent') {
    try {
      await deletePermanently(current.value.path)
      return success({ path: current.value.path, kind: current.value.kind, mode: 'permanent' })
    } catch (error) {
      return failure(FAILURE_CODES.operationFailed, describeFsError(error), {
        path: current.value.path,
      })
    }
  }

  const trashed = await moveToTrash(current.value.path)
  if (trashed.trashed) {
    return success({
      path: current.value.path,
      kind: current.value.kind,
      mode: 'trash',
      strategy: trashed.strategy,
    })
  }
  // Nothing was deleted: report the capability gap so the Client can re-ask
  // with the permanent-delete warning rather than silently destroying data.
  return failure(
    FAILURE_CODES.unsupported,
    trashed.reason ?? 'the operating system recycle bin is not reachable from this host',
    { path: current.value.path, kind: current.value.kind, strategy: trashed.strategy, trashUnavailable: true },
  )
}

/**
 * Copy one file to a chosen directory under a chosen name, as "Save as" does.
 *
 * The source is never modified. An existing target is refused unless
 * `overwrite` is set, so the Client can show its own confirmation first.
 *
 * @param {string} sourcePath - absolute path of the source file.
 * @param {{ directory?: string, name?: string, overwrite?: boolean }} options - the destination.
 * @param {string} [workspaceRoot] - root the source must stay inside.
 * @returns {Promise<object>} the outcome with the written path.
 */
export async function copyToPath(sourcePath, options = {}, workspaceRoot) {
  const current = await statPath(sourcePath, workspaceRoot)
  if (!current.ok) return current
  if (current.value.kind !== 'file') {
    return failure(FAILURE_CODES.notRegularFile, 'only regular files can be saved as a copy', {
      kind: current.value.kind,
    })
  }

  const directory = typeof options?.directory === 'string' && options.directory.trim() !== ''
    ? resolve(options.directory)
    : current.value.parent
  const name = typeof options?.name === 'string' && options.name.trim() !== ''
    ? options.name.trim()
    : basename(current.value.path)

  const problem = validateFileName(name)
  if (problem !== null) {
    return failure(FAILURE_CODES.invalidName, `the name is not usable: ${problem}`, { reason: problem })
  }

  try {
    const info = await stat(directory)
    if (!info.isDirectory()) {
      return failure(FAILURE_CODES.notDirectory, 'the destination is not a directory', { directory })
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return failure(FAILURE_CODES.notFound, 'the destination directory does not exist', { directory })
    }
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { directory })
  }

  const target = join(directory, name)
  if (resolve(target) === current.value.path) {
    return failure(FAILURE_CODES.alreadyExists, 'the destination is the source file', { path: target })
  }

  let exists = false
  try {
    await access(target, constants.F_OK)
    exists = true
  } catch {
    // Absent: the normal case.
  }
  if (exists && options?.overwrite !== true) {
    return failure(FAILURE_CODES.alreadyExists, 'a file with that name already exists', {
      path: target,
      name,
      directory,
    })
  }

  try {
    await copyFile(current.value.path, target)
    const written = await stat(target)
    return success({
      path: target,
      name,
      directory,
      bytes: written.size,
      source: current.value.path,
      overwritten: exists,
    })
  } catch (error) {
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { path: target })
  }
}

/**
 * Read a file for the browser-download fallback, bounded by `maxBytes`.
 *
 * @param {string} path - absolute path.
 * @param {{ maxBytes?: number }} options - the size cap.
 * @param {string} [workspaceRoot] - root the file must stay inside.
 * @returns {Promise<object>} the outcome with base64 data.
 */
export async function readForDownload(path, options = {}, workspaceRoot) {
  const current = await statPath(path, workspaceRoot)
  if (!current.ok) return current
  if (current.value.kind !== 'file') {
    return failure(FAILURE_CODES.notRegularFile, 'only regular files can be downloaded', {
      kind: current.value.kind,
    })
  }
  const maxBytes = Number.isFinite(options?.maxBytes) ? Number(options.maxBytes) : 32 * 1024 * 1024
  if (current.value.bytes > maxBytes) {
    return failure(FAILURE_CODES.tooLarge, 'the file is too large for a browser download', {
      bytes: current.value.bytes,
      limit: maxBytes,
    })
  }
  try {
    const bytes = await readFile(current.value.path)
    return success({
      path: current.value.path,
      name: current.value.name,
      bytes: bytes.byteLength,
      data: bytes.toString('base64'),
    })
  } catch (error) {
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), {
      path: current.value.path,
    })
  }
}

/**
 * Turn a Node filesystem error into a message a person can act on.
 *
 * @param {unknown} error - the caught value.
 * @returns {string} the message.
 */
function describeFsError(error) {
  const code = error?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied by the operating system'
  if (code === 'ENOENT') return 'the file no longer exists'
  if (code === 'ENOSPC') return 'the destination has no free space'
  if (code === 'EBUSY') return 'the file is in use by another program'
  if (code === 'EROFS') return 'the destination is read-only'
  if (code === 'EISDIR') return 'the target is a directory'
  if (code === 'ENOTDIR') return 'part of the path is not a directory'
  return String(error?.message ?? error)
}

export { basename, dirname, join, resolve }
