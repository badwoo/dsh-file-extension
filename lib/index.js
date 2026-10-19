// src/host/contract.js
var MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
var FAILURE_CODES = Object.freeze({
  notFound: "file-extension/not-found",
  notRegularFile: "file-extension/not-regular-file",
  notDirectory: "file-extension/not-directory",
  alreadyExists: "file-extension/already-exists",
  invalidName: "file-extension/invalid-name",
  outsideWorkspace: "file-extension/outside-workspace",
  tooLarge: "file-extension/too-large",
  unsupported: "file-extension/unsupported",
  operationFailed: "file-extension/operation-failed",
  cancelled: "file-extension/cancelled"
});
var INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
var RESERVED_NAMES = /* @__PURE__ */ new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);
function validateFileName(name2) {
  if (typeof name2 !== "string") return "invalid";
  const trimmed = name2.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") return "empty";
  if (INVALID_NAME_CHARS.test(trimmed)) return "invalidCharacters";
  if (trimmed.length > 255) return "tooLong";
  if (/[. ]$/.test(trimmed)) return "trailingDotOrSpace";
  const stem = trimmed.split(".")[0].toLowerCase();
  if (RESERVED_NAMES.has(stem)) return "reservedName";
  return null;
}

// src/host/fsops.js
import { access as access2, constants as constants2, copyFile, readFile, rename as rename2, stat as stat2 } from "node:fs/promises";
import { basename as basename2, dirname as dirname2, join as join2, resolve as resolve2, sep } from "node:path";

// src/host/trash.js
import { spawn } from "node:child_process";
import { access, constants, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
function run(command, args, timeoutMs = 15e3) {
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Launch the helper with a scrubbed environment: nothing from the
        // Harness credentials should reach an external process.
        env: scrubbedEnv()
      });
    } catch (error) {
      settle({ code: null, stdout: "", stderr: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 64 * 1024) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
function scrubbedEnv() {
  const keep = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "DISPLAY"
  ];
  const env = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== void 0) env[key] = value;
  }
  return env;
}
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function psQuote(value) {
  return value.replace(/'/g, "''");
}
async function trashWindows(path) {
  const isDirectory = (await stat(path)).isDirectory();
  const call = isDirectory ? "DeleteDirectory" : "DeleteFile";
  const script = [
    '$ErrorActionPreference = "Stop"',
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$target = '${psQuote(path)}'`,
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${call}($target, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`,
    'Write-Output "trashed"'
  ].join("; ");
  const result = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ]);
  if (result.code === 0 && await exists(path) === false) {
    return { trashed: true, strategy: "windows-recycle-bin" };
  }
  return {
    trashed: false,
    strategy: "windows-recycle-bin",
    reason: result.stderr.trim() || `exit ${String(result.code)}`
  };
}
async function trashMac(path) {
  const cli = await run("trash", [path]);
  if (cli.code === 0 && await exists(path) === false) {
    return { trashed: true, strategy: "macos-trash-cli" };
  }
  const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "Finder" to delete POSIX file "${escaped}"`;
  const finder = await run("osascript", ["-e", script]);
  if (finder.code === 0 && await exists(path) === false) {
    return { trashed: true, strategy: "macos-finder" };
  }
  return {
    trashed: false,
    strategy: "macos-finder",
    reason: (finder.stderr || cli.stderr).trim() || "Finder refused the item"
  };
}
async function trashLinux(path) {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const root = join(dataHome, "Trash");
  const filesDir = join(root, "files");
  const infoDir = join(root, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });
  const name2 = basename(path);
  let candidate = name2;
  let counter = 1;
  while (await exists(join(filesDir, candidate)) || await exists(join(infoDir, `${candidate}.trashinfo`))) {
    const dot = name2.lastIndexOf(".");
    candidate = dot > 0 ? `${name2.slice(0, dot)}.${counter}${name2.slice(dot)}` : `${name2}.${counter}`;
    counter += 1;
  }
  const destination = join(filesDir, candidate);
  try {
    await rename(path, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      return { trashed: false, strategy: "freedesktop-trash", reason: String(error?.message ?? error) };
    }
    try {
      const { cp, rm: remove } = await import("node:fs/promises");
      await cp(path, destination, { recursive: true });
      await remove(path, { recursive: true, force: true });
    } catch (copyError) {
      return { trashed: false, strategy: "freedesktop-trash", reason: String(copyError?.message ?? copyError) };
    }
  }
  const deletedAt = (/* @__PURE__ */ new Date()).toISOString();
  const record = [
    "[Trash Info]",
    `Path=${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    `DeletionDate=${deletedAt}`,
    ""
  ].join("\n");
  await writeFile(join(infoDir, `${candidate}.trashinfo`), record, "utf8");
  return { trashed: true, strategy: "freedesktop-trash" };
}
async function probeTrash() {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      const probe = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Add-Type -AssemblyName Microsoft.VisualBasic; Write-Output "ok"'
      ], 1e4);
      return probe.code === 0 && probe.stdout.includes("ok") ? { supported: true, strategy: "windows-recycle-bin" } : { supported: false, strategy: "windows-recycle-bin", reason: probe.stderr.trim() || "PowerShell helper unavailable" };
    }
    if (platform === "darwin") {
      const cli = await run("trash", ["--version"], 5e3);
      if (cli.code === 0) return { supported: true, strategy: "macos-trash-cli" };
      const finder = await run("osascript", ["-e", 'tell application "Finder" to get name'], 8e3);
      return finder.code === 0 ? { supported: true, strategy: "macos-finder" } : { supported: false, strategy: "macos-finder", reason: "Finder is not reachable from this host" };
    }
    if (platform === "linux") {
      const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
      await mkdir(join(dataHome, "Trash", "files"), { recursive: true });
      await mkdir(join(dataHome, "Trash", "info"), { recursive: true });
      return { supported: true, strategy: "freedesktop-trash" };
    }
    return { supported: false, strategy: "none", reason: `unsupported platform: ${platform}` };
  } catch (error) {
    return { supported: false, strategy: "none", reason: String(error?.message ?? error) };
  }
}
async function moveToTrash(path) {
  const absolute = resolve(path);
  try {
    if (process.platform === "win32") return await trashWindows(absolute);
    if (process.platform === "darwin") return await trashMac(absolute);
    if (process.platform === "linux") return await trashLinux(absolute);
    return { trashed: false, strategy: "none", reason: `unsupported platform: ${process.platform}` };
  } catch (error) {
    return {
      trashed: false,
      strategy: process.platform,
      reason: String(error?.message ?? error)
    };
  }
}
async function deletePermanently(path) {
  await rm(resolve(path), { recursive: true, force: true, maxRetries: 2 });
}

// src/host/fsops.js
function failure(code, message, details = {}) {
  return { ok: false, code, message, details };
}
function success(value = {}) {
  return { ok: true, value };
}
function isInside(root, candidate) {
  if (root === void 0 || root === null || root === "") return true;
  const normalizedRoot = resolve2(root);
  const normalizedCandidate = resolve2(candidate);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const left = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const right = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  if (left === right) return true;
  const prefix = left.endsWith(sep) ? left : `${left}${sep}`;
  return right.startsWith(prefix);
}
async function statPath(path, workspaceRoot) {
  if (typeof path !== "string" || path.trim() === "") {
    return failure(FAILURE_CODES.notFound, "a path is required");
  }
  const absolute = resolve2(path);
  if (!isInside(workspaceRoot, absolute)) {
    return failure(FAILURE_CODES.outsideWorkspace, "the path is outside the session workspace");
  }
  try {
    const info = await stat2(absolute);
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
    return success({
      path: absolute,
      name: basename2(absolute),
      parent: dirname2(absolute),
      kind,
      bytes: info.size,
      mtime: info.mtimeMs
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return failure(FAILURE_CODES.notFound, "the file no longer exists", { path: absolute });
    }
    return failure(FAILURE_CODES.operationFailed, String(error?.message ?? error), { path: absolute });
  }
}
async function renamePath(path, name2, workspaceRoot) {
  const current = await statPath(path, workspaceRoot);
  if (!current.ok) return current;
  const problem = validateFileName(name2);
  if (problem !== null) {
    return failure(FAILURE_CODES.invalidName, `the name is not usable: ${problem}`, { reason: problem });
  }
  const target = join2(dirname2(current.value.path), name2.trim());
  if (target === current.value.path) {
    return success({ path: target, name: basename2(target), unchanged: true });
  }
  if (!isInside(workspaceRoot, target)) {
    return failure(FAILURE_CODES.outsideWorkspace, "the target is outside the session workspace");
  }
  try {
    await access2(target, constants2.F_OK);
    return failure(FAILURE_CODES.alreadyExists, "an entry with that name already exists", {
      name: name2,
      path: target
    });
  } catch {
  }
  try {
    await rename2(current.value.path, target);
    return success({ path: target, name: basename2(target), previousPath: current.value.path });
  } catch (error) {
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), {
      path: current.value.path,
      name: name2
    });
  }
}
async function removePath(path, options = {}, workspaceRoot) {
  const current = await statPath(path, workspaceRoot);
  if (!current.ok) return current;
  const mode = options?.mode === "permanent" ? "permanent" : "trash";
  if (mode === "permanent") {
    try {
      await deletePermanently(current.value.path);
      return success({ path: current.value.path, kind: current.value.kind, mode: "permanent" });
    } catch (error) {
      return failure(FAILURE_CODES.operationFailed, describeFsError(error), {
        path: current.value.path
      });
    }
  }
  const trashed = await moveToTrash(current.value.path);
  if (trashed.trashed) {
    return success({
      path: current.value.path,
      kind: current.value.kind,
      mode: "trash",
      strategy: trashed.strategy
    });
  }
  return failure(
    FAILURE_CODES.unsupported,
    trashed.reason ?? "the operating system recycle bin is not reachable from this host",
    { path: current.value.path, kind: current.value.kind, strategy: trashed.strategy, trashUnavailable: true }
  );
}
async function copyToPath(sourcePath, options = {}, workspaceRoot) {
  const current = await statPath(sourcePath, workspaceRoot);
  if (!current.ok) return current;
  if (current.value.kind !== "file") {
    return failure(FAILURE_CODES.notRegularFile, "only regular files can be saved as a copy", {
      kind: current.value.kind
    });
  }
  const directory = typeof options?.directory === "string" && options.directory.trim() !== "" ? resolve2(options.directory) : current.value.parent;
  const name2 = typeof options?.name === "string" && options.name.trim() !== "" ? options.name.trim() : basename2(current.value.path);
  const problem = validateFileName(name2);
  if (problem !== null) {
    return failure(FAILURE_CODES.invalidName, `the name is not usable: ${problem}`, { reason: problem });
  }
  try {
    const info = await stat2(directory);
    if (!info.isDirectory()) {
      return failure(FAILURE_CODES.notDirectory, "the destination is not a directory", { directory });
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return failure(FAILURE_CODES.notFound, "the destination directory does not exist", { directory });
    }
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { directory });
  }
  const target = join2(directory, name2);
  if (resolve2(target) === current.value.path) {
    return failure(FAILURE_CODES.alreadyExists, "the destination is the source file", { path: target });
  }
  let exists2 = false;
  try {
    await access2(target, constants2.F_OK);
    exists2 = true;
  } catch {
  }
  if (exists2 && options?.overwrite !== true) {
    return failure(FAILURE_CODES.alreadyExists, "a file with that name already exists", {
      path: target,
      name: name2,
      directory
    });
  }
  try {
    await copyFile(current.value.path, target);
    const written = await stat2(target);
    return success({
      path: target,
      name: name2,
      directory,
      bytes: written.size,
      source: current.value.path,
      overwritten: exists2
    });
  } catch (error) {
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { path: target });
  }
}
async function readForDownload(path, options = {}, workspaceRoot) {
  const current = await statPath(path, workspaceRoot);
  if (!current.ok) return current;
  if (current.value.kind !== "file") {
    return failure(FAILURE_CODES.notRegularFile, "only regular files can be downloaded", {
      kind: current.value.kind
    });
  }
  const maxBytes = Number.isFinite(options?.maxBytes) ? Number(options.maxBytes) : 32 * 1024 * 1024;
  if (current.value.bytes > maxBytes) {
    return failure(FAILURE_CODES.tooLarge, "the file is too large for a browser download", {
      bytes: current.value.bytes,
      limit: maxBytes
    });
  }
  try {
    const bytes = await readFile(current.value.path);
    return success({
      path: current.value.path,
      name: current.value.name,
      bytes: bytes.byteLength,
      data: bytes.toString("base64")
    });
  } catch (error) {
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), {
      path: current.value.path
    });
  }
}
function describeFsError(error) {
  const code = error?.code;
  if (code === "EACCES" || code === "EPERM") return "permission denied by the operating system";
  if (code === "ENOENT") return "the file no longer exists";
  if (code === "ENOSPC") return "the destination has no free space";
  if (code === "EBUSY") return "the file is in use by another program";
  if (code === "EROFS") return "the destination is read-only";
  if (code === "EISDIR") return "the target is a directory";
  if (code === "ENOTDIR") return "part of the path is not a directory";
  return String(error?.message ?? error);
}

// src/host/index.js
var ROUTE_PREFIX = "/api/dsh-file-extension/";
var MAX_BODY_BYTES = 64 * 1024;
var inject = ["webServer", "connection"];
var name = "dsh-file-extension";
var Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-file-extension",
    validate(value) {
      const input = value !== null && typeof value === "object" ? value : {};
      const maxDownloadBytes = Number.isFinite(input.maxDownloadBytes) ? Number(input.maxDownloadBytes) : MAX_DOWNLOAD_BYTES;
      const allowPermanentDeleteFallback = input.allowPermanentDeleteFallback !== false;
      return { value: { maxDownloadBytes, allowPermanentDeleteFallback } };
    }
  }
};
function workspaceRootOf(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return void 0;
  try {
    const session = ctx.get("sessions")?.get(sessionId);
    return session?.header?.cwd;
  } catch {
    return void 0;
  }
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}
function sendFailure(res, outcome) {
  const status = outcome.code === FAILURE_CODES.notFound ? 404 : outcome.code === FAILURE_CODES.invalidName || outcome.code === FAILURE_CODES.outsideWorkspace ? 400 : outcome.code === FAILURE_CODES.alreadyExists ? 409 : outcome.code === FAILURE_CODES.tooLarge ? 413 : outcome.code === FAILURE_CODES.unsupported ? 422 : 500;
  sendJson(res, status, {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    details: outcome.details ?? {}
  });
}
function readJsonBody(req) {
  return new Promise((settle) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size === 0) {
        settle({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        settle(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
      } catch {
        settle(null);
      }
    });
    req.on("error", () => settle(null));
  });
}
function apply(ctx, config = {}) {
  const resolved = {
    maxDownloadBytes: Number.isFinite(config?.maxDownloadBytes) ? config.maxDownloadBytes : MAX_DOWNLOAD_BYTES,
    allowPermanentDeleteFallback: config?.allowPermanentDeleteFallback !== false
  };
  const webServer = ctx.get("webServer");
  const connection = ctx.get("connection");
  if (webServer === void 0 || connection === void 0) {
    return;
  }
  let trashCapability;
  const capabilities = async () => {
    if (trashCapability === void 0) {
      trashCapability = probeTrash();
    }
    return trashCapability;
  };
  const capabilitiesSafe = async () => {
    try {
      const value = await capabilities();
      return value;
    } catch (error) {
      trashCapability = void 0;
      return { supported: false, strategy: "none", reason: String(error?.message ?? error) };
    }
  };
  const rejected = (req, res) => {
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch {
      rejection = 403;
    }
    if (rejection === void 0) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };
  const route = (method, handler) => async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== method) {
      res.statusCode = 405;
      res.setHeader("allow", method);
      res.end();
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        code: FAILURE_CODES.operationFailed,
        message: String(error?.message ?? error),
        details: {}
      });
    }
  };
  const capabilitiesHandler = route("GET", async (_req, res) => {
    const trash = await capabilitiesSafe();
    sendJson(res, 200, {
      ok: true,
      value: {
        platform: process.platform,
        separator: process.platform === "win32" ? "\\" : "/",
        trash: { supported: trash.supported, strategy: trash.strategy, reason: trash.reason },
        permanentDeleteFallback: resolved.allowPermanentDeleteFallback,
        maxDownloadBytes: resolved.maxDownloadBytes,
        // The save-as flow uses the native directory picker plus a name field,
        // because dsh's desktop shell exposes no save dialog.
        saveAs: "directory-picker"
      }
    });
  });
  const statHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const outcome = await statPath(body.path, workspaceRootOf(ctx, body.sessionId));
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const renameHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const outcome = await renamePath(body.path, body.name, workspaceRootOf(ctx, body.sessionId));
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const removeHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const mode = body?.options?.mode === "permanent" ? "permanent" : "trash";
    if (mode === "permanent" && !resolved.allowPermanentDeleteFallback) {
      sendFailure(res, {
        code: FAILURE_CODES.unsupported,
        message: "permanent deletion is disabled by plugin configuration",
        details: { disabled: true }
      });
      return;
    }
    const outcome = await removePath(
      body.path,
      { mode },
      workspaceRootOf(ctx, body.sessionId)
    );
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const copyHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const outcome = await copyToPath(
      body.path,
      {
        directory: body?.options?.directory,
        name: body?.options?.name,
        overwrite: body?.options?.overwrite === true
      },
      workspaceRootOf(ctx, body.sessionId)
    );
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const downloadHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const outcome = await readForDownload(
      body.path,
      { maxBytes: resolved.maxDownloadBytes },
      workspaceRootOf(ctx, body.sessionId)
    );
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const routes = [
    ["capabilities", capabilitiesHandler],
    ["stat", statHandler],
    ["rename", renameHandler],
    ["remove", removeHandler],
    ["copy", copyHandler],
    ["download", downloadHandler]
  ];
  for (const [name2, handler] of routes) {
    ctx.effect(
      () => webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}${name2}`,
        handler
      }),
      `dsh-file-extension: ${name2}`
    );
  }
  ctx.logger?.info?.("dsh-file-extension: file menu routes registered");
}
export {
  Config,
  ROUTE_PREFIX,
  apply,
  inject,
  name
};
