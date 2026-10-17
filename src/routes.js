/**
 * HTTP surface of dsh-expert-hub.
 *
 * Mounted as one prefix route (`/expert-hub`) on the shared webserver. The
 * handlers stay thin: scan/install/compose logic lives in the store, the
 * importers and the switcher; this module owns transport, caching, revision
 * accounting and the SSE change feed.
 *
 * Contract: docs/CONTRACT.md §7.
 *
 * @module dsh-expert-hub/routes
 */

import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { excerptOf, ID_RE } from './format.js'
import {
  HttpError,
  assertLoopback,
  assertMutation,
  openSse,
  queryOf,
  readJsonBody,
  sendError,
  sendJson,
} from './http.js'
import { displayPath } from './paths.js'
import {
  avatarFileOf,
  cardFromDraft,
  installDraft,
  installedState,
  readAvailableDraft,
  readInstalledDetail,
  scanAvailable,
} from './store.js'

const PREFIX = '/expert-hub'
const CACHE_MS = 2000
const BODY_CAP = 1024 * 1024
const BODY_CAP_LARGE = 8 * 1024 * 1024
const MAX_IMPORT_IDS = 100
const CONTENT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** Error text never leaks a stack trace to the browser. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Convert any thrown value into the wire failure envelope. */
function fail(res, error) {
  if (error instanceof HttpError) {
    sendError(res, error.status, error.code, error.message)
    return
  }
  const message = messageOf(error)
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'EXPERT_HUB_FAILED'
  sendError(res, 400, code, message)
}

/**
 * Create the route set.
 *
 * @param {object} options
 * @param {object} options.paths
 * @param {object} options.switcher
 * @param {object} options.selections
 * @param {{warn?: (message: string) => void}} [options.logger]
 */
export function createRoutes({ paths, switcher, selections, ensureApplied, diagnostics, logger = {} }) {
  const warn = logger.warn ?? (() => {})
  const clients = new Set()
  const runtime = { revision: 1, cache: undefined, cacheAt: 0 }

  /** Notify every SSE client and invalidate the snapshot cache. */
  function bump() {
    runtime.revision += 1
    runtime.cache = undefined
    for (const client of [...clients]) {
      try {
        client.frame('state', { revision: runtime.revision })
      } catch {
        clients.delete(client)
      }
    }
  }

  /** Build (or reuse) the library snapshot used by `/state`. */
  async function snapshot() {
    const now = Date.now()
    if (runtime.cache !== undefined && now - runtime.cacheAt < CACHE_MS) return runtime.cache
    const installed = await installedState(paths)
    const available = await scanAvailable(paths, { installed })
    const counts = {
      installed: installed.cards.filter((card) => card.broken === undefined).length,
      available: available.cards.filter((card) => card.broken === undefined).length,
      updatable: available.cards.filter((card) => card.updatable === true).length,
    }
    const warnings = [...installed.warnings, ...available.warnings]
    const cache = {
      config: {
        sourcePath: displayPath(paths.sourcePath ?? ''),
        sourceExists: available.sourceExists === true,
        expertsRoot: displayPath(paths.expertsRoot),
      },
      counts,
      installed: installed.cards,
      available: available.cards,
      warnings,
    }
    runtime.cache = cache
    runtime.cacheAt = now
    return cache
  }

  /** Serialize one expert detail payload for the client. */
  async function detailOf(id, scope) {
    if (!ID_RE.test(String(id ?? ''))) throw new HttpError(400, 'INVALID_ID', '专家 id 不合法')
    if (scope === 'workbuddy') {
      const draft = await readAvailableDraft(paths, id)
      const installed = await installedState(paths)
      return {
        ok: true,
        card: cardFromDraft(draft, {
          installed: installed.ids.has(id),
          installedFingerprint: installed.fingerprints[id],
        }),
        roleText: draft.roleText ?? '',
        skills: (draft.skills ?? [])
          .filter((skill) => skill.hasSkillMd)
          .map((skill) => ({ name: skill.name, description: skill.description, content: skill.content })),
        meta: { sourcePath: '', agentFile: draft.origin?.agentFile ?? '' },
      }
    }
    const detail = await readInstalledDetail(paths, id)
    return { ok: true, ...detail }
  }

  /** Stream one avatar image, 404 for anything unresolvable. */
  async function avatarOf(req, res) {
    const query = queryOf(req)
    const id = query.get('id') ?? ''
    const scope = query.get('scope') ?? 'installed'
    const file = scope === 'workbuddy'
      ? (await readAvailableDraft(paths, id).catch(() => undefined))?.avatar ?? null
      : await avatarFileOf(paths, id).catch(() => null)
    if (file === null || file === undefined) {
      sendError(res, 404, 'NOT_FOUND', '没有头像')
      return
    }
    const ext = file.ext ?? extname(file.path)
    const contentType = CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
    try {
      const data = await readFile(file.path)
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'private, max-age=60',
        'content-length': data.length,
      })
      res.end(data)
    } catch {
      sendError(res, 404, 'NOT_FOUND', '没有头像')
    }
  }

  /** POST /import — copy WorkBuddy experts into the library. */
  async function handleImport(req, res) {
    const body = await readJsonBody(req, BODY_CAP)
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => ID_RE.test(String(id))).slice(0, MAX_IMPORT_IDS) : []
    if (ids.length === 0) throw new HttpError(400, 'NO_IDS', '没有要导入的专家')
    const imported = []
    const failed = []
    const installedNow = await installedState(paths)
    for (const id of ids) {
      try {
        const draft = await readAvailableDraft(paths, id)
        imported.push(await installDraft(draft, paths, { update: installedNow.ids.has(id) }))
      } catch (error) {
        failed.push({ id, error: messageOf(error) })
      }
    }
    if (imported.length > 0) bump()
    sendJson(res, 200, { ok: true, imported, failed })
  }

  /** POST /import-web | /import-path — install experts from a URL or folder. */
  async function handleSourceImport(req, res, kind) {
    const body = await readJsonBody(req, BODY_CAP_LARGE)
    const source = kind === 'web' ? body.url : body.path
    if (typeof source !== 'string' || source.trim() === '') {
      throw new HttpError(400, 'NO_SOURCE', kind === 'web' ? '请填写专家包网址' : '请填写本机目录或 .md 文件路径')
    }
    let importers
    try {
      importers = await import('./importers.js')
    } catch (error) {
      throw new HttpError(501, 'IMPORT_UNAVAILABLE', `导入模块不可用：${messageOf(error)}`)
    }
    let result
    try {
      result = kind === 'web'
        ? await importers.importFromUrl(source, { tmpRoot: join(paths.stateDir, 'tmp') })
        : await importers.importFromPath(source, { tmpRoot: join(paths.stateDir, 'tmp') })
    } catch (error) {
      throw new HttpError(400, 'IMPORT_FAILED', messageOf(error))
    }
    const drafts = Array.isArray(result?.drafts) ? result.drafts : []
    const imported = []
    const failed = []
    const experts = []
    try {
      for (const draft of drafts) {
        try {
          const installed = await installDraft(draft, paths)
          imported.push(installed)
          experts.push((await readInstalledDetail(paths, installed.id)).card)
        } catch (error) {
          failed.push({ id: draft.id, error: messageOf(error) })
        }
      }
    } finally {
      if (typeof result?.cleanup === 'function') await result.cleanup().catch(() => {})
    }
    if (imported.length > 0) bump()
    sendJson(res, 200, {
      ok: true,
      experts,
      imported,
      failed,
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    })
  }

  /** POST /create | /update | /delete — the authoring surface. */
  async function handleAuthor(req, res, action) {
    let author
    try {
      author = await import('./author.js')
    } catch (error) {
      throw new HttpError(501, 'AUTHOR_UNAVAILABLE', `创建/编辑模块不可用：${messageOf(error)}`)
    }
    const body = await readJsonBody(req, BODY_CAP_LARGE)
    if (action === 'create') {
      const input = { ...(body.expert ?? {}), avatarDataUrl: body.avatarDataUrl }
      const expert = await author.createExpert(input, paths)
      bump()
      sendJson(res, 200, { ok: true, expert })
      return
    }
    if (action === 'update') {
      const patch = { ...(body.patch ?? {}), roleText: body.roleText, avatarDataUrl: body.avatarDataUrl }
      const expert = await author.updateExpert(body.id, patch, paths)
      bump()
      sendJson(res, 200, { ok: true, expert })
      return
    }
    await author.deleteExpertCard(body.id, paths)
    switcher.forget(String(body.id ?? ''))
    bump()
    sendJson(res, 200, { ok: true })
  }

  /** One request dispatch. */
  async function handle(req, res) {
    assertLoopback(req)
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      throw new HttpError(400, 'BAD_URL', '请求地址不合法')
    }
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : url.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/state') {
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      if (typeof sessionId === 'string' && sessionId !== '' && typeof ensureApplied === 'function') {
        // Land a cold-session selection once the agent exists; never blocks
        // the snapshot response (the SSE `state` frame refreshes the client).
        void Promise.resolve(ensureApplied(sessionId)).catch(() => {})
      }
      const core = await snapshot()
      sendJson(res, 200, {
        ok: true,
        revision: runtime.revision,
        ...core,
        session: typeof sessionId === 'string' && sessionId !== '' ? switcher.current(sessionId) : undefined,
      })
      return
    }
    if (method === 'GET' && path === '/detail') {
      sendJson(res, 200, await detailOf(url.searchParams.get('id') ?? '', url.searchParams.get('scope') ?? 'installed'))
      return
    }
    if (method === 'GET' && path === '/avatar') {
      await avatarOf(req, res)
      return
    }
    if (method === 'GET' && path === '/events') {
      const client = openSse(res)
      clients.add(client)
      client.frame('state', { revision: runtime.revision })
      req.on('close', () => clients.delete(client))
      res.on('close', () => clients.delete(client))
      return
    }
    if (method === 'GET' && path === '/diagnostics') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const inspected = typeof diagnostics === 'function' ? await diagnostics(sessionId) : {}
      sendJson(res, 200, {
        ok: true,
        sessionId,
        expert: typeof sessionId === 'string' && sessionId !== '' ? switcher.current(sessionId) : undefined,
        ...inspected,
      })
      return
    }

    assertMutation(req)
    if (path === '/switch') {
      const body = await readJsonBody(req, BODY_CAP)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') throw new HttpError(400, 'NO_SESSION', '缺少会话 id')
      const expertId = body.expertId === null || body.expertId === undefined ? null : String(body.expertId)
      const session = await switcher.switchTo(sessionId, expertId)
      bump()
      sendJson(res, 200, { ok: true, session })
      return
    }
    if (path === '/refresh') {
      runtime.cache = undefined
      runtime.cacheAt = 0
      const core = await snapshot()
      bump()
      sendJson(res, 200, { ok: true, revision: runtime.revision, counts: core.counts })
      return
    }
    if (path === '/import') {
      await handleImport(req, res)
      return
    }
    if (path === '/import-path') {
      await handleSourceImport(req, res, 'path')
      return
    }
    if (path === '/create' || path === '/update' || path === '/delete') {
      await handleAuthor(req, res, path.slice(1))
      return
    }
    throw new HttpError(404, 'NOT_FOUND', '未知的接口')
  }

  /**
   * Register the prefix route.
   * @param {{register: Function}} webServer
   * @returns {() => void} disposer
   */
  function mount(webServer) {
    const off = webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        void handle(req, res).catch((error) => {
          if (!res.writableEnded) fail(res, error)
        })
      },
    })
    return () => {
      off?.()
      for (const client of [...clients]) client.end()
      clients.clear()
    }
  }

  return { mount, bump, snapshot, sessions: selections }
}
