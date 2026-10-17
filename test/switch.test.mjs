/**
 * Switcher tests: compose / dispose / rollback / cold-session restore.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPaths } from '../src/paths.js'
import { openSelections } from '../src/selections.js'
import { installDraft } from '../src/store.js'
import { createSwitcher } from '../src/switch.js'

const home = await mkdtemp(join(tmpdir(), 'expert-hub-switch-'))
const paths = createPaths({ dshHome: home })
const warnings = []

/** Fake agent whose prompt section throws when the role text says BROKEN. */
function makeAgent(sessionId) {
  const sections = new Map()
  const skills = new Map()
  const ctx = {
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(section) {
            if (typeof section.text === 'string' && section.text.includes('BROKEN')) throw new Error('section exploded')
            sections.set(section.name, section)
            return () => sections.delete(section.name)
          },
        }
      }
      if (name === 'skills') {
        return {
          register(skill) {
            skills.set(skill.name, skill)
            return () => skills.delete(skill.name)
          },
        }
      }
      return undefined
    },
  }
  return { id: sessionId, session: { id: sessionId }, ctx, status: 'idle', sections, skills }
}

const base = {
  name: '',
  profession: '',
  tags: [],
  category: '',
  categoryLabel: '',
  quickPrompts: [],
  teamSize: 1,
  sourceKind: 'custom',
  sourceLabel: '本机自建',
  skills: [],
  avatar: null,
  origin: { kind: 'custom', origin: '' },
}

await installDraft({ ...base, id: 'alpha', displayName: 'Alpha', description: 'A', roleText: '你是 Alpha 专家。' }, paths)
await installDraft({ ...base, id: 'beta', displayName: 'Beta', description: 'B', roleText: '你是 Beta 专家。' }, paths)
await installDraft({ ...base, id: 'broken', displayName: 'Broken', description: 'C', roleText: 'BROKEN 专家。' }, paths)

const selections = await openSelections(paths.stateFile, { warn: (m) => warnings.push(m) })
const agents = new Map()
const switcher = createSwitcher({
  paths,
  selections,
  resolveAgent: (sessionId) => agents.get(sessionId),
  logger: { warn: (m) => warnings.push(m) },
})

// Cold session: the choice is remembered, not applied.
const cold = await switcher.switchTo('s-cold', 'alpha')
assert.equal(cold.applied, false)
assert.equal(selections.get('s-cold').expertId, 'alpha')
const coldAgent = makeAgent('s-cold')
agents.set('s-cold', coldAgent)
await switcher.restore(coldAgent)
assert.equal(coldAgent.sections.get('expert-role').text.includes('Alpha'), true)

// Live switch replaces the role section.
const agent = makeAgent('s1')
agents.set('s1', agent)
const first = await switcher.switchTo('s1', 'alpha')
assert.equal(first.applied, true)
assert.match(agent.sections.get('expert-role').text, /Alpha/)
const second = await switcher.switchTo('s1', 'beta')
assert.equal(second.applied, true)
assert.match(agent.sections.get('expert-role').text, /Beta/)
assert.equal(agent.sections.size, 1)

// A failed compose rolls back to the previous expert and surfaces the error.
await assert.rejects(() => switcher.switchTo('s1', 'broken'), /section exploded/)
assert.match(agent.sections.get('expert-role').text, /Beta/)
assert.equal(switcher.current('s1').expertId, 'beta')
assert.equal(switcher.current('s1').applied, true)

// Clearing removes the section and the stored choice.
const cleared = await switcher.switchTo('s1', null)
assert.equal(cleared.applied, true)
assert.equal(agent.sections.has('expert-role'), false)
assert.equal(selections.get('s1'), undefined)

// Unknown expert is a clean rejection, the session keeps its current expert.
await assert.rejects(() => switcher.switchTo('s1', 'nope'), /不存在/)
assert.equal(agent.sections.has('expert-role'), false)

// Forget drops the selection and the composition.
await switcher.switchTo('s1', 'alpha')
switcher.forget('s1')
assert.equal(selections.get('s1'), undefined)
assert.equal(agent.sections.has('expert-role'), false)

switcher.dispose()
await selections.flush()
await rm(home, { recursive: true, force: true })
console.log('switch.test.mjs: ok')
