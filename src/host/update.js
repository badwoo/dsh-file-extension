/**
 * "Check for updates" support for this plugin: version discovery and a
 * manager-delegated apply.
 *
 * The plugin is installed from a GitHub repository, not from npm, so its pin
 * lives as a git commit in the owning profile's `pnpm-lock.yaml`. That shapes
 * both halves of this module:
 *
 * - **Check** answers the user's actual question ("获取该插件最新版") with a
 *   version: it reads this package's own `package.json`, asks the GitHub REST
 *   API for the latest release, and compares the two semantically. Network
 *   work is bounded by a real timeout and cached in-process, so a hanging or
 *   rate-limited GitHub cannot hang the Host route and repeated clicks cannot
 *   hammer the API.
 * - **Apply** deliberately does not spawn pnpm. Shelling out would either fail
 *   (the profile the GUI runs in may be app-managed and refused by the `dsh`
 *   CLI) or corrupt the profile (the plugin's own `lib/` files are loaded and
 *   locked by the running process). Instead it delegates to the Harness's own
 *   `pluginManager` Service — the same code path `dsh plugin` uses, with its
 *   file lock, atomic restore, and compatibility gate — and when that manager
 *   cannot complete the change it returns an honest manual command rather than
 *   claiming success.
 *
 * Nothing here throws across the wire: every entry point returns a
 * discriminated `{ ok: true, value }` / `{ ok: false, code, message }` outcome
 * whose `code` comes from the plugin's stable failure vocabulary.
 *
 * @module dsh-file-extension/update
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAILURE_CODES } from './contract.js'

/** GitHub repository this plugin is published from. */
export const GITHUB_REPO = 'badwoo/dsh-file-extension'

/** The git installation spec the plugin is normally installed with. */
export const GITHUB_SPEC = `github:${GITHUB_REPO}`

/** The dependency key this plugin occupies in the owning profile. */
export const PLUGIN_NAME = 'dsh-file-extension'

/** GitHub REST API base. */
const GITHUB_API = 'https://api.github.com'

/** How long a successful check is reused before GitHub is asked again. */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * How long a failed check is reused. Much shorter than {@link CACHE_TTL_MS}
 * on purpose: a transient network blip must not lock the button out for five
 * minutes, while a burst of clicks during one outage still shares one probe.
 */
const FAILURE_CACHE_TTL_MS = 30 * 1000

/** Default bound on one GitHub request. */
const DEFAULT_TIMEOUT_MS = 10 * 1000

/** Longest release-note body carried to the browser, in characters. */
const MAX_NOTES_CHARS = 8000

/**
 * Build one failure outcome.
 *
 * @param {string} code - stable failure code.
 * @param {string} message - human diagnostic.
 * @param {Record<string, unknown>} [details] - structured extras.
 * @returns {{ ok: false, code: string, message: string, details: Record<string, unknown> }} the failure.
 */
function failure(code, message, details = {}) {
  return { ok: false, code, message, details }
}

/**
 * Build one success outcome.
 *
 * @param {Record<string, unknown>} value - the payload.
 * @returns {{ ok: true, value: Record<string, unknown> }} the success.
 */
function success(value = {}) {
  return { ok: true, value }
}

/**
 * Parse a semantic version, tolerating a leading `v`, a missing minor or patch
 * segment, and a prerelease suffix. Build metadata is ignored, matching the
 * semver precedence rules.
 *
 * @param {unknown} value - the version string.
 * @returns {{ nums: [number, number, number], pre: string[] } | null} the parsed
 *   parts, or null when the value is not a version at all.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  return {
    nums: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare the prerelease halves of two versions, by the semver precedence
 * rules: an empty (release) prerelease outranks any identifier list; numeric
 * identifiers compare numerically and sort below alphanumeric ones.
 *
 * @param {string[]} a - first prerelease identifiers.
 * @param {string[]} b - second prerelease identifiers.
 * @returns {-1 | 0 | 1} the comparison.
 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  // A release outranks a prerelease of the same version.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * Compare two semantic versions. Returns null when either side cannot be
 * parsed: an unprovable comparison must never be reported as "newer".
 *
 * @param {unknown} a - first version.
 * @param {unknown} b - second version.
 * @returns {-1 | 0 | 1 | null} negative when a < b, 0 when equal, positive when
 *   a > b, null when the two cannot be compared semantically.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] < right.nums[index] ? -1 : 1
  }
  return comparePrerelease(left.pre, right.pre)
}

/**
 * Candidate `package.json` paths for this package, most authoritative first.
 *
 * This module is bundled into `lib/index.js`, so `import.meta.url` names the
 * *output* file at runtime. The require-based candidate therefore resolves the
 * installed copy's manifest through the profile's `node_modules` (and, when
 * running from source, this repository's own manifest through Node's
 * self-reference rule), while the relative candidates cover the bundled and
 * un-bundled layouts directly.
 *
 * @returns {string[]} existing candidate paths, most authoritative first.
 */
function packageJsonCandidates() {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = []
  try {
    // Resolves the installed copy when bundled, and this repository when run
    // from source: `./package.json` is an export of this package.
    candidates.push(createRequire(import.meta.url).resolve(`${PLUGIN_NAME}/package.json`))
  } catch {
    // An uninstalled/one-off layout has no resolvable self reference.
  }
  candidates.push(join(here, '..', 'package.json'))
  candidates.push(join(here, '..', '..', 'package.json'))
  return candidates.filter((path) => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  })
}

/**
 * Read the `version` field of the first readable candidate manifest.
 *
 * @returns {Promise<string | null>} the installed version, or null when no
 *   candidate manifest could be read.
 */
async function readInstalledVersion() {
  for (const path of packageJsonCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (typeof parsed?.version === 'string' && parsed.version !== '') return parsed.version
    } catch {
      // A missing or malformed candidate is not fatal: try the next layout.
    }
  }
  return null
}

/**
 * Walk up from a package manifest to the nearest owning `dsh-profile-*`
 * manifest, which is the profile whose lockfile pins this install.
 *
 * @param {string} manifestPath - absolute path of a package's `package.json`.
 * @returns {string | null} the profile name, or null when the walk finds none.
 */
function findOwningProfile(manifestPath) {
  let directory = dirname(manifestPath)
  // The profile directory is an ancestor, within a handful of levels.
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, 'package.json')
    try {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
        if (typeof parsed?.name === 'string' && parsed.name.startsWith('dsh-profile-')) {
          return parsed.name.slice('dsh-profile-'.length)
        }
      }
    } catch {
      // An unreadable ancestor manifest simply ends this branch.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/**
 * Resolve the name of the profile the user would have to name on the command
 * line. The running profile's own context is authoritative when present, since
 * it also works for an app-managed profile that has no CLI-visible ancestor.
 *
 * @param {object} [ctx] - owning Cordis context, when one was supplied.
 * @returns {string | null} the profile name, or null when none could be
 *   determined.
 */
function resolveProfileName(ctx) {
  try {
    const name = ctx?.get?.('profileContext')?.name
    if (typeof name === 'string' && name !== '') return name
  } catch {
    // A context without that service falls through to the manifest walk.
  }
  for (const path of packageJsonCandidates()) {
    const name = findOwningProfile(path)
    if (name !== null && name !== '') return name
  }
  return null
}

/**
 * Build the manual command a user can run to update this plugin.
 *
 * `profileName` is null when no owning profile could be determined. In that
 * case the command cannot be completed, so the placeholder-free form is handed
 * over with `manualCommandUsable: false` rather than a literal `<profile>`
 * token the user would have to guess at.
 *
 * `appManaged` is reported alongside the name: a profile the Electron
 * application owns is refused by the `dsh` CLI ("profile \"desktop\" is managed
 * exclusively by the Electron application"), so the command exists for
 * reference but cannot be run by the user in that profile. Saying so is more
 * useful than handing over a command that will fail.
 *
 * @param {object} [ctx] - owning Cordis context, when one was supplied.
 * @returns {{ profileName: string | null, manualCommand: string, appManaged: boolean, manualCommandUsable: boolean }} the hand-off facts.
 */
function manualHandoff(ctx) {
  const profileName = resolveProfileName(ctx)
  const usable = profileName !== null && profileName !== 'desktop'
  return {
    profileName,
    manualCommand: profileName === null
      ? `dsh plugin --profile <profile> add ${GITHUB_SPEC}`
      : `dsh plugin --profile ${profileName} add ${GITHUB_SPEC}`,
    appManaged: profileName === 'desktop',
    manualCommandUsable: usable,
  }
}

/**
 * The in-process cache of the last check, shared by every caller.
 *
 * A success is kept for {@link CACHE_TTL_MS} and a failure for
 * {@link FAILURE_CACHE_TTL_MS}; a successful apply clears it so the next click
 * re-reads the profile rather than echoing a pre-update answer.
 */
let cachedCheck

/** Drop the cached check so the next call asks GitHub again. */
export function invalidateUpdateCache() {
  cachedCheck = undefined
}

/**
 * Fetch one GitHub JSON document with an explicit timeout and the headers
 * GitHub requires.
 *
 * @param {string} url - absolute request URL.
 * @param {typeof fetch} fetchImpl - the fetch implementation to use.
 * @param {number} timeoutMs - hard bound on the request.
 * @returns {Promise<{ status: number, body: unknown }>} the decoded response.
 * @throws {Error} on a transport failure, an abort, or a non-JSON body.
 */
async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        // GitHub rejects an API request that names no User-Agent.
        'user-agent': 'dsh-file-extension-update-check',
        accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    })
    const text = await response.text()
    if (response.status !== 200) {
      const error = new Error(`HTTP ${String(response.status)}`)
      error.status = response.status
      error.body = text
      throw error
    }
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask GitHub for the newest release of this plugin.
 *
 * The latest published release is the preferred source because it carries the
 * display fields the panel shows (`html_url`, `body`, `published_at`). A
 * repository with no releases at all answers 404, so the newest tag is used
 * instead — a version answer without notes is still a version answer.
 *
 * @param {typeof fetch} fetchImpl - the fetch implementation to use.
 * @param {number} timeoutMs - hard bound on each request.
 * @returns {Promise<{ latest: string, source: 'release' | 'tag', releaseUrl: string | null, notes: string | null, publishedAt: string | null }>} the newest version.
 * @throws {Error} on any network, HTTP, or parse failure.
 */
async function fetchLatestRelease(fetchImpl, timeoutMs) {
  try {
    const { body } = await fetchJson(`${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`, fetchImpl, timeoutMs)
    const tag = typeof body?.tag_name === 'string' ? body.tag_name : null
    if (tag === null || tag === '') throw new Error('the latest release reported no tag_name')
    const notes = typeof body?.body === 'string' && body.body !== ''
      ? body.body.slice(0, MAX_NOTES_CHARS)
      : null
    return {
      latest: tag.replace(/^v/i, ''),
      source: 'release',
      releaseUrl: typeof body?.html_url === 'string' ? body.html_url : `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
      notes,
      publishedAt: typeof body?.published_at === 'string' ? body.published_at : null,
    }
  } catch (error) {
    // No releases at all is the one 404 that has a fallback; every other
    // failure belongs to the caller, which reports it as unavailable.
    if (error?.status !== 404) throw error
  }
  const { body } = await fetchJson(`${GITHUB_API}/repos/${GITHUB_REPO}/tags?per_page=1`, fetchImpl, timeoutMs)
  const tag = Array.isArray(body) && typeof body[0]?.name === 'string' ? body[0].name : null
  if (tag === null || tag === '') throw new Error('the repository has no releases and no tags')
  return {
    latest: tag.replace(/^v/i, ''),
    source: 'tag',
    releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
    notes: null,
    publishedAt: null,
  }
}

/**
 * Turn one caught failure into a human message that names the HTTP status when
 * there was one.
 *
 * @param {unknown} error - the caught value.
 * @returns {string} the diagnostic.
 */
function describeFetchFailure(error) {
  if (error?.name === 'AbortError') return 'the request to GitHub timed out'
  const status = error?.status
  if (typeof status === 'number') {
    if (status === 403 || status === 429) {
      return `GitHub refused the request (HTTP ${String(status)}) — the API rate limit was reached; try again later`
    }
    if (status === 404) return 'GitHub reported no releases or tags for this repository (HTTP 404)'
    return `GitHub answered HTTP ${String(status)}`
  }
  return `the request to GitHub failed: ${String(error?.message ?? error)}`
}

/**
 * Discover the newest released version of this plugin and compare it with the
 * installed one.
 *
 * A successful answer is cached in-process for {@link CACHE_TTL_MS}; a failed
 * answer for {@link FAILURE_CACHE_TTL_MS}. Pass `force` to bypass the cache,
 * which is what a "re-check" click should do.
 *
 * The comparison is semantic and honest: when either version cannot be parsed
 * the result reports `hasUpdate: false` with an explanatory `note`, because an
 * unprovable comparison must never be presented as an available update.
 *
 * @param {object} [options] - call tunables.
 * @param {string} [options.current] - installed version; read from this
 *   package's own manifest when omitted.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation (a test seam).
 * @param {number} [options.timeoutMs] - per-request bound, default 10s.
 * @param {() => number} [options.now] - clock (a test seam).
 * @param {boolean} [options.force] - ignore the cache and ask GitHub again.
 * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string, details: object }>}
 *   `value` carries `current`, `latest`, `hasUpdate`, `source`, `releaseUrl`,
 *   `notes`, `publishedAt`, `checkedAt`, `upToDate`, `cached`, `cacheAgeMs`,
 *   `note`; a failure carries `FAILURE_CODES.updateUnavailable` (network or
 *   HTTP) or `FAILURE_CODES.updateFailed` (the installed version is unreadable).
 */
export async function checkForUpdate(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  if (typeof fetchImpl !== 'function') {
    return failure(FAILURE_CODES.updateUnavailable, 'no fetch implementation is available in this Host')
  }

  const cached = cachedCheck
  if (options.force !== true && cached !== undefined) {
    const ttl = cached.value.ok === true ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS
    const age = now() - cached.at
    if (age < ttl) {
      if (cached.value.ok === true) {
        return success({ ...cached.value.value, checkedAt: cached.value.value.checkedAt, cached: true, cacheAgeMs: age })
      }
      return failure(cached.value.code, cached.value.message, { ...cached.value.details, cached: true, cacheAgeMs: age })
    }
  }

  const current = typeof options.current === 'string' && options.current !== ''
    ? options.current
    : await readInstalledVersion()
  if (current === null) {
    return failure(
      FAILURE_CODES.updateFailed,
      'the installed version of this plugin could not be read from its package.json',
    )
  }

  let newest
  try {
    newest = await fetchLatestRelease(fetchImpl, timeoutMs)
  } catch (error) {
    // `current` rides along on a failed check so the caller can still show the
    // installed version beside the reason GitHub could not be reached.
    const outcome = failure(FAILURE_CODES.updateUnavailable, describeFetchFailure(error), { current })
    cachedCheck = { at: now(), value: outcome }
    return outcome
  }

  // One extra request, inside the same cache window. A `github:` installation
  // pins a COMMIT, not a version, so the newest release tag is not by itself
  // proof of what this profile is running; the branch's newest commit is the
  // one fact versions cannot express. It refines the answer and never replaces
  // it, so a repository that cannot be reached simply leaves it out.
  const git = await inspectDrift(fetchImpl, timeoutMs)

  const order = compareVersions(newest.latest, current)
  const hasUpdate = order === null ? false : order > 0
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
    ...(git === null ? {} : { git }),
    note: order === null
      ? `versions could not be compared semantically (installed ${current}, latest ${newest.latest})`
      : null,
  }
  cachedCheck = { at: now(), value: success(value) }
  return success(value)
}

/**
 * GitHub API endpoint for the repository's newest commit.
 *
 * Only reached when the plan can and should be read; it is kept in one named
 * constant so the network surface of this module stays enumerable at a glance.
 */
const COMMITS_ENDPOINT = `${GITHUB_API}/repos/${GITHUB_REPO}/commits?per_page=1`

/**
 * Compare the newest release tag with the newest branch commit.
 *
 * A `github:` installation pins a **commit**, not a version, so a profile can be
 * running the same version number as the latest release while still missing that
 * release's commit — and, more importantly, the reverse is impossible to see from
 * versions alone. This reads only public commit metadata (a SHA and its date) and
 * never the profile's own lockfile, which the Host cannot portably read.
 *
 * Failure here is never fatal: the answer is a *refinement* of the version
 * comparison, so an unreachable repository degrades to `null` and the caller
 * reports the version facts alone.
 *
 * @param {typeof fetch} fetchImpl - the fetch implementation to use.
 * @param {number} timeoutMs - hard bound on the request.
 * @returns {Promise<{ branch: string, head: string, headDate: string | null, state: 'behind' | 'unknown' } | null>} the comparison, or null when unknown.
 */
async function inspectDrift(fetchImpl, timeoutMs) {
  let head
  try {
    const { body } = await fetchJson(COMMITS_ENDPOINT, fetchImpl, timeoutMs)
    if (!Array.isArray(body) || body.length === 0) return null
    head = body[0]
  } catch {
    // A repository with no commits, or no network: not a reportable failure.
    return null
  }
  const sha = typeof head?.sha === 'string' ? head.sha : null
  if (sha === null) return null
  return {
    branch: 'default',
    head: sha.slice(0, 7),
    headDate: typeof head?.commit?.committer?.date === 'string' ? head.commit.committer.date : null,
    // Without the profile's own pin the plugin cannot prove it is behind, only
    // that a newer commit exists on the branch. `unknown` keeps it honest.
    state: 'unknown',
  }
}

/**
 * Read a `ChangeResult`'s stable rejection code, when it carries one.
 *
 * @param {object} result - a manager `ChangeResult`.
 * @returns {string | null} the code, or null for a successful change.
 */
function changeResultCode(result) {
  if (result === null || typeof result !== 'object') return null
  if (result.application !== 'failed') return null
  const code = result.error?.code
  return typeof code === 'string' ? code : 'operation-error'
}

/**
 * Attempt a real, in-place update of this plugin through the Harness's own
 * `pluginManager` Service.
 *
 * The manager is the only supported installer: it holds the profile manifest
 * lock while it rewrites `package.json` and `pnpm-lock.yaml`, restores them
 * atomically when pnpm fails, and applies the revision through the Loader's
 * declared reload lifecycle. This function therefore never spawns pnpm itself.
 *
 * The manager refuses an in-place reinstall while the hot-reload service is
 * live (`application: 'failed'`, `error.code: 'already-installed'`), so the
 * supported sequence is `removeBundle` then `installBundle`. Because a profile
 * left with the plugin *removed* is worse than one left stale, a failed
 * reinstall is retried once and, if it still fails, reported as
 * `reinstall-failed` with the manual command — never as success.
 *
 * `ok: false` is reserved for a genuinely unusable manager: one that exists but
 * throws something the manager's own vocabulary cannot attribute. Every other
 * outcome, including every refusal, resolves as `ok: true` with
 * `applied: false` and the reason the user needs.
 *
 * @param {object} ctx - owning Cordis context; `ctx.get('pluginManager')` is
 *   the installer this delegates to.
 * @param {object} [options] - call tunables.
 * @param {string} [options.spec] - installation spec, defaulting to
 *   `github:badwoo/dsh-file-extension`.
 * @param {string} [options.current] - installed version reported as `before`.
 * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string, details: object }>}
 *   `value` carries `applied`, `before`, `after`, `noChange`, `application`,
 *   `restartRequired`, `requiresRestart`, `blocked`, `reason`, `output`,
 *   `manualCommand`, `profileName`, `manualCommandUsable`.
 */
export async function applyUpdate(ctx, options = {}) {
  const spec = typeof options.spec === 'string' && options.spec !== '' ? options.spec : GITHUB_SPEC
  const handoff = manualHandoff(ctx)
  const before = typeof options.current === 'string' && options.current !== ''
    ? options.current
    : await readInstalledVersion()

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
    manualCommandUsable: handoff.manualCommandUsable,
  }

  let manager
  try {
    manager = ctx?.get?.('pluginManager')
  } catch {
    manager = undefined
  }
  if (manager === undefined || manager === null) {
    return success({
      ...base,
      reason: 'manager-unavailable',
      output: 'this profile exposes no pluginManager service, so the plugin cannot update itself',
    })
  }
  if (typeof manager.installBundle !== 'function' || typeof manager.removeBundle !== 'function') {
    return success({
      ...base,
      reason: 'manager-unavailable',
      output: 'the pluginManager service exposes no installBundle/removeBundle pair',
    })
  }

  // Probe the install path BEFORE removing anything.
  //
  // The manager refuses to install over a live package while hot reload is
  // active (`application: 'failed'`, `error.code: 'already-installed'`), so the
  // supported sequence is remove-then-install. Probing first is what makes that
  // sequence safe: a refusal is discovered while the plugin is still installed.
  // Without this probe the removal below could run against a refusal it cannot
  // recover from, leaving the user with no plugin at all — strictly worse than
  // staying on a stale version.
  let probe
  let probeError
  try {
    probe = await manager.installBundle(spec, { enabled: true })
  } catch (error) {
    probeError = error
  }
  if (probe !== undefined && changeResultCode(probe) === null) {
    // The install was accepted outright (nothing was live to refuse it).
    return describeInstallOutcome(probe, { before, base })
  }
  const probeCode = changeResultCode(probe) ?? (typeof probeError?.code === 'string' ? probeError.code : null)
  if (probeCode !== 'already-installed') {
    // Any other refusal — a compatibility gate, a lock, a network failure — is
    // final. The plugin stays installed and the user is told exactly why.
    return success({
      ...base,
      reason: probeCode === null ? 'install-refused' : `install-refused:${probeCode}`,
      output: String(probeError?.message ?? probe?.error?.message ?? 'installBundle did not complete'),
    })
  }

  // The one refusal remove-then-install can answer: the live package itself.
  // Removal first, then reinstall, with one retry so a transient refusal cannot
  // leave the profile without the plugin.
  let removed
  try {
    removed = await manager.removeBundle(PLUGIN_NAME)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null
    if (code !== null) {
      return success({ ...base, reason: `manager-refused:${code}`, output: String(error?.message ?? error) })
    }
    return failure(FAILURE_CODES.updateFailed, `the plugin manager failed to remove the plugin: ${String(error?.message ?? error)}`)
  }
  const removeCode = changeResultCode(removed)
  if (removeCode !== null) {
    return success({ ...base, reason: `remove-refused:${removeCode}`, output: null })
  }

  let installed
  let installError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      installed = await manager.installBundle(spec, { enabled: true })
      installError = undefined
      break
    } catch (error) {
      installError = error
      const code = typeof error?.code === 'string' ? error.code : null
      // A refusal the manager named is final: retrying cannot help it.
      if (code !== null) break
    }
  }

  if (installed === undefined) {
    const code = typeof installError?.code === 'string' ? installError.code : null
    if (code === null && installError !== undefined) {
      // Unclassifiable infrastructure failure while the plugin is now removed:
      // this is the "genuinely unusable manager" case.
      return failure(
        FAILURE_CODES.updateFailed,
        `the plugin manager failed to reinstall the plugin after removing it: ${String(installError?.message ?? installError)}`,
        { reason: 'reinstall-failed', manualCommand: handoff.manualCommand },
      )
    }
    return success({
      ...base,
      reason: code === null ? 'reinstall-failed' : `install-refused:${code}`,
      output: String(installError?.message ?? 'installBundle did not complete'),
    })
  }

  return describeInstallOutcome(installed, { before, base })
}

/**
 * Turn an accepted `installBundle` result into the caller's outcome.
 *
 * Shared by the pre-removal probe and the real reinstall so both report one
 * shape: the probe reached this point only when the install was accepted
 * outright, and the reinstall only after a removal, but "what the profile now
 * holds" is the same question either way.
 *
 * @param {object} installed - the manager's `ChangeResult`.
 * @param {object} context - reporting context.
 * @param {string | null} context.before - the version installed before the call.
 * @param {object} context.base - the pre-built outcome fields.
 * @returns {Promise<object>} the settled outcome.
 */
async function describeInstallOutcome(installed, { before, base }) {
  const installCode = changeResultCode(installed)
  if (installCode !== null) {
    return success({
      ...base,
      reason: `install-refused:${installCode}`,
      output: String(installed?.error?.message ?? 'installBundle did not complete'),
    })
  }

  const after = typeof installed.version === 'string' && installed.version !== ''
    ? installed.version
    : await readInstalledVersion()
  const noChange = before !== null && after !== null && compareVersions(before, after) === 0
  const application = typeof installed.application === 'string' ? installed.application : null
  // Any real change to the loaded plugin files needs a restart to take effect;
  // the manager reports that itself, and its silence is not a live reload.
  const restartRequired = application !== 'applied'

  // The profile now holds a different revision, so the cached check describes
  // a state that no longer exists.
  invalidateUpdateCache()

  return success({
    ...base,
    applied: true,
    after,
    noChange,
    application,
    restartRequired,
    requiresRestart: restartRequired,
    reason: noChange ? 'already-current' : null,
    output: null,
  })
}

/**
 * Whether a request arrived over a loopback connection.
 *
 * The apply route changes installed files, so it must be reachable only from
 * the machine's own browser and never from a LAN or tunnel origin. The socket
 * address is authoritative — `X-Forwarded-For` is never trusted, because any
 * proxy in front of the server can set it — and the `Host` header must name a
 * loopback authority too, which is what stops a DNS-rebinding origin from
 * reaching the route on a loopback socket. Browser same-origin markers are
 * checked last as defence in depth.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true only when every check passes.
 */
export function isLoopbackRequest(req) {
  try {
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
    const host = req?.headers?.host
    if (typeof host !== 'string' || host === '') return false
    let hostUrl
    try {
      hostUrl = new URL(`http://${host}`)
    } catch {
      return false
    }
    if (!isLoopbackHostname(hostUrl.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    if (origin === undefined) return true
    try {
      return new URL(origin).host === hostUrl.host
    } catch {
      return false
    }
  } catch {
    // A malformed request cannot be trusted as loopback.
    return false
  }
}

/**
 * Whether a peer socket address names the loopback range.
 *
 * @param {unknown} address - `req.socket.remoteAddress`.
 * @returns {boolean} true for `::1`, an IPv4-mapped loopback, or `127/8`.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * Whether a `Host`-header hostname names the loopback authority.
 *
 * @param {string} hostname - a URL hostname (`localhost`, `127.0.0.1`, `[::1]`).
 * @returns {boolean} true for the loopback names.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Whether an IPv4 literal is inside `127/8`.
 *
 * @param {string} value - the candidate literal.
 * @returns {boolean} true when all four octets are valid and the first is 127.
 */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
