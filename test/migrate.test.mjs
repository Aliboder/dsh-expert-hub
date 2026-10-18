/**
 * 专家迁移：全局 ↔ 项目，目录整体移动，不复制、不丢技能。
 */

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createExpert, moveExpert } from '../src/author.js'
import { createPaths, projectPaths } from '../src/paths.js'
import { scanInstalled, readInstalledDetail } from '../src/store.js'
import { runExpertManage } from '../src/tools.js'

const home = await mkdtemp(join(tmpdir(), 'expert-hub-migrate-home-'))
const project = await mkdtemp(join(tmpdir(), 'expert-hub-migrate-project-'))
try {
  await mkdir(join(project, '.git'), { recursive: true })
  const paths = createPaths({ dshHome: home })
  const scoped = projectPaths(paths, project)
  const expert = await createExpert({
    displayName: '迁移测试专家',
    roleText: '# 迁移\n\n角色正文。',
    skills: [{ name: 'skill-a', content: '---\nname: skill-a\ndescription: A\n---\n\n步骤。' }],
  }, paths)
  assert.equal((await scanInstalled(paths)).cards.length, 1)
  assert.equal((await scanInstalled(scoped)).cards.length, 0)

  const moved = await moveExpert(expert.id, paths, scoped)
  assert.equal(moved.id, expert.id)
  assert.equal((await scanInstalled(paths)).cards.length, 0)
  assert.equal((await scanInstalled(scoped)).cards.length, 1)
  await assert.rejects(access(join(paths.expertsRoot, expert.id)))
  const detail = await readInstalledDetail(scoped, expert.id)
  assert.deepEqual(detail.skills.map((row) => row.name), ['skill-a'])

  const back = await moveExpert(expert.id, scoped, paths)
  assert.equal(back.id, expert.id)
  assert.equal((await scanInstalled(paths)).cards.length, 1)
  assert.equal((await scanInstalled(scoped)).cards.length, 0)

  // Model-facing migration action uses the same folder move.
  const toolResult = await runExpertManage({
    action: 'migrate',
    id: expert.id,
    targetLibrary: 'project',
    targetWorkspace: project,
  }, {
    paths,
    sessionId: 's1',
    resolveProjectPaths: async (_sessionId, workspace) => (workspace === project ? scoped : undefined),
    listWorkspaces: async () => [{ path: project, title: '测试项目', available: true }],
  })
  assert.equal(toolResult.ok, true)
  assert.equal(toolResult.expert.library, 'project')
  assert.equal((await scanInstalled(paths)).cards.length, 0)
  assert.equal((await scanInstalled(scoped)).cards.length, 1)
} finally {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
}
console.log('migrate.test.mjs: ok')
