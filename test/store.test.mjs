/**
 * Store tests: install → scan → update → delete against a temp expert root.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPaths } from '../src/paths.js'
import {
  deleteExpert,
  installedState,
  installDraft,
  readInstalledDetail,
  scanAvailable,
  scanInstalled,
} from '../src/store.js'

const home = await mkdtemp(join(tmpdir(), 'expert-hub-store-'))
const worksBuddy = join(home, 'source', 'demo-expert')
const { mkdir } = await import('node:fs/promises')
await mkdir(join(worksBuddy, '.codebuddy-plugin'), { recursive: true })
await mkdir(join(worksBuddy, 'agents'), { recursive: true })
await mkdir(join(worksBuddy, 'skills', 'demo-skill'), { recursive: true })
await writeFile(
  join(worksBuddy, '.codebuddy-plugin', 'plugin.json'),
  JSON.stringify({
    name: 'demo-expert',
    profession: { zh: '演示专家', en: 'Demo Expert' },
    displayName: { zh: '演示专家', en: 'Demo' },
    displayDescription: { zh: '一位演示专家', en: 'A demo expert' },
    categoryId: '02-Engineering',
    tags: [{ zh: '演示', en: 'demo' }],
    quickPrompts: [{ zh: '做点演示', en: 'Demo it' }],
    avatar: 'expert.png',
  }),
  'utf8',
)
await writeFile(
  join(worksBuddy, 'agents', 'demo-expert.md'),
  '---\nname: demo-expert\ndisplayName:\n  zh: 演示专家\n  en: Demo\ndescription: A demo expert\n---\n\n# Demo\n\n你是一位演示专家。\n',
  'utf8',
)
await writeFile(join(worksBuddy, 'skills', 'demo-skill', 'SKILL.md'), '# Demo Skill\n\nUse it.\n', 'utf8')
await writeFile(join(worksBuddy, 'skills', 'demo-skill', 'notes.txt'), 'resource\n', 'utf8')
const avatarPath = join(worksBuddy, 'expert.png')
await writeFile(avatarPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

const paths = createPaths({ dshHome: home, sourcePath: join(home, 'source') })

const draft = {
  id: 'demo-expert',
  displayName: '演示专家',
  name: 'Demo',
  profession: '演示',
  description: '一位演示专家',
  tags: ['demo'],
  category: '02-Engineering',
  categoryLabel: '工程开发',
  quickPrompts: ['做点演示'],
  roleText: '# Demo\n\n你是一位演示专家。',
  skills: [{ name: 'demo-skill', dir: join(worksBuddy, 'skills', 'demo-skill'), hasSkillMd: true, content: '# Demo Skill\n\nUse it.\n', description: 'Use it.' }],
  avatar: { path: avatarPath, ext: '.png' },
  teamSize: 1,
  sourceKind: 'workbuddy',
  sourceLabel: 'WorkBuddy 专家中心',
  origin: { kind: 'workbuddy', origin: join(home, 'source'), pluginDir: 'demo-expert', agentFile: 'a.md' },
}

const installed = await installDraft(draft, paths)
assert.equal(installed.action, 'install')
const yml = await readFile(join(installed.dir, 'expert.yml'), 'utf8')
assert.match(yml, /display_name: 演示专家/)
const manifest = JSON.parse(await readFile(join(installed.dir, '.expert-source.json'), 'utf8'))
assert.equal(manifest.format, 'expert-hub/v1')
assert.equal(manifest.kind, 'workbuddy')

const scanned = await scanInstalled(paths)
assert.equal(scanned.cards.length, 1)
assert.equal(scanned.cards[0].id, 'demo-expert')
assert.equal(scanned.cards[0].broken, undefined)
assert.equal(scanned.cards[0].skills.length, 1)
assert.equal(scanned.cards[0].displayName, '演示专家')
assert.match(scanned.cards[0].avatarUrl, /scope=installed/)

const detail = await readInstalledDetail(paths, 'demo-expert')
assert.match(detail.roleText, /演示专家/)
assert.equal(detail.skills.length, 1)
assert.match(detail.skills[0].content, /Demo Skill/)

// A second install without update is refused.
await assert.rejects(() => installDraft(draft, paths), /已存在/)

// Update rewrites the role and bumps the manifest fingerprint.
const before = await installedState(paths)
draft.roleText = '# Demo\n\n你是一位升级后的演示专家。'
const updated = await installDraft(draft, paths, { update: true })
assert.equal(updated.action, 'update')
const after = await installedState(paths)
assert.notEqual(before.fingerprints['demo-expert'], after.fingerprints['demo-expert'])

// Source overlay: installed + updatable detection through our own fingerprints.
// The manual update above diverged from the source, so it reads as updatable.
const available = await scanAvailable(paths, { installed: after })
assert.equal(available.sourceExists, true)
assert.equal(available.cards.length, 1)
assert.equal(available.cards[0].installed, true)
assert.equal(available.cards[0].updatable, true)

// Re-importing the source content clears the update badge.
await installDraft({ ...draft, roleText: '# Demo\n\n你是一位演示专家。' }, paths, { update: true })
const availableAgain = await scanAvailable(paths, { installed: await installedState(paths) })
assert.equal(availableAgain.cards[0].updatable, false)

// A legacy manifest (foreign fingerprint) must not fake an update badge.
const legacyDir = join(paths.expertsRoot, 'legacy-expert')
await mkdir(legacyDir, { recursive: true })
await writeFile(join(legacyDir, 'expert.yml'), 'id: legacy-expert\ndisplay_name: 旧专家\ndescription: old\n', 'utf8')
await writeFile(join(legacyDir, 'role.md'), '# Legacy\n', 'utf8')
await writeFile(join(legacyDir, '.expert-source.json'), JSON.stringify({ sourcePath: 'x', pluginDir: 'legacy-expert', agentFile: 'a.md', fingerprint: 'abc', importedAt: '2026-01-01T00:00:00Z' }), 'utf8')
const legacyState = await installedState(paths)
assert.equal(legacyState.ids.has('legacy-expert'), true)
assert.equal(legacyState.fingerprints['legacy-expert'], undefined)

// Delete removes the folder and a second delete fails cleanly.
await deleteExpert(paths, 'demo-expert')
const afterDelete = await scanInstalled(paths)
assert.equal(afterDelete.cards.some((card) => card.id === 'demo-expert'), false)
await assert.rejects(() => deleteExpert(paths, 'demo-expert'))

// Truncated / invalid ids never touch the filesystem.
await assert.rejects(() => deleteExpert(paths, '../etc'), /id/)

await rm(home, { recursive: true, force: true })
console.log('store.test.mjs: ok')
