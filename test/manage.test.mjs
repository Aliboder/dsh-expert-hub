/**
 * expert_manage 工具测试：列出、读取、创建、更新、技能增删、目录导入、启用。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPaths } from '../src/paths.js'
import { ManageToolError, runExpertManage } from '../src/tools.js'

const home = await mkdtemp(join(tmpdir(), 'expert-hub-manage-'))
const paths = createPaths({ dshHome: home })
const sessionId = 'session-test'
let switchedTo = ''
const deps = {
  paths,
  sessionId,
  switcher: {
    async switchTo(_session, id) {
      switchedTo = id
      return { applied: true, queued: false }
    },
  },
}

try {
  const guide = await runExpertManage({ action: 'guide' }, deps)
  assert.equal(guide.ok, true)
  assert.match(guide.guide, /DSH 专家创作规范/)
  assert.equal(guide.checklist.length > 0, true)

  const created = await runExpertManage({
    action: 'create',
    expert: {
      id: 'manage-test',
      displayName: '管理测试专家',
      profession: '测试',
      roleText: '# 角色\n\n你是测试专家。',
      skills: [{ name: 'alpha', content: '# Alpha\n\n第一技能。' }],
    },
  }, deps)
  assert.equal(created.ok, true)
  assert.equal(created.expert.id, 'manage-test')
  assert.equal(created.expert.skills, 1)

  const listed = await runExpertManage({ action: 'list' }, deps)
  assert.equal(listed.ok, true)
  assert.equal(listed.experts.some((item) => item.id === 'manage-test'), true)

  const got = await runExpertManage({ action: 'get', id: 'manage-test' }, deps)
  assert.equal(got.ok, true)
  assert.match(got.roleText, /你是测试专家/)
  assert.deepEqual(got.skills.map((item) => item.name), ['alpha'])

  const updated = await runExpertManage({
    action: 'update',
    id: 'manage-test',
    patch: { displayName: '改名后的专家', roleText: '# 新角色\n\n更新后的提示词。' },
  }, deps)
  assert.equal(updated.ok, true)
  assert.equal(updated.expert.displayName, '改名后的专家')

  const added = await runExpertManage({
    action: 'add_skill',
    id: 'manage-test',
    skill: { name: 'beta', content: '# Beta\n\n第二技能。' },
  }, deps)
  assert.equal(added.ok, true)
  assert.equal(added.replaced, false)

  const afterAdd = await runExpertManage({ action: 'get', id: 'manage-test' }, deps)
  assert.deepEqual(afterAdd.skills.map((item) => item.name).sort(), ['alpha', 'beta'])

  const replaced = await runExpertManage({
    action: 'add_skill',
    id: 'manage-test',
    skill: { name: 'beta', content: '# Beta v2' },
  }, deps)
  assert.equal(replaced.replaced, true)

  const removed = await runExpertManage({ action: 'remove_skill', id: 'manage-test', name: 'alpha' }, deps)
  assert.equal(removed.ok, true)
  assert.equal(removed.skills, 1)

  const skillDir = join(home, 'imported-skill')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: imported-skill\n---\n\n# Imported\n', 'utf8')
  const imported = await runExpertManage({ action: 'import_skill', id: 'manage-test', path: skillDir }, deps)
  assert.equal(imported.ok, true)

  const afterImport = await runExpertManage({ action: 'get', id: 'manage-test' }, deps)
  assert.deepEqual(afterImport.skills.map((item) => item.name).sort(), ['beta', 'imported-skill'])

  const used = await runExpertManage({ action: 'use', id: 'manage-test' }, deps)
  assert.equal(used.ok, true)
  assert.equal(switchedTo, 'manage-test')

  await assert.rejects(
    () => runExpertManage({ action: 'nope' }, deps),
    (error) => error instanceof ManageToolError && error.code === 'ACTION_INVALID',
  )
  await assert.rejects(
    () => runExpertManage({ action: 'get', id: 'missing-expert' }, deps),
    (error) => error instanceof ManageToolError && error.code === 'EXPERT_NOT_FOUND',
  )
  await assert.rejects(
    () => runExpertManage({ action: 'remove_skill', id: 'manage-test', name: 'nope' }, deps),
    (error) => error instanceof ManageToolError && error.code === 'SKILL_NOT_FOUND',
  )

  console.log('manage.test.mjs: ok')
} finally {
  await rm(home, { recursive: true, force: true })
}
