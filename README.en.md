# dsh-file-extension (File Operations Extension)

[中文](README.md) | English

Trae-style file actions for the **right Sidebar file tree** of the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI and
desktop app: right-click any file for a themed context menu, hover any row for a
one-click **@** button, and delete into the operating system's recycle bin
instead of destroying files.

> **Status:** verified on dsh `0.2.1-rc.2` (Windows 11). See
> [Compatibility](#compatibility).

## What the menu looks like

```
┌───────────────────────────────────┐
│ 🔍  Reveal in File Manager        │
│ @   Add to Conversation           │
│ ↗   Open in New Tab               │
│ ⬇   Save As…                      │
│───────────────────────────────────│
│ ⧉   Copy Absolute Path            │
│ ⧉   Copy Relative Path            │
│───────────────────────────────────│
│ ✎   Rename                        │
│ 🗑  Delete                        │
└───────────────────────────────────┘
```

Drawn with the harness theme tokens, so it follows light and dark themes.
Directory rows show the same menu minus **Add to Conversation**, **Open in New
Tab**, and **Save As**.

---

## Table of contents

- [What it does](#what-it-does)
- [Install](#install)
- [Uninstall](#uninstall)
- [Compatibility](#compatibility)
- [Web vs. desktop behaviour](#web-vs-desktop-behaviour)
- [Known limitations](#known-limitations)
- [How it is wired](#how-it-is-wired)
- [Development](#development)
- [Verification checklist](#verification-checklist)
- [License](#license)

---

## What it does

### File context menu

Right-click any file in the right Sidebar's file tree. The plugin draws its own
menu — never the native one — using the harness theme tokens, so it matches the
active light or dark theme.

| Row | What it does |
|---|---|
| **Reveal in File Manager** | Selects the file in Finder / Explorer / the desktop file manager. Greyed out with a tooltip when the host cannot open one. |
| **Add to Conversation** | Inserts `@path` at the composer caret without replacing the existing draft. Paths with spaces use the quoted `@"path"` form. |
| **Open in New Tab** | Opens the file in a new right-panel preview tab. |
| **Save As…** | Writes a copy under a new name and folder. Defaults to `name-copy.ext` / `名称-副本.ext`. Never modifies the source. Asks before overwriting. |
| **Copy Absolute Path** | Copies the full path, with a toast. |
| **Copy Relative Path** | Copies the workspace-relative path, with a toast. |
| **Rename** | Inline editor over the row, with the file stem selected. `Enter` commits, `Esc` cancels, clicking away cancels. |
| **Delete** | **Moves the file to the operating system's recycle bin** and says so. Only falls back to permanent deletion — with a red warning — when the host has no reachable recycle bin. |

Menu behaviour: closes on outside click and on `Esc`, navigates with
`↑`/`↓`/`Home`/`End`, skips disabled rows, and flips itself back inside the
viewport at every edge.

### Hover `@` button

Hovering any file row reveals a small `@` button at its right edge, with an
"Add to conversation" tooltip. It is positioned over the row rather than
inserted into it, so long file names keep their ellipsis and the row does not
reflow. Clicking it is identical to the menu's **Add to Conversation**.

### Directory rows

Directories get **Reveal**, **Copy Absolute Path**, **Copy Relative Path**,
**Rename**, and **Delete Folder**. Deleting a folder says that the whole folder
is moved to the recycle bin and asks for confirmation first.

### Everything else

- Every mutation leaves the tree consistent: the file tree refreshes itself
  through its own directory watches, and deleting a file that is currently
  previewed closes that preview tab.
- All copy is bilingual (English / 简体中文) and follows the harness locale
  service.
- Unloading or hot-reloading the plugin removes its menu, button, dialogs,
  stylesheet, document listeners, `MutationObserver`, and slot registrations.

---

## Install

```bash
dsh plugin --profile web add github:badwoo/dsh-file-extension
```

Then restart the harness and hard-refresh the browser (`Ctrl+Shift+R`).

**Desktop app:** the desktop profile is managed by the Electron application and
`dsh plugin --profile desktop` refuses to touch it. Install through
**Settings → Plugins → Add** in the app, or add the package to the desktop
profile's `package.json` and `dsh.profile.bundles` and restart the app.

### From a local checkout

```bash
git clone https://github.com/badwoo/dsh-file-extension.git
cd dsh-file-extension
dsh plugin --profile web add "$(pwd)"
```

`lib/` is committed, so no build step is required to install.

---

## Uninstall

```bash
dsh plugin --profile web remove dsh-file-extension
```

Restart the harness and hard-refresh the browser. Nothing is left behind: no
routes, no stylesheet tag, no listeners. To confirm, check that
`document.querySelector('style[data-plugin="dsh-file-extension"]')` is `null` and
that `/api/dsh-file-extension/capabilities` returns `404`.

---

## Compatibility

| dsh version | Desktop (Electron) | Web | Notes |
|---|---|---|---|
| `0.2.1-rc.2` | ✅ verified | ✅ verified | Windows 11; 17 browser checks + 25 operation checks pass |
| other `0.2.x` | ⚠️ expected | ⚠️ expected | Depends on the `data-files-*` row attributes below |

The plugin reads three attributes from the official UI. If a future dsh release
renames them, the menu and hover button go quiet rather than erroring, and the
fix is a one-line change in `src/client/controller.js`:

| Attribute | Owner | Used for |
|---|---|---|
| `data-files-entry` | `dsh-client-ui-sidebar-files` | `file` / `directory` / `other` |
| `data-files-path` | `dsh-client-ui-sidebar-files` | the row's absolute path |
| `data-sidebar-right-session` | `dsh-client-ui-sidebar-right` | which Session the panel shows |

---

## Web vs. desktop behaviour

The plugin runs in the browser, but every filesystem operation runs on the
**host machine** through `/api/dsh-file-extension/*` routes. So "can it reveal /
save / trash" depends on the host, not on the browser.

| Feature | Desktop app | Web (host on the same machine) | Web (host elsewhere) |
|---|---|---|---|
| Reveal in File Manager | ✅ native | ✅ via the host's desktop opener | ❌ greyed out with a tooltip |
| Add to Conversation | ✅ | ✅ | ✅ |
| Open in New Tab | ✅ | ✅ | ✅ |
| Save As | ✅ native folder picker + Host write | ✅ native folder picker + Host write | ⬇️ falls back to a browser download (bounded at 32 MiB, with a size warning) |
| Copy paths | ✅ | ✅ | ✅ |
| Rename | ✅ Host filesystem | ✅ Host filesystem | ✅ Host filesystem |
| Delete | ♻️ recycle bin | ♻️ recycle bin | ♻️ depends on the host OS |

The **Save As** dialog is drawn by the plugin: both the file name and the
**destination folder** are editable fields, and the **Choose…** button calls the
host's own directory dialog (the native folder chooser on desktop). When that
dialog does not answer — it opened behind the window, or the host is a plain Web
deployment — the button immediately shows "Waiting for the host…" and explains
itself after 30 seconds; typing a folder path always works, and an empty folder
saves beside the original. Save As therefore stays usable even when the host
dialog is not.

### Recycle bin by platform

| Platform | Implementation | Verified |
|---|---|---|
| Windows | `Microsoft.VisualBasic.FileIO.FileSystem` with `SendToRecycleBin` via PowerShell | ✅ file and folder both confirmed present in `D:\$Recycle.Bin` |
| macOS | `trash` CLI when installed, else a Finder AppleScript | not tested on this machine |
| Linux | FreeDesktop Trash spec (`~/.local/share/Trash` with `.trashinfo`) | not tested on this machine |

When the recycle bin is genuinely unreachable, the plugin **does not silently
delete**. It re-opens the confirmation with the red warning
"This action permanently deletes the file and cannot be undone." and requires a
second explicit confirmation.

---

## Known limitations

1. **DOM coupling.** dsh has no row-level extension point for the file tree, so
   the plugin attaches to the row attributes listed under
   [Compatibility](#compatibility). This is the only coupling, and it is
   deliberately narrow.
2. **Inline rename is an overlay.** The editor is absolutely positioned over the
   row (the official row cannot host an injected component). It follows the row
   through scroll and refresh, and closes if the row disappears.
3. **Host-side recycle bin.** Deletion happens on the machine running the host
   process, not the machine running the browser.
4. **Browser download cap.** The download fallback refuses files above 32 MiB by
   default (`maxDownloadBytes` in the plugin config).
5. **`open-in-app` is required for reveal.** If a deployment omits the
   `session.openWorkspacePath` Remote, the reveal row stays disabled.
6. **Two files can race.** The Host refuses to overwrite an existing target, but
   a file created between the check and the write can still be replaced by the
   OS-level copy. This is the same window every save dialog has.

---

## How it is wired

### Bundle patch

`cordis.patch.yml` inserts one loader row:

```yaml
- insert:
    - id: dsh-file-extension
      name: dsh-file-extension
```

`package.json` points at it with `dsh.bundle.patch`, so
`dsh plugin add` installs the dependency **and** registers the row in one step.

### package.json fields that matter

| Field | Value | Why |
|---|---|---|
| `exports["."]` | `./lib/index.js` | the loader `import()`s the package root for the Host half |
| `exports["./client"]` | `./lib/client.js` | the browser module system serves this bundle |
| `dsh.bundle.patch` | `./cordis.patch.yml` | makes the package a bundle |
| `dsh.client.platform` | `web` | it is a browser plugin |
| `dsh.client.immediately` | `true` | load it at boot, not on first use |
| `dsh.client.inject` | slots, sidebar-right, conversation, locale, remotes, session-controller | activation ordering only |
| `files` | `lib/`, patch, locale, icon, README, LICENSE | keeps the published tarball small |
| `peerDependencies` | all `@deepseek-ai/*` and `react` | nothing is bundled twice |

### Loader registration location

The row lands in the profile's `cordis.patch.yml`-composed tree. Verify with:

```bash
dsh --profile web --dump-config | grep -A2 "dsh-file-extension"
```

### Runtime pieces

| Piece | Where | Lifetime |
|---|---|---|
| Host routes `/api/dsh-file-extension/*` | `ctx.webServer.register` inside `ctx.effect` | removed on unload |
| Context menu, dialogs, toasts | `shell.overlay` slot | removed on unload |
| Composer `inputActions` capture | `conversation.input.dock` slot | removed on unload |
| Row listeners + `MutationObserver` | `document`, inside `ctx.effect` | removed on unload |
| Stylesheet | one `<style data-plugin="dsh-file-extension">` | removed on unload |
| Locale dictionaries | `ctx.locale.register` | removed on unload |

Every route is authenticated with `ctx.connection.requestRejection`, so a plugin
route is exactly as protected as an official one — an unauthenticated request
gets `401`.

---

## Development

```bash
npm install          # esbuild only
node build.mjs       # src/ -> lib/
```

`src/host/` is a normal ES module. `src/client/` is bundled to CommonJS and
wrapped in `window.__ModuleLoader__.load({ id, factory })`, because the browser
module system only registers factories. `react` and the platform module table are
left external.

### Layout

```
src/host/
  index.js       apply(), Config, HTTP routes, auth
  contract.js    shared codes, name validation, copy-name helper
  fsops.js       stat / rename / remove / copy / download
  trash.js       per-platform recycle bin + permanent fallback
src/client/
  index.js       inject, apply, slot registration, service wiring
  actions.js     controller: store + Host calls + sidebar/composer actions
  controller.js  DOM binding: row discovery, event delegation, observers
  overlay.jsx    overlay root: hover button, inline rename, toast stack
  menu.jsx       context menu with keyboard navigation and edge flipping
  dialogs.jsx    delete / rename / save-as / overwrite dialogs
  icons.jsx      inline SVG icons
  locales.js     English + Chinese copy
  styles.js      theme-token CSS
```

### Tests

Both suites drive the real thing and need a running instance:

```bash
# Browser: loads the page, right-clicks a real row, drives every dialog.
$env:DSH_TEST_URL="http://127.0.0.1:PORT/?token=..."
$env:DSH_TEST_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
node tests/smoke.mjs

# Filesystem: renames, copies, and deletes real files, then confirms the
# deleted ones are actually in the OS recycle bin.
$env:DSH_TEST_BASE="http://127.0.0.1:PORT"
$env:DSH_TEST_TOKEN="..."
$env:DSH_TEST_WORKSPACE="D:\path\to\workspace"
$env:DSH_TEST_SESSION="session-..."
node tests/operations.mjs
```

---

## Verification checklist

After installing, restart `dsh web`, hard-refresh the browser, and walk this list.

**Open the tree:** right Sidebar → guide → **Workspace files**.

| # | Check | Expected |
|---|---|---|
| 1 | Right-click a file | The plugin's menu appears; no native menu |
| 2 | Menu appearance | Follows the theme; switch light/dark and re-open |
| 3 | `↑` / `↓` / `Home` / `End` | Highlight moves, skipping greyed rows |
| 4 | `Esc`, click outside | Menu closes |
| 5 | Right-click near the bottom-right corner | Menu flips to stay fully on screen |
| 6 | Reveal in File Manager | Explorer opens with the file selected |
| 7 | Add to Conversation | `@path` inserted at the caret; existing draft kept |
| 8 | Type text after the mention, add another | Both mentions coexist |
| 9 | Open in New Tab | File opens in a new right-panel tab |
| 10 | Save As | Name defaults to `name-副本.ext`; pick a folder; file appears there |
| 11 | Save As twice to the same name | Overwrite confirmation appears |
| 12 | Compare source and copy | Source byte-identical; only the copy is new |
| 13 | Copy Absolute / Relative Path | Toast appears; paste into the composer to confirm |
| 14 | Rename → `Enter` | Row shows the new name; stem was pre-selected |
| 15 | Rename → `Esc` | Name unchanged |
| 16 | Rename to an existing name | Error toast; original file untouched |
| 17 | Rename to `a<b>.txt` | "characters not allowed" error; nothing changed |
| 18 | Hover a file row | `@` button fades in at the right edge with a tooltip |
| 19 | Hover a long-named file | Name still ends in an ellipsis; row does not shift |
| 20 | Click the `@` button | Same as Add to Conversation |
| 21 | Delete a file | Dialog says it goes to the recycle bin |
| 22 | Confirm, then **open the OS recycle bin** | **The file is there** |
| 23 | Delete the file currently previewed | Its preview tab closes |
| 24 | Right-click a folder | Reveal / copy / rename / Delete Folder only |
| 25 | Delete a folder | Confirmation mentions the whole folder and the recycle bin |
| 26 | Switch locale to English | All menu and dialog text is English |
| 27 | Disable the plugin in Settings → Plugins | Menu, `@` button, and styles all disappear |
| 28 | Re-enable it | Everything comes back without a page reload |

**Residue check after uninstalling:**

```js
// In the browser console, after removing the plugin and refreshing:
document.querySelector('style[data-plugin="dsh-file-extension"]')  // null
document.querySelectorAll('.dfx-menu, .dfx-row-at, .dfx-dialog').length // 0
```

```bash
curl -i http://127.0.0.1:PORT/api/dsh-file-extension/capabilities   # 404
```

---

## License

[MIT](LICENSE)
