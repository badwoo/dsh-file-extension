/**
 * Browser-side client for this plugin's Host routes.
 *
 * All calls go to `/api/dsh-file-extension/*` with the page's own cookie, so the
 * deployment's browser authentication applies exactly as it does to official
 * routes. Nothing here throws: every method resolves to a discriminated result
 * the UI can render.
 *
 * @module dsh-file-extension/client/api
 */

/** Route prefix, matching the Host half. */
const BASE = '/api/dsh-file-extension/'

/**
 * @typedef {object} ApiFailure
 * @property {false} ok
 * @property {string} code - stable failure code from the Host.
 * @property {string} message - human diagnostic.
 * @property {Record<string, unknown>} details - structured extras.
 */

/**
 * @typedef {object} ApiSuccess
 * @property {true} ok
 * @property {Record<string, unknown>} value - the payload.
 */

/**
 * POST one JSON body to a plugin route.
 *
 * @param {string} method - route name after the prefix.
 * @param {Record<string, unknown>} body - the request payload.
 * @param {AbortSignal} [signal] - caller lifetime.
 * @returns {Promise<ApiSuccess | ApiFailure>} the settled result.
 */
async function post(method, body, signal) {
  try {
    const response = await fetch(`${BASE}${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    })
    return await readResult(response)
  } catch (error) {
    return transportFailure(error)
  }
}

/**
 * GET one plugin route.
 *
 * @param {string} method - route name after the prefix.
 * @param {AbortSignal} [signal] - caller lifetime.
 * @returns {Promise<ApiSuccess | ApiFailure>} the settled result.
 */
async function get(method, signal) {
  try {
    const response = await fetch(`${BASE}${method}`, {
      method: 'GET',
      credentials: 'same-origin',
      signal,
    })
    return await readResult(response)
  } catch (error) {
    return transportFailure(error)
  }
}

/**
 * Read one plugin response into the shared result shape.
 *
 * @param {Response} response - the HTTP response.
 * @returns {Promise<ApiSuccess | ApiFailure>} the settled result.
 */
async function readResult(response) {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (payload !== null && typeof payload === 'object' && payload.ok === true) {
    return { ok: true, value: payload.value ?? {} }
  }
  if (payload !== null && typeof payload === 'object' && payload.ok === false) {
    return {
      ok: false,
      code: String(payload.code ?? 'file-extension/operation-failed'),
      message: String(payload.message ?? `HTTP ${String(response.status)}`),
      details: payload.details ?? {},
    }
  }
  return {
    ok: false,
    code: 'file-extension/operation-failed',
    message: response.status === 401 || response.status === 403
      ? 'the request was not authorized'
      : `HTTP ${String(response.status)}`,
    details: {},
  }
}

/**
 * Fold a carrier failure into the shared result shape.
 *
 * @param {unknown} error - the caught value.
 * @returns {ApiFailure} the failure.
 */
function transportFailure(error) {
  if (error?.name === 'AbortError') {
    return { ok: false, code: 'file-extension/cancelled', message: 'the request was cancelled', details: {} }
  }
  return {
    ok: false,
    code: 'file-extension/operation-failed',
    message: String(error?.message ?? error),
    details: {},
  }
}

/** Host capability report, as `/capabilities` returns it. */
/**
 * @typedef {object} HostCapabilities
 * @property {string} platform
 * @property {string} separator
 * @property {{ supported: boolean, strategy: string, reason?: string }} trash
 * @property {boolean} permanentDeleteFallback
 * @property {number} maxDownloadBytes
 * @property {string} saveAs
 */

/**
 * Read what this Host can do. Cached per page for the plugin's lifetime, with a
 * retry on the next call when the read fails.
 *
 * @returns {Promise<HostCapabilities | null>} the capabilities, or null on failure.
 */
let cachedCapabilities
export function hostCapabilities() {
  if (cachedCapabilities !== undefined) return cachedCapabilities
  cachedCapabilities = get('capabilities').then((result) => {
    if (!result.ok) {
      cachedCapabilities = undefined
      return null
    }
    return result.value
  })
  return cachedCapabilities
}

/** Reset the capability cache; used after a failed trash attempt. */
export function invalidateCapabilities() {
  cachedCapabilities = undefined
}

export const api = {
  /** Metadata for one path. */
  stat: (path, sessionId) => post('stat', { path, sessionId }),
  /** Rename one entry in place. */
  rename: (path, name, sessionId) => post('rename', { path, name, sessionId }),
  /** Trash or permanently delete one entry. */
  remove: (path, mode, sessionId) => post('remove', { path, options: { mode }, sessionId }),
  /** Write a "Save as" copy. */
  copy: (path, options, sessionId) => post('copy', { path, options, sessionId }),
  /** Read a file for the browser-download fallback. */
  download: (path, sessionId) => post('download', { path, sessionId }),
}
