/**
 * Host half of dsh-expert-hub.
 *
 * Wires the four pieces together and owns nothing else:
 *   - `paths`       — where the library and sidecar live
 *   - `selections`  — durable per-session expert choice
 *   - `switcher`    — compose/dispose transaction, restore on agent creation
 *   - `routes`      — the `/expert-hub/*` HTTP surface
 *
 * A hard `webServer` dependency keeps the plugin inert in hosts without the
 * browser carrier; the command and lifecycle listeners are staged so a late
 * service still gets wired.
 *
 * @module dsh-expert-hub
 */

import { registerExpertCommand } from './src/command.js'
import { disposeStaleCompositions } from './src/compose.js'
import { createPaths } from './src/paths.js'
import { createRoutes } from './src/routes.js'
import { openSelections } from './src/selections.js'
import { createSwitcher } from './src/switch.js'
import { EXPERT_AUTHORING_PROMPT, registerExpertTools } from './src/tools.js'
import { DEFAULT_SOURCE_PATH } from './src/workbuddy.js'

/** Cordis plugin name. */
export const name = 'dsh-expert-hub'

/** The browser carrier is the only hard dependency. */
export const inject = ['webServer']

/** Session id across the host's agent shapes. */
function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.sessionId ?? agent?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ sourcePath?: string, dshHome?: string }} [config]
 */
export async function apply(ctx, config = {}) {
  const warn = (message) => ctx.logger?.warn?.(`dsh-expert-hub: ${message}`)
  const paths = createPaths({
    dshHome: typeof config.dshHome === 'string' ? config.dshHome : undefined,
    sourcePath: typeof config.sourcePath === 'string' && config.sourcePath.trim() !== ''
      ? config.sourcePath
      : DEFAULT_SOURCE_PATH,
  })

  const selections = await openSelections(paths.stateFile, { warn })

  // A reload leaves old scoped sections/skills on live agents; release them
  // before this instance registers anything new.
  disposeStaleCompositions()

  /** Resolve one live agent by session id, tolerant of host service shapes. */
  function resolveAgent(sessionId) {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || agents === null) return undefined
    if (typeof agents.get === 'function') {
      const direct = agents.get(sessionId)
      if (direct !== undefined && direct !== null) return direct
    }
    if (typeof agents.list === 'function') {
      return agents.list().find((agent) => sessionIdOf(agent) === sessionId)
    }
    return undefined
  }

  let routes
  const switcher = createSwitcher({
    paths,
    selections,
    resolveAgent,
    logger: { warn },
    onChange: () => routes?.bump?.(),
  })

  /** Read-only diagnostics: live agents plus one session's registered skills. */
  async function diagnostics(sessionId) {
    const agentsService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    let agents = []
    try {
      if (agentsService !== undefined && typeof agentsService.list === 'function') {
        agents = agentsService.list().map((agent) => ({ sessionId: sessionIdOf(agent), status: agent.status }))
      }
    } catch (error) {
      warn(`diagnostics agents failed: ${error?.message ?? error}`)
    }
    const agent = typeof sessionId === 'string' && sessionId !== '' ? resolveAgent(sessionId) : undefined
    let skills = []
    if (agent !== undefined) {
      const skillsService = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
      if (skillsService !== undefined && typeof skillsService.list === 'function') {
        try {
          const list = await skillsService.list({ scope: agent })
          skills = list.map((skill) => ({
            name: skill.name,
            description: skill.description,
            provider: skill.provider,
            source: skill.source,
          }))
        } catch (error) {
          skills = [{ error: error?.message ?? String(error) }]
        }
      }
    }
    return { agents, skills }
  }

  routes = createRoutes({
    paths,
    switcher,
    selections,
    ensureApplied: (sessionId) => switcher.ensureApplied(sessionId),
    diagnostics,
    logger: { warn },
  })

  ctx.effect(() => routes.mount(ctx.webServer), 'dsh-expert-hub:routes')

  // Restore a stored expert when its session's agent appears, release the
  // composition when the agent goes away (the selection survives for the next
  // resume), and forget the selection when the session itself is disposed.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {}
    const offs = []
    try {
      offs.push(ctx.on('agent/created', (payload) => {
        const agent = payload?.agent ?? payload
        return switcher.restore(agent).catch((error) => warn(`恢复专家失败：${error?.message ?? error}`))
      }))
    } catch (error) {
      warn(`agent/created 监听注册失败：${error?.message ?? error}`)
    }
    try {
      offs.push(ctx.on('agent/disposed', (payload) => {
        const agent = payload?.agent ?? payload
        const id = agent?.session?.id ?? agent?.sessionId ?? agent?.id
        if (typeof id === 'string') switcher.release(id)
      }))
    } catch (error) {
      warn(`agent/disposed 监听注册失败：${error?.message ?? error}`)
    }
    try {
      offs.push(ctx.on('session/disposed', (session) => {
        const id = session?.id ?? session?.sessionId
        if (typeof id === 'string') switcher.forget(id)
      }))
    } catch (error) {
      warn(`session/disposed 监听注册失败：${error?.message ?? error}`)
    }
    return () => {
      for (const off of offs) {
        try {
          off?.()
        } catch {
          // already disposed
        }
      }
    }
  }, 'dsh-expert-hub:lifecycle')

  ctx.inject(['commands'], (commandsCtx) => {
    ctx.effect(() => registerExpertCommand(commandsCtx, { paths, switcher }), 'dsh-expert-hub:command')
  })

  // The AI-mediated import surface: `expert_import` reads one source (or
  // writes one model-normalized expert). Staged so a late tools service still
  // gets the registration.
  ctx.inject(['tools'], (toolsCtx) => {
    ctx.effect(
      () => registerExpertTools(toolsCtx, { paths, switcher, logger: { warn } }),
      'dsh-expert-hub:tools',
    )
  })

  // Authoring guidance for chat-created experts. Guarded because the prompt
  // service is session-scoped in some hosts; when absent the tool description
  // and action="guide" still carry the same standard.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    if (promptCtx.systemPrompt === undefined || typeof promptCtx.systemPrompt.section !== 'function') return
    ctx.effect(
      () => promptCtx.systemPrompt.section({
        name: 'expert-authoring',
        order: 140,
        text: EXPERT_AUTHORING_PROMPT,
      }),
      'dsh-expert-hub:authoring-prompt',
    )
  })

  ctx.effect(() => () => {
    switcher.dispose()
    void selections.flush()
  }, 'dsh-expert-hub:teardown')
}
