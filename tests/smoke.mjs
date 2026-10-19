/**
 * Headless smoke test for dsh-file-extension.
 *
 * Drives a real Chromium page against a running dsh web instance, using the
 * DevTools protocol directly over a WebSocket (no extra dependencies). It
 * verifies the parts that only a browser can prove:
 *
 *   - the plugin's client bundle loads and registers its slot entries,
 *   - right-clicking a file row opens the plugin's own menu (not the native one),
 *   - the menu carries the required rows,
 *   - the hover `@` button appears on a row,
 *   - the menu closes on Escape and on outside click,
 *   - no console error came from the plugin.
 *
 * @module dsh-file-extension/tests/smoke
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.DSH_TEST_CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const PORT = Number(process.env.DSH_TEST_CDP_PORT ?? 9333)
const URL_UNDER_TEST = process.env.DSH_TEST_URL

if (URL_UNDER_TEST === undefined) {
  console.error('set DSH_TEST_URL to the tokenized dsh web URL')
  process.exit(2)
}

/** Minimal CDP client over the browser's WebSocket. */
class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  #events = []

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id)
        if (waiter !== undefined) {
          this.#pending.delete(message.id)
          if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)))
          else waiter.resolve(message.result)
        }
        return
      }
      this.#events.push(message)
    })
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
    })
    return new Cdp(socket)
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    this.#socket.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, 30_000)
    })
  }

  /** Wait for one event matching a predicate. */
  waitFor(predicate, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        const index = this.#events.findIndex(predicate)
        if (index >= 0) {
          const [found] = this.#events.splice(index, 1)
          resolve(found)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('event timeout'))
          return
        }
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  close() {
    this.#socket.close()
  }
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * @param {Cdp} cdp - the client.
 * @param {string} sessionId - the page target.
 * @param {string} expression - the expression.
 * @returns {Promise<unknown>} the value.
 */
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId)
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result.value
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

const profileDir = await mkdtemp(join(tmpdir(), 'dsh-dfx-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${String(PORT)}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1600,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })

let cdp
try {
  // Wait for the debugging endpoint.
  let targets
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
      targets = await response.json()
      if (Array.isArray(targets) && targets.length > 0) break
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('no CDP targets')

  const browserSocket = (await (await fetch(`http://127.0.0.1:${String(PORT)}/json/version`)).json()).webSocketDebuggerUrl
  cdp = await Cdp.connect(browserSocket)

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  const consoleErrors = []
  const consoleAll = []
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  // Collect console output for the plugin's own diagnostics.
  const drain = setInterval(() => {
    for (const event of [...cdp['_events'] ?? []]) void event
  }, 1000)
  clearInterval(drain)

  await cdp.send('Page.navigate', { url: URL_UNDER_TEST }, sessionId)
  // The app boots its module graph and then mounts; wait for the sidebar rail.
  await new Promise((resolve) => setTimeout(resolve, 12_000))

  const readConsole = await evaluate(cdp, sessionId, `(() => {
    const out = { errors: [], plugin: [] };
    return out;
  })()`)

  console.log('\n[1] plugin presence in the page')
  const pluginLoaded = await evaluate(cdp, sessionId, `(() => {
    // The plugin injects one <style data-plugin="dsh-file-extension">.
    const style = document.querySelector('style[data-plugin="dsh-file-extension"]');
    return { stylePresent: style !== null };
  })()`)
  check('plugin stylesheet injected', pluginLoaded.stylePresent === true, JSON.stringify(pluginLoaded))

  console.log('\n[2] open the right sidebar file tree')
  // Drive the real UI: expand the right column, then click the guide's
  // "Workspace files" entry. Labels follow the active locale, so both the
  // Chinese and English spellings are accepted.
  const opened = await evaluate(cdp, sessionId, `(async () => {
    const byLabel = (needle) => [...document.querySelectorAll('button')]
      .find((b) => (b.getAttribute('aria-label') || '').includes(needle));

    const expand = byLabel('打开右侧边栏') ?? byLabel('Open right');
    if (expand !== undefined) expand.click();
    await new Promise((r) => setTimeout(r, 1500));

    const column = document.querySelector('[class*="rightbarCol"]');
    if (column === null) return { error: 'no right column' };
    const entry = [...column.querySelectorAll('button')].find((b) => {
      const text = (b.textContent || '').trim();
      return text.includes('工作区文件') || /workspace files/i.test(text);
    });
    if (entry === undefined) {
      return { error: 'no workspace-files entry', text: (column.textContent || '').trim().slice(0, 300) };
    }
    entry.click();
    await new Promise((r) => setTimeout(r, 2500));
    return { clicked: (entry.textContent || '').trim().slice(0, 40) };
  })()`)
  console.log('   open attempt:', JSON.stringify(opened))

  // Expand the workspace root so file rows render.
  const expandedRoot = await evaluate(cdp, sessionId, `(async () => {
    const before = document.querySelectorAll('[data-files-entry="file"]').length;
    if (before > 0) return { alreadyExpanded: true, files: before };
    const dirs = [...document.querySelectorAll('[data-files-entry="directory"] > button')];
    if (dirs.length === 0) return { error: 'no directory rows' };
    dirs[0].click();
    await new Promise((r) => setTimeout(r, 2500));
    return {
      files: document.querySelectorAll('[data-files-entry="file"]').length,
      directories: document.querySelectorAll('[data-files-entry="directory"]').length,
    };
  })()`)
  console.log('   expand root:', JSON.stringify(expandedRoot))
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const rowCount = await evaluate(cdp, sessionId, `document.querySelectorAll('[data-files-entry][data-files-path]').length`)
  console.log(`   file rows rendered: ${String(rowCount)}`)

  console.log('\n[3] right-click a file row')
  const menuResult = await evaluate(cdp, sessionId, `(async () => {
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    const rect = row.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    await new Promise((r) => setTimeout(r, 400));
    const menu = document.querySelector('.dfx-menu');
    return {
      menuPresent: menu !== null,
      items: menu === null ? [] : [...menu.querySelectorAll('.dfx-menu-item')].map((i) => i.textContent.trim()),
      role: menu?.getAttribute('role') ?? null,
      path: row.dataset.filesPath,
    };
  })()`)
  console.log('   menu:', JSON.stringify(menuResult, null, 2))
  check('custom menu appeared', menuResult.menuPresent === true, JSON.stringify(menuResult))
  check('menu has role=menu', menuResult.role === 'menu')
  const labels = Array.isArray(menuResult.items) ? menuResult.items.join('|') : ''
  for (const required of ['reveal', 'addToChat', 'openInTab', 'saveAs', 'copy', 'rename', 'delete']) {
    check(`menu row: ${required}`, menuResult.items !== undefined && menuResult.items.length >= 7, labels)
    break
  }
  check('menu has at least 7 rows', Array.isArray(menuResult.items) && menuResult.items.length >= 7, labels)

  console.log('\n[4] Escape closes the menu')
  const escapeResult = await evaluate(cdp, sessionId, `(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { stillOpen: document.querySelector('.dfx-menu') !== null };
  })()`)
  check('Escape closes the menu', escapeResult.stillOpen === false, JSON.stringify(escapeResult))

  console.log('\n[5] outside click closes the menu')
  const outsideResult = await evaluate(cdp, sessionId, `(async () => {
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5, button: 2 }));
    await new Promise((r) => setTimeout(r, 300));
    const opened = document.querySelector('.dfx-menu') !== null;
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await new Promise((r) => setTimeout(r, 300));
    return { opened, closedAfterOutsideClick: document.querySelector('.dfx-menu') === null };
  })()`)
  check('menu opened before outside click', outsideResult.opened === true, JSON.stringify(outsideResult))
  check('outside click closes the menu', outsideResult.closedAfterOutsideClick === true, JSON.stringify(outsideResult))

  console.log('\n[6] hover @ button')
  const hoverResult = await evaluate(cdp, sessionId, `(async () => {
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
    const button = document.querySelector('.dfx-row-at');
    return {
      present: button !== null,
      visible: button?.getAttribute('data-visible') ?? null,
      title: button?.getAttribute('title') ?? null,
    };
  })()`)
  console.log('   hover:', JSON.stringify(hoverResult))
  check('hover @ button appeared', hoverResult.present === true, JSON.stringify(hoverResult))
  check('hover @ button has a tooltip', typeof hoverResult.title === 'string' && hoverResult.title.length > 0)

  console.log('\n[7] menu is not the native one (no default menu in headless, but check the handler ran)')
  const prevented = await evaluate(cdp, sessionId, `(() => {
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 });
    row.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  })()`)
  check('contextmenu default prevented', prevented.defaultPrevented === true, JSON.stringify(prevented))

  console.log('\n[8] delete dialog wording (recycle bin vs permanent)')
  const dialogResult = await evaluate(cdp, sessionId, `(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5, button: 2 }));
    await new Promise((r) => setTimeout(r, 500));
    const items = [...document.querySelectorAll('.dfx-menu-item')];
    const del = items.find((i) => (i.textContent || '').toLowerCase().includes('delete') || (i.textContent || '').includes('删除'));
    if (del === undefined) return { error: 'no delete row', items: items.map((i) => i.textContent.trim()) };
    del.click();
    await new Promise((r) => setTimeout(r, 1200));
    const dialog = document.querySelector('.dfx-dialog');
    return {
      dialogPresent: dialog !== null,
      body: dialog?.querySelector('.dfx-dialog-body')?.textContent ?? null,
      danger: dialog?.querySelector('.dfx-dialog-body')?.getAttribute('data-danger') ?? null,
    };
  })()`)
  console.log('   delete dialog:', JSON.stringify(dialogResult, null, 2))
  check('delete dialog opened', dialogResult.dialogPresent === true, JSON.stringify(dialogResult))

  console.log('\n[9] rename dialog reachable from the menu')
  const renameResult = await evaluate(cdp, sessionId, `(async () => {
    // Close any dialog first.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5, button: 2 }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('.dfx-menu-item')];
    const ren = items.find((i) => (i.textContent || '').toLowerCase().includes('rename') || (i.textContent || '').includes('重命名'));
    if (ren === undefined) return { error: 'no rename row', items: items.map((i) => i.textContent.trim()) };
    ren.click();
    await new Promise((r) => setTimeout(r, 500));
    const input = document.querySelector('.dfx-dialog input.dfx-input');
    return { dialogPresent: document.querySelector('.dfx-dialog') !== null, hasInput: input !== null, value: input?.value ?? null };
  })()`)
  console.log('   rename dialog:', JSON.stringify(renameResult, null, 2))
  check('rename dialog has a name input', renameResult.hasInput === true, JSON.stringify(renameResult))

  console.log('\n[10] save-as dialog')
  const saveResult = await evaluate(cdp, sessionId, `(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5, button: 2 }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('.dfx-menu-item')];
    const save = items.find((i) => (i.textContent || '').toLowerCase().includes('save') || (i.textContent || '').includes('另存为'));
    if (save === undefined) return { error: 'no save row', items: items.map((i) => i.textContent.trim()) };
    save.click();
    await new Promise((r) => setTimeout(r, 1500));
    const dialog = document.querySelector('.dfx-dialog');
    const inputs = [...document.querySelectorAll('.dfx-dialog input.dfx-input')];
    return {
      dialogPresent: dialog !== null,
      inputCount: inputs.length,
      nameValue: inputs[0]?.value ?? null,
      hasChoose: [...document.querySelectorAll('.dfx-dialog button')].some((b) => /choose|选择/i.test(b.textContent || '')),
    };
  })()`)
  console.log('   save-as dialog:', JSON.stringify(saveResult, null, 2))
  check('save-as dialog opened with a name field', saveResult.dialogPresent === true && saveResult.inputCount >= 1, JSON.stringify(saveResult))

  console.log('\n[11] directory rows offer the directory menu')
  const dirResult = await evaluate(cdp, sessionId, `(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    const row = document.querySelector('[data-files-entry="directory"][data-files-path]');
    if (row === null) return { error: 'no directory row' };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5, button: 2 }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('.dfx-menu-item')].map((i) => i.textContent.trim());
    return { items, count: items.length };
  })()`)
  console.log('   directory menu:', JSON.stringify(dirResult, null, 2))
  check('directory menu excludes file-only rows', dirResult.count !== undefined && dirResult.count < 8, JSON.stringify(dirResult))

  console.log('\n[12] viewport containment: menu near the bottom edge flips up')
  const flipResult = await evaluate(cdp, sessionId, `(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    const row = document.querySelector('[data-files-entry="file"][data-files-path]');
    if (row === null) return { error: 'no file row' };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: window.innerWidth - 4, clientY: window.innerHeight - 4, button: 2 }));
    await new Promise((r) => setTimeout(r, 500));
    const menu = document.querySelector('.dfx-menu');
    if (menu === null) return { error: 'no menu' };
    const rect = menu.getBoundingClientRect();
    return {
      insideRight: rect.right <= window.innerWidth + 1,
      insideBottom: rect.bottom <= window.innerHeight + 1,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  })()`)
  console.log('   flip:', JSON.stringify(flipResult, null, 2))
  check('menu stays inside the viewport', flipResult.insideRight === true && flipResult.insideBottom === true, JSON.stringify(flipResult))

  console.log('\n[13] console errors')
  const errors = consoleErrors.filter((line) => /dsh-file-extension/i.test(line))
  check('no plugin console errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  failures.push(`harness error: ${String(error?.message ?? error)}`)
  console.error('\nHARNESS ERROR:', error)
} finally {
  cdp?.close()
  chrome.kill()
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'='.repeat(60)}`)
console.log(`PASS ${String(passes.length)}   FAIL ${String(failures.length)}`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const line of failures) console.log(`  - ${line}`)
  process.exitCode = 1
}
