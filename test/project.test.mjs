/**
 * 项目级专家：路径解析、扫描、工具 scope。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPaths, findProjectRoot, pickWorkspaceRoot, projectPaths } from '../src/paths.js'
import { createExpert } from '../src/author.js'
import { scanInstalled } from '../src/store.js'
import { runExpertManage } from '../src/tools.js'

const home = await mkdtemp(join(tmpdir(), 'expert-hub-project-home-'))
const project = await mkdtemp(join(tmpdir(), 'expert-hub-project-'))
try {
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, 'nested', 'dir'), { recursive: true })
  const base = createPaths({ dshHome: home })
  const scoped = projectPaths(base, project)
  assert.equal(scoped.scope, 'project')
  assert.equal(scoped.expertsRoot, join(project, '.dsh', 'experts'))
  assert.equal(await findProjectRoot(project), project)
  assert.equal(await findProjectRoot(join(project, 'nested', 'dir')), project)

  // DSH workspace registry wins over .git/cwd: exact session mapping first,
  // then the longest workspace path containing the working directory.
  assert.equal(pickWorkspaceRoot([
    { path: join(project, 'other'), sessionIds: [] },
    { path: join(project, 'nested'), sessionIds: ['session-project'] },
  ], 'session-project', join(project, 'nested', 'dir')), join(project, 'nested'))
  assert.equal(pickWorkspaceRoot([
    { path: project, sessionIds: [] },
    { path: join(project, 'nested'), sessionIds: [] },
  ], 'unattached', join(project, 'nested', 'dir')), join(project, 'nested'))

  const card = await createExpert({ displayName: '项目专家', roleText: '# 项目专家\n\n只在项目里。' }, scoped)
  assert.ok(card.id.length > 0)
  const scanned = await scanInstalled(scoped)
  assert.equal(scanned.cards.length, 1)
  assert.equal(scanned.cards[0].library, 'project')

  const deps = {
    paths: base,
    sessionId: 'session-project',
    resolveProjectPaths: async () => scoped,
  }
  const listed = await runExpertManage({ action: 'list', library: 'project' }, deps)
  assert.equal(listed.ok, true)
  assert.equal(listed.library, 'project')
  assert.equal(listed.experts.length, 1)
  assert.equal(listed.experts[0].displayName, '项目专家')

  const got = await runExpertManage({ action: 'get', library: 'project', id: scanned.cards[0].id }, deps)
  assert.equal(got.ok, true)
  assert.match(got.roleText, /只在项目里/)

  await assert.rejects(
    () => runExpertManage({ action: 'list', library: 'project' }, { paths: base, sessionId: '' }),
    (error) => error.code === 'NO_PROJECT',
  )

  console.log('project.test.mjs: ok')
} finally {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
}
