window.__ModuleLoader__.load({
  id: "dsh-file-extension",
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    (function (module, exports, require) {
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  fileAddress: () => fileAddress,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react4 = require("react");

// src/client/api.js
var BASE = "/api/dsh-file-extension/";
async function post(method, body, signal) {
  try {
    const response = await fetch(`${BASE}${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal
    });
    return await readResult(response);
  } catch (error) {
    return transportFailure(error);
  }
}
async function get(method, signal) {
  try {
    const response = await fetch(`${BASE}${method}`, {
      method: "GET",
      credentials: "same-origin",
      signal
    });
    return await readResult(response);
  } catch (error) {
    return transportFailure(error);
  }
}
async function readResult(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (payload !== null && typeof payload === "object" && payload.ok === true) {
    return { ok: true, value: payload.value ?? {} };
  }
  if (payload !== null && typeof payload === "object" && payload.ok === false) {
    return {
      ok: false,
      code: String(payload.code ?? "file-extension/operation-failed"),
      message: String(payload.message ?? `HTTP ${String(response.status)}`),
      details: payload.details ?? {}
    };
  }
  return {
    ok: false,
    code: "file-extension/operation-failed",
    message: response.status === 401 || response.status === 403 ? "the request was not authorized" : `HTTP ${String(response.status)}`,
    details: {}
  };
}
function transportFailure(error) {
  if (error?.name === "AbortError") {
    return { ok: false, code: "file-extension/cancelled", message: "the request was cancelled", details: {} };
  }
  return {
    ok: false,
    code: "file-extension/operation-failed",
    message: String(error?.message ?? error),
    details: {}
  };
}
var cachedCapabilities;
function hostCapabilities() {
  if (cachedCapabilities !== void 0) return cachedCapabilities;
  cachedCapabilities = get("capabilities").then((result) => {
    if (!result.ok) {
      cachedCapabilities = void 0;
      return null;
    }
    return result.value;
  });
  return cachedCapabilities;
}
function invalidateCapabilities() {
  cachedCapabilities = void 0;
}
var api = {
  /** Metadata for one path. */
  stat: (path, sessionId) => post("stat", { path, sessionId }),
  /** Rename one entry in place. */
  rename: (path, name, sessionId) => post("rename", { path, name, sessionId }),
  /** Trash or permanently delete one entry. */
  remove: (path, mode, sessionId) => post("remove", { path, options: { mode }, sessionId }),
  /** Write a "Save as" copy. */
  copy: (path, options, sessionId) => post("copy", { path, options, sessionId }),
  /** Read a file for the browser-download fallback. */
  download: (path, sessionId) => post("download", { path, sessionId })
};

// src/client/controller.js
var ROW_SELECTOR = "[data-files-entry][data-files-path]";
function rowOf(target) {
  if (!(target instanceof Element)) return null;
  const row = target.closest(ROW_SELECTOR);
  return row instanceof HTMLElement ? row : null;
}
function entryOf(row) {
  const path = row.dataset.filesPath;
  if (typeof path !== "string" || path === "") return null;
  const kind = row.dataset.filesEntry;
  if (kind !== "file" && kind !== "directory" && kind !== "other") return null;
  return { path, kind, name: baseName(path), row };
}
function baseName(path) {
  const normalized = path.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return cut < 0 ? normalized : normalized.slice(cut + 1);
}
function relativeTo(path, root) {
  if (typeof root !== "string" || root === "") return path;
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) return "";
  const prefix = `${normalizedRoot}/`;
  if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length);
  return normalizedPath;
}
function mentionFor(path) {
  return /[\s"]/u.test(path) ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`;
}
function attachRowObservers(handlers) {
  let hovered = null;
  const onMouseOver = (event) => {
    const row = rowOf(event.target);
    const entry = row === null ? null : entryOf(row);
    const key = entry === null ? null : entry.path;
    const previousKey = hovered === null ? null : hovered.path;
    if (key === previousKey) return;
    hovered = entry;
    handlers.onHoverChange(entry);
  };
  const onMouseOut = (event) => {
    const row = rowOf(event.target);
    if (row === null || hovered === null) return;
    const next = event.relatedTarget;
    if (next instanceof Node && row.contains(next)) return;
    hovered = null;
    handlers.onHoverChange(null);
  };
  const onContextMenu = (event) => {
    const row = rowOf(event.target);
    if (row === null) return;
    const entry = entryOf(row);
    if (entry === null) return;
    event.preventDefault();
    event.stopPropagation();
    handlers.onContextMenu(entry, event);
  };
  const onScroll = () => {
    handlers.onTreeMutated();
  };
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("scroll", onScroll, true);
  const observer = new MutationObserver(() => {
    handlers.onTreeMutated();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-files-path"] });
  return () => {
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("scroll", onScroll, true);
    observer.disconnect();
  };
}
function findRow(path) {
  for (const candidate of document.querySelectorAll(ROW_SELECTOR)) {
    if (candidate instanceof HTMLElement && candidate.dataset.filesPath === path) return candidate;
  }
  return null;
}

// src/client/store.js
function createStore(initial) {
  let state = initial;
  const listeners = /* @__PURE__ */ new Set();
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch };
      let changed = false;
      for (const key of Object.keys(patch)) {
        if (!Object.is(state[key], next[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "\u2014";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

// src/client/actions.js
var TOAST_MS = 2600;
function createController(deps) {
  const { t } = deps;
  const store = createStore({
    /** The open context menu, or null. */
    menu: null,
    /** The hovered row entry, or null. */
    hover: null,
    /** The active dialog descriptor, or null. */
    dialog: null,
    /** The entry being renamed inline, or null. */
    renaming: null,
    /** A rename validation message shown under the inline editor. */
    renameError: null,
    /** Visible toasts. */
    toasts: [],
    /** True while a Host request is in flight. */
    busy: false,
    /** Bumped whenever the tree mutates, so overlays re-measure. */
    revision: 0,
    /** Host capabilities, once read. */
    capabilities: null
  });
  let toastSeq = 0;
  const timers = /* @__PURE__ */ new Set();
  const toast = (text, level = "info") => {
    toastSeq += 1;
    const id = toastSeq;
    const next = [...store.get().toasts, { id, text, level }];
    store.set({ toasts: next });
    const timer = setTimeout(() => {
      timers.delete(timer);
      store.set({ toasts: store.get().toasts.filter((entry) => entry.id !== id) });
    }, TOAST_MS);
    timers.add(timer);
  };
  const dispose = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const describeFailure = (failure) => {
    const code = String(failure.code ?? "");
    const reason = failure.details?.reason;
    if (code.endsWith("/invalid-name") && typeof reason === "string") {
      return t(`error.${reason}`);
    }
    if (code.endsWith("/already-exists")) return t("error.alreadyExists");
    if (code.endsWith("/not-found")) return t("error.notFound");
    if (code.endsWith("/not-regular-file")) return t("error.notRegularFile");
    if (code.endsWith("/not-directory")) return t("error.notDirectory");
    if (code.endsWith("/outside-workspace")) return t("error.outsideWorkspace");
    if (code.endsWith("/too-large")) return t("error.tooLarge");
    if (code.endsWith("/unsupported")) return t("error.unsupported");
    if (/permission|denied/i.test(String(failure.message))) return t("error.permission");
    return t("error.operationFailed", { message: failure.message });
  };
  const ensureCapabilities = async () => {
    const known = store.get().capabilities;
    if (known !== null) return known;
    const value = await hostCapabilities();
    if (value !== null) store.set({ capabilities: value });
    return value;
  };
  const canAddToChat = () => deps.composer() !== void 0;
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  };
  const addToChat = (entry) => {
    const composer = deps.composer();
    if (composer === void 0) {
      toast(t("menu.addToChat.disabled"), "error");
      return false;
    }
    const relative = relativeTo(entry.path, deps.workspaceRoot());
    const mention = mentionFor(relative);
    const span = composer.captureInsertion();
    const draft = composer.state?.getSnapshot?.()?.draft;
    const needsSpace = typeof draft === "string" && draft.length > 0 && !/[\s]$/u.test(draft.slice(0, span?.offset ?? draft.length));
    const ok = composer.insertText(`${needsSpace ? " " : ""}${mention}`, span);
    if (!ok) {
      toast(t("toast.addedToChatFailed"), "error");
      return false;
    }
    toast(t("toast.addedToChat"), "success");
    return true;
  };
  const openInTab = (entry) => {
    try {
      deps.openResource(entry.path);
    } catch (error) {
      toast(t("toast.openFailed"), "error");
      console.error("[dsh-file-extension] open in tab failed:", error);
    }
  };
  const reveal = async (entry) => {
    try {
      const ok = await deps.reveal(entry.path);
      if (!ok) toast(t("toast.revealFailed"), "error");
    } catch (error) {
      toast(t("toast.revealFailed"), "error");
      console.error("[dsh-file-extension] reveal failed:", error);
    }
  };
  const runMenuAction = async (action) => {
    const menu = store.get().menu;
    store.set({ menu: null });
    if (menu === null) return;
    const entry = { path: menu.path, name: menu.name, kind: menu.kind };
    switch (action) {
      case "reveal":
        await reveal(entry);
        return;
      case "addToChat":
        addToChat(entry);
        return;
      case "openInTab":
        openInTab(entry);
        return;
      case "copyAbsolutePath": {
        const ok = await copyText(entry.path);
        toast(ok ? t("toast.pathCopied") : t("toast.copyFailed"), ok ? "success" : "error");
        return;
      }
      case "copyRelativePath": {
        const relative = relativeTo(entry.path, deps.workspaceRoot());
        const ok = await copyText(relative);
        toast(ok ? t("toast.pathCopied") : t("toast.copyFailed"), ok ? "success" : "error");
        return;
      }
      case "rename":
        store.set({ dialog: { kind: "rename", entry }, renameError: null });
        return;
      case "delete":
        await openDeleteDialog(entry);
        return;
      case "saveAs":
        await openSaveAsDialog(entry);
        return;
      default:
        return;
    }
  };
  const openDeleteDialog = async (entry) => {
    const capabilities = await ensureCapabilities();
    const trashSupported = capabilities?.trash?.supported === true;
    store.set({
      dialog: {
        kind: "delete",
        entry,
        permanent: !trashSupported
      }
    });
  };
  const openSaveAsDialog = async (entry) => {
    const capabilities = await ensureCapabilities();
    const info = await api.stat(entry.path, deps.sessionId());
    const bytes = info.ok ? Number(info.value.bytes ?? 0) : void 0;
    store.set({
      dialog: {
        kind: "saveAs",
        entry: { ...entry, bytes },
        canWrite: capabilities?.saveAs === "directory-picker"
      }
    });
  };
  const closeDialog = () => {
    store.set({ dialog: null, busy: false });
  };
  const confirmDelete = async (permanent) => {
    const dialog = store.get().dialog;
    if (dialog === null || dialog.kind !== "delete") return;
    store.set({ busy: true });
    const result = await api.remove(dialog.entry.path, permanent ? "permanent" : "trash", deps.sessionId());
    if (result.ok) {
      store.set({ dialog: null, busy: false });
      toast(permanent ? t("toast.deletePermanent") : t("toast.deleteTrashed"), "success");
      deps.closePreview(dialog.entry.path);
      return;
    }
    if (result.details?.trashUnavailable === true) {
      invalidateCapabilities();
      store.set({
        busy: false,
        capabilities: null,
        dialog: { kind: "delete", entry: dialog.entry, permanent: true }
      });
      return;
    }
    store.set({ busy: false });
    toast(describeFailure(result), "error");
  };
  const confirmRename = async (name) => {
    const dialog = store.get().dialog;
    if (dialog === null || dialog.kind !== "rename") return;
    store.set({ busy: true });
    const result = await api.rename(dialog.entry.path, name, deps.sessionId());
    if (result.ok) {
      store.set({ dialog: null, busy: false });
      toast(t("toast.renameSuccess", { name }), "success");
      deps.afterMutation();
      return;
    }
    store.set({ busy: false });
    toast(describeFailure(result), "error");
  };
  const startInlineRename = (entry) => {
    store.set({ renaming: { path: entry.path, name: entry.name, kind: entry.kind }, renameError: null });
  };
  const cancelInlineRename = () => {
    store.set({ renaming: null, renameError: null, busy: false });
  };
  const commitInlineRename = async (name) => {
    const renaming = store.get().renaming;
    if (renaming === null) return;
    store.set({ busy: true, renameError: null });
    const result = await api.rename(renaming.path, name, deps.sessionId());
    if (result.ok) {
      store.set({ renaming: null, busy: false });
      toast(t("toast.renameSuccess", { name }), "success");
      deps.afterMutation();
      return;
    }
    store.set({ busy: false, renameError: describeFailure(result) });
  };
  const pickDirectory = (suggestedName) => deps.pickDirectory(suggestedName);
  const confirmSaveAs = async (name, directory) => {
    const dialog = store.get().dialog;
    if (dialog === null || dialog.kind !== "saveAs") return;
    store.set({ busy: true });
    const canWrite = dialog.canWrite === true;
    if (!canWrite) {
      const result2 = await api.download(dialog.entry.path, deps.sessionId());
      store.set({ busy: false });
      if (!result2.ok) {
        toast(t("toast.saveAsFailed", { message: describeFailure(result2) }), "error");
        return;
      }
      deps.download(result2.value.name, result2.value.data);
      store.set({ dialog: null });
      toast(t("toast.savedAs", { path: result2.value.name }), "success");
      return;
    }
    const result = await api.copy(
      dialog.entry.path,
      { directory, name, overwrite: false },
      deps.sessionId()
    );
    if (result.ok) {
      store.set({ dialog: null, busy: false });
      toast(t("toast.savedAs", { path: result.value.path }), "success");
      deps.afterMutation();
      return;
    }
    if (result.details?.name !== void 0 || result.code.endsWith("/already-exists")) {
      store.set({ busy: false, dialog: { kind: "overwrite", name, directory, entry: dialog.entry } });
      return;
    }
    store.set({ busy: false });
    toast(t("toast.saveAsFailed", { message: describeFailure(result) }), "error");
  };
  const confirmOverwrite = async () => {
    const dialog = store.get().dialog;
    if (dialog === null || dialog.kind !== "overwrite") return;
    store.set({ busy: true });
    const result = await api.copy(
      dialog.entry.path,
      { directory: dialog.directory, name: dialog.name, overwrite: true },
      deps.sessionId()
    );
    store.set({ busy: false });
    if (result.ok) {
      store.set({ dialog: null });
      toast(t("toast.savedAs", { path: result.value.path }), "success");
      deps.afterMutation();
      return;
    }
    toast(t("toast.saveAsFailed", { message: describeFailure(result) }), "error");
  };
  const openMenu = (entry, event) => {
    store.set({
      menu: {
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        anchor: { x: event.clientX, y: event.clientY }
      }
    });
  };
  const attach = () => attachRowObservers({
    onContextMenu: (entry, event) => {
      void ensureCapabilities();
      openMenu(entry, event);
    },
    onHoverChange: (entry) => {
      const renaming = store.get().renaming;
      if (renaming !== null && entry !== null && renaming.path === entry.path) {
        store.set({ hover: null });
        return;
      }
      store.set({ hover: entry });
    },
    onRowRemoved: () => {
      store.set({ revision: store.get().revision + 1 });
    },
    onTreeMutated: () => {
      store.set({ revision: store.get().revision + 1 });
    }
  });
  return {
    store,
    t,
    attach,
    dispose,
    runMenuAction,
    addToChat,
    openMenu,
    canAddToChat,
    ensureCapabilities,
    closeDialog,
    confirmDelete,
    confirmRename,
    startInlineRename,
    cancelInlineRename,
    commitInlineRename,
    pickDirectory,
    confirmSaveAs,
    confirmOverwrite
  };
}

// src/client/locales.js
var NS = "dshFileExtension";
var en = {
  "menu.reveal": "Reveal in File Manager",
  "menu.reveal.disabled": "This host cannot open a system file manager",
  "menu.addToChat": "Add to Conversation",
  "menu.addToChat.disabled": "No conversation is open for this file",
  "menu.openInTab": "Open in New Tab",
  "menu.saveAs": "Save As\u2026",
  "menu.copyPath": "Copy Path",
  "menu.copyAbsolutePath": "Copy Absolute Path",
  "menu.copyRelativePath": "Copy Relative Path",
  "menu.rename": "Rename",
  "menu.delete": "Delete",
  "menu.deleteDirectory": "Delete Folder",
  "toast.pathCopied": "Path copied",
  "toast.addedToChat": "Added to the conversation",
  "toast.addedToChatFailed": "The draft changed while inserting; please retry",
  "toast.renameSuccess": "Renamed to \u201C{name}\u201D",
  "toast.deleteTrashed": "Moved to the recycle bin",
  "toast.deletePermanent": "Deleted permanently",
  "toast.savedAs": "Saved a copy to {path}",
  "toast.saveAsFailed": "Save as failed: {message}",
  "toast.openFailed": "Could not open the file",
  "toast.revealFailed": "Could not reveal the file",
  "toast.copyFailed": "Could not copy to the clipboard",
  "toast.unavailable": "Not available on this host: {message}",
  "dialog.delete.title": "Delete \u201C{name}\u201D?",
  "dialog.delete.body": "The file will be moved to the recycle bin and can be restored from there.",
  "dialog.delete.bodyDirectory": "The folder and everything inside it will be moved to the recycle bin and can be restored from there.",
  "dialog.delete.bodyPermanent": "This action permanently deletes the file and cannot be undone.",
  "dialog.delete.bodyPermanentDirectory": "This action permanently deletes the folder and everything inside it, and cannot be undone.",
  "dialog.delete.confirm": "Delete",
  "dialog.delete.confirmPermanent": "Delete Permanently",
  "dialog.rename.title": "Rename",
  "dialog.rename.label": "New name",
  "dialog.rename.confirm": "Rename",
  "dialog.saveAs.title": "Save a Copy",
  "dialog.saveAs.name": "File name",
  "dialog.saveAs.directory": "Destination folder",
  "dialog.saveAs.choose": "Choose\u2026",
  "dialog.saveAs.confirm": "Save",
  "dialog.saveAs.download": "Download",
  "dialog.saveAs.overwrite": "\u201C{name}\u201D already exists in that folder. Replace it?",
  "dialog.saveAs.tooLarge": "The file is {size}; it may take a while to download.",
  "dialog.saveAs.downloadHint": "This host cannot write to disk from the browser, so the file is downloaded instead.",
  "dialog.cancel": "Cancel",
  "error.empty": "The name cannot be empty",
  "error.invalidCharacters": "The name contains characters that are not allowed",
  "error.tooLong": "The name is too long",
  "error.trailingDotOrSpace": "The name cannot end with a dot or a space",
  "error.reservedName": "That name is reserved by the operating system",
  "error.alreadyExists": "An entry with that name already exists",
  "error.permission": "Permission denied by the operating system",
  "error.notFound": "The file no longer exists",
  "error.notRegularFile": "Only regular files support this action",
  "error.notDirectory": "The destination is not a folder",
  "error.outsideWorkspace": "The path is outside this session\u2019s workspace",
  "error.tooLarge": "The file is too large",
  "error.unsupported": "Not supported on this host",
  "error.operationFailed": "The operation failed: {message}",
  "aria.atButton": "Add to conversation",
  "aria.menu": "File actions"
};
var zh = {
  "menu.reveal": "\u5728\u6587\u4EF6\u8D44\u6E90\u7BA1\u7406\u5668\u4E2D\u663E\u793A",
  "menu.reveal.disabled": "\u5F53\u524D\u5BBF\u4E3B\u65E0\u6CD5\u6253\u5F00\u7CFB\u7EDF\u6587\u4EF6\u7BA1\u7406\u5668",
  "menu.addToChat": "\u6DFB\u52A0\u5230\u5BF9\u8BDD",
  "menu.addToChat.disabled": "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u7684\u4F1A\u8BDD",
  "menu.openInTab": "\u5728\u65B0\u6807\u7B7E\u9875\u4E2D\u6253\u5F00",
  "menu.saveAs": "\u53E6\u5B58\u4E3A\u2026",
  "menu.copyPath": "\u590D\u5236\u8DEF\u5F84",
  "menu.copyAbsolutePath": "\u590D\u5236\u7EDD\u5BF9\u8DEF\u5F84",
  "menu.copyRelativePath": "\u590D\u5236\u76F8\u5BF9\u8DEF\u5F84",
  "menu.rename": "\u91CD\u547D\u540D",
  "menu.delete": "\u5220\u9664",
  "menu.deleteDirectory": "\u5220\u9664\u6587\u4EF6\u5939",
  "toast.pathCopied": "\u8DEF\u5F84\u5DF2\u590D\u5236",
  "toast.addedToChat": "\u5DF2\u6DFB\u52A0\u5230\u5BF9\u8BDD",
  "toast.addedToChatFailed": "\u63D2\u5165\u65F6\u8349\u7A3F\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u8BD5",
  "toast.renameSuccess": "\u5DF2\u91CD\u547D\u540D\u4E3A\u300C{name}\u300D",
  "toast.deleteTrashed": "\u5DF2\u79FB\u52A8\u5230\u56DE\u6536\u7AD9",
  "toast.deletePermanent": "\u5DF2\u6C38\u4E45\u5220\u9664",
  "toast.savedAs": "\u526F\u672C\u5DF2\u4FDD\u5B58\u5230 {path}",
  "toast.saveAsFailed": "\u53E6\u5B58\u4E3A\u5931\u8D25\uFF1A{message}",
  "toast.openFailed": "\u65E0\u6CD5\u6253\u5F00\u8BE5\u6587\u4EF6",
  "toast.revealFailed": "\u65E0\u6CD5\u5728\u6587\u4EF6\u7BA1\u7406\u5668\u4E2D\u663E\u793A",
  "toast.copyFailed": "\u65E0\u6CD5\u590D\u5236\u5230\u526A\u8D34\u677F",
  "toast.unavailable": "\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\uFF1A{message}",
  "dialog.delete.title": "\u5220\u9664\u300C{name}\u300D\uFF1F",
  "dialog.delete.body": "\u8BE5\u6587\u4EF6\u5C06\u88AB\u79FB\u52A8\u5230\u56DE\u6536\u7AD9\uFF0C\u53EF\u4EE5\u4ECE\u56DE\u6536\u7AD9\u6062\u590D\u3002",
  "dialog.delete.bodyDirectory": "\u8BE5\u6587\u4EF6\u5939\u53CA\u5176\u5168\u90E8\u5185\u5BB9\u5C06\u88AB\u79FB\u52A8\u5230\u56DE\u6536\u7AD9\uFF0C\u53EF\u4EE5\u4ECE\u56DE\u6536\u7AD9\u6062\u590D\u3002",
  "dialog.delete.bodyPermanent": "\u8BE5\u64CD\u4F5C\u5C06\u6C38\u4E45\u5220\u9664\uFF0C\u4E0D\u53EF\u6062\u590D\u3002",
  "dialog.delete.bodyPermanentDirectory": "\u8BE5\u64CD\u4F5C\u5C06\u6C38\u4E45\u5220\u9664\u8BE5\u6587\u4EF6\u5939\u53CA\u5176\u5168\u90E8\u5185\u5BB9\uFF0C\u4E0D\u53EF\u6062\u590D\u3002",
  "dialog.delete.confirm": "\u5220\u9664",
  "dialog.delete.confirmPermanent": "\u6C38\u4E45\u5220\u9664",
  "dialog.rename.title": "\u91CD\u547D\u540D",
  "dialog.rename.label": "\u65B0\u540D\u79F0",
  "dialog.rename.confirm": "\u91CD\u547D\u540D",
  "dialog.saveAs.title": "\u53E6\u5B58\u4E3A\u526F\u672C",
  "dialog.saveAs.name": "\u6587\u4EF6\u540D",
  "dialog.saveAs.directory": "\u76EE\u6807\u6587\u4EF6\u5939",
  "dialog.saveAs.choose": "\u9009\u62E9\u2026",
  "dialog.saveAs.confirm": "\u4FDD\u5B58",
  "dialog.saveAs.download": "\u4E0B\u8F7D",
  "dialog.saveAs.overwrite": "\u8BE5\u6587\u4EF6\u5939\u4E2D\u5DF2\u5B58\u5728\u300C{name}\u300D\uFF0C\u662F\u5426\u8986\u76D6\uFF1F",
  "dialog.saveAs.tooLarge": "\u6587\u4EF6\u5927\u5C0F\u4E3A {size}\uFF0C\u4E0B\u8F7D\u53EF\u80FD\u9700\u8981\u4E00\u4E9B\u65F6\u95F4\u3002",
  "dialog.saveAs.downloadHint": "\u5F53\u524D\u5BBF\u4E3B\u65E0\u6CD5\u4ECE\u6D4F\u89C8\u5668\u5199\u76D8\uFF0C\u5C06\u6539\u4E3A\u6D4F\u89C8\u5668\u4E0B\u8F7D\u3002",
  "dialog.cancel": "\u53D6\u6D88",
  "error.empty": "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A",
  "error.invalidCharacters": "\u540D\u79F0\u5305\u542B\u4E0D\u5141\u8BB8\u7684\u5B57\u7B26",
  "error.tooLong": "\u540D\u79F0\u8FC7\u957F",
  "error.trailingDotOrSpace": "\u540D\u79F0\u4E0D\u80FD\u4EE5\u70B9\u6216\u7A7A\u683C\u7ED3\u5C3E",
  "error.reservedName": "\u8BE5\u540D\u79F0\u88AB\u64CD\u4F5C\u7CFB\u7EDF\u4FDD\u7559",
  "error.alreadyExists": "\u5DF2\u5B58\u5728\u540C\u540D\u6587\u4EF6",
  "error.permission": "\u64CD\u4F5C\u7CFB\u7EDF\u62D2\u7EDD\u4E86\u8BE5\u64CD\u4F5C\uFF08\u6743\u9650\u4E0D\u8DB3\uFF09",
  "error.notFound": "\u6587\u4EF6\u5DF2\u4E0D\u5B58\u5728",
  "error.notRegularFile": "\u4EC5\u666E\u901A\u6587\u4EF6\u652F\u6301\u8BE5\u64CD\u4F5C",
  "error.notDirectory": "\u76EE\u6807\u4E0D\u662F\u6587\u4EF6\u5939",
  "error.outsideWorkspace": "\u8DEF\u5F84\u8D85\u51FA\u4E86\u5F53\u524D\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u533A",
  "error.tooLarge": "\u6587\u4EF6\u8FC7\u5927",
  "error.unsupported": "\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\u8BE5\u64CD\u4F5C",
  "error.operationFailed": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}",
  "aria.atButton": "\u6DFB\u52A0\u5230\u5BF9\u8BDD",
  "aria.menu": "\u6587\u4EF6\u64CD\u4F5C"
};

// src/client/overlay.jsx
var import_react3 = require("react");
var import_jsx_runtime4 = require("react/jsx-runtime");

// src/client/menu.jsx
var import_react = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");

// src/client/icons.jsx
var import_jsx_runtime = require("react/jsx-runtime");
function Icon({ children, ...extra }) {
  return (0, import_jsx_runtime.jsx)("svg", {
    viewBox: "0 0 16 16",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...extra,
    children
  });
}
function IconReveal() {
  return Icon({
    children: [
      (0, import_jsx_runtime.jsx)("path", { key: "a", d: "M1.8 4.2a1 1 0 0 1 1-1h3.1l1.3 1.6h6a1 1 0 0 1 1 1v1.4" }),
      (0, import_jsx_runtime.jsx)("path", { key: "b", d: "M1.8 4.2v7.6a1 1 0 0 0 1 1h5" }),
      (0, import_jsx_runtime.jsx)("circle", { key: "c", cx: 11.1, cy: 10.6, r: 2.3 }),
      (0, import_jsx_runtime.jsx)("path", { key: "d", d: "m12.9 12.4 1.5 1.5" })
    ]
  });
}
function IconAt() {
  return Icon({
    children: [
      (0, import_jsx_runtime.jsx)("circle", { key: "a", cx: 8, cy: 8, r: 3 }),
      (0, import_jsx_runtime.jsx)("path", { key: "b", d: "M11 8v1.2a1.9 1.9 0 0 0 3.8 0V8a6.8 6.8 0 1 0-2.6 5.4" })
    ]
  });
}
function IconNewTab() {
  return Icon({
    children: [
      (0, import_jsx_runtime.jsx)("path", { key: "a", d: "M13.2 9v3.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1H7" }),
      (0, import_jsx_runtime.jsx)("path", { key: "b", d: "M9.6 2.2h4.2v4.2" }),
      (0, import_jsx_runtime.jsx)("path", { key: "c", d: "M13.4 2.6 7.6 8.4" })
    ]
  });
}
function IconSaveAs() {
  return Icon({
    children: [
      (0, import_jsx_runtime.jsx)("path", { key: "a", d: "M8 2.2v6.4" }),
      (0, import_jsx_runtime.jsx)("path", { key: "b", d: "m5.4 6.2 2.6 2.6 2.6-2.6" }),
      (0, import_jsx_runtime.jsx)("path", { key: "c", d: "M2.6 10.4v2a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4v-2" })
    ]
  });
}
function IconCopy() {
  return Icon({
    children: [
      (0, import_jsx_runtime.jsx)("rect", { key: "a", x: 5.6, y: 5.6, width: 8.2, height: 8.2, rx: 1.4 }),
      (0, import_jsx_runtime.jsx)("path", { key: "b", d: "M10.4 5.6V3.6a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4v5.4a1.4 1.4 0 0 0 1.4 1.4h2" })
    ]
  });
}
function IconRename() {
  return Icon({
    children: [
      (0, import_jsx_runtime.jsx)("path", { key: "a", d: "M10.9 2.5a1.6 1.6 0 0 1 2.3 2.3L5.7 12.3l-3 .8.8-3z" }),
      (0, import_jsx_runtime.jsx)("path", { key: "b", d: "m9.6 3.8 2.3 2.3" })
    ]
  });
}
function IconTrash() {
  return Icon({
    children: [
      (0, import_jsx_runtime.jsx)("path", { key: "a", d: "M2.6 4.2h10.8" }),
      (0, import_jsx_runtime.jsx)("path", { key: "b", d: "M6.2 4.2V2.9a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.3" }),
      (0, import_jsx_runtime.jsx)("path", { key: "c", d: "M3.9 4.2v8.5a1 1 0 0 0 1 1h6.2a1 1 0 0 0 1-1V4.2" }),
      (0, import_jsx_runtime.jsx)("path", { key: "d", d: "M6.6 7v4M9.4 7v4" })
    ]
  });
}
function IconFolder() {
  return Icon({
    children: (0, import_jsx_runtime.jsx)("path", {
      d: "M1.9 4.3a1 1 0 0 1 1-1h2.9l1.3 1.6h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z"
    })
  });
}

// src/client/menu.jsx
var VIEWPORT_MARGIN = 8;
function clampToViewport(anchor, size) {
  const maxLeft = window.innerWidth - size.width - VIEWPORT_MARGIN;
  const maxTop = window.innerHeight - size.height - VIEWPORT_MARGIN;
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(anchor.x, maxLeft)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.y, maxTop))
  };
}
function ContextMenu({ anchor, items, onActivate, onClose, t }) {
  const ref = (0, import_react.useRef)(null);
  const [position, setPosition] = (0, import_react.useState)({ left: anchor.x, top: anchor.y });
  const [activeIndex, setActiveIndex] = (0, import_react.useState)(-1);
  const navigable = items.map((item, index) => item.disabled === true || item.kind === "separator" ? -1 : index).filter((index) => index >= 0);
  (0, import_react.useLayoutEffect)(() => {
    const element = ref.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    setPosition(clampToViewport(anchor, { width: rect.width, height: rect.height }));
  }, [anchor]);
  (0, import_react.useEffect)(() => {
    const element = ref.current;
    element?.focus();
    const onPointerDown = (event) => {
      if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (navigable.length === 0) return;
        const current = navigable.indexOf(activeIndex);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = current < 0 ? step > 0 ? navigable[0] : navigable[navigable.length - 1] : navigable[(current + step + navigable.length) % navigable.length];
        setActiveIndex(next);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (navigable.length === 0) return;
        setActiveIndex(event.key === "Home" ? navigable[0] : navigable[navigable.length - 1]);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        if (activeIndex < 0) return;
        event.preventDefault();
        const item = items[activeIndex];
        if (item !== void 0 && item.disabled !== true) onActivate(item);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeIndex, items, navigable, onActivate, onClose]);
  const rows = items.map((item, index) => {
    if (item.kind === "separator") {
      return (0, import_jsx_runtime2.jsx)("div", { key: `sep-${String(index)}`, className: "dfx-menu-separator", role: "separator" });
    }
    const disabled = item.disabled === true;
    const Icon2 = item.icon;
    return (0, import_jsx_runtime2.jsx)("button", {
      key: item.id,
      type: "button",
      role: "menuitem",
      className: "dfx-menu-item",
      "data-active": activeIndex === index ? "true" : "false",
      "data-danger": item.danger === true ? "true" : void 0,
      "aria-disabled": disabled ? "true" : void 0,
      title: item.hint ?? void 0,
      onMouseEnter: () => setActiveIndex(disabled ? -1 : index),
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (disabled) return;
        onActivate(item);
      },
      children: [
        (0, import_jsx_runtime2.jsx)("span", { key: "icon", className: "dfx-menu-icon", children: (0, import_jsx_runtime2.jsx)(Icon2, {}) }),
        (0, import_jsx_runtime2.jsx)("span", { key: "label", className: "dfx-menu-label", children: item.label }),
        item.shortcut === void 0 ? null : (0, import_jsx_runtime2.jsx)("span", { key: "shortcut", className: "dfx-menu-shortcut", children: item.shortcut })
      ]
    });
  });
  return (0, import_jsx_runtime2.jsx)("div", {
    ref,
    className: "dfx-menu",
    role: "menu",
    tabIndex: -1,
    "aria-label": t("aria.menu"),
    style: { left: `${String(position.left)}px`, top: `${String(position.top)}px` },
    onContextMenu: (event) => event.preventDefault(),
    children: rows
  });
}
function menuItemsFor({ kind, canReveal, canAddToChat }) {
  const isDirectory = kind === "directory";
  const items = [
    {
      id: "reveal",
      icon: IconReveal,
      labelKey: "menu.reveal",
      hintKey: "menu.reveal.disabled",
      disabled: !canReveal,
      action: "reveal"
    }
  ];
  if (!isDirectory) {
    items.push({
      id: "addToChat",
      icon: IconAt,
      labelKey: "menu.addToChat",
      hintKey: "menu.addToChat.disabled",
      disabled: !canAddToChat,
      action: "addToChat"
    });
    items.push({
      id: "openInTab",
      icon: IconNewTab,
      labelKey: "menu.openInTab",
      action: "openInTab"
    });
    items.push({
      id: "saveAs",
      icon: IconSaveAs,
      labelKey: "menu.saveAs",
      action: "saveAs"
    });
  }
  items.push({ kind: "separator" });
  items.push({
    id: "copyAbsolutePath",
    icon: IconCopy,
    labelKey: "menu.copyAbsolutePath",
    action: "copyAbsolutePath"
  });
  items.push({
    id: "copyRelativePath",
    icon: IconCopy,
    labelKey: "menu.copyRelativePath",
    action: "copyRelativePath"
  });
  items.push({ kind: "separator" });
  items.push({
    id: "rename",
    icon: IconRename,
    labelKey: "menu.rename",
    action: "rename"
  });
  items.push({
    id: "delete",
    icon: isDirectory ? IconFolder : IconTrash,
    labelKey: isDirectory ? "menu.deleteDirectory" : "menu.delete",
    action: "delete",
    danger: true
  });
  return items;
}

// src/client/dialogs.jsx
var import_react2 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
function useDialogBehavior(ref, onCancel) {
  (0, import_react2.useEffect)(() => {
    const element = ref.current;
    if (element === null) return;
    const previouslyFocused = document.activeElement;
    const focusable = () => [...element.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )].filter((node) => node instanceof HTMLElement);
    const first = element.querySelector("input:not(:disabled)");
    if (first instanceof HTMLElement) {
      first.focus();
      if (first instanceof HTMLInputElement) first.select();
    } else {
      const candidates = focusable();
      const primary = element.querySelector('[data-primary="true"], [data-danger="true"]');
      const target = primary instanceof HTMLElement ? primary : candidates[0];
      target?.focus();
    }
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) return;
      const firstNode = candidates[0];
      const lastNode = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onCancel, ref]);
}
function Dialog({ title, children, actions, onCancel }) {
  const ref = (0, import_react2.useRef)(null);
  useDialogBehavior(ref, onCancel);
  return (0, import_jsx_runtime3.jsx)("div", {
    className: "dfx-dialog-backdrop",
    onPointerDown: (event) => {
      if (event.target === event.currentTarget) onCancel();
    },
    children: (0, import_jsx_runtime3.jsx)("div", {
      ref,
      className: "dfx-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title,
      onContextMenu: (event) => event.preventDefault(),
      children: [
        (0, import_jsx_runtime3.jsx)("h2", { key: "title", className: "dfx-dialog-title", children: title }),
        ...children,
        (0, import_jsx_runtime3.jsx)("div", { key: "actions", className: "dfx-dialog-actions", children: actions })
      ]
    })
  });
}
function DeleteDialog({ entry, permanent, busy, onConfirm, onCancel, t }) {
  const isDirectory = entry.kind === "directory";
  const bodyKey = permanent ? isDirectory ? "dialog.delete.bodyPermanentDirectory" : "dialog.delete.bodyPermanent" : isDirectory ? "dialog.delete.bodyDirectory" : "dialog.delete.body";
  return (0, import_jsx_runtime3.jsx)(Dialog, {
    title: t("dialog.delete.title", { name: entry.name }),
    onCancel,
    children: [
      (0, import_jsx_runtime3.jsx)("p", {
        key: "body",
        className: "dfx-dialog-body",
        "data-danger": permanent ? "true" : void 0,
        children: t(bodyKey)
      }),
      (0, import_jsx_runtime3.jsx)("code", { key: "path", className: "dfx-dialog-path", children: entry.path })
    ],
    actions: [
      (0, import_jsx_runtime3.jsx)("button", {
        key: "cancel",
        type: "button",
        className: "dfx-button",
        disabled: busy,
        onClick: onCancel,
        children: t("dialog.cancel")
      }),
      (0, import_jsx_runtime3.jsx)("button", {
        key: "confirm",
        type: "button",
        className: "dfx-button",
        "data-danger": "true",
        "data-primary": permanent ? void 0 : "true",
        disabled: busy,
        onClick: () => onConfirm(permanent),
        children: permanent ? t("dialog.delete.confirmPermanent") : t("dialog.delete.confirm")
      })
    ]
  });
}
function RenameDialog({ entry, busy, onConfirm, onCancel, t }) {
  const [value, setValue] = (0, import_react2.useState)(entry.name);
  const [error, setError] = (0, import_react2.useState)(null);
  const inputRef = (0, import_react2.useRef)(null);
  (0, import_react2.useEffect)(() => {
    const input = inputRef.current;
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    const dot = entry.name.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [entry.name]);
  const submit = (0, import_react2.useCallback)(() => {
    const name = value.trim();
    if (name === "") {
      setError(t("error.empty"));
      return;
    }
    if (name === entry.name) {
      onCancel();
      return;
    }
    setError(null);
    onConfirm(name);
  }, [entry.name, onCancel, onConfirm, t, value]);
  return (0, import_jsx_runtime3.jsx)(Dialog, {
    title: t("dialog.rename.title"),
    onCancel,
    children: [
      (0, import_jsx_runtime3.jsx)("div", {
        key: "field",
        className: "dfx-dialog-field",
        children: [
          (0, import_jsx_runtime3.jsx)("label", { key: "label", className: "dfx-dialog-label", children: t("dialog.rename.label") }),
          (0, import_jsx_runtime3.jsx)("input", {
            key: "input",
            ref: inputRef,
            className: "dfx-input",
            value,
            "data-invalid": error === null ? void 0 : "true",
            disabled: busy,
            onChange: (event) => {
              setValue(event.target.value);
              setError(null);
            },
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }
          })
        ]
      }),
      (0, import_jsx_runtime3.jsx)("div", { key: "hint", className: "dfx-dialog-hint", children: error ?? "" })
    ],
    actions: [
      (0, import_jsx_runtime3.jsx)("button", {
        key: "cancel",
        type: "button",
        className: "dfx-button",
        disabled: busy,
        onClick: onCancel,
        children: t("dialog.cancel")
      }),
      (0, import_jsx_runtime3.jsx)("button", {
        key: "confirm",
        type: "button",
        className: "dfx-button",
        "data-primary": "true",
        disabled: busy,
        onClick: submit,
        children: t("dialog.rename.confirm")
      })
    ]
  });
}
function SaveAsDialog({ entry, canWrite, busy, pickDirectory, onConfirm, onCancel, t }) {
  const [name, setName] = (0, import_react2.useState)(entry.name);
  const [directory, setDirectory] = (0, import_react2.useState)(null);
  const [error, setError] = (0, import_react2.useState)(null);
  const [picking, setPicking] = (0, import_react2.useState)(false);
  const choose = (0, import_react2.useCallback)(async () => {
    setPicking(true);
    try {
      const picked = await pickDirectory(entry.name);
      if (picked !== null) setDirectory(picked);
    } finally {
      setPicking(false);
    }
  }, [entry.name, pickDirectory]);
  const submit = (0, import_react2.useCallback)(() => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("error.empty"));
      return;
    }
    setError(null);
    onConfirm(trimmed, directory);
  }, [directory, name, onConfirm, t]);
  const oversized = typeof entry.bytes === "number" && entry.bytes > 32 * 1024 * 1024;
  return (0, import_jsx_runtime3.jsx)(Dialog, {
    title: t("dialog.saveAs.title"),
    onCancel,
    children: [
      (0, import_jsx_runtime3.jsx)("div", {
        key: "name",
        className: "dfx-dialog-field",
        children: [
          (0, import_jsx_runtime3.jsx)("label", { key: "label", className: "dfx-dialog-label", children: t("dialog.saveAs.name") }),
          (0, import_jsx_runtime3.jsx)("input", {
            key: "input",
            className: "dfx-input",
            value: name,
            "data-invalid": error === null ? void 0 : "true",
            disabled: busy,
            onChange: (event) => {
              setName(event.target.value);
              setError(null);
            },
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }
          })
        ]
      }),
      canWrite ? (0, import_jsx_runtime3.jsx)("div", {
        key: "directory",
        className: "dfx-dialog-field",
        children: [
          (0, import_jsx_runtime3.jsx)("label", { key: "label", className: "dfx-dialog-label", children: t("dialog.saveAs.directory") }),
          (0, import_jsx_runtime3.jsx)("div", {
            key: "row",
            className: "dfx-dialog-row",
            children: [
              (0, import_jsx_runtime3.jsx)("input", {
                key: "input",
                className: "dfx-input",
                value: directory ?? "",
                readOnly: true,
                placeholder: t("dialog.saveAs.directory")
              }),
              (0, import_jsx_runtime3.jsx)("button", {
                key: "choose",
                type: "button",
                className: "dfx-button",
                disabled: busy || picking,
                onClick: choose,
                children: t("dialog.saveAs.choose")
              })
            ]
          })
        ]
      }) : (0, import_jsx_runtime3.jsx)("p", {
        key: "hint",
        className: "dfx-dialog-body",
        children: t("dialog.saveAs.downloadHint")
      }),
      oversized ? (0, import_jsx_runtime3.jsx)("p", {
        key: "size",
        className: "dfx-dialog-body",
        children: t("dialog.saveAs.tooLarge", { size: formatBytes(entry.bytes) })
      }) : null,
      (0, import_jsx_runtime3.jsx)("div", { key: "error", className: "dfx-dialog-hint", children: error ?? "" })
    ],
    actions: [
      (0, import_jsx_runtime3.jsx)("button", {
        key: "cancel",
        type: "button",
        className: "dfx-button",
        disabled: busy,
        onClick: onCancel,
        children: t("dialog.cancel")
      }),
      (0, import_jsx_runtime3.jsx)("button", {
        key: "confirm",
        type: "button",
        className: "dfx-button",
        "data-primary": "true",
        disabled: busy || canWrite && directory === null,
        onClick: submit,
        children: canWrite ? t("dialog.saveAs.confirm") : t("dialog.saveAs.download")
      })
    ]
  });
}
function OverwriteDialog({ name, busy, onConfirm, onCancel, t }) {
  return (0, import_jsx_runtime3.jsx)(Dialog, {
    title: t("dialog.saveAs.title"),
    onCancel,
    children: (0, import_jsx_runtime3.jsx)("p", {
      key: "body",
      className: "dfx-dialog-body",
      "data-danger": "true",
      children: t("dialog.saveAs.overwrite", { name })
    }),
    actions: [
      (0, import_jsx_runtime3.jsx)("button", {
        key: "cancel",
        type: "button",
        className: "dfx-button",
        disabled: busy,
        onClick: onCancel,
        children: t("dialog.cancel")
      }),
      (0, import_jsx_runtime3.jsx)("button", {
        key: "confirm",
        type: "button",
        className: "dfx-button",
        "data-danger": "true",
        disabled: busy,
        onClick: onConfirm,
        children: t("dialog.saveAs.confirm")
      })
    ]
  });
}

// src/client/overlay.jsx
function useRowBox(path, revision) {
  const [box, setBox] = (0, import_react3.useState)(null);
  (0, import_react3.useLayoutEffect)(() => {
    if (path === null) {
      setBox(null);
      return;
    }
    const measure = () => {
      const row = findRow(path);
      if (row === null) {
        setBox(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      setBox((previous) => {
        if (previous !== null && previous.left === rect.left && previous.top === rect.top && previous.width === rect.width && previous.height === rect.height) {
          return previous;
        }
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [path, revision]);
  return box;
}
function HoverAtButton({ entry, revision, onClick, t }) {
  const box = useRowBox(entry === null ? null : entry.path, revision);
  if (entry === null || box === null) return null;
  return (0, import_jsx_runtime4.jsx)("button", {
    type: "button",
    className: "dfx-row-at",
    "data-visible": "true",
    title: t("aria.atButton"),
    "aria-label": t("aria.atButton"),
    style: {
      left: `${String(box.left + box.width - 28)}px`,
      top: `${String(box.top + box.height / 2 - 11)}px`
    },
    onPointerDown: (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(entry);
    },
    children: (0, import_jsx_runtime4.jsx)(IconAt, {})
  });
}
function InlineRename({ entry, revision, busy, onCommit, onCancel, error, t }) {
  const box = useRowBox(entry.path, revision);
  const [value, setValue] = (0, import_react3.useState)(entry.name);
  const inputRef = (0, import_react3.useRef)(null);
  (0, import_react3.useEffect)(() => {
    setValue(entry.name);
  }, [entry.name, entry.path]);
  (0, import_react3.useEffect)(() => {
    const input = inputRef.current;
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    const dot = entry.name.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [entry.name]);
  if (box === null) {
    onCancel();
    return null;
  }
  return (0, import_jsx_runtime4.jsx)("input", {
    ref: inputRef,
    className: "dfx-rename-input",
    value,
    disabled: busy,
    "aria-label": t("dialog.rename.label"),
    "data-invalid": error === null ? void 0 : "true",
    style: {
      left: `${String(box.left + 6)}px`,
      top: `${String(box.top + 1)}px`,
      width: `${String(Math.max(120, box.width - 12))}px`,
      height: `${String(Math.max(20, box.height - 2))}px`
    },
    onChange: (event) => setValue(event.target.value),
    onBlur: () => {
      if (!busy) onCancel();
    },
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const name = value.trim();
        if (name === "" || name === entry.name) {
          onCancel();
          return;
        }
        onCommit(name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    },
    onPointerDown: (event) => event.stopPropagation(),
    onClick: (event) => event.stopPropagation(),
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}
function ToastStack({ toasts }) {
  if (toasts.length === 0) return null;
  return (0, import_jsx_runtime4.jsx)("div", {
    className: "dfx-toast-stack",
    role: "status",
    "aria-live": "polite",
    children: toasts.map((toast) => (0, import_jsx_runtime4.jsx)("div", {
      key: toast.id,
      className: "dfx-toast",
      "data-level": toast.level,
      children: toast.text
    }))
  });
}
function Overlay({ controller }) {
  const state = (0, import_react3.useSyncExternalStore)(controller.store.subscribe, controller.store.get, controller.store.get);
  const t = controller.t;
  const items = state.menu === null ? [] : menuItemsFor({
    kind: state.menu.kind,
    canReveal: state.capabilities?.reveal !== false,
    canAddToChat: controller.canAddToChat()
  }).map((item) => item.kind === "separator" ? item : {
    ...item,
    label: t(item.labelKey),
    hint: item.hintKey === void 0 ? void 0 : t(item.hintKey)
  });
  const onActivate = (0, import_react3.useCallback)((item) => {
    controller.runMenuAction(item.action);
  }, [controller]);
  const onMenuClose = (0, import_react3.useCallback)(() => {
    controller.store.set({ menu: null });
  }, [controller]);
  return (0, import_jsx_runtime4.jsx)("div", {
    className: "dfx-root",
    children: [
      state.menu === null ? null : (0, import_jsx_runtime4.jsx)(ContextMenu, {
        key: "menu",
        anchor: state.menu.anchor,
        items,
        onActivate,
        onClose: onMenuClose,
        t
      }),
      state.dialog === null ? null : renderDialog(state, controller, t),
      (0, import_jsx_runtime4.jsx)(HoverAtButton, {
        key: "at",
        entry: state.hover,
        revision: state.revision,
        onClick: (entry) => controller.addToChat(entry),
        t
      }),
      state.renaming === null ? null : (0, import_jsx_runtime4.jsx)(InlineRename, {
        key: `rename-${state.renaming.path}`,
        entry: state.renaming,
        revision: state.revision,
        busy: state.busy,
        error: state.renameError,
        onCommit: (name) => controller.commitInlineRename(name),
        onCancel: () => controller.cancelInlineRename(),
        t
      }),
      (0, import_jsx_runtime4.jsx)(ToastStack, { key: "toasts", toasts: state.toasts })
    ]
  });
}
function renderDialog(state, controller, t) {
  const dialog = state.dialog;
  const entry = dialog.entry;
  if (dialog.kind === "delete") {
    return (0, import_jsx_runtime4.jsx)(DeleteDialog, {
      entry,
      permanent: dialog.permanent === true,
      busy: state.busy,
      onConfirm: (permanent) => controller.confirmDelete(permanent),
      onCancel: () => controller.closeDialog(),
      t
    });
  }
  if (dialog.kind === "rename") {
    return (0, import_jsx_runtime4.jsx)(RenameDialog, {
      entry,
      busy: state.busy,
      onConfirm: (name) => controller.confirmRename(name),
      onCancel: () => controller.closeDialog(),
      t
    });
  }
  if (dialog.kind === "saveAs") {
    return (0, import_jsx_runtime4.jsx)(SaveAsDialog, {
      entry,
      canWrite: dialog.canWrite === true,
      busy: state.busy,
      pickDirectory: (name) => controller.pickDirectory(name),
      onConfirm: (name, directory) => controller.confirmSaveAs(name, directory),
      onCancel: () => controller.closeDialog(),
      t
    });
  }
  if (dialog.kind === "overwrite") {
    return (0, import_jsx_runtime4.jsx)(OverwriteDialog, {
      name: dialog.name,
      busy: state.busy,
      onConfirm: () => controller.confirmOverwrite(),
      onCancel: () => controller.closeDialog(),
      t
    });
  }
  return null;
}

// src/client/styles.js
var CSS = `
.dfx-root {
  --dfx-radius: var(--dsw-radius-md, 8px);
  --dfx-radius-sm: var(--dsw-radius-sm, 6px);
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}

.dfx-menu {
  position: fixed;
  min-width: 208px;
  max-width: 320px;
  padding: 4px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dfx-radius);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.1);
  pointer-events: auto;
  outline: none;
}

.dfx-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--dfx-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}

.dfx-menu-item[data-active='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dfx-menu-item[aria-disabled='true'] {
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  cursor: default;
  opacity: 0.6;
}

.dfx-menu-item[aria-disabled='true'][data-active='true'] {
  background: none;
}

.dfx-menu-item[data-danger='true'] {
  color: var(--dsw-alias-state-error-primary);
}

.dfx-menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--dsw-alias-label-secondary);
}

.dfx-menu-item[data-danger='true'] .dfx-menu-icon {
  color: var(--dsw-alias-state-error-primary);
}

.dfx-menu-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dfx-menu-shortcut {
  flex: none;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size: 11px;
}

.dfx-menu-separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--dsw-alias-border-l1);
}

.dfx-dialog-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.32);
  pointer-events: auto;
}

.dfx-dialog {
  width: 100%;
  max-width: 420px;
  box-sizing: border-box;
  padding: 18px 20px 16px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 12px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
}

.dfx-dialog-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.dfx-dialog-body {
  margin: 0 0 16px;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
}

.dfx-dialog-body[data-danger='true'] {
  color: var(--dsw-alias-state-error-primary);
  font-weight: 500;
}

.dfx-dialog-path {
  display: block;
  margin-top: 6px;
  padding: 6px 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  border-radius: var(--dfx-radius-sm);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
  max-height: 96px;
  overflow: auto;
}

.dfx-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.dfx-dialog-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.dfx-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dfx-radius-sm);
  outline: none;
}

.dfx-input:focus {
  border-color: var(--dsw-alias-brand-primary);
}

.dfx-input[data-invalid='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}

.dfx-dialog-hint {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  min-height: 16px;
}

.dfx-dialog-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dfx-dialog-row .dfx-input {
  flex: 1;
}

.dfx-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.dfx-button {
  padding: 6px 14px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dfx-radius-sm);
  cursor: pointer;
}

.dfx-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dfx-button[data-primary='true'] {
  color: #fff;
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
}

.dfx-button[data-danger='true'] {
  color: #fff;
  background: var(--dsw-alias-state-error-primary);
  border-color: transparent;
}

.dfx-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.dfx-toast-stack {
  position: fixed;
  left: 50%;
  bottom: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateX(-50%);
  pointer-events: none;
}

.dfx-toast {
  max-width: 460px;
  padding: 8px 14px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 10px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2);
  pointer-events: auto;
  word-break: break-word;
}

.dfx-toast[data-level='error'] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

.dfx-toast[data-level='success'] {
  border-color: var(--dsw-alias-state-success-primary);
}

.dfx-row-at {
  position: absolute;
  top: 50%;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: -11px;
  padding: 0;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dfx-radius-sm);
  cursor: pointer;
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 90ms ease, transform 90ms ease;
  pointer-events: none;
  z-index: 2;
}

.dfx-row-at[data-visible='true'] {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

.dfx-row-at:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.dfx-rename-input {
  position: absolute;
  box-sizing: border-box;
  margin: 0;
  padding: 0 4px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-brand-primary);
  border-radius: var(--dfx-radius-sm);
  outline: none;
  z-index: 3;
}

.dfx-hidden-probe {
  display: none;
}
`;

// src/client/index.js
var inject = [
  "slots",
  "locale",
  "remote",
  "sessions",
  "sidebarRight"
];
var composers = /* @__PURE__ */ new Map();
function ComposerProbe(props) {
  const { sessionId, inputActions } = props;
  composers.set(String(sessionId), inputActions);
  return null;
}
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), "dsh-file-extension: dictionaries");
  const t = ctx.locale.bind(NS);
  const slots = ctx.get("slots");
  if (slots === void 0) return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-file-extension";
    tag.dataset.pluginCss = "dsh-file-extension/client.css";
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "dsh-file-extension: styles");
  const sessionId = () => {
    const mounted = ctx.get("sidebarRight")?.mounted?.getSnapshot?.();
    if (typeof mounted === "string" && mounted !== "") return mounted;
    const marker = document.querySelector("[data-sidebar-right-session]");
    const id = marker?.getAttribute("data-sidebar-right-session");
    return typeof id === "string" && id !== "" ? id : void 0;
  };
  const workspaceRoot = () => {
    const id = sessionId();
    if (id === void 0) return void 0;
    const sessions = ctx.get("sessions");
    const snapshot = sessions?.byId;
    return snapshot?.[id]?.cwd;
  };
  const composer = () => {
    const id = sessionId();
    if (id === void 0) return void 0;
    return composers.get(id);
  };
  const reveal = async (path) => {
    const session = ctx.get("remote")?.session;
    if (session?.openWorkspacePath === void 0) return false;
    const result = await session.openWorkspacePath({ path, action: "reveal" });
    return result?.ok === true;
  };
  const openResource = (path) => {
    const id = sessionId();
    const sidebar = ctx.get("sidebarRight");
    if (id === void 0 || sidebar === void 0) throw new Error("no sidebar to open into");
    const address = fileAddress(id, path, workspaceRoot());
    sidebar.openResource(address);
  };
  const closePreview = (path) => {
    const id = sessionId();
    const sidebar = ctx.get("sidebarRight");
    if (id === void 0 || sidebar === void 0) return;
    const address = fileAddress(id, path, workspaceRoot());
    try {
      const tabs = sidebar.tabsIn(id) ?? [];
      for (const tab of tabs) {
        if (tab?.contentId === address) sidebar.closeIn(id, tab.id);
      }
    } catch {
    }
  };
  const pickDirectory = async () => {
    try {
      const result = await ctx.get("remote")?.directoryPicker?.pick();
      if (result === void 0) return null;
      return result?.ok === true ? result.value ?? null : null;
    } catch {
      return null;
    }
  };
  const download = (name, base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e4);
  };
  const controller = createController({
    t,
    sessionId,
    workspaceRoot,
    composer,
    reveal,
    openResource,
    closePreview,
    pickDirectory,
    download,
    afterMutation: () => {
      const { store } = controller;
      store.set({ revision: store.get().revision + 1 });
    }
  });
  ctx.effect(() => controller.attach(), "dsh-file-extension: row listeners");
  slots.inject("shell.overlay", () => slots.register({
    name: "shell.overlay",
    id: "dsh-file-extension",
    order: 60,
    locale: NS
  }, () => (0, import_react4.createElement)(Overlay, { controller })));
  slots.inject("conversation.input.dock", () => slots.register({
    name: "conversation.input.dock",
    id: "dsh-file-extension-composer",
    order: 90,
    locale: NS
  }, ComposerProbe));
  ctx.effect(() => () => {
    controller.dispose();
    composers.clear();
  }, "dsh-file-extension: teardown");
}
function fileAddress(sessionId, path, root) {
  const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ":");
  let target = path.replace(/\\/g, "/");
  if (typeof root === "string" && root !== "") {
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (target === normalizedRoot) target = "";
    else if (target.startsWith(`${normalizedRoot}/`)) target = target.slice(normalizedRoot.length + 1);
  }
  target = target.replace(/^(?:\.\/)+/, "");
  const encoded = target.split("/").map(encodeSegment).join("/");
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`;
}

    })(module, exports, require);
    return module.exports;
  },
});
