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

  /** sessionId → { expertId, composition, displayName } */
  const states = new Map()
  /** sessionId → tail promise (serial chain) */
  const chains = new Map()

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
    if (expertId === null) return { sessionId, expertId: null, applied: false }
    return {
      sessionId,
      expertId,
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
  async function recompose(agent, detail, sessionId) {
    const previous = states.get(sessionId)
    disposeState(sessionId)
    try {
      const composition = composeExpert(agent, detail, logger)
      states.set(sessionId, {
        expertId: detail.card?.id ?? detail.id,
        displayName: detail.card?.displayName,
        composition,
      })
      return composition
    } catch (error) {
      // Roll back to the expert that was mounted before this attempt.
      if (previous !== undefined) {
        try {
          const previousDetail = await readInstalledDetail(paths, previous.expertId)
          const composition = composeExpert(agent, previousDetail, logger)
          states.set(sessionId, {
            expertId: previousDetail.card?.id ?? previous.expertId,
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
  async function switchTo(sessionId, expertId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('缺少会话 id')
    return serialize(sessionId, async () => {
      const agent = resolveAgent(sessionId)
      if (expertId === null || expertId === '') {
        disposeState(sessionId)
        selections.set(sessionId, null)
        onChange()
        return { sessionId, expertId: null, applied: true }
      }
      const detail = await readInstalledDetail(paths, expertId)
      const displayName = detail.card?.displayName
      if (agent === undefined || agent === null) {
        // No live agent yet: remember the choice; restore() applies it later.
        selections.set(sessionId, expertId)
        onChange()
        return { sessionId, expertId, displayName, applied: false }
      }
      const same = states.get(sessionId)
      if (same !== undefined && same.expertId === expertId) {
        selections.set(sessionId, expertId)
        onChange()
        return { sessionId, expertId, displayName, applied: true }
      }
      await waitIdle(agent, logger)
      await recompose(agent, detail, sessionId)
      selections.set(sessionId, expertId)
      onChange()
      return { sessionId, expertId, displayName, applied: true }
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
      const detail = await readInstalledDetail(paths, stored.expertId)
      const composition = composeExpert(agent, detail, logger)
      states.set(sessionId, {
        expertId: detail.card?.id ?? stored.expertId,
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
  }

  /**
   * Replay a stored selection once the agent exists (idempotent).
   * Used by the `/state` route so a cold-selected expert lands on its own.
   */
  async function ensureApplied(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (states.has(sessionId)) return
    const stored = selections.get(sessionId)
    if (stored === undefined || stored.expertId === null) return
    if (resolveAgent(sessionId) === undefined) return
    try {
      await switchTo(sessionId, stored.expertId)
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
