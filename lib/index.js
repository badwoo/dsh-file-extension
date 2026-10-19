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
  cancelled: "file-extension/cancelled",
  updateUnavailable: "file-extension/update-unavailable",
  updateFailed: "file-extension/update-failed",
  restartRequired: "file-extension/restart-required"
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
import { access as access2, constants as constants2, copyFile, mkdir as mkdir2, readFile, rename as rename2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
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
  if (root === void 0 || root === null || root === "") return false;
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
async function createPath(directory, options = {}, workspaceRoot) {
  const kind = options?.kind === "directory" ? "directory" : "file";
  const name2 = typeof options?.name === "string" ? options.name.trim() : "";
  const problem = validateFileName(name2);
  if (problem !== null) {
    return failure(FAILURE_CODES.invalidName, `the name is not usable: ${problem}`, { reason: problem });
  }
  if (typeof directory !== "string" || directory.trim() === "") {
    return failure(FAILURE_CODES.notFound, "a containing directory is required");
  }
  const parent = resolve2(directory);
  if (!isInside(workspaceRoot, parent)) {
    return failure(FAILURE_CODES.outsideWorkspace, "the directory is outside the session workspace");
  }
  try {
    const info = await stat2(parent);
    if (!info.isDirectory()) {
      return failure(FAILURE_CODES.notDirectory, "the target is not a directory", { directory: parent });
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return failure(FAILURE_CODES.notFound, "the directory no longer exists", { directory: parent });
    }
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { directory: parent });
  }
  const target = join2(parent, name2);
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
    if (kind === "directory") {
      await mkdir2(target);
    } else {
      await writeFile2(target, "", { flag: "wx" });
    }
    return success({ path: target, name: name2, parent, kind });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return failure(FAILURE_CODES.alreadyExists, "an entry with that name already exists", {
        name: name2,
        path: target
      });
    }
    return failure(FAILURE_CODES.operationFailed, describeFsError(error), { path: target, name: name2 });
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

// src/host/update.js
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";
import { dirname as dirname3, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
var GITHUB_REPO = "badwoo/dsh-file-extension";
var GITHUB_SPEC = `github:${GITHUB_REPO}`;
var PLUGIN_NAME = "dsh-file-extension";
var GITHUB_API = "https://api.github.com";
var CACHE_TTL_MS = 5 * 60 * 1e3;
var FAILURE_CACHE_TTL_MS = 30 * 1e3;
var DEFAULT_TIMEOUT_MS = 10 * 1e3;
var MAX_NOTES_CHARS = 8e3;
function failure2(code, message, details = {}) {
  return { ok: false, code, message, details };
}
function success2(value = {}) {
  return { ok: true, value };
}
function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return null;
  return {
    nums: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] === void 0 ? [] : match[4].split(".")
  };
}
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === void 0) return -1;
    if (right === void 0) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] < right.nums[index] ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}
function packageJsonCandidates() {
  const here = dirname3(fileURLToPath(import.meta.url));
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve(`${PLUGIN_NAME}/package.json`));
  } catch {
  }
  candidates.push(join3(here, "..", "package.json"));
  candidates.push(join3(here, "..", "..", "package.json"));
  return candidates.filter((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
}
async function readInstalledVersion() {
  for (const path of packageJsonCandidates()) {
    try {
      const parsed = JSON.parse(await readFile2(path, "utf8"));
      if (typeof parsed?.version === "string" && parsed.version !== "") return parsed.version;
    } catch {
    }
  }
  return null;
}
function findOwningProfile(manifestPath) {
  let directory = dirname3(manifestPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join3(directory, "package.json");
    try {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        if (typeof parsed?.name === "string" && parsed.name.startsWith("dsh-profile-")) {
          return parsed.name.slice("dsh-profile-".length);
        }
      }
    } catch {
    }
    const parent = dirname3(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
function resolveProfileName(ctx) {
  try {
    const name2 = ctx?.get?.("profileContext")?.name;
    if (typeof name2 === "string" && name2 !== "") return name2;
  } catch {
  }
  for (const path of packageJsonCandidates()) {
    const name2 = findOwningProfile(path);
    if (name2 !== null && name2 !== "") return name2;
  }
  return null;
}
function manualHandoff(ctx) {
  const profileName = resolveProfileName(ctx);
  const usable = profileName !== null && profileName !== "desktop";
  return {
    profileName,
    manualCommand: profileName === null ? `dsh plugin --profile <profile> add ${GITHUB_SPEC}` : `dsh plugin --profile ${profileName} add ${GITHUB_SPEC}`,
    appManaged: profileName === "desktop",
    manualCommandUsable: usable
  };
}
var cachedCheck;
function invalidateUpdateCache() {
  cachedCheck = void 0;
}
async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        // GitHub rejects an API request that names no User-Agent.
        "user-agent": "dsh-file-extension-update-check",
        accept: "application/vnd.github+json"
      },
      signal: controller.signal
    });
    const text = await response.text();
    if (response.status !== 200) {
      const error = new Error(`HTTP ${String(response.status)}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  } finally {
    clearTimeout(timer);
  }
}
async function fetchLatestRelease(fetchImpl, timeoutMs) {
  try {
    const { body: body2 } = await fetchJson(`${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`, fetchImpl, timeoutMs);
    const tag2 = typeof body2?.tag_name === "string" ? body2.tag_name : null;
    if (tag2 === null || tag2 === "") throw new Error("the latest release reported no tag_name");
    const notes = typeof body2?.body === "string" && body2.body !== "" ? body2.body.slice(0, MAX_NOTES_CHARS) : null;
    return {
      latest: tag2.replace(/^v/i, ""),
      source: "release",
      releaseUrl: typeof body2?.html_url === "string" ? body2.html_url : `https://github.com/${GITHUB_REPO}/releases/tag/${tag2}`,
      notes,
      publishedAt: typeof body2?.published_at === "string" ? body2.published_at : null
    };
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  const { body } = await fetchJson(`${GITHUB_API}/repos/${GITHUB_REPO}/tags?per_page=1`, fetchImpl, timeoutMs);
  const tag = Array.isArray(body) && typeof body[0]?.name === "string" ? body[0].name : null;
  if (tag === null || tag === "") throw new Error("the repository has no releases and no tags");
  return {
    latest: tag.replace(/^v/i, ""),
    source: "tag",
    releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
    notes: null,
    publishedAt: null
  };
}
function describeFetchFailure(error) {
  if (error?.name === "AbortError") return "the request to GitHub timed out";
  const status = error?.status;
  if (typeof status === "number") {
    if (status === 403 || status === 429) {
      return `GitHub refused the request (HTTP ${String(status)}) \u2014 the API rate limit was reached; try again later`;
    }
    if (status === 404) return "GitHub reported no releases or tags for this repository (HTTP 404)";
    return `GitHub answered HTTP ${String(status)}`;
  }
  return `the request to GitHub failed: ${String(error?.message ?? error)}`;
}
async function checkForUpdate(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  if (typeof fetchImpl !== "function") {
    return failure2(FAILURE_CODES.updateUnavailable, "no fetch implementation is available in this Host");
  }
  const cached = cachedCheck;
  if (options.force !== true && cached !== void 0) {
    const ttl = cached.value.ok === true ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS;
    const age = now() - cached.at;
    if (age < ttl) {
      if (cached.value.ok === true) {
        return success2({ ...cached.value.value, checkedAt: cached.value.value.checkedAt, cached: true, cacheAgeMs: age });
      }
      return failure2(cached.value.code, cached.value.message, { ...cached.value.details, cached: true, cacheAgeMs: age });
    }
  }
  const current = typeof options.current === "string" && options.current !== "" ? options.current : await readInstalledVersion();
  if (current === null) {
    return failure2(
      FAILURE_CODES.updateFailed,
      "the installed version of this plugin could not be read from its package.json"
    );
  }
  let newest;
  try {
    newest = await fetchLatestRelease(fetchImpl, timeoutMs);
  } catch (error) {
    const outcome = failure2(FAILURE_CODES.updateUnavailable, describeFetchFailure(error), { current });
    cachedCheck = { at: now(), value: outcome };
    return outcome;
  }
  const git = await inspectDrift(fetchImpl, timeoutMs);
  const order = compareVersions(newest.latest, current);
  const hasUpdate = order === null ? false : order > 0;
  const value = {
    current,
    latest: newest.latest,
    hasUpdate,
    source: newest.source,
    releaseUrl: newest.releaseUrl,
    notes: newest.notes,
    publishedAt: newest.publishedAt,
    checkedAt: new Date(now()).toISOString(),
    upToDate: !hasUpdate,
    cached: false,
    cacheAgeMs: 0,
    ...git === null ? {} : { git },
    note: order === null ? `versions could not be compared semantically (installed ${current}, latest ${newest.latest})` : null
  };
  cachedCheck = { at: now(), value: success2(value) };
  return success2(value);
}
var COMMITS_ENDPOINT = `${GITHUB_API}/repos/${GITHUB_REPO}/commits?per_page=1`;
async function inspectDrift(fetchImpl, timeoutMs) {
  let head;
  try {
    const { body } = await fetchJson(COMMITS_ENDPOINT, fetchImpl, timeoutMs);
    if (!Array.isArray(body) || body.length === 0) return null;
    head = body[0];
  } catch {
    return null;
  }
  const sha = typeof head?.sha === "string" ? head.sha : null;
  if (sha === null) return null;
  return {
    branch: "default",
    head: sha.slice(0, 7),
    headDate: typeof head?.commit?.committer?.date === "string" ? head.commit.committer.date : null,
    // Without the profile's own pin the plugin cannot prove it is behind, only
    // that a newer commit exists on the branch. `unknown` keeps it honest.
    state: "unknown"
  };
}
function changeResultCode(result) {
  if (result === null || typeof result !== "object") return null;
  if (result.application !== "failed") return null;
  const code = result.error?.code;
  return typeof code === "string" ? code : "operation-error";
}
async function applyUpdate(ctx, options = {}) {
  const spec = typeof options.spec === "string" && options.spec !== "" ? options.spec : GITHUB_SPEC;
  const handoff = manualHandoff(ctx);
  const before = typeof options.current === "string" && options.current !== "" ? options.current : await readInstalledVersion();
  const base = {
    applied: false,
    before,
    after: null,
    noChange: false,
    application: null,
    restartRequired: true,
    requiresRestart: true,
    blocked: null,
    reason: null,
    output: null,
    manualCommand: handoff.manualCommand,
    profileName: handoff.profileName,
    manualCommandUsable: handoff.manualCommandUsable
  };
  let manager;
  try {
    manager = ctx?.get?.("pluginManager");
  } catch {
    manager = void 0;
  }
  if (manager === void 0 || manager === null) {
    return success2({
      ...base,
      reason: "manager-unavailable",
      output: "this profile exposes no pluginManager service, so the plugin cannot update itself"
    });
  }
  if (typeof manager.installBundle !== "function" || typeof manager.removeBundle !== "function") {
    return success2({
      ...base,
      reason: "manager-unavailable",
      output: "the pluginManager service exposes no installBundle/removeBundle pair"
    });
  }
  let probe;
  let probeError;
  try {
    probe = await manager.installBundle(spec, { enabled: true });
  } catch (error) {
    probeError = error;
  }
  if (probe !== void 0 && changeResultCode(probe) === null) {
    return describeInstallOutcome(probe, { before, base });
  }
  const probeCode = changeResultCode(probe) ?? (typeof probeError?.code === "string" ? probeError.code : null);
  if (probeCode !== "already-installed") {
    return success2({
      ...base,
      reason: probeCode === null ? "install-refused" : `install-refused:${probeCode}`,
      output: String(probeError?.message ?? probe?.error?.message ?? "installBundle did not complete")
    });
  }
  let removed;
  try {
    removed = await manager.removeBundle(PLUGIN_NAME);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : null;
    if (code !== null) {
      return success2({ ...base, reason: `manager-refused:${code}`, output: String(error?.message ?? error) });
    }
    return failure2(FAILURE_CODES.updateFailed, `the plugin manager failed to remove the plugin: ${String(error?.message ?? error)}`);
  }
  const removeCode = changeResultCode(removed);
  if (removeCode !== null) {
    return success2({ ...base, reason: `remove-refused:${removeCode}`, output: null });
  }
  let installed;
  let installError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      installed = await manager.installBundle(spec, { enabled: true });
      installError = void 0;
      break;
    } catch (error) {
      installError = error;
      const code = typeof error?.code === "string" ? error.code : null;
      if (code !== null) break;
    }
  }
  if (installed === void 0) {
    const code = typeof installError?.code === "string" ? installError.code : null;
    if (code === null && installError !== void 0) {
      return failure2(
        FAILURE_CODES.updateFailed,
        `the plugin manager failed to reinstall the plugin after removing it: ${String(installError?.message ?? installError)}`,
        { reason: "reinstall-failed", manualCommand: handoff.manualCommand }
      );
    }
    return success2({
      ...base,
      reason: code === null ? "reinstall-failed" : `install-refused:${code}`,
      output: String(installError?.message ?? "installBundle did not complete")
    });
  }
  return describeInstallOutcome(installed, { before, base });
}
async function describeInstallOutcome(installed, { before, base }) {
  const installCode = changeResultCode(installed);
  if (installCode !== null) {
    return success2({
      ...base,
      reason: `install-refused:${installCode}`,
      output: String(installed?.error?.message ?? "installBundle did not complete")
    });
  }
  const after = typeof installed.version === "string" && installed.version !== "" ? installed.version : await readInstalledVersion();
  const noChange = before !== null && after !== null && compareVersions(before, after) === 0;
  const application = typeof installed.application === "string" ? installed.application : null;
  const restartRequired = application !== "applied";
  invalidateUpdateCache();
  return success2({
    ...base,
    applied: true,
    after,
    noChange,
    application,
    restartRequired,
    requiresRestart: restartRequired,
    reason: noChange ? "already-current" : null,
    output: null
  });
}
function isLoopbackRequest(req) {
  try {
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
    const host = req?.headers?.host;
    if (typeof host !== "string" || host === "") return false;
    let hostUrl;
    try {
      hostUrl = new URL(`http://${host}`);
    } catch {
      return false;
    }
    if (!isLoopbackHostname(hostUrl.hostname)) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers.origin;
    if (origin === void 0) return true;
    try {
      return new URL(origin).host === hostUrl.host;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
function isLoopbackAddress(address) {
  if (typeof address !== "string" || address === "") return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice("::ffff:".length));
  return isIPv4Loopback(normalized);
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return isIPv4Loopback(hostname);
}
function isIPv4Loopback(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  if (parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
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
  if (typeof sessionId !== "string" || sessionId === "") {
    return { root: void 0, found: false };
  }
  try {
    const session = ctx.get("sessions")?.get(sessionId);
    const cwd = session?.header?.cwd;
    if (typeof cwd === "string" && cwd !== "") return { root: cwd, found: true };
    return { root: void 0, found: false };
  } catch {
    return { root: void 0, found: false };
  }
}
function fenceFor(ctx, body) {
  const { root, found } = workspaceRootOf(ctx, body?.sessionId);
  if (!found) {
    return {
      refusal: {
        code: FAILURE_CODES.outsideWorkspace,
        message: "the request names no Session this host can resolve",
        details: { sessionResolved: false }
      }
    };
  }
  return { root };
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
    const fence = fenceFor(ctx, body);
    if (fence.refusal !== void 0) {
      sendFailure(res, fence.refusal);
      return;
    }
    const outcome = await statPath(body.path, fence.root);
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const renameHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const fence = fenceFor(ctx, body);
    if (fence.refusal !== void 0) {
      sendFailure(res, fence.refusal);
      return;
    }
    const outcome = await renamePath(body.path, body.name, fence.root);
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
    const fence = fenceFor(ctx, body);
    if (fence.refusal !== void 0) {
      sendFailure(res, fence.refusal);
      return;
    }
    const outcome = await removePath(body.path, { mode }, fence.root);
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const copyHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const fence = fenceFor(ctx, body);
    if (fence.refusal !== void 0) {
      sendFailure(res, fence.refusal);
      return;
    }
    const outcome = await copyToPath(
      body.path,
      {
        directory: body?.options?.directory,
        name: body?.options?.name,
        overwrite: body?.options?.overwrite === true
      },
      fence.root
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
    const fence = fenceFor(ctx, body);
    if (fence.refusal !== void 0) {
      sendFailure(res, fence.refusal);
      return;
    }
    const outcome = await readForDownload(
      body.path,
      { maxBytes: resolved.maxDownloadBytes },
      fence.root
    );
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const createHandler = route("POST", async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const fence = fenceFor(ctx, body);
    if (fence.refusal !== void 0) {
      sendFailure(res, fence.refusal);
      return;
    }
    const outcome = await createPath(
      body.directory,
      { name: body.name, kind: body.kind === "directory" ? "directory" : "file" },
      fence.root
    );
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const updateCheckHandler = route("GET", async (_req, res) => {
    const outcome = await checkForUpdate();
    if (outcome.ok) {
      sendJson(res, 200, outcome);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      value: { current: outcome.details?.current, latest: null, hasUpdate: false, upToDate: null, error: outcome.message, code: outcome.code }
    });
  });
  const updateApplyHandler = route("POST", async (req, res) => {
    if (!isLoopbackRequest(req)) {
      sendFailure(res, {
        code: FAILURE_CODES.unsupported,
        message: "updating the plugin is only allowed from the host machine itself",
        details: { loopbackRequired: true }
      });
      return;
    }
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: "the request body is not JSON", details: {} });
      return;
    }
    const outcome = await applyUpdate(ctx, { spec: body.spec });
    if (outcome.ok) sendJson(res, 200, outcome);
    else sendFailure(res, outcome);
  });
  const routes = [
    ["capabilities", capabilitiesHandler],
    ["stat", statHandler],
    ["rename", renameHandler],
    ["remove", removeHandler],
    ["copy", copyHandler],
    ["download", downloadHandler],
    ["create", createHandler],
    ["update-check", updateCheckHandler],
    ["update-apply", updateApplyHandler]
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
