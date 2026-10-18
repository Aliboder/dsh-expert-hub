/**
 * The expert switch transaction.
 *
 * One serialized chain per session. A switch never leaves the session worse
 * than it found it: the new composition is built in the same scope after the
 * old one is disposed, and a failure re-composes the previous expert before
 * surfacing the error.
 *
 * The selection is also persisted through the sidecar so it survives a Host
 * restart, and `restore()` replays it when the agent appears.
 *
 * @module dsh-expert-hub/switch
 */

import { composeExpert } from './compose.js'
import { readInstalledDetail } from './store.js'

const IDLE_TIMEOUT_MS = 60_000

/** Resolve the session id of a live agent across the known shapes. */
export function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.sessionId ?? agent?.id
  return typeof id === 'string' ? id : undefined
}

/** Wait until the agent is idle, bounded so a stuck turn cannot block forever. */
async function waitIdle(agent, logger) {
  if (agent === null || typeof agent !== 'object') return
  if (agent.status !== 'running' || typeof agent.whenIdle !== 'function') return
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger?.warn?.('等待会话空闲超时，仍在当前轮次边界挂载专家')
      resolve()
    }, IDLE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
  })
  await Promise.race([Promise.resolve(agent.whenIdle()).catch(() => {}), timeout])
}

/**
 * Create the switcher.
 *
 * @param {object} options
 * @param {object} options.paths
 * @param {object} options.selections - openSelections() result
 * @param {(sessionId: string) => object|undefined} options.resolveAgent
 * @param {{warn?: (message: string) => void}} [options.logger]
 * @param {() => void} [options.onChange] - called after a selection changed
 */
export function createSwitcher(options) {
  const { paths, selections, resolveAgent } = options
  const logger = options.logger ?? {}
  const warn = logger.warn ?? (() => {})
  const onChange = options.onChange ?? (() => {})

  /** Resolve the storage paths for one library in one session. */
  async function pathsFor(sessionId, library, workspace = '') {
    if (library !== 'project') return paths
    if (typeof options.resolvePaths !== 'function') throw new Error('当前环境不支持项目级专家')
    const scoped = await options.resolvePaths(sessionId, 'project', workspace)
    if (scoped === undefined || scoped === null) throw new Error('当前会话没有项目目录，无法使用项目级专家')
    return scoped
  }

  /** sessionId → { expertId, library, workspace, paths, composition, displayName } */
  const states = new Map()
  /** sessionId → tail promise (serial chain) */
  const chains = new Map()
  /** sessionId → a waiter is composing after the current turn ends */
  const pending = new Set()

  /** Run `task` after the session's previous transaction settled. */
  function serialize(sessionId, task) {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => {})
    chains.set(sessionId, tail)
    void tail.finally(() => {
      if (chains.get(sessionId) === tail) chains.delete(sessionId)
    })
    return run
  }

  /** Project one session's state for the wire. */
  function current(sessionId) {
    const state = typeof sessionId === 'string' ? states.get(sessionId) : undefined
    const stored = typeof sessionId === 'string' ? selections.get(sessionId) : undefined
    const expertId = state?.expertId ?? stored?.expertId ?? null
    if (expertId === null) return { sessionId, expertId: null, library: 'global', workspace: '', applied: false }
    return {
      sessionId,
      expertId,
      library: state?.library ?? stored?.library ?? 'global',
      workspace: state?.workspace ?? stored?.workspace ?? '',
      displayName: state?.displayName,
      applied: state !== undefined,
    }
  }

  /** Dispose the live composition of one session (no sidecar write). */
  function disposeState(sessionId) {
    const state = states.get(sessionId)
    if (state === undefined) return
    try {
      state.composition?.dispose?.()
    } catch (error) {
      warn(`卸载专家「${state.expertId}」时出错：${error?.message ?? error}`)
    }
    states.delete(sessionId)
  }

  /** Compose `detail` onto `agent`, leaving `previous` recoverable on failure. */
  async function recompose(agent, detail, sessionId, scopedPaths = paths, workspace = '') {
    const previous = states.get(sessionId)
    disposeState(sessionId)
    try {
      const composition = composeExpert(agent, detail, logger)
      states.set(sessionId, {
        expertId: detail.card?.id ?? detail.id,
        library: scopedPaths.scope === 'project' ? 'project' : 'global',
        workspace: scopedPaths.scope === 'project' ? (workspace || scopedPaths.projectRoot || '') : '',
        paths: scopedPaths,
        displayName: detail.card?.displayName,
        composition,
      })
      return composition
    } catch (error) {
      // Roll back to the expert that was mounted before this attempt.
      if (previous !== undefined) {
        try {
          const previousDetail = await readInstalledDetail(previous.paths ?? paths, previous.expertId)
          const composition = composeExpert(agent, previousDetail, logger)
          states.set(sessionId, {
            expertId: previousDetail.card?.id ?? previous.expertId,
            library: previous.library ?? 'global',
            workspace: previous.workspace ?? '',
            paths: previous.paths ?? paths,
            displayName: previousDetail.card?.displayName,
            composition,
          })
        } catch (rollbackError) {
          warn(`切换失败后无法恢复原专家：${rollbackError?.message ?? rollbackError}`)
        }
      }
      throw error
    }
  }

  /**
   * Switch (or clear) one session's expert.
   *
   * @param {string} sessionId
   * @param {string|null} expertId - null clears the expert
   */
  async function switchTo(sessionId, expertId, library = 'global', workspace = '') {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('缺少会话 id')
    // Clearing is immediate: it must cancel any switch still waiting for the
    // current turn to finish, and it must never block behind that wait.
    if (expertId === null || expertId === '') {
      disposeState(sessionId)
      selections.set(sessionId, null)
      onChange()
      return { sessionId, expertId: null, library: 'global', workspace: '', applied: true }
    }
    const scope = library === 'project' ? 'project' : 'global'
    const workspacePath = scope === 'project' && typeof workspace === 'string' ? workspace : ''
    const scopedPaths = await pathsFor(sessionId, scope, workspacePath)
    return serialize(sessionId, async () => {
      const agent = resolveAgent(sessionId)
      const detail = await readInstalledDetail(scopedPaths, expertId)
      const displayName = detail.card?.displayName
      if (agent === undefined || agent === null) {
        // No live agent yet: remember the choice; restore() applies it later.
        selections.set(sessionId, expertId, scope, workspacePath)
        onChange()
        return { sessionId, expertId, library: scope, workspace: workspacePath, displayName, applied: false }
      }
      const same = states.get(sessionId)
      if (same !== undefined && same.expertId === expertId && same.library === scope &&
        (scope !== 'project' || same.workspace === workspacePath)) {
        selections.set(sessionId, expertId, scope, workspacePath)
        onChange()
        return { sessionId, expertId, library: scope, workspace: workspacePath, displayName, applied: true }
      }
      // A running turn keeps its current prompt until the boundary. Persist the
      // choice and let ONE waiter apply whatever is selected after idle: a newer
      // switch or a clear simply overwrites the selection the waiter reads.
      if (agent.status === 'running' && typeof agent.whenIdle === 'function') {
        selections.set(sessionId, expertId, scope, workspacePath)
        onChange()
        if (!pending.has(sessionId)) {
          pending.add(sessionId)
          void (async () => {
            try {
              const live = resolveAgent(sessionId)
              if (live === undefined || live === null) return
              await waitIdle(live, logger)
              const stored = selections.get(sessionId)
              const target = stored?.expertId
              if (target === null || target === undefined) return
              const targetLibrary = stored?.library === 'project' ? 'project' : 'global'
              const targetWorkspace = typeof stored?.workspace === 'string' ? stored.workspace : ''
              const targetPaths = await pathsFor(sessionId, targetLibrary, targetWorkspace)
              const latest = await readInstalledDetail(targetPaths, target)
              await recompose(live, latest, sessionId, targetPaths, targetWorkspace)
              onChange()
            } catch (error) {
              warn(`排队切换专家失败：${error?.message ?? error}`)
            } finally {
              pending.delete(sessionId)
            }
          })().catch(() => {})
        }
        return { sessionId, expertId, library: scope, workspace: workspacePath, displayName, applied: false, queued: true }
      }
      await waitIdle(agent, logger)
      await recompose(agent, detail, sessionId, scopedPaths, workspacePath)
      selections.set(sessionId, expertId, scope, workspacePath)
      onChange()
      return { sessionId, expertId, library: scope, workspace: workspacePath, displayName, applied: true }
    })
  }

  /**
   * Replay a stored selection for a freshly created agent.
   * Failures are logged, never thrown into the agent lifecycle.
   */
  async function restore(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    if (states.has(sessionId)) return
    const stored = selections.get(sessionId)
    if (stored === undefined || stored.expertId === null) return
    try {
      const library = stored.library === 'project' ? 'project' : 'global'
      const workspace = typeof stored.workspace === 'string' ? stored.workspace : ''
      const scopedPaths = await pathsFor(sessionId, library, workspace)
      const detail = await readInstalledDetail(scopedPaths, stored.expertId)
      const composition = composeExpert(agent, detail, logger)
      states.set(sessionId, {
        expertId: detail.card?.id ?? stored.expertId,
        library,
        workspace,
        paths: scopedPaths,
        displayName: detail.card?.displayName,
        composition,
      })
      warn(`已恢复会话专家：${detail.card?.displayName ?? stored.expertId}`)
    } catch (error) {
      warn(`恢复会话专家失败：${error?.message ?? error}`)
    }
  }

  /** Release one agent's composition but keep the stored selection (agent disposed). */
  function release(sessionId) {
    if (typeof sessionId !== 'string') return
    disposeState(sessionId)
    chains.delete(sessionId)
  }

  /** Forget one session: dispose its composition and delete its selection. */
  function forget(sessionId) {
    if (typeof sessionId !== 'string') return
    disposeState(sessionId)
    selections.remove(sessionId)
    chains.delete(sessionId)
    pending.delete(sessionId)
  }

  /**
   * Replay a stored selection once the agent exists (idempotent).
   * Used by the `/state` route so a cold-selected expert lands on its own.
   */
  async function ensureApplied(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (states.has(sessionId)) return
    if (pending.has(sessionId)) return
    const stored = selections.get(sessionId)
    if (stored === undefined || stored.expertId === null) return
    const agent = resolveAgent(sessionId)
    // A running agent is handled by the queued waiter; retrying from a polling
    // /state call would rewrite the selection on every poll.
    if (agent === undefined || agent === null || agent.status === 'running') return
    try {
      await switchTo(sessionId, stored.expertId, stored.library === 'project' ? 'project' : 'global',
        typeof stored.workspace === 'string' ? stored.workspace : '')
    } catch (error) {
      warn(`恢复会话专家失败：${error?.message ?? error}`)
    }
  }

  /** Dispose every composition (plugin unload). */
  function dispose() {
    for (const sessionId of [...states.keys()]) disposeState(sessionId)
    chains.clear()
  }

  return {
    switchTo,
    restore,
    release,
    forget,
    current,
    dispose,
    ensureApplied,
    hasComposition: (sessionId) => states.has(sessionId),
  }
}
