/**
 * AI-import tool tests: normalization, inspect mode, install mode, dedupe.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPaths } from '../src/paths.js'
import { scanInstalled } from '../src/store.js'
import {
  ImportToolError,
  clip,
  normalizeExpertInput,
  normalizeSource,
  runExpertImport,
  uniqueExpertId,
} from '../src/tools.js'

// ── pure helpers ────────────────────────────────────────────────────────────

assert.equal(clip('abcdef', 3), 'abc\n\n…（已截断，原文 6 字）')
assert.equal(clip('abc', 10), 'abc')

const normalized = normalizeExpertInput({
  displayName: '像素君',
  roleText: '你是 UI 设计师。',
  profession: 'UI 设计师',
  tags: ['UI设计', 'UI设计', '组件库'],
  quickPrompts: ['帮我搭设计规范'],
  skills: [{ name: 'Not A Slug', content: '# Skill\n\nUse it.' }],
})
assert.equal(normalized.expert.displayName, '像素君')
assert.equal(normalized.expert.profession, 'UI 设计师')
assert.deepEqual(normalized.expert.tags, ['UI设计', '组件库'])
assert.equal(normalized.expert.sourceKind, 'ai')
assert.equal(normalized.expert.sourceLabel, 'AI 整理导入')
assert.equal(normalized.expert.skills.length, 1)
assert.match(normalized.expert.skills[0].name, /^[a-z0-9][a-z0-9-]*$/)
assert.match(normalized.expert.skills[0].content, /Use it/)

assert.throws(() => normalizeExpertInput({ roleText: 'x' }), (error) => error instanceof ImportToolError)
assert.throws(() => normalizeExpertInput({ displayName: 'x' }), ImportToolError)
assert.throws(() => normalizeExpertInput({ displayName: 'x', roleText: 'y', id: 'Bad Id' }), ImportToolError)

assert.deepEqual(normalizeSource({ text: 'hello' }), { url: '', path: '', text: 'hello' })
assert.throws(() => normalizeSource({ url: 'https://x', path: '/tmp/x' }), ImportToolError)
assert.throws(() => normalizeSource({}), ImportToolError)

assert.equal(uniqueExpertId('demo', new Set()), 'demo')
assert.equal(uniqueExpertId('demo', new Set(['demo'])), 'demo-2')
assert.equal(uniqueExpertId('demo', new Set(['demo', 'demo-2'])), 'demo-3')
assert.match(uniqueExpertId('设计专家', new Set()), /^expert-[0-9a-f]{6}$/)

// ── install mode writes a complete expert folder ─────────────────────────────

const home = await mkdtemp(join(tmpdir(), 'expert-hub-tools-'))
const paths = createPaths({ dshHome: home })

const installed = await runExpertImport({
  expert: {
    displayName: '测试整理专家',
    profession: '测试',
    description: 'AI 整理出来的专家',
    tags: ['测试'],
    quickPrompts: ['帮我测一下'],
    roleText: '# 测试整理专家\n\n你负责测试。',
    skills: [{ name: 'smoke', content: '# Smoke\n\nRun smoke checks.' }],
    origin: 'https://example.com/expert',
  },
}, { paths })
assert.equal(installed.ok, true)
assert.equal(installed.mode, 'install')
assert.ok(installed.expert.id)
const id = installed.expert.id
assert.equal(installed.expert.sourceLabel, 'AI 整理导入')

const dir = join(paths.expertsRoot, id)
const yml = await readFile(join(dir, 'expert.yml'), 'utf8')
assert.match(yml, /display_name: 测试整理专家/)
assert.match(yml, /source_kind: ai/)
const manifest = JSON.parse(await readFile(join(dir, '.expert-source.json'), 'utf8'))
assert.equal(manifest.kind, 'ai')
assert.equal(manifest.format, 'expert-hub/v1')
assert.equal(manifest.origin, 'https://example.com/expert')
const skill = await readFile(join(dir, 'skills', 'smoke', 'SKILL.md'), 'utf8')
assert.match(skill, /Run smoke checks/)

// A second import with the same name must not overwrite: it gets a suffix.
const again = await runExpertImport({
  expert: { displayName: '测试整理专家', roleText: '第二份。' },
}, { paths })
assert.equal(again.ok, true)
assert.notEqual(again.expert.id, id)
assert.match(again.expert.id, new RegExp(`^${id}-2$`))
assert.equal(again.warnings.some((message) => message.includes('已改用')), true)

// ── inspect mode reads a folder without writing ─────────────────────────────

const sourceDir = join(home, 'source-expert')
await mkdir(sourceDir, { recursive: true })
await writeFile(join(sourceDir, 'expert.yml'), 'id: tmp-expert\ndisplay_name: 临时专家\ndescription: from folder\n', 'utf8')
await writeFile(join(sourceDir, 'role.md'), '# 临时专家\n\n你是一位临时专家。\n', 'utf8')
const before = (await scanInstalled(paths)).cards.length
const inspected = await runExpertImport({ source: { path: sourceDir } }, { paths })
assert.equal(inspected.ok, true)
assert.equal(inspected.mode, 'inspect')
assert.equal(inspected.candidates.length, 1)
assert.match(inspected.candidates[0].roleText, /临时专家/)
assert.equal((await scanInstalled(paths)).cards.length, before)

const textInspect = await runExpertImport({ source: { text: '一段专家介绍文字' } }, { paths })
assert.equal(textInspect.mode, 'inspect')
assert.equal(textInspect.kind, 'text')
assert.match(textInspect.text, /专家介绍/)

await assert.rejects(
  () => runExpertImport({ source: { text: 'x' }, expert: { displayName: 'x', roleText: 'y' } }, { paths }),
  ImportToolError,
)

await rm(home, { recursive: true, force: true })
console.log('tools.test.mjs: ok')
