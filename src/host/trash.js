/**
 * Cross-platform recycle bin with an explicit permanent-delete fallback.
 *
 * dsh itself ships no trash capability (verified: no `trashItem`, `Recycle`, or
 * `trash` anywhere in the official package set), so this module implements it:
 *
 *  - Windows: `Microsoft.VisualBasic.FileIO.FileSystem` `SendToRecycleBin` via
 *    PowerShell. Verified on this machine to place the file in
 *    `C:\$Recycle.Bin\<SID>\` with a resolvable `$I` record.
 *  - macOS: `trash` CLI when installed, otherwise a Finder AppleScript.
 *  - Linux: the FreeDesktop Trash specification, `~/.local/share/Trash`.
 *
 * Every strategy reports whether it actually trashed the target. A strategy
 * that cannot run leaves the target untouched so the caller can decide between
 * permanent deletion (with the red warning) and an error.
 *
 * @module dsh-file-extension/trash
 */

import { spawn } from 'node:child_process'
import { access, constants, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Result of one trash attempt. */
/**
 * @typedef {object} TrashOutcome
 * @property {boolean} trashed - true when the target reached a recycle bin.
 * @property {string} strategy - which implementation ran.
 * @property {string} [reason] - why a strategy could not run or failed.
 */

/**
 * Run one command to completion without a shell, collecting bounded output.
 *
 * @param {string} command - executable to spawn.
 * @param {readonly string[]} args - argv, never a shell string.
 * @param {number} timeoutMs - deadline before the child is killed.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} the settled process.
 */
function run(command, args, timeoutMs = 15_000) {
  return new Promise((settle) => {
    let child
    try {
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Launch the helper with a scrubbed environment: nothing from the
        // Harness credentials should reach an external process.
        env: scrubbedEnv(),
      })
    } catch (error) {
      settle({ code: null, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The child already exited; nothing to kill.
      }
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk)
    })
    child.on('error', (error) => {
      stderr += String(error)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/**
 * Environment for a helper process: the OS essentials only.
 *
 * @returns {Record<string, string>} a minimal environment.
 */
function scrubbedEnv() {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'DISPLAY']
  const env = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Whether a path exists, without throwing. */
async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Quote a path for a PowerShell single-quoted literal.
 *
 * @param {string} value - raw path.
 * @returns {string} the escaped inner text.
 */
function psQuote(value) {
  return value.replace(/'/g, "''")
}

/**
 * Windows: hand the target to the shell's recycle bin through the .NET helper
 * that Explorer itself uses. Works for files and directories.
 *
 * @param {string} path - absolute target.
 * @returns {Promise<TrashOutcome>} the outcome.
 */
async function trashWindows(path) {
  const isDirectory = (await stat(path)).isDirectory()
  const call = isDirectory ? 'DeleteDirectory' : 'DeleteFile'
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$target = '${psQuote(path)}'`,
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${call}($target, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`,
    'Write-Output "trashed"',
  ].join('; ')

  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ])

  if (result.code === 0 && (await exists(path)) === false) {
    return { trashed: true, strategy: 'windows-recycle-bin' }
  }
  return {
    trashed: false,
    strategy: 'windows-recycle-bin',
    reason: result.stderr.trim() || `exit ${String(result.code)}`,
  }
}

/**
 * macOS: prefer the `trash` CLI (Homebrew `macos-trash`), which restores
 * reliably; fall back to Finder, which is always present.
 *
 * @param {string} path - absolute target.
 * @returns {Promise<TrashOutcome>} the outcome.
 */
async function trashMac(path) {
  const cli = await run('trash', [path])
  if (cli.code === 0 && (await exists(path)) === false) {
    return { trashed: true, strategy: 'macos-trash-cli' }
  }

  const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "Finder" to delete POSIX file "${escaped}"`
  const finder = await run('osascript', ['-e', script])
  if (finder.code === 0 && (await exists(path)) === false) {
    return { trashed: true, strategy: 'macos-finder' }
  }
  return {
    trashed: false,
    strategy: 'macos-finder',
    reason: (finder.stderr || cli.stderr).trim() || 'Finder refused the item',
  }
}

/**
 * Linux: implement the FreeDesktop Trash specification directly.
 *
 * The target is moved (same filesystem) or copied then removed (cross
 * filesystem) into `$XDG_DATA_HOME/Trash/files`, with a matching `.trashinfo`
 * record so desktop trash browsers can restore it.
 *
 * @param {string} path - absolute target.
 * @returns {Promise<TrashOutcome>} the outcome.
 */
async function trashLinux(path) {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const root = join(dataHome, 'Trash')
  const filesDir = join(root, 'files')
  const infoDir = join(root, 'info')
  await mkdir(filesDir, { recursive: true })
  await mkdir(infoDir, { recursive: true })

  const name = basename(path)
  let candidate = name
  let counter = 1
  // A name already present in the bin is never overwritten: the spec reserves
  // uniqueness by suffixing before the extension.
  while ((await exists(join(filesDir, candidate))) || (await exists(join(infoDir, `${candidate}.trashinfo`)))) {
    const dot = name.lastIndexOf('.')
    candidate = dot > 0
      ? `${name.slice(0, dot)}.${counter}${name.slice(dot)}`
      : `${name}.${counter}`
    counter += 1
  }

  const destination = join(filesDir, candidate)
  try {
    await rename(path, destination)
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      return { trashed: false, strategy: 'freedesktop-trash', reason: String(error?.message ?? error) }
    }
    // Different filesystem: copy then remove, matching what the spec requires.
    try {
      const { cp, rm: remove } = await import('node:fs/promises')
      await cp(path, destination, { recursive: true })
      await remove(path, { recursive: true, force: true })
    } catch (copyError) {
      return { trashed: false, strategy: 'freedesktop-trash', reason: String(copyError?.message ?? copyError) }
    }
  }

  const deletedAt = new Date().toISOString()
  const record = [
    '[Trash Info]',
    `Path=${encodeURIComponent(path).replace(/%2F/g, '/')}`,
    `DeletionDate=${deletedAt}`,
    '',
  ].join('\n')
  await writeFile(join(infoDir, `${candidate}.trashinfo`), record, 'utf8')
  return { trashed: true, strategy: 'freedesktop-trash' }
}

/**
 * Describe what trash support this host has, without touching any file.
 *
 * @returns {Promise<{ supported: boolean, strategy: string, reason?: string }>} the capability.
 */
export async function probeTrash() {
  const platform = process.platform
  try {
    if (platform === 'win32') {
      const probe = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName Microsoft.VisualBasic; Write-Output "ok"',
      ], 10_000)
      return probe.code === 0 && probe.stdout.includes('ok')
        ? { supported: true, strategy: 'windows-recycle-bin' }
        : { supported: false, strategy: 'windows-recycle-bin', reason: probe.stderr.trim() || 'PowerShell helper unavailable' }
    }
    if (platform === 'darwin') {
      const cli = await run('trash', ['--version'], 5_000)
      if (cli.code === 0) return { supported: true, strategy: 'macos-trash-cli' }
      const finder = await run('osascript', ['-e', 'tell application "Finder" to get name'], 8_000)
      return finder.code === 0
        ? { supported: true, strategy: 'macos-finder' }
        : { supported: false, strategy: 'macos-finder', reason: 'Finder is not reachable from this host' }
    }
    if (platform === 'linux') {
      // FreeDesktop trash needs a writable data home, not a display server.
      const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
      await mkdir(join(dataHome, 'Trash', 'files'), { recursive: true })
      await mkdir(join(dataHome, 'Trash', 'info'), { recursive: true })
      return { supported: true, strategy: 'freedesktop-trash' }
    }
    return { supported: false, strategy: 'none', reason: `unsupported platform: ${platform}` }
  } catch (error) {
    return { supported: false, strategy: 'none', reason: String(error?.message ?? error) }
  }
}

/**
 * Move one file or directory to the operating system's recycle bin.
 *
 * @param {string} path - absolute target path.
 * @returns {Promise<TrashOutcome>} whether the target was trashed.
 */
export async function moveToTrash(path) {
  const absolute = resolve(path)
  try {
    if (process.platform === 'win32') return await trashWindows(absolute)
    if (process.platform === 'darwin') return await trashMac(absolute)
    if (process.platform === 'linux') return await trashLinux(absolute)
    return { trashed: false, strategy: 'none', reason: `unsupported platform: ${process.platform}` }
  } catch (error) {
    return {
      trashed: false,
      strategy: process.platform,
      reason: String(error?.message ?? error),
    }
  }
}

/**
 * Permanently delete one file or directory. Only reached when the caller has
 * decided the recycle bin is unavailable and the user accepted the red warning.
 *
 * @param {string} path - absolute target path.
 * @returns {Promise<void>} settles when the target is gone.
 */
export async function deletePermanently(path) {
  await rm(resolve(path), { recursive: true, force: true, maxRetries: 2 })
}

export { exists, run, scrubbedEnv, dirname }
