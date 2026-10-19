/**
 * End-to-end operation test: exercises the Host routes against real files and
 * asserts what actually happened on disk — including that a deleted file is
 * genuinely in the Windows recycle bin and that a "Save as" never modifies its
 * source.
 *
 * Runs against a live `dsh web` instance, authenticated with its token.
 *
 * @module dsh-file-extension/tests/operations
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DSH_TEST_BASE
const TOKEN = process.env.DSH_TEST_TOKEN
const WORKSPACE = process.env.DSH_TEST_WORKSPACE

if (BASE === undefined || TOKEN === undefined || WORKSPACE === undefined) {
  console.error('set DSH_TEST_BASE, DSH_TEST_TOKEN, DSH_TEST_WORKSPACE')
  process.exit(2)
}

const failures = []
const passes = []
const check = (name, condition, detail = '') => {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// --- authenticate once, reuse the cookie ------------------------------------
const login = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' })
const setCookie = login.headers.get('set-cookie')
if (setCookie === null) {
  console.error('login failed; no cookie', login.status)
  process.exit(2)
}
const cookie = setCookie.split(';')[0]

/**
 * Call one plugin route.
 *
 * @param {string} route - route name after the prefix.
 * @param {object} [body] - JSON body for POST.
 * @returns {Promise<object>} the parsed response.
 */
async function call(route, body) {
  const response = await fetch(`${BASE}/api/dsh-file-extension/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

// --- fixture ---------------------------------------------------------------
const fixtureDir = join(WORKSPACE, '_dfx-test-fixture')
await rm(fixtureDir, { recursive: true, force: true })
await mkdir(fixtureDir, { recursive: true })
const sample = join(fixtureDir, 'sample.txt')
await writeFile(sample, 'original content', 'utf8')
const toTrash = join(fixtureDir, 'trash-me.txt')
await writeFile(toTrash, 'delete me', 'utf8')
const toTrashDir = join(fixtureDir, 'trash-dir')
await mkdir(toTrashDir, { recursive: true })
await writeFile(join(toTrashDir, 'inner.txt'), 'inner', 'utf8')
const sessionId = process.env.DSH_TEST_SESSION

try {
  console.log('\n[1] capabilities')
  const caps = await call('capabilities')
  check('capabilities ok', caps.body.ok === true, JSON.stringify(caps.body))
  check('trash supported on this host', caps.body.value?.trash?.supported === true, JSON.stringify(caps.body.value?.trash))
  console.log('   trash strategy:', caps.body.value?.trash?.strategy)

  console.log('\n[2] stat')
  const st = await call('stat', { path: sample, sessionId })
  check('stat reports the file', st.body.ok === true && st.body.value?.kind === 'file', JSON.stringify(st.body))
  check('stat reports the size', st.body.value?.bytes === 'original content'.length, String(st.body.value?.bytes))

  console.log('\n[3] rename')
  const renamed = await call('rename', { path: sample, name: 'renamed.txt', sessionId })
  check('rename ok', renamed.body.ok === true, JSON.stringify(renamed.body))
  const renamedPath = join(fixtureDir, 'renamed.txt')
  const renamedExists = await stat(renamedPath).then(() => true, () => false)
  check('renamed file exists on disk', renamedExists === true)
  const renamedContent = renamedExists ? await readFile(renamedPath, 'utf8') : ''
  check('rename preserved the content', renamedContent === 'original content', renamedContent)

  console.log('\n[4] rename collision is refused')
  await writeFile(join(fixtureDir, 'other.txt'), 'other', 'utf8')
  const collision = await call('rename', { path: renamedPath, name: 'other.txt', sessionId })
  check('duplicate name refused', collision.body.ok === false && collision.body.code?.endsWith('/already-exists'), JSON.stringify(collision.body))
  const stillThere = await stat(renamedPath).then(() => true, () => false)
  check('original untouched after refused rename', stillThere === true)

  console.log('\n[5] rename rejects illegal characters')
  const illegal = await call('rename', { path: renamedPath, name: 'bad<name>.txt', sessionId })
  check('illegal characters refused', illegal.body.ok === false && illegal.body.code?.endsWith('/invalid-name'), JSON.stringify(illegal.body))

  console.log('\n[6] save-as writes a copy and never touches the source')
  const copy = await call('copy', {
    path: renamedPath,
    options: { directory: fixtureDir, name: 'renamed-copy.txt', overwrite: false },
    sessionId,
  })
  check('save-as ok', copy.body.ok === true, JSON.stringify(copy.body))
  const copyPath = join(fixtureDir, 'renamed-copy.txt')
  const copyContent = await readFile(copyPath, 'utf8').catch(() => '')
  check('copy has the same content', copyContent === 'original content', copyContent)
  const sourceContent = await readFile(renamedPath, 'utf8').catch(() => '')
  check('source unchanged by save-as', sourceContent === 'original content', sourceContent)

  console.log('\n[7] save-as refuses to overwrite without permission')
  const overwriteRefused = await call('copy', {
    path: renamedPath,
    options: { directory: fixtureDir, name: 'renamed-copy.txt', overwrite: false },
    sessionId,
  })
  check('overwrite refused', overwriteRefused.body.ok === false && overwriteRefused.body.code?.endsWith('/already-exists'), JSON.stringify(overwriteRefused.body))
  const overwriteAllowed = await call('copy', {
    path: renamedPath,
    options: { directory: fixtureDir, name: 'renamed-copy.txt', overwrite: true },
    sessionId,
  })
  check('overwrite allowed when confirmed', overwriteAllowed.body.ok === true, JSON.stringify(overwriteAllowed.body))

  console.log('\n[8] delete a file into the recycle bin')
  const trashed = await call('remove', { path: toTrash, options: { mode: 'trash' }, sessionId })
  check('trash delete ok', trashed.body.ok === true && trashed.body.value?.mode === 'trash', JSON.stringify(trashed.body))
  const gone = await stat(toTrash).then(() => false, () => true)
  check('file is gone from the workspace', gone === true)

  console.log('\n[9] confirm the file is really in the OS recycle bin')
  // Each volume has its own recycle bin, and the workspace may not be on the
  // system drive, so every drive root is scanned. The folder name starts with a
  // literal `$`, so it is assembled from character codes: a plain `$Recycle`
  // inside a PowerShell string would be read as a variable and expand to empty.
  const inBin = await new Promise((resolve) => {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      '$found=$false',
      '$binName = [string]::Concat([char]36, "Recycle.Bin")',
      '$infoPrefix = [string]::Concat([char]36, "I")',
      'foreach($d in Get-PSDrive -PSProvider FileSystem){',
      '  $root = Join-Path ($d.Name + ":") $binName',
      '  if(-not (Test-Path -LiteralPath $root)){ continue }',
      '  foreach($sid in Get-ChildItem -LiteralPath $root -Force -Directory){',
      '    foreach($i in Get-ChildItem -LiteralPath $sid.FullName -Force -Filter ($infoPrefix + "*")) {',
      '      try{',
      '        $b=[System.IO.File]::ReadAllBytes($i.FullName)',
      '        if($b.Length -gt 28){',
      '          $p=[System.Text.Encoding]::Unicode.GetString($b[28..($b.Length-1)]) -replace "`0",""',
      "          if($p -like '*trash-me.txt'){ $found=$true }",
      '        }',
      '      }catch{}',
      '    }',
      '  }',
      '}',
      'Write-Output $found',
    ].join('; ')
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    ps.stdout.on('data', (chunk) => { out += String(chunk) })
    ps.on('close', () => resolve(out.trim() === 'True'))
  })
  check('file found in the OS recycle bin', inBin === true)

  console.log('\n[10] delete a directory into the recycle bin')
  const trashedDir = await call('remove', { path: toTrashDir, options: { mode: 'trash' }, sessionId })
  check('directory trash ok', trashedDir.body.ok === true, JSON.stringify(trashedDir.body))
  const dirGone = await stat(toTrashDir).then(() => false, () => true)
  check('directory gone from the workspace', dirGone === true)

  console.log('\n[11] permanent delete')
  const permanentTarget = join(fixtureDir, 'permanent.txt')
  await writeFile(permanentTarget, 'bye', 'utf8')
  const permanent = await call('remove', { path: permanentTarget, options: { mode: 'permanent' }, sessionId })
  check('permanent delete ok', permanent.body.ok === true && permanent.body.value?.mode === 'permanent', JSON.stringify(permanent.body))
  const permGone = await stat(permanentTarget).then(() => false, () => true)
  check('permanently deleted file is gone', permGone === true)

  console.log('\n[12] workspace containment')
  const outside = await call('stat', { path: join(tmpdir(), 'nope.txt'), sessionId })
  check('outside-workspace path refused', outside.body.ok === false && outside.body.code?.endsWith('/outside-workspace'), JSON.stringify(outside.body))

  console.log('\n[13] download fallback returns bounded bytes')
  const download = await call('download', { path: renamedPath, sessionId })
  check('download ok', download.body.ok === true, JSON.stringify(download.body).slice(0, 200))
  const decoded = download.body.ok === true ? Buffer.from(download.body.value.data, 'base64').toString('utf8') : ''
  check('download returns the file content', decoded === 'original content', decoded)
} finally {
  await rm(fixtureDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'='.repeat(60)}`)
console.log(`PASS ${String(passes.length)}   FAIL ${String(failures.length)}`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const line of failures) console.log(`  - ${line}`)
  process.exitCode = 1
}
