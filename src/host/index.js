/**
 * dsh-file-extension — Host half.
 *
 * Registers the browser-facing HTTP routes that back the right Sidebar's file
 * context menu. Every route is authenticated through the deployment's browser
 * credential (`ctx.connection.requestRejection`), so a plugin route is exactly
 * as protected as an official one.
 *
 * This half owns everything that needs Node: recycle-bin deletion, rename,
 * save-as copies, and reading a file for the browser-download fallback. The
 * browser half owns only presentation.
 *
 * @module dsh-file-extension
 */

import { MAX_DOWNLOAD_BYTES, FAILURE_CODES } from './contract.js'
import { copyToPath, createPath, readForDownload, removePath, renamePath, statPath } from './fsops.js'
import { probeTrash } from './trash.js'
import { applyUpdate, checkForUpdate, isLoopbackRequest } from './update.js'

/** Route prefix. One plugin, one namespace, mirroring `/api/<plugin>/*`. */
const ROUTE_PREFIX = '/api/dsh-file-extension/'

/** Largest request body any route accepts; these payloads are tiny JSON objects. */
const MAX_BODY_BYTES = 64 * 1024

/** Services this plugin needs. `webServer` and `connection` are optional so the
 * plugin stays inert (rather than throwing) in a composition without a browser. */
export const inject = ['webServer', 'connection']

/** Plugin display name, read by the Loader. */
export const name = 'dsh-file-extension'

/**
 * Tunables the user may set in `cordis.patch.yml`.
 *
 * Declared as a plain standard-schema object (`~standard.validate`) rather than
 * a schemastery schema, so the Host half needs no runtime dependency on
 * `@deepseek-ai/schemastery` — which is not a dependency of this package and
 * would otherwise have to be installed just to boot.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-file-extension',
    validate(value) {
      const input = value !== null && typeof value === 'object' ? value : {}
      const maxDownloadBytes = Number.isFinite(input.maxDownloadBytes)
        ? Number(input.maxDownloadBytes)
        : MAX_DOWNLOAD_BYTES
      const allowPermanentDeleteFallback = input.allowPermanentDeleteFallback !== false
      return { value: { maxDownloadBytes, allowPermanentDeleteFallback } }
    },
  },
}

/**
 * Resolve the workspace root of one Session.
 *
 * The tree only lists inside this root, so it is also the containment fence that
 * keeps the plugin from becoming a general-purpose filesystem API for the page.
 *
 * A request naming no Session, or naming one this host has never seen, resolves
 * to nothing. That is treated as a refusal by every caller rather than as "no
 * fence": failing open here would let an unauthenticated-shaped request reach
 * any path on the machine, which is exactly what the fence exists to prevent.
 *
 * @param {object} ctx - owning Cordis context.
 * @param {string | undefined} sessionId - Session named by the request.
 * @returns {{ root: string | undefined, found: boolean }} the root, and whether
 *   the Session was actually resolved.
 */
function workspaceRootOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { root: undefined, found: false }
  }
  try {
    const session = ctx.get('sessions')?.get(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return { root: cwd, found: true }
    return { root: undefined, found: false }
  } catch {
    return { root: undefined, found: false }
  }
}

/**
 * Read the Session identity and fence for one request, refusing an unresolvable
 * Session with the plugin's own failure shape.
 *
 * @param {object} ctx - owning Cordis context.
 * @param {object} body - the parsed request body.
 * @returns {{ root: string } | { refusal: object }} the fence, or the refusal.
 */
function fenceFor(ctx, body) {
  const { root, found } = workspaceRootOf(ctx, body?.sessionId)
  if (!found) {
    return {
      refusal: {
        code: FAILURE_CODES.outsideWorkspace,
        message: 'the request names no Session this host can resolve',
        details: { sessionResolved: false },
      },
    }
  }
  return { root }
}

/**
 * Send one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serialisable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * Send one failed outcome as an HTTP error, keeping the plugin's stable code.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {{ code: string, message: string, details?: object }} outcome - the failure.
 */
function sendFailure(res, outcome) {
  const status = outcome.code === FAILURE_CODES.notFound
    ? 404
    : outcome.code === FAILURE_CODES.invalidName || outcome.code === FAILURE_CODES.outsideWorkspace
      ? 400
      : outcome.code === FAILURE_CODES.alreadyExists
        ? 409
        : outcome.code === FAILURE_CODES.tooLarge
          ? 413
          : outcome.code === FAILURE_CODES.unsupported
            ? 422
            : 500
  sendJson(res, status, {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    details: outcome.details ?? {},
  })
}

/**
 * Read and parse a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object | null>} the parsed object, or null when unusable.
 */
function readJsonBody(req) {
  return new Promise((settle) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settle(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        settle({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settle(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        settle(null)
      }
    })
    req.on('error', () => settle(null))
  })
}

/**
 * Install the Host half.
 *
 * @param {object} ctx - owning Cordis context.
 * @param {Partial<typeof Config>} [config] - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
  const resolved = {
    maxDownloadBytes: Number.isFinite(config?.maxDownloadBytes) ? config.maxDownloadBytes : MAX_DOWNLOAD_BYTES,
    allowPermanentDeleteFallback: config?.allowPermanentDeleteFallback !== false,
  }

  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || connection === undefined) {
    // No browser carrier in this composition: stay inert instead of throwing,
    // so a headless or API-only profile still boots with the plugin installed.
    return
  }

  // Trash capability is probed once per process and cached: it spawns a helper
  // process on Windows, which is far too expensive to repeat per menu open.
  let trashCapability
  const capabilities = async () => {
    if (trashCapability === undefined) {
      trashCapability = probeTrash()
    }
    return trashCapability
  }
  // A failed probe must not poison the cache forever; drop it so the next menu
  // open retries, which recovers after a transient PowerShell failure.
  const capabilitiesSafe = async () => {
    try {
      const value = await capabilities()
      return value
    } catch (error) {
      trashCapability = undefined
      return { supported: false, strategy: 'none', reason: String(error?.message ?? error) }
    }
  }

  /**
   * Answer an untrusted request; true when it was already rejected.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {boolean} whether the request was refused.
   */
  const rejected = (req, res) => {
    let rejection
    try {
      rejection = connection.requestRejection(req)
    } catch {
      // A malformed request cannot be trusted either.
      rejection = 403
    }
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /**
   * Wrap one route: method check, authentication, then the handler.
   *
   * @param {string} method - required HTTP method.
   * @param {(req: object, res: object) => Promise<void>} handler - the body.
   * @returns {(req: object, res: object) => Promise<void>} the wrapped handler.
   */
  const route = (method, handler) => async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== method) {
      res.statusCode = 405
      res.setHeader('allow', method)
      res.end()
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      // Nothing may escape into the carrier: a thrown route would surface as a
      // broken response rather than a readable plugin error.
      sendJson(res, 500, {
        ok: false,
        code: FAILURE_CODES.operationFailed,
        message: String(error?.message ?? error),
        details: {},
      })
    }
  }

  /** GET /capabilities — what this host can do, plus platform facts. */
  const capabilitiesHandler = route('GET', async (_req, res) => {
    const trash = await capabilitiesSafe()
    sendJson(res, 200, {
      ok: true,
      value: {
        platform: process.platform,
        separator: process.platform === 'win32' ? '\\' : '/',
        trash: { supported: trash.supported, strategy: trash.strategy, reason: trash.reason },
        permanentDeleteFallback: resolved.allowPermanentDeleteFallback,
        maxDownloadBytes: resolved.maxDownloadBytes,
        // The save-as flow uses the native directory picker plus a name field,
        // because dsh's desktop shell exposes no save dialog.
        saveAs: 'directory-picker',
      },
    })
  })

  /** POST /stat — metadata for one path. */
  const statHandler = route('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: 'the request body is not JSON', details: {} })
      return
    }
    const fence = fenceFor(ctx, body)
    if (fence.refusal !== undefined) {
      sendFailure(res, fence.refusal)
      return
    }
    const outcome = await statPath(body.path, fence.root)
    if (outcome.ok) sendJson(res, 200, outcome)
    else sendFailure(res, outcome)
  })

  /** POST /rename — rename one entry in place. */
  const renameHandler = route('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: 'the request body is not JSON', details: {} })
      return
    }
    const fence = fenceFor(ctx, body)
    if (fence.refusal !== undefined) {
      sendFailure(res, fence.refusal)
      return
    }
    const outcome = await renamePath(body.path, body.name, fence.root)
    if (outcome.ok) sendJson(res, 200, outcome)
    else sendFailure(res, outcome)
  })

  /** POST /remove — trash or permanently delete one entry. */
  const removeHandler = route('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: 'the request body is not JSON', details: {} })
      return
    }
    const mode = body?.options?.mode === 'permanent' ? 'permanent' : 'trash'
    if (mode === 'permanent' && !resolved.allowPermanentDeleteFallback) {
      sendFailure(res, {
        code: FAILURE_CODES.unsupported,
        message: 'permanent deletion is disabled by plugin configuration',
        details: { disabled: true },
      })
      return
    }
    const fence = fenceFor(ctx, body)
    if (fence.refusal !== undefined) {
      sendFailure(res, fence.refusal)
      return
    }
    const outcome = await removePath(body.path, { mode }, fence.root)
    if (outcome.ok) sendJson(res, 200, outcome)
    else sendFailure(res, outcome)
  })

  /** POST /copy — write a "Save as" copy without touching the source. */
  const copyHandler = route('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: 'the request body is not JSON', details: {} })
      return
    }
    const fence = fenceFor(ctx, body)
    if (fence.refusal !== undefined) {
      sendFailure(res, fence.refusal)
      return
    }
    const outcome = await copyToPath(
      body.path,
      {
        directory: body?.options?.directory,
        name: body?.options?.name,
        overwrite: body?.options?.overwrite === true,
      },
      fence.root,
    )
    if (outcome.ok) sendJson(res, 200, outcome)
    else sendFailure(res, outcome)
  })

  /** POST /download — bounded file bytes for the browser-download fallback. */
  const downloadHandler = route('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: 'the request body is not JSON', details: {} })
      return
    }
    const fence = fenceFor(ctx, body)
    if (fence.refusal !== undefined) {
      sendFailure(res, fence.refusal)
      return
    }
    const outcome = await readForDownload(
      body.path,
      { maxBytes: resolved.maxDownloadBytes },
      fence.root,
    )
    if (outcome.ok) sendJson(res, 200, outcome)
    else sendFailure(res, outcome)
  })

  /** POST /create — create one new file or directory inside a directory. */
  const createHandler = route('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: 'the request body is not JSON', details: {} })
      return
    }
    const fence = fenceFor(ctx, body)
    if (fence.refusal !== undefined) {
      sendFailure(res, fence.refusal)
      return
    }
    const outcome = await createPath(
      body.directory,
      { name: body.name, kind: body.kind === 'directory' ? 'directory' : 'file' },
      fence.root,
    )
    if (outcome.ok) sendJson(res, 200, outcome)
    else sendFailure(res, outcome)
  })

  /**
   * GET /update-check — which version is installed, and which one GitHub offers.
   *
   * Reads GitHub only; it never touches the installed package, so it is safe to
   * call from any authorized browser session.
   */
  const updateCheckHandler = route('GET', async (_req, res) => {
    const outcome = await checkForUpdate()
    if (outcome.ok) {
      sendJson(res, 200, outcome)
      return
    }
    // A check that could not reach GitHub is not an HTTP error: the caller wants
    // the reason rendered, not a failed request. The plugin's own code is kept in
    // `details` so the Client can still branch on it.
    sendJson(res, 200, {
      ok: true,
      value: { current: outcome.details?.current, latest: null, hasUpdate: false, upToDate: null, error: outcome.message, code: outcome.code },
    })
  })

  /**
   * POST /update-apply — install the newest release of this plugin.
   *
   * This is the only route that changes what is installed, so it carries the
   * deployment's own authorization AND a loopback fence: a remote browser must
   * not be able to reinstall a plugin on the host machine.
   */
  const updateApplyHandler = route('POST', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      sendFailure(res, {
        code: FAILURE_CODES.unsupported,
        message: 'updating the plugin is only allowed from the host machine itself',
        details: { loopbackRequired: true },
      })
      return
    }
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, code: FAILURE_CODES.operationFailed, message: 'the request body is not JSON', details: {} })
      return
    }
    const outcome = await applyUpdate(ctx, { spec: body.spec })
    if (outcome.ok) sendJson(res, 200, outcome)
    else sendFailure(res, outcome)
  })

  // Every registration is an effect: unloading the plugin removes the routes,
  // so nothing survives an uninstall or a hot reload.
  const routes = [
    ['capabilities', capabilitiesHandler],
    ['stat', statHandler],
    ['rename', renameHandler],
    ['remove', removeHandler],
    ['copy', copyHandler],
    ['download', downloadHandler],
    ['create', createHandler],
    ['update-check', updateCheckHandler],
    ['update-apply', updateApplyHandler],
  ]
  for (const [name, handler] of routes) {
    ctx.effect(
      () => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}${name}`,
        handler,
      }),
      `dsh-file-extension: ${name}`,
    )
  }

  ctx.logger?.info?.('dsh-file-extension: file menu routes registered')
}

export { ROUTE_PREFIX }
