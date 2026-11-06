/**
 * Cross-fence transfers: copy workspace entries OUT to the wider machine, and
 * paste operating-system entries IN to the workspace.
 *
 * This is the one place the plugin deliberately leaves the workspace fence, and
 * `CROSS_FENCE_ROUTES` in `contract.js` explains why it is still safe:
 *
 *  - **copy out** keeps the *source* fenced, so the page cannot name a file it
 *    was never allowed to read;
 *  - **paste in** keeps the *destination* fenced, so the page cannot write
 *    anywhere it was never allowed to write.
 *
 * Failures are split into two kinds on purpose:
 *
 *  - A **policy refusal** (a source outside the fence, a directory copied into
 *    its own descendant) fails the whole request with a stable code. These are
 *    not races and not partial: they mean the caller asked for something the
 *    route must never do, so nothing is attempted.
 *  - A **per-entry problem** (the entry vanished, the target is locked, the name
 *    collided under `skip`, the entry is over the size cap) is reported in
 *    `skipped` and the rest still proceeds. "3 of 5 copied" is the honest answer
 *    a file manager gives, and throwing it away would be worse.
 *
 * Nothing here throws across the wire.
 *
 * @module dsh-file-extension/transfer
 */

import { access, constants, copyFile, cp, lstat, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { COLLISION_MODES, FAILURE_CODES, normalizePathList, withCopyIndex } from './contract.js'
import { failure, isInside, success } from './fsops.js'
import { readClipboard } from './clipboard.js'

/** Default collision mode: what a file manager's paste does. */
const DEFAULT_COLLISION = 'rename'

/**
 * How many `name (n).ext` candidates to try before giving up.
 *
 * A bound is needed because a caller cannot be allowed to make the Host spin; a
 * thousand candidates is far past anything a person would accept by hand.
 */
const MAX_COPY_CANDIDATES = 1000

/** Default per-entry size cap when the caller names none: 2 GiB. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024

/**
 * One copied entry, as the caller reports it.
 *
 * @typedef {object} CopiedEntry
 * @property {string} source - absolute source path.
 * @property {string} dest - absolute path actually written.
 * @property {'file' | 'directory'} kind - what was copied.
 */

/**
 * One entry that was not copied, and why.
 *
 * @typedef {object} SkippedEntry
 * @property {string} path - absolute path that was skipped.
 * @property {string} reason - a short machine-readable reason.
 * @property {string} [message] - a human sentence, when the reason needs one.
 */

/**
 * Coerce the caller's `collision` option into a known mode.
 *
 * @param {unknown} value - the caller's value.
 * @returns {'rename' | 'overwrite' | 'skip'} the usable mode.
 */
function collisionMode(value) {
  return COLLISION_MODES.includes(value) ? value : DEFAULT_COLLISION
}

/**
 * Coerce the caller's `maxBytes` option into a positive number.
 *
 * @param {unknown} value - the caller's value.
 * @returns {number} the byte cap.
 */
function byteCap(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES
}

/**
 * Whether a path exists, without throwing.
 *
 * @param {string} path - absolute path.
 * @returns {Promise<boolean>} true when present.
 */
async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether `candidate` is `root` itself or sits below it.
 *
 * Used for the "a directory cannot be copied into its own descendant" rule; it
 * reuses the fence comparison so Windows' case-insensitivity is applied the same
 * way everywhere.
 *
 * @param {string} root - the outer directory.
 * @param {string} candidate - the inner path.
 * @returns {boolean} true when `candidate` is inside `root`.
 */
function isNested(root, candidate) {
  return isInside(root, candidate)
}

/**
 * Describe one entry's kind and byte size.
 *
 * Directories are measured recursively but the walk stops as soon as the cap is
 * exceeded, so a huge tree costs a bounded amount of work.
 *
 * @param {string} path - absolute path.
 * @param {number} cap - stop counting above this size.
 * @returns {Promise<{ kind: 'file' | 'directory' | 'other', bytes: number, capped: boolean }>} the measurement.
 */
async function measure(path, cap) {
  const info = await lstat(path)
  if (info.isFile()) {
    return { kind: 'file', bytes: info.size, capped: info.size > cap }
  }
  // A symbolic link is reported as "other" and refused: following one could
  // walk out of the fence or loop forever, and neither is worth supporting for
  // a right-click copy.
  if (!info.isDirectory()) return { kind: 'other', bytes: 0, capped: false }

  let bytes = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const childInfo = await lstat(child)
        bytes += childInfo.size
      } catch {
        continue
      }
      if (bytes > cap) return { kind: 'directory', bytes, capped: true }
    }
  }
  return { kind: 'directory', bytes, capped: bytes > cap }
}

/**
 * Pick the destination path for one source, applying the collision mode.
 *
 * @param {string} directory - absolute destination directory.
 * @param {string} source - absolute source path.
 * @param {'rename' | 'overwrite' | 'skip'} mode - the collision mode.
 * @returns {Promise<{ target: string } | { conflict: 'skip' }>} the chosen target, or the skip.
 */
async function chooseTarget(directory, source, mode) {
  const name = basename(source)
  const first = join(directory, name)
  if (!(await pathExists(first))) return { target: first }

  if (mode === 'overwrite') return { target: first }
  if (mode === 'skip') return { conflict: 'skip' }

  for (let index = 2; index <= MAX_COPY_CANDIDATES; index += 1) {
    const candidate = join(directory, withCopyIndex(name, index))
    if (!(await pathExists(candidate))) return { target: candidate }
  }
  return { conflict: 'skip' }
}

/**
 * Copy one entry, recursively for directories.
 *
 * @param {string} source - absolute source path.
 * @param {string} target - absolute destination path.
 * @param {'file' | 'directory' | 'other'} kind - the source's measured kind.
 * @returns {Promise<void>} settles when the copy is written.
 */
async function copyEntry(source, target, kind) {
  if (kind === 'file') {
    await copyFile(source, target)
    return
  }
  // `force` lets an explicit `overwrite` replace an existing file inside a
  // merged directory; the collision decision was already made by the caller.
  await cp(source, target, { recursive: true, force: true, errorOnExist: false })
}

/**
 * Turn a Node filesystem error into a message a person can act on.
 *
 * Mirrors the mapping in `fsops.js` so both halves of the plugin speak the same
 * language; it is repeated rather than imported because that one is private.
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
  if (code === 'EEXIST') return 'the target already exists'
  if (code === 'EMFILE' || code === 'ENFILE') return 'too many files are open'
  return String(error?.message ?? error)
}

/**
 * Resolve the destination directory of a copy-out.
 *
 * @param {unknown} value - the caller's `options.destination`.
 * @returns {{ directory: string } | { refusal: object }} the directory, or the refusal.
 */
async function resolveCopyOutDestination(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      refusal: failure(
        FAILURE_CODES.operationFailed,
        'a destination directory is required: pick one with the directory picker first',
        { destinationMissing: true },
      ),
    }
  }
  const directory = resolve(value.trim())
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) {
      return {
        refusal: failure(FAILURE_CODES.notDirectory, 'the destination is not a directory', { directory }),
      }
    }
    return { directory }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // Never created implicitly: a typo must not scatter a tree somewhere odd.
      return {
        refusal: failure(FAILURE_CODES.notFound, 'the destination directory does not exist', { directory }),
      }
    }
    return {
      refusal: failure(FAILURE_CODES.operationFailed, describeFsError(error), { directory }),
    }
  }
}

/**
 * Copy workspace entries out to a free-form destination directory.
 *
 * Sources are fenced: a source outside the session workspace refuses the whole
 * request rather than being skipped, because that is the fence being tested, not
 * a race with another program.
 *
 * @param {unknown} paths - the caller's source paths.
 * @param {{ destination?: string, collision?: string, maxBytes?: number }} options - the request options.
 * @param {string | undefined} workspaceRoot - the session workspace root.
 * @returns {Promise<object>} the outcome with `copied`, `skipped`, and `destination`.
 */
export async function copyOut(paths, options = {}, workspaceRoot) {
  const list = normalizePathList(paths)
  if (list.accepted.length === 0) {
    return failure(FAILURE_CODES.notFound, 'no copyable paths were named', {
      rejected: list.rejected.slice(0, 20),
    })
  }

  // Fence first: a source outside the workspace is a policy refusal, so nothing
  // is attempted at all and no partial tree is left behind.
  const outside = []
  const sources = []
  for (const candidate of list.accepted) {
    const absolute = resolve(candidate)
    if (!isInside(workspaceRoot, absolute)) outside.push(absolute)
    else sources.push(absolute)
  }
  if (outside.length > 0) {
    return failure(
      FAILURE_CODES.outsideWorkspace,
      'every source must be inside the session workspace',
      { outside: outside.slice(0, 20) },
    )
  }

  const resolved = await resolveCopyOutDestination(options?.destination)
  if (resolved.refusal !== undefined) return resolved.refusal
  const directory = resolved.directory

  // Nesting is also a policy refusal: copying `a/` into `a/b/` can never finish,
  // and copying `a/` into `a/` would try to build `a/a/`. `isNested` also covers
  // equality, and a *file* source can never satisfy it, because a file cannot
  // contain a directory.
  const nested = []
  for (const source of sources) {
    if (isNested(source, directory)) nested.push(source)
  }
  if (nested.length > 0) {
    return failure(
      FAILURE_CODES.selfNested,
      'a directory cannot be copied into itself or one of its own descendants',
      { nested: nested.slice(0, 20), destination: directory },
    )
  }

  const mode = collisionMode(options?.collision)
  const cap = byteCap(options?.maxBytes)
  const copied = []
  const skipped = [...list.rejected.map((entry) => ({ path: entry.path, reason: entry.reason }))]

  for (const source of sources) {
    let measured
    try {
      measured = await measure(source, cap)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        skipped.push({ path: source, reason: 'notFound', message: 'the entry no longer exists' })
        continue
      }
      skipped.push({ path: source, reason: 'unreadable', message: describeFsError(error) })
      continue
    }
    if (measured.kind === 'other') {
      skipped.push({ path: source, reason: 'unsupported', message: 'only files and directories can be copied' })
      continue
    }
    const target = join(directory, basename(source))
    if (resolve(target) === source) {
      skipped.push({ path: source, reason: 'sameLocation', message: 'the entry is already there' })
      continue
    }
    if (measured.capped) {
      skipped.push({
        path: source,
        reason: 'tooLarge',
        message: `the entry is larger than the ${String(cap)} byte limit`,
      })
      continue
    }

    const choice = await chooseTarget(directory, source, mode)
    if (choice.conflict !== undefined) {
      skipped.push({ path: source, reason: 'alreadyExists', message: 'an entry with that name already exists' })
      continue
    }
    try {
      await copyEntry(source, choice.target, measured.kind)
      copied.push({ source, dest: choice.target, kind: measured.kind })
    } catch (error) {
      skipped.push({ path: source, reason: 'copyFailed', message: describeFsError(error) })
    }
  }

  return success({ copied, skipped, destination: directory, collision: mode })
}

/**
 * Copy operating-system entries into one workspace directory.
 *
 * The destination is fenced and must be a real directory; the sources come from
 * the clipboard, which the user themselves populated, and each one is reported
 * separately so one unreadable entry cannot lose the rest of the paste.
 *
 * @param {unknown} directory - the caller's destination directory.
 * @param {{ sourcePaths?: unknown, collision?: string, maxBytes?: number }} options - the request options.
 * @param {string | undefined} workspaceRoot - the session workspace root.
 * @returns {Promise<object>} the outcome with `copied`, `skipped`, and `directory`.
 */
export async function pasteIn(directory, options = {}, workspaceRoot) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    return failure(FAILURE_CODES.notFound, 'a destination directory is required')
  }
  const target = resolve(directory.trim())
  if (!isInside(workspaceRoot, target)) {
    return failure(FAILURE_CODES.outsideWorkspace, 'the destination is outside the session workspace', {
      directory: target,
    })
  }
  try {
    const info = await stat(target)
    if (!info.isDirectory()) {
      return failure(FAILURE_CODES.notDirectory, 'the destination is not a directory', { directory: target })
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return failure(FAILURE_CODES.notFound, 'the destination directory does not exist', { directory: target })
    }
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { directory: target })
  }

  const skipped = []

  // Sources: the caller's list when it has one, the clipboard otherwise.
  let rawSources = options?.sourcePaths
  if (rawSources === undefined || rawSources === null) {
    const clipboard = await readClipboard()
    if (!clipboard.ok) return clipboard
    if (clipboard.value.supported !== true) {
      return failure(
        FAILURE_CODES.clipboardUnavailable,
        clipboard.value.reason ?? 'the operating-system clipboard is not reachable from this host',
        { platform: clipboard.value.platform },
      )
    }
    rawSources = clipboard.value.files
    if (rawSources.length === 0) {
      return failure(FAILURE_CODES.clipboardEmpty, 'the clipboard holds no files to paste', {
        platform: clipboard.value.platform,
        text: clipboard.value.text === null ? null : clipboard.value.text.slice(0, 200),
      })
    }
  }

  const list = normalizePathList(rawSources)
  if (list.accepted.length === 0) {
    return failure(FAILURE_CODES.clipboardEmpty, 'the clipboard holds no files to paste', {
      rejected: list.rejected.slice(0, 20),
    })
  }
  skipped.push(...list.rejected.map((entry) => ({ path: entry.path, reason: entry.reason })))

  // Nesting is a policy refusal in this direction too: the destination must not
  // sit inside any source, or the copy would consume its own output.
  const nested = []
  for (const candidate of list.accepted) {
    const source = resolve(candidate)
    if (isInside(source, target)) nested.push(source)
  }
  if (nested.length > 0) {
    return failure(
      FAILURE_CODES.selfNested,
      'the destination directory is inside one of the sources being pasted',
      { nested: nested.slice(0, 20), directory: target },
    )
  }

  const mode = collisionMode(options?.collision)
  const cap = byteCap(options?.maxBytes)
  const copied = []

  for (const candidate of list.accepted) {
    const source = resolve(candidate)

    let measured
    try {
      measured = await measure(source, cap)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        skipped.push({ path: source, reason: 'notFound', message: 'the entry no longer exists' })
        continue
      }
      skipped.push({ path: source, reason: 'unreadable', message: describeFsError(error) })
      continue
    }
    if (measured.kind === 'other') {
      skipped.push({ path: source, reason: 'unsupported', message: 'only files and directories can be pasted' })
      continue
    }
    // Pasting an entry into the directory that already contains it is a no-op,
    // not a rename: the user would end up with a duplicate of a file they did
    // not move.
    if (resolve(dirname(source)) === target) {
      skipped.push({
        path: source,
        reason: 'selfNested',
        message: 'the entry is already in that directory',
      })
      continue
    }
    if (measured.capped) {
      skipped.push({
        path: source,
        reason: 'tooLarge',
        message: `the entry is larger than the ${String(cap)} byte limit`,
      })
      continue
    }

    const choice = await chooseTarget(target, source, mode)
    if (choice.conflict !== undefined) {
      skipped.push({ path: source, reason: 'alreadyExists', message: 'an entry with that name already exists' })
      continue
    }
    try {
      await copyEntry(source, choice.target, measured.kind)
      copied.push({ source, dest: choice.target, kind: measured.kind })
    } catch (error) {
      skipped.push({ path: source, reason: 'copyFailed', message: describeFsError(error) })
    }
  }

  return success({ copied, skipped, directory: target, collision: mode })
}
