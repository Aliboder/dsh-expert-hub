/**
 * Local skill discovery: known agent roots, project roots, frontmatter parsing,
 * and the "a root can itself be a skill" case.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverSkills } from '../src/skill-sources.js'

const root = await mkdtemp(join(tmpdir(), 'expert-hub-skill-sources-'))
const home = join(root, 'home')
const project = join(root, 'project')

async function skill(dir, content) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
}

try {
  await skill(join(home, '.dsh', 'skills', 'alpha'),
    '---\nname: alpha\ndescription: Alpha skill\n---\n\n# Alpha\n\nAlpha body\n')
  await skill(join(home, '.claude', 'skills', 'beta'),
    '# Beta\n\nBeta does things.\n\nSecond paragraph.\n')
  await skill(join(home, '.agents', 'skills', 'gamma'),
    '---\nname: gamma\n---\nGamma body\n')
  await skill(join(project, '.dsh', 'skills', 'proj'),
    '---\nname: proj\ndescription: Project skill\n---\n')
  // A folder without SKILL.md is not a skill.
  await mkdir(join(home, '.dsh', 'skills', 'not-a-skill'), { recursive: true })
  // A known root that is itself a skill (SKILL.md at the root).
  await skill(join(home, '.codex', 'skills'), '---\nname: root-skill\ndescription: Root level\n---\n')

  const found = await discoverSkills({ home, dshHome: join(home, '.dsh'), projectRoot: project })
  const byName = Object.fromEntries(found.items.map((item) => [item.name, item]))

  assert.equal(byName.alpha.description, 'Alpha skill')
  assert.equal(byName.alpha.scope, 'global')
  assert.equal(byName.beta.description, 'Beta does things.')
  assert.equal(byName.gamma.description, 'Gamma body')
  assert.equal(byName.proj.description, 'Project skill')
  assert.equal(byName.proj.scope, 'project')
  assert.equal(byName['root-skill'].description, 'Root level')
  assert.equal(found.items.some((item) => item.name === 'not-a-skill'), false)
  assert.equal(found.items[0].scope, 'project', 'project skills sort first')
  assert.equal(typeof byName.alpha.path, 'string')
  assert.equal(typeof byName.alpha.pathLabel, 'string')
  assert.ok(found.roots > 0)

  // A home with no skill folders is an empty, non-failing scan.
  const empty = await discoverSkills({ home: join(root, 'missing'), dshHome: join(root, 'missing', '.dsh') })
  assert.deepEqual(empty.items, [])
  assert.deepEqual(empty.warnings, [])

  // The cap is honored.
  const capped = await discoverSkills({ home, dshHome: join(home, '.dsh'), projectRoot: project, maxItems: 2 })
  assert.equal(capped.items.length, 2)
  assert.equal(capped.truncated, true)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('skill-sources.test.mjs: ok')
