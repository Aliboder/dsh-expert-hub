/**
 * Session composition: attach one installed expert to a live agent.
 *
 * An expert contributes exactly two things, both registered inside the
 * agent's scoped context so they unwind with the session:
 *   - a `systemPrompt.section` (name `expert-role`, order 150) carrying the
 *     role body plus one meta line;
 *   - its `skills/* /SKILL.md` bodies through the layered `skills` service,
 *     each with `resourceBase` so relative `scripts/` and `references/`
 *     references resolve.
 *
 * No scripts, no plugin rows, no tool restrictions: the import pipeline strips
 * everything an expert could execute.
 *
 * @module dsh-expert-hub/compose
 */

import { join } from 'node:path'

import { excerptOf, sanitizeRoleText } from './format.js'

/** Prompt section owned by this plugin (one per agent scope). */
export const ROLE_SECTION_NAME = 'expert-role'

/** Documented free band: after the deployment persona, before PLAN_POLICY. */
export const ROLE_SECTION_ORDER = 150

/**
 * Process-global composition registry.
 *
 * A plugin reload (bundle toggle, HMR) disposes the old module instance but the
 * live agents keep their scoped registrations. Keeping the disposers on
 * `globalThis` lets the next apply() release those orphan sections/skills
 * instead of leaving a stale expert persona on a running agent.
 */
const REGISTRY_KEY = '__dshExpertHubCompositions'

/** @returns {Map<string, () => void>} */
function compositionRegistry() {
  if (globalThis[REGISTRY_KEY] === undefined) globalThis[REGISTRY_KEY] = new Map()
  return globalThis[REGISTRY_KEY]
}

/** Dispose every composition left behind by a previous plugin instance. */
export function disposeStaleCompositions() {
  const registry = compositionRegistry()
  for (const [key, dispose] of [...registry.entries()]) {
    try {
      dispose()
    } catch {
      // A stale disposer may already be invalid; never block plugin startup.
    }
    registry.delete(key)
  }
}

/** One line that tells the model which expert persona it is running. */
export function roleMetaLine(detail) {
  const name = detail.card?.displayName ?? detail.card?.id ?? detail.id ?? '专家'
  return `你当前以「${name}」专家身份工作。角色与技能来自用户的专家库；切换或取消由用户在输入框旁的专家胶囊里完成。`
}

/** Render the degraded catalog used when the skills service is unavailable. */
function fallbackCatalog(detail) {
  const lines = ['以下技能以文本形式随角色提供（skills 服务不可用）：']
  for (const skill of detail.skills ?? []) {
    lines.push(`## skill: ${skill.name}\n${skill.content ?? ''}`)
  }
  return lines.join('\n')
}

/**
 * Register the expert's skills into the agent scope.
 *
 * @returns {{ disposers: Array<() => void>, failed: string[] }}
 */
export function registerSkills(agentCtx, detail, logger) {
  const warn = logger?.warn ?? (() => {})
  const skills = (detail.skills ?? []).filter((skill) => typeof skill.content === 'string' && skill.content !== '')
  const disposers = []
  const failed = []
  if (skills.length === 0) return { disposers, failed }
  const skillsService = typeof agentCtx.get === 'function' ? agentCtx.get('skills') : undefined
  if (skillsService === undefined || typeof skillsService.register !== 'function') {
    warn('skills 服务不可用，专家技能降级为角色文本')
    return { disposers, failed: skills.map((skill) => skill.name) }
  }
  for (const skill of skills) {
    try {
      disposers.push(
        skillsService.register({
          name: skill.name,
          description: skill.description || excerptOf(skill.content, 120),
          content: skill.content,
          path: typeof skill.path === 'string' ? skill.path : undefined,
          source: 'custom',
          provider: `expert-hub:${detail.card?.id ?? detail.id ?? 'expert'}`,
          resourceBase: typeof skill.path === 'string'
            ? { kind: 'directory', path: join(skill.path, '..') }
            : undefined,
        }),
      )
    } catch (error) {
      failed.push(skill.name)
      warn(`技能 "${skill.name}" 注册失败：${error?.message ?? error}`)
    }
  }
  return { disposers, failed }
}

/**
 * Compose one expert onto a live agent.
 *
 * Everything registered before a throw is disposed again, so a failed compose
 * never leaves ghost skills or a ghost section behind.
 *
 * @param {object} agent - live agent (`agent.ctx` is its scoped context)
 * @param {object} detail - readInstalledDetail() payload
 * @param {{ warn?: (message: string) => void }} [logger]
 * @returns {{ expertId: string, dispose: () => void }}
 */
export function composeExpert(agent, detail, logger = {}) {
  const warn = logger.warn ?? (() => {})
  const agentCtx = agent?.ctx
  if (agentCtx === undefined || typeof agentCtx.get !== 'function') {
    throw new Error('当前会话没有可用的作用域上下文，无法挂载专家')
  }
  const expertId = detail.card?.id ?? detail.id
  if (typeof expertId !== 'string' || expertId === '') throw new Error('专家数据缺少 id')

  const registered = []
  const cleanup = () => {
    for (const dispose of [...registered].reverse()) {
      try {
        dispose()
      } catch (error) {
        warn(`专家「${expertId}」清理失败：${error?.message ?? error}`)
      }
    }
  }

  try {
    const { disposers, failed } = registerSkills(agentCtx, detail, logger)
    registered.push(...disposers)
    const body = sanitizeRoleText(detail.roleText ?? '')
    const parts = [body === '' ? '' : body, roleMetaLine(detail)]
    if (failed.length > 0) parts.push(fallbackCatalog({ ...detail, skills: (detail.skills ?? []).filter((skill) => failed.includes(skill.name)) }))
    const text = parts.filter((part) => part !== '').join('\n\n')

    const systemPrompt = typeof agentCtx.get === 'function' ? agentCtx.get('systemPrompt') : undefined
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
      throw new Error('systemPrompt 服务不可用，无法挂载专家角色')
    }
    registered.push(systemPrompt.section({ name: ROLE_SECTION_NAME, order: ROLE_SECTION_ORDER, text }))
    const key = `agent:${String(agent.id ?? 'unknown')}`
    const registry = compositionRegistry()
    const dispose = () => {
      try {
        cleanup()
      } finally {
        registry.delete(key)
      }
    }
    registry.set(key, dispose)
    return { expertId, dispose }
  } catch (error) {
    cleanup()
    throw error
  }
}
