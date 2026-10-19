/**
 * Capture README screenshots from the live page.
 *
 * @module dsh-file-extension/tests/screenshot
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9339
const U = process.env.DSH_TEST_URL
const OUT = resolve(import.meta.dirname, '..', 'docs')
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-dfx-shot-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${String(PORT)}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1500,940', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  let v
  for (let i = 0; i < 60; i += 1) {
    try {
      v = await (await fetch(`http://127.0.0.1:${String(PORT)}/json/version`)).json()
      if (v?.webSocketDebuggerUrl) break
    } catch { /* wait */ }
    await sleep(500)
  }
  const socket = new WebSocket(v.webSocketDebuggerUrl)
  await new Promise((r) => socket.addEventListener('open', r, { once: true }))
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    const w = pending.get(m.id)
    if (w) { pending.delete(m.id); w(m.result) }
  })
  const send = (method, params = {}, sessionId) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((r) => pending.set(id, r))
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1500, height: 940, deviceScaleFactor: 2, mobile: false,
  }, sessionId)
  await send('Page.navigate', { url: U }, sessionId)
  await sleep(15000)
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result?.value
  }

  // Open the right column and its file tree.
  await ev(`(async () => {
    const byLabel = (n) => [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes(n));
    (byLabel('打开右侧边栏') ?? byLabel('Open right'))?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const col = document.querySelector('[class*="rightbarCol"]');
    const entry = [...col.querySelectorAll('button')].find((b) => /工作区文件|workspace files/i.test((b.textContent || '').trim()));
    entry?.click();
    await new Promise((r) => setTimeout(r, 2500));
    const dirs = [...document.querySelectorAll('[data-files-entry="directory"] > button')];
    if (document.querySelectorAll('[data-files-entry="file"]').length === 0) dirs[0]?.click();
    await new Promise((r) => setTimeout(r, 2500));
  })()`)

  // Hover a row so the @ button shows, then open the menu.
  await ev(`(async () => {
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return;
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
  })()`)
  await sleep(600)

  await mkdir(OUT, { recursive: true })
  const hoverShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(join(OUT, 'screenshot-hover.png'), Buffer.from(hoverShot.data, 'base64'))

  // Now the menu.
  await ev(`(async () => {
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return;
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 60, clientY: rect.bottom, button: 2 }));
    await new Promise((r) => setTimeout(r, 600));
  })()`)
  await sleep(800)
  const menuShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(join(OUT, 'screenshot-menu.png'), Buffer.from(menuShot.data, 'base64'))

  // And the delete dialog.
  await ev(`(async () => {
    const items = [...document.querySelectorAll('.dfx-menu-item')];
    const del = items.find((i) => /delete|删除/i.test(i.textContent || ''));
    del?.click();
    await new Promise((r) => setTimeout(r, 1500));
  })()`)
  await sleep(900)
  const dialogShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(join(OUT, 'screenshot-delete.png'), Buffer.from(dialogShot.data, 'base64'))

  console.log('screenshots written to', OUT)
} finally {
  chrome.kill()
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
}
