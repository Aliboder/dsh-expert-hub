/**
 * 路由层项目/全局 scope 集成测试（无 DSH，只测 HTTP surface）。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createExpert } from '../src/author.js'
import { createPaths, projectPaths } from '../src/paths.js'
import { createRoutes } from '../src/routes.js'

const home = await mkdtemp(join(tmpdir(), 'expert-hub-routes-home-'))
const project = await mkdtemp(join(tmpdir(), 'expert-hub-routes-project-'))
let server
try {
  await mkdir(join(project, '.git'), { recursive: true })
  const paths = createPaths({ dshHome: home })
  const scoped = projectPaths(paths, project)
  const projectExpert = await createExpert({ displayName: '路由项目专家', roleText: '# 项目\n\n路由测试。' }, scoped)

  let switched = null
  const switcher = {
    current: () => ({ sessionId: 's1', expertId: projectExpert.id, library: 'project', applied: true }),
    switchTo: async (sessionId, expertId, library) => {
      switched = { sessionId, expertId, library }
      return { sessionId, expertId, library, applied: true }
    },
    forget: () => {},
    ensureApplied: async () => {},
  }
  const routes = createRoutes({
    paths,
    switcher,
    selections: { get: () => undefined, set: () => {}, remove: () => {} },
    resolveProjectPaths: async () => scoped,
    ensureApplied: async () => {},
    logger: { warn: () => {} },
  })
  let handler
  routes.mount({
    register: ({ handler: h }) => {
      handler = h
      return () => {}
    },
  })
  server = http.createServer((req, res) => {
    try {
      handler(req, res)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { message: String(error) } }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/expert-hub`

  const state = await (await fetch(`${base}/state?sessionId=s1`)).json()
  assert.equal(state.ok, true)
  assert.equal(state.installed.length, 0)
  assert.equal(state.project.length, 1)
  assert.equal(state.counts.project, 1)
  assert.equal(state.project[0].library, 'project')

  const detail = await (await fetch(`${base}/detail?id=${projectExpert.id}&scope=installed&library=project&sessionId=s1`)).json()
  assert.equal(detail.ok, true)
  assert.match(detail.roleText, /路由测试/)
  assert.equal(detail.card.library, 'project')

  const switchedResponse = await (await fetch(`${base}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', expertId: projectExpert.id, library: 'project' }),
  })).json()
  assert.equal(switchedResponse.ok, true)
  assert.deepEqual(switched, { sessionId: 's1', expertId: projectExpert.id, library: 'project' })

  const trash = await (await fetch(`${base}/trash?library=project&sessionId=s1`)).json()
  assert.equal(trash.ok, true)
  assert.equal(trash.library, 'project')

  const updated = await (await fetch(`${base}/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: projectExpert.id,
      library: 'project',
      sessionId: 's1',
      patch: { displayName: '改名项目专家' },
    }),
  })).json()
  assert.equal(updated.ok, true)
  assert.equal(updated.expert.displayName, '改名项目专家')
  assert.equal(updated.expert.library, 'project')

  const removed = await (await fetch(`${base}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectExpert.id, library: 'project', sessionId: 's1' }),
  })).json()
  assert.equal(removed.ok, true)
  const trashAfter = await (await fetch(`${base}/trash?library=project&sessionId=s1`)).json()
  assert.equal(trashAfter.items.length, 1)
  assert.equal(trashAfter.items[0].displayName, '改名项目专家')

  const purged = await (await fetch(`${base}/purge-trash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: trashAfter.items[0].name, library: 'project', sessionId: 's1' }),
  })).json()
  assert.equal(purged.ok, true)
  const trashFinal = await (await fetch(`${base}/trash?library=project&sessionId=s1`)).json()
  assert.equal(trashFinal.items.length, 0)

  console.log('routes-project.test.mjs: ok')
} finally {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve))
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
}
