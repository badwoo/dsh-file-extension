/**
 * Operating-system clipboard access for *file lists*, not text.
 *
 * Files dragged onto an Explorer/Finder window arrive as a file drop list
 * (`CF_HDROP` on Windows, `NSPasteboard` file URLs on macOS, `text/uri-list` on
 * X11). `navigator.clipboard` in the page cannot read or write that, and dsh
 * itself ships no clipboard capability, so this module drives the platform
 * helper directly:
 *
 *  - Windows: `System.Windows.Forms.Clipboard` `GetFileDropList` /
 *    `SetFileDropList` through Windows PowerShell. Verified on this machine to
 *    round-trip a Chinese path (`中文名.txt`) byte-identically.
 *  - macOS: the AppKit `NSPasteboard` through `osascript -l JavaScript` and the
 *    ObjC bridge.
 *  - Linux: `xclip` (which can carry a typed selection such as `text/uri-list`),
 *    falling back to `xsel` for the text half only.
 *
 * Two Windows details are load-bearing and easy to get wrong:
 *
 *  1. A `.ps1` file containing non-ASCII must be written as UTF-8 **with BOM**.
 *     Without the BOM Windows PowerShell decodes it as the console code page and
 *     every Chinese path comes out as mojibake — the clipboard itself was always
 *     fine.
 *  2. Paths are never interpolated into a `-Command` string. They travel in in a
 *     UTF-8 JSON file that the script reads with an explicit encoding, and
 *     results come back the same way, so no console code page can touch them.
 *
 * A headless host legitimately has no clipboard. That is reported as
 * `supported: false` with a readable reason, never as a thrown error, so the
 * Sidebar can hide the action instead of showing a failure.
 *
 * @module dsh-file-extension/clipboard
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FAILURE_CODES, MAX_CLIPBOARD_ENTRIES } from './contract.js'
import { failure, success } from './fsops.js'
import { exists, run } from './trash.js'

/** Deadline for one clipboard helper invocation. */
const CLIPBOARD_TIMEOUT_MS = 12_000

/** Deadline for the cheap capability probe. */
const PROBE_TIMEOUT_MS = 8_000

/** Strategy names reported by the probe and by a real read. */
const STRATEGY = Object.freeze({
  windowsForms: 'windows-forms-clipboard',
  macPasteboard: 'macos-nspasteboard',
  linuxXclip: 'linux-xclip',
  linuxXsel: 'linux-xsel',
  none: 'none',
})

/**
 * One clipboard read: the file drop list plus the plain-text flavour.
 *
 * @typedef {object} ClipboardValue
 * @property {string} platform - `process.platform` of the host.
 * @property {string[]} files - absolute paths, in clipboard order.
 * @property {string | null} text - the text flavour, or null when there is none.
 * @property {boolean} supported - whether the platform clipboard was reachable.
 * @property {string} [reason] - why it was not, when `supported` is false.
 */

/**
 * Quote a value for a PowerShell single-quoted string literal.
 *
 * @param {string} value - raw text.
 * @returns {string} the escaped inner text (no surrounding quotes).
 */
function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Embed a value as a JavaScript string literal for an `osascript -l JavaScript`
 * program, where the value also travels through argv.
 *
 * @param {string} value - raw text.
 * @returns {string} a quoted, escaped literal.
 */
function jsLiteral(value) {
  return JSON.stringify(String(value))
}

/**
 * Create a private scratch directory for one helper invocation.
 *
 * @returns {Promise<string>} the directory path.
 */
async function makeScratch() {
  return mkdtemp(join(tmpdir(), 'dsh-file-extension-clip-'))
}

/**
 * Write one PowerShell script file as UTF-8 **with BOM**.
 *
 * The BOM is not cosmetic: it is how Windows PowerShell learns that the file is
 * UTF-8. Without it the file is decoded with the console code page and any
 * non-ASCII path inside it is corrupted before a single line runs.
 *
 * @param {string} directory - scratch directory to write into.
 * @param {string} fileName - script file name.
 * @param {string} body - script source.
 * @returns {Promise<string>} the script path.
 */
async function writePowerShellScript(directory, fileName, body) {
  const path = join(directory, fileName)
  await writeFile(path, `\uFEFF${body}`, 'utf8')
  return path
}

/**
 * Run one PowerShell script file to completion.
 *
 * `-STA` is required because both clipboard APIs are COM apartment-threaded;
 * `-NonInteractive` keeps a modal prompt from hanging the Host route.
 *
 * @param {string} scriptPath - absolute path of the `.ps1` file.
 * @param {number} [timeoutMs] - deadline before the child is killed.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} the settled process.
 */
async function runPowerShell(scriptPath, timeoutMs = CLIPBOARD_TIMEOUT_MS) {
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ], timeoutMs)
}

/**
 * Read one UTF-8 JSON file a helper wrote, tolerating a BOM.
 *
 * @param {string} path - absolute path.
 * @returns {Promise<unknown>} the parsed value, or null when the file is empty.
 */
async function readJsonFile(path) {
  const raw = await readFile(path, 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (text.trim() === '') return null
  return JSON.parse(text)
}

/**
 * Normalize a helper's `files` field.
 *
 * Windows PowerShell's `ConvertTo-Json` unwraps a one-element array in some
 * shapes, so a bare string is accepted as a one-entry list rather than being
 * silently dropped.
 *
 * @param {unknown} value - the raw field.
 * @returns {string[]} the usable absolute paths, capped at the clipboard limit.
 */
function normalizeFiles(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const files = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || files.includes(trimmed)) continue
    if (files.length >= MAX_CLIPBOARD_ENTRIES) break
    files.push(trimmed)
  }
  return files
}

/**
 * Normalize a helper's `text` field.
 *
 * @param {unknown} value - the raw field.
 * @returns {string | null} the text, or null when absent.
 */
function normalizeText(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Windows: read the file drop list and the text flavour.
 *
 * @returns {Promise<{ files: string[], text: string | null, supported: boolean, reason?: string }>} the read.
 */
async function readWindowsClipboard() {
  const scratch = await makeScratch()
  try {
    const outPath = join(scratch, 'read.json')
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Windows.Forms',
      `$outPath = '${psQuote(outPath)}'`,
      '$files = @()',
      'try {',
      '  $dropList = [System.Windows.Forms.Clipboard]::GetFileDropList()',
      '  if ($null -ne $dropList) {',
      '    foreach ($entry in $dropList) {',
      '      if (-not [string]::IsNullOrEmpty($entry)) { $files += [string]$entry }',
      '    }',
      '  }',
      '} catch { }',
      '$text = $null',
      'try {',
      '  if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() }',
      '} catch { }',
      '$payload = [pscustomobject]@{ files = $files; text = $text }',
      '$json = $payload | ConvertTo-Json -Compress -Depth 4',
      '[System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))',
    ].join('\r\n')

    const scriptPath = await writePowerShellScript(scratch, 'read.ps1', script)
    const result = await runPowerShell(scriptPath)
    if (result.code !== 0) {
      return {
        files: [],
        text: null,
        supported: false,
        reason: result.stderr.trim() || `the clipboard helper exited with ${String(result.code)}`,
      }
    }
    const payload = await readJsonFile(outPath)
    return {
      files: normalizeFiles(payload?.files),
      text: normalizeText(payload?.text),
      supported: true,
    }
  } catch (error) {
    return { files: [], text: null, supported: false, reason: String(error?.message ?? error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Windows: replace the clipboard with a file drop list (`CF_HDROP`).
 *
 * `SetFileDropList` needs the clipboard exclusively and another process can hold
 * it for a moment, so the script retries briefly instead of failing the user's
 * copy on a transient lock.
 *
 * @param {readonly string[]} paths - absolute paths that already exist.
 * @returns {Promise<{ written: number } | { error: string }>} the effect.
 */
async function writeWindowsClipboard(paths) {
  const scratch = await makeScratch()
  try {
    const inPath = join(scratch, 'paths.json')
    // Plain UTF-8 without BOM: the script reads it with an explicit encoding.
    await writeFile(inPath, JSON.stringify(paths), 'utf8')
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Windows.Forms',
      `$inPath = '${psQuote(inPath)}'`,
      '$raw = [System.IO.File]::ReadAllText($inPath, [System.Text.Encoding]::UTF8)',
      '$paths = @()',
      'if ($raw.Trim().Length -gt 0) {',
      '  $parsed = ConvertFrom-Json -InputObject $raw',
      '  foreach ($entry in @($parsed)) { $paths += [string]$entry }',
      '}',
      '$list = New-Object System.Collections.Specialized.StringCollection',
      'foreach ($entry in $paths) { [void]$list.Add($entry) }',
      '$attempt = 0',
      'while ($true) {',
      '  try { [System.Windows.Forms.Clipboard]::SetFileDropList($list); break }',
      '  catch { $attempt += 1; if ($attempt -ge 3) { throw }; Start-Sleep -Milliseconds 150 }',
      '}',
      'Write-Output "ok"',
    ].join('\r\n')

    const scriptPath = await writePowerShellScript(scratch, 'write.ps1', script)
    const result = await runPowerShell(scriptPath)
    if (result.code !== 0 || !result.stdout.includes('ok')) {
      return {
        error: result.stderr.trim() || `the clipboard helper exited with ${String(result.code)}`,
      }
    }
    return { written: paths.length }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * macOS: read the pasteboard through the ObjC bridge.
 *
 * Uses `var` and function-level syntax only: the JavaScriptCore shipped with
 * `osascript` is old enough that arrows and `let` are not worth the risk.
 *
 * @returns {Promise<{ files: string[], text: string | null, supported: boolean, reason?: string }>} the read.
 */
async function readMacClipboard() {
  const scratch = await makeScratch()
  try {
    const outPath = join(scratch, 'read.json')
    const program = [
      'ObjC.import("AppKit");',
      'ObjC.import("Foundation");',
      'var pb = $.NSPasteboard.generalPasteboard;',
      'var found = [];',
      'var text = null;',
      'try {',
      '  var objects = pb.readObjectsForClassesOptions($([$.NSURL]), $({}));',
      '  if (objects && !objects.isNil()) {',
      '    var count = objects.count;',
      '    for (var i = 0; i < count; i++) {',
      '      var url = objects.objectAtIndex(i);',
      '      if (url && !url.isNil() && url.isFileURL) { found.push(ObjC.unwrap(url.path)); }',
      '    }',
      '  }',
      '} catch (error) { }',
      'try {',
      '  var raw = pb.stringForType($.NSPasteboardTypeString);',
      '  if (raw && !raw.isNil()) { text = ObjC.unwrap(raw); }',
      '} catch (error) { }',
      `var payload = JSON.stringify({ files: found, text: text });`,
      `var outPath = ${jsLiteral(outPath)};`,
      '$.NSString.stringWithString($(payload))',
      '  .writeToFileAtomicallyEncodingError($(outPath), true, $.NSUTF8StringEncoding, null);',
    ].join('\n')

    const result = await run('osascript', ['-l', 'JavaScript', '-e', program], CLIPBOARD_TIMEOUT_MS)
    if (result.code !== 0) {
      return {
        files: [],
        text: null,
        supported: false,
        reason: result.stderr.trim() || `osascript exited with ${String(result.code)}`,
      }
    }
    const payload = await readJsonFile(outPath)
    return {
      files: normalizeFiles(payload?.files),
      text: normalizeText(payload?.text),
      supported: true,
    }
  } catch (error) {
    return { files: [], text: null, supported: false, reason: String(error?.message ?? error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * macOS: replace the pasteboard with file URLs.
 *
 * @param {readonly string[]} paths - absolute paths that already exist.
 * @returns {Promise<{ written: number } | { error: string }>} the effect.
 */
async function writeMacClipboard(paths) {
  const scratch = await makeScratch()
  try {
    const inPath = join(scratch, 'paths.json')
    await writeFile(inPath, JSON.stringify(paths), 'utf8')
    const program = [
      'ObjC.import("AppKit");',
      'ObjC.import("Foundation");',
      `var inPath = ${jsLiteral(inPath)};`,
      'var raw = $.NSString.stringWithContentsOfFileEncodingError($(inPath), $.NSUTF8StringEncoding, null);',
      'var paths = JSON.parse(ObjC.unwrap(raw));',
      'var urls = [];',
      'for (var i = 0; i < paths.length; i++) { urls.push($.NSURL.fileURLWithPath($(paths[i]))); }',
      'var pb = $.NSPasteboard.generalPasteboard;',
      'pb.clearContents;',
      'pb.writeObjects($(urls));',
    ].join('\n')

    const result = await run('osascript', ['-l', 'JavaScript', '-e', program], CLIPBOARD_TIMEOUT_MS)
    if (result.code !== 0) {
      return { error: result.stderr.trim() || `osascript exited with ${String(result.code)}` }
    }
    return { written: paths.length }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Turn one `text/uri-list` payload into absolute paths.
 *
 * @param {string} stdout - the raw selection body.
 * @returns {string[]} the decoded paths.
 */
function parseUriList(stdout) {
  const files = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!trimmed.startsWith('file://')) continue
    try {
      const path = decodeURIComponent(trimmed.replace(/^file:\/\/(?:localhost)?/, ''))
      if (files.length >= MAX_CLIPBOARD_ENTRIES) break
      if (!files.includes(path)) files.push(path)
    } catch {
      // A malformed percent-escape is skipped rather than failing the read.
    }
  }
  return files
}

/**
 * Linux: read the typed selection, then the text flavour.
 *
 * @returns {Promise<{ files: string[], text: string | null, supported: boolean, reason?: string }>} the read.
 */
async function readLinuxClipboard() {
  const uri = await run('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o'], 6_000)
  if (uri.code !== 0) {
    // No `xclip`, no DISPLAY, or an empty selection: try the text half through
    // `xsel` so a plain-text clipboard still round-trips.
    const fallback = await run('xsel', ['--clipboard', '--output'], 6_000)
    if (fallback.code !== 0) {
      return {
        files: [],
        text: null,
        supported: false,
        reason: (uri.stderr || fallback.stderr).trim()
          || 'neither xclip nor xsel could read the X11 clipboard',
      }
    }
    return { files: [], text: normalizeText(fallback.stdout), supported: true }
  }
  const text = await run('xclip', ['-selection', 'clipboard', '-o'], 6_000)
  return {
    files: parseUriList(uri.stdout),
    text: text.code === 0 ? normalizeText(text.stdout) : null,
    supported: true,
  }
}

/**
 * Linux: replace the clipboard with `text/uri-list` file URLs.
 *
 * `xclip -i` reads the selection body from a file, which keeps every path out of
 * argv and out of any shell quoting question.
 *
 * @param {readonly string[]} paths - absolute paths that already exist.
 * @returns {Promise<{ written: number } | { error: string }>} the effect.
 */
async function writeLinuxClipboard(paths) {
  const scratch = await makeScratch()
  try {
    const inPath = join(scratch, 'uri-list.txt')
    const body = `${paths.map((path) => pathToFileURL(path).href).join('\n')}\n`
    await writeFile(inPath, body, 'utf8')
    const result = await run(
      'xclip',
      ['-selection', 'clipboard', '-t', 'text/uri-list', '-i', inPath],
      CLIPBOARD_TIMEOUT_MS,
    )
    if (result.code !== 0) {
      return { error: result.stderr.trim() || `xclip exited with ${String(result.code)}` }
    }
    return { written: paths.length }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Read the operating-system clipboard's file drop list and text flavour.
 *
 * Never throws and never reports a missing clipboard as an error: a headless or
 * remote host returns `supported: false` with a reason so the caller can hide
 * the action instead of rendering a failure.
 *
 * @returns {Promise<{ ok: true, value: ClipboardValue }>} the read.
 */
export async function readClipboard() {
  const platform = process.platform
  try {
    let read
    if (platform === 'win32') read = await readWindowsClipboard()
    else if (platform === 'darwin') read = await readMacClipboard()
    else if (platform === 'linux') read = await readLinuxClipboard()
    else {
      read = {
        files: [],
        text: null,
        supported: false,
        reason: `unsupported platform: ${platform}`,
      }
    }
    const value = { platform, files: read.files, text: read.text, supported: read.supported === true }
    if (read.reason !== undefined) value.reason = read.reason
    return success(value)
  } catch (error) {
    return success({
      platform,
      files: [],
      text: null,
      supported: false,
      reason: String(error?.message ?? error),
    })
  }
}

/**
 * Put absolute paths on the operating-system clipboard as a file drop list.
 *
 * This deliberately writes the file flavour, not text: the user must be able to
 * paste the entries into Explorer, Finder, or any other file manager, and a
 * text-only clipboard would paste a note instead of the files.
 *
 * Every path is checked first, and the missing ones are named in the failure —
 * a copy that silently dropped half the selection would be worse than a refusal.
 *
 * @param {unknown} paths - the caller's absolute paths.
 * @returns {Promise<object>} the outcome with the number of entries written.
 */
export async function writeClipboard(paths) {
  const candidates = Array.isArray(paths) ? paths : []
  const resolvedPaths = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const absolute = resolve(candidate.trim())
    if (!resolvedPaths.includes(absolute)) resolvedPaths.push(absolute)
  }

  if (resolvedPaths.length === 0) {
    return failure(FAILURE_CODES.clipboardEmpty, 'no paths were supplied')
  }
  if (resolvedPaths.length > MAX_CLIPBOARD_ENTRIES) {
    return failure(
      FAILURE_CODES.operationFailed,
      `at most ${String(MAX_CLIPBOARD_ENTRIES)} entries can be put on the clipboard at once`,
      { limit: MAX_CLIPBOARD_ENTRIES, requested: resolvedPaths.length },
    )
  }

  const missing = []
  const present = []
  for (const absolute of resolvedPaths) {
    if (await exists(absolute)) present.push(absolute)
    else missing.push(absolute)
  }
  if (missing.length > 0) {
    return failure(
      FAILURE_CODES.notFound,
      `${String(missing.length)} of ${String(resolvedPaths.length)} entries no longer exist`,
      { missing: missing.slice(0, 20) },
    )
  }

  let written
  if (process.platform === 'win32') written = await writeWindowsClipboard(present)
  else if (process.platform === 'darwin') written = await writeMacClipboard(present)
  else if (process.platform === 'linux') written = await writeLinuxClipboard(present)
  else {
    return failure(
      FAILURE_CODES.clipboardUnavailable,
      `the clipboard is not supported on ${process.platform}`,
      { platform: process.platform },
    )
  }

  if (written.error !== undefined) {
    return failure(FAILURE_CODES.clipboardUnavailable, written.error, {
      platform: process.platform,
      strategy: STRATEGY.none,
    })
  }
  return success({ written: written.written })
}

/**
 * Describe what clipboard support this host has, without touching any user data.
 *
 * Kept cheap on purpose: it runs once per process and is cached by the caller,
 * so it only checks that the platform helper starts — not that the clipboard is
 * populated.
 *
 * @returns {Promise<{ supported: boolean, strategy: string, reason?: string }>} the capability.
 */
export async function probeClipboard() {
  const platform = process.platform
  try {
    if (platform === 'win32') {
      const probe = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-Command', 'Add-Type -AssemblyName System.Windows.Forms; Write-Output "ok"',
      ], PROBE_TIMEOUT_MS)
      const ok = probe.code === 0 && probe.stdout.includes('ok')
      return ok
        ? { supported: true, strategy: STRATEGY.windowsForms }
        : {
            supported: false,
            strategy: STRATEGY.windowsForms,
            reason: probe.stderr.trim() || 'the Windows clipboard assembly is unavailable',
          }
    }
    if (platform === 'darwin') {
      const probe = await run('osascript', [
        '-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); "ok"',
      ], PROBE_TIMEOUT_MS)
      const ok = probe.code === 0 && probe.stdout.includes('ok')
      return ok
        ? { supported: true, strategy: STRATEGY.macPasteboard }
        : {
            supported: false,
            strategy: STRATEGY.macPasteboard,
            reason: probe.stderr.trim() || 'the macOS pasteboard is not reachable from this host',
          }
    }
    if (platform === 'linux') {
      const xclip = await run('xclip', ['-version'], 5_000)
      if (xclip.code === 0) return { supported: true, strategy: STRATEGY.linuxXclip }
      const xsel = await run('xsel', ['--version'], 5_000)
      if (xsel.code === 0) {
        return {
          supported: true,
          strategy: STRATEGY.linuxXsel,
          reason: 'xsel carries text only; install xclip to copy files',
        }
      }
      return {
        supported: false,
        strategy: STRATEGY.none,
        reason: 'neither xclip nor xsel is installed on this host',
      }
    }
    return { supported: false, strategy: STRATEGY.none, reason: `unsupported platform: ${platform}` }
  } catch (error) {
    return { supported: false, strategy: STRATEGY.none, reason: String(error?.message ?? error) }
  }
}

export { STRATEGY as CLIPBOARD_STRATEGIES }
