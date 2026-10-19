# dsh-file-extension v0.1.0

Trae-style file actions for the **right Sidebar file tree** of the DeepSeek
Harness Web UI and desktop app.

## Features

- **Right-click menu** on any file or folder, drawn with the harness theme
  tokens, so it follows light and dark themes and never mixes with the native
  menu. Arrow-key navigation, `Esc` and outside-click dismissal, and automatic
  flipping at every viewport edge.
- **Reveal in File Manager** — selects the file in Finder / Explorer / the
  desktop file manager. Greyed out with a tooltip where the host cannot.
- **Add to Conversation** — inserts `@path` at the composer caret without
  replacing the draft. Quoted `@"path with spaces"` form when needed.
- **Open in New Tab** — opens the file in a new right-panel preview tab.
- **Save As** — writes a copy under a new name and folder, defaulting to
  `name-copy.ext` / `原名-副本.ext`. Never modifies the source; asks before
  overwriting.
- **Copy absolute / relative path**, each with a toast.
- **Rename** — inline editor with the file stem pre-selected; `Enter` commits,
  `Esc` cancels.
- **Delete into the recycle bin** — the confirmation says the file can be
  restored from the bin. Permanent deletion is used only when the host has no
  reachable recycle bin, and then the dialog switches to a red
  "cannot be undone" warning.
- **Hover `@` button** on every row, with a tooltip, without disturbing the file
  name's ellipsis.
- **Bilingual** English / 简体中文 copy following the harness locale.

## Install

```bash
dsh plugin --profile web add github:badwoo/dsh-file-extension
```

Restart the harness, then hard-refresh the browser.

Desktop: install from **Settings → Plugins → Add** in the app; the desktop
profile is owned by Electron and `dsh plugin --profile desktop` will refuse it.

## Compatibility

Verified on dsh `0.2.1-rc.2`, Windows 11: 17 browser checks and 25 filesystem
checks pass, including confirming a deleted file and folder really reached the
Windows recycle bin.

The plugin binds to the official tree's `data-files-entry` / `data-files-path`
attributes and the sidebar's `data-sidebar-right-session` marker — the only
coupling surface, documented in the README.

## Known limitations

- dsh exposes no row-level slot for the file tree, so the plugin uses DOM event
  delegation; a future rename of those attributes disables it silently rather
  than breaking the page.
- Save As uses the native directory picker plus the plugin's own name field,
  because dsh's desktop shell exposes no save-dialog channel.
- Deletion happens on the host machine, not the browser's machine.
- The browser-download fallback refuses files above 32 MiB by default.

## License

MIT
