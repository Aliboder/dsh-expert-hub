/**
 * The `/expert` chat command.
 *
 *   /expert            list the installed experts
 *   /expert <id>       switch this session to <id>
 *   /expert off        remove the current session's expert
 *   /expert info <id>  show one expert's description and skills
 *
 * @module dsh-expert-hub/command
 */

import { scanInstalled } from './store.js'

export const COMMAND_NAME = 'expert'

/** Render the installed expert table. */
export function renderExpertList(cards) {
  const valid = cards.filter((card) => card.broken === undefined)
  const broken = cards.filter((card) => card.broken !== undefined)
  const lines = [`专家库：${valid.length} 位可用${broken.length > 0 ? `，${broken.length} 位损坏` : ''}`]
  for (const card of valid) {
    const name = card.displayName && card.displayName !== card.id ? `${card.displayName}（${card.id}）` : card.id
    const profession = card.profession ? ` · ${card.profession}` : ''
    const skills = card.skills.length > 0 ? ` · ${card.skills.length} 个技能` : ''
    lines.push(`- ${name}${profession}${skills}`)
  }
  for (const card of broken) lines.push(`- ${card.id} ⚠ ${card.broken}`)
  if (valid.length === 0) lines.push('专家库是空的：在 设置 → 专家中心 导入或新建专家。')
  lines.push('用法：/expert <id> 切换，/expert off 取消，/expert info <id> 查看详情。')
  return lines.join('\n')
}

/** Render one expert's detail for the command result. */
export function renderExpertInfo(card) {
  const lines = [`${card.displayName || card.id}（${card.id}）`]
  if (card.profession) lines.push(`职业：${card.profession}`)
  if (card.description) lines.push(card.description)
  if (card.tags.length > 0) lines.push(`标签：${card.tags.join('、')}`)
  if (card.skills.length > 0) {
    lines.push('技能：')
    for (const skill of card.skills) lines.push(`- ${skill.name}：${skill.description}`)
  } else {
    lines.push('技能：无')
  }
  if (card.sourceLabel) lines.push(`来源：${card.sourceLabel}`)
  return lines.join('\n')
}

/**
 * Register the command against a live `commands` service.
 *
 * @param {object} commandsCtx - context that owns the commands service
 * @param {object} options - { paths, switcher }
 */
export function registerExpertCommand(commandsCtx, options) {
  const { paths, switcher } = options
  const commands = typeof commandsCtx.get === 'function' ? commandsCtx.get('commands') : undefined
  if (commands === undefined || typeof commands.register !== 'function') return () => {}
  return commands.register({
    name: COMMAND_NAME,
    description: '列出已安装专家；/expert <id> 切换当前会话专家；/expert off 取消；/expert info <id> 查看详情。',
    handler: async (invocation) => {
      const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const { cards } = await scanInstalled(paths)
      if (raw === '') return { kind: 'success', text: renderExpertList(cards) }
      const [verb, ...rest] = raw.split(/\s+/)
      if (verb === 'off') {
        const agent = invocation?.agent
        const sessionId = agent?.session?.id ?? agent?.id
        if (typeof sessionId !== 'string') return { kind: 'error', text: '当前命令缺少会话上下文，无法取消专家。' }
        await switcher.switchTo(sessionId, null)
        return { kind: 'success', text: '已取消当前会话的专家。' }
      }
      if (verb === 'info') {
        const id = rest[0] ?? ''
        const card = cards.find((item) => item.id === id)
        if (card === undefined) return { kind: 'error', text: `没有找到专家：${id}` }
        return { kind: 'success', text: renderExpertInfo(card) }
      }
      const agent = invocation?.agent
      const sessionId = agent?.session?.id ?? agent?.id
      if (typeof sessionId !== 'string') return { kind: 'error', text: '当前命令缺少会话上下文，无法切换专家。' }
      const card = cards.find((item) => item.id === verb)
      if (card === undefined) return { kind: 'error', text: `没有找到专家：${verb}` }
      const session = await switcher.switchTo(sessionId, verb)
      return { kind: 'success', text: `已切换为「${session.displayName ?? verb}」专家。` }
    },
  })
}
