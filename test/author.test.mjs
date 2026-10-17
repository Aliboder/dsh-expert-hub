/**
 * Tests for src/author.js — node:test only, writes under os.tmpdir().
 *
 * Run alone:   node test/author.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  MAX_AVATAR_BYTES,
  createExpert,
  decodeDataUrl,
  deleteExpertCard,
  updateExpert,
} from '../src/author.js'
import { createPaths } from '../src/paths.js'
import { readInstalledDetail, scanInstalled } from '../src/store.js'

/** 1×1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

/** Minimal but structurally valid JPEG header. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`

/** Minimal WebP header (RIFF....WEBPVP8 ). */
const WEBP_BYTES = (() => {
  const buffer = Buffer.alloc(16)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(8, 4)
  buffer.write('WEBP', 8, 'latin1')
  buffer.write('VP8 ', 12, 'latin1')
  return buffer
})()
const WEBP_DATA_URL = `data:image/webp;base64,${WEBP_BYTES.toString('base64')}`

async function makeContext() {
  const home = await mkdtemp(join(tmpdir(), 'eh-author-'))
  return {
    home,
    paths: createPaths({ dshHome: home }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// createExpert
// ---------------------------------------------------------------------------

test('createExpert 写入规范专家目录并出现在 scanInstalled', async () => {
  const ctx = await makeContext()
  try {
    const card = await createExpert(
      {
        displayName: 'Test Expert',
        roleText: '你是一位测试专家。',
        description: '用于测试的专家',
        profession: '质量工程师',
        tags: ['测试', '自动化'],
        quickPrompts: ['帮我写一个测试', '检查一下代码'],
        initPrompt: '我们从测试开始。',
        avatarDataUrl: PNG_DATA_URL,
      },
      ctx.paths,
    )
    assert.equal(card.id, 'test-expert')
    assert.equal(card.displayName, 'Test Expert')
    assert.equal(card.profession, '质量工程师')
    assert.deepEqual(card.tags, ['测试', '自动化'])
    assert.deepEqual(card.quickPrompts, ['帮我写一个测试', '检查一下代码'])
    assert.equal(card.initPrompt, '我们从测试开始。')
    assert.equal(card.installed, true)
    assert.ok(card.avatarUrl.includes('scope=installed'), card.avatarUrl)

    const dir = join(ctx.paths.expertsRoot, card.id)
    for (const name of ['expert.yml', 'role.md', 'avatar.png', '.expert-source.json']) {
      assert.equal(existsSync(join(dir, name)), true, `${name} 应该存在`)
      assert.equal((await stat(join(dir, name))).isFile(), true, `${name} 应该是文件`)
    }

    const yml = await readFile(join(dir, 'expert.yml'), 'utf8')
    assert.match(yml, /^schema: 1$/m)
    assert.match(yml, /^id: test-expert$/m)
    assert.match(yml, /^display_name: Test Expert$/m)
    assert.match(yml, /^source_kind: custom$/m)
    assert.match(yml, /^source_label: 本机自建$/m)

    const manifest = JSON.parse(await readFile(join(dir, '.expert-source.json'), 'utf8'))
    assert.equal(manifest.kind, 'custom')
    assert.equal(manifest.origin, '')
    assert.match(manifest.fingerprint, /^[0-9a-f]{64}$/)
    assert.ok(!Number.isNaN(Date.parse(manifest.importedAt)))

    assert.equal(await readFile(join(dir, 'role.md'), 'utf8'), '你是一位测试专家。\n')

    const { cards } = await scanInstalled(ctx.paths)
    assert.equal(cards.length, 1)
    assert.equal(cards[0].id, 'test-expert')
    assert.equal(cards[0].description, '用于测试的专家')

    const detail = await readInstalledDetail(ctx.paths, 'test-expert')
    assert.equal(detail.roleText.trimEnd(), '你是一位测试专家。')
  } finally {
    await ctx.cleanup()
  }
})

test('createExpert 自动给重复 id 加 -2/-3，显式 id 也去重', async () => {
  const ctx = await makeContext()
  try {
    const first = await createExpert({ displayName: 'Test Expert', roleText: '角色一' }, ctx.paths)
    const second = await createExpert({ displayName: 'Test Expert', roleText: '角色二' }, ctx.paths)
    const third = await createExpert({ displayName: 'Test Expert', roleText: '角色三' }, ctx.paths)
    assert.equal(first.id, 'test-expert')
    assert.equal(second.id, 'test-expert-2')
    assert.equal(third.id, 'test-expert-3')

    const explicit = await createExpert({ id: 'my-own', displayName: 'Own', roleText: '角色' }, ctx.paths)
    const explicitAgain = await createExpert({ id: 'my-own', displayName: 'Own 2', roleText: '角色' }, ctx.paths)
    assert.equal(explicit.id, 'my-own')
    assert.equal(explicitAgain.id, 'my-own-2')
  } finally {
    await ctx.cleanup()
  }
})

test('createExpert 校验必填字段、非法 id 与模板转义', async () => {
  const ctx = await makeContext()
  try {
    await assert.rejects(createExpert({ roleText: '角色' }, ctx.paths), /显示名不能为空/)
    await assert.rejects(createExpert({ displayName: '   ', roleText: '角色' }, ctx.paths), /显示名不能为空/)
    await assert.rejects(createExpert({ displayName: 'X' }, ctx.paths), /角色提示词/)
    await assert.rejects(createExpert({ displayName: 'X', roleText: '   ' }, ctx.paths), /角色提示词/)
    await assert.rejects(
      createExpert({ id: '../escape', displayName: 'X', roleText: '角色' }, ctx.paths),
      /专家 id 不合法/,
    )
    await assert.rejects(
      createExpert({ id: 'Bad_ID', displayName: 'X', roleText: '角色' }, ctx.paths),
      /专家 id 不合法/,
    )
    await assert.rejects(createExpert(null, ctx.paths), /无效的专家数据/)
    await assert.rejects(createExpert({ displayName: 'X', roleText: '角色' }, null), /路径配置/)

    const card = await createExpert({ displayName: 'Escape', roleText: '你好 {{name}}！' }, ctx.paths)
    const detail = await readInstalledDetail(ctx.paths, card.id)
    assert.equal(detail.roleText.trimEnd(), '你好 { {name} }！')
    assert.ok(detail.card.description.length > 0, '缺少 description 时应回退到正文摘要')
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// updateExpert
// ---------------------------------------------------------------------------

test('updateExpert 修改元数据、role.md，并保留 skills', async () => {
  const ctx = await makeContext()
  try {
    const created = await createExpert(
      { displayName: 'Test Expert', roleText: '原始角色', profession: '工程师' },
      ctx.paths,
    )
    const dir = join(ctx.paths.expertsRoot, created.id)
    await mkdir(join(dir, 'skills', 'demo'), { recursive: true })
    await writeFile(join(dir, 'skills', 'demo', 'SKILL.md'), '# Demo\n\n示例技能\n', 'utf8')

    const card = await updateExpert(
      created.id,
      {
        displayName: '新名字',
        name: 'New Name',
        profession: '资深工程师',
        description: '新的描述',
        tags: ['标签A', '标签B'],
        quickPrompts: ['提示一', '提示二'],
        initPrompt: '新的开场白',
        order: 42,
        roleText: '新的角色提示词',
      },
      ctx.paths,
    )
    assert.equal(card.id, created.id)
    assert.equal(card.displayName, '新名字')
    assert.equal(card.name, 'New Name')
    assert.equal(card.profession, '资深工程师')
    assert.equal(card.description, '新的描述')
    assert.deepEqual(card.tags, ['标签A', '标签B'])
    assert.deepEqual(card.quickPrompts, ['提示一', '提示二'])
    assert.equal(card.initPrompt, '新的开场白')
    assert.equal(card.order, 42)

    const detail = await readInstalledDetail(ctx.paths, created.id)
    assert.equal(detail.roleText.trimEnd(), '新的角色提示词')
    assert.equal(detail.skills.length, 1)
    assert.equal(detail.skills[0].name, 'demo')

    const yml = await readFile(join(dir, 'expert.yml'), 'utf8')
    assert.match(yml, /^source_kind: custom$/m, '更新不应丢掉来源字段')
    assert.match(yml, /^source_label: 本机自建$/m)
    assert.equal(await readFile(join(dir, 'role.md'), 'utf8'), '新的角色提示词\n')

    // 缺省字段保留：只改 order 时 displayName 不变。
    const ordered = await updateExpert(created.id, { order: 7 }, ctx.paths)
    assert.equal(ordered.displayName, '新名字')
    assert.equal(ordered.order, 7)
  } finally {
    await ctx.cleanup()
  }
})

test('updateExpert 替换头像时删除旧格式文件', async () => {
  const ctx = await makeContext()
  try {
    const created = await createExpert(
      { displayName: 'Avatar Expert', roleText: '角色', avatarDataUrl: PNG_DATA_URL },
      ctx.paths,
    )
    const dir = join(ctx.paths.expertsRoot, created.id)
    assert.equal(existsSync(join(dir, 'avatar.png')), true)

    await updateExpert(created.id, { avatarDataUrl: JPEG_DATA_URL }, ctx.paths)
    assert.equal(existsSync(join(dir, 'avatar.jpg')), true)
    assert.equal(existsSync(join(dir, 'avatar.png')), false)

    await updateExpert(created.id, { avatarDataUrl: WEBP_DATA_URL }, ctx.paths)
    assert.equal(existsSync(join(dir, 'avatar.webp')), true)
    assert.equal(existsSync(join(dir, 'avatar.jpg')), false)

    const card = await updateExpert(created.id, { avatarDataUrl: PNG_DATA_URL }, ctx.paths)
    assert.ok(card.avatarUrl.includes('scope=installed'))
    assert.equal(existsSync(join(dir, 'avatar.png')), true)
    assert.equal(existsSync(join(dir, 'avatar.webp')), false)
  } finally {
    await ctx.cleanup()
  }
})

test('updateExpert 拒绝非法 id、不存在的专家、空角色与坏头像', async () => {
  const ctx = await makeContext()
  try {
    const created = await createExpert({ displayName: 'Bad Update', roleText: '角色' }, ctx.paths)
    await assert.rejects(updateExpert('../escape', {}, ctx.paths), /专家 id 不合法/)
    await assert.rejects(updateExpert('missing-id', {}, ctx.paths), /专家不存在/)
    await assert.rejects(updateExpert(created.id, { roleText: '   ' }, ctx.paths), /角色提示词不能为空/)
    await assert.rejects(updateExpert(created.id, { roleText: 42 }, ctx.paths), /角色提示词必须是/)
    await assert.rejects(
      updateExpert(created.id, { avatarDataUrl: 'data:text/plain;base64,aGk=' }, ctx.paths),
      /AVATAR_TYPE/,
    )
    await assert.rejects(updateExpert(created.id, { avatarDataUrl: 'not-a-data-url' }, ctx.paths), /AVATAR_INVALID/)
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// deleteExpertCard
// ---------------------------------------------------------------------------

test('deleteExpertCard 删除专家目录', async () => {
  const ctx = await makeContext()
  try {
    const card = await createExpert({ displayName: 'Delete Me', roleText: '角色' }, ctx.paths)
    const dir = join(ctx.paths.expertsRoot, card.id)
    assert.equal(existsSync(dir), true)

    const removed = await deleteExpertCard(card.id, ctx.paths)
    assert.equal(removed.id, card.id)
    assert.equal(existsSync(dir), false)
    assert.equal((await scanInstalled(ctx.paths)).cards.length, 0)

    await assert.rejects(deleteExpertCard('never-existed', ctx.paths), /不是专家文件夹/)
    await assert.rejects(deleteExpertCard('../escape', ctx.paths), /invalid expert id/)
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// decodeDataUrl
// ---------------------------------------------------------------------------

test('decodeDataUrl 接受 png/jpeg/webp', () => {
  const png = decodeDataUrl(PNG_DATA_URL)
  assert.equal(png.mime, 'image/png')
  assert.equal(png.ext, '.png')
  assert.ok(Buffer.isBuffer(png.data))
  assert.equal(png.data.subarray(0, 4).toString('latin1'), '\x89PNG')

  const jpeg = decodeDataUrl(JPEG_DATA_URL)
  assert.equal(jpeg.mime, 'image/jpeg')
  assert.equal(jpeg.ext, '.jpg')

  const webp = decodeDataUrl(WEBP_DATA_URL)
  assert.equal(webp.mime, 'image/webp')
  assert.equal(webp.ext, '.webp')
})

test('decodeDataUrl 拒绝非法输入', async () => {
  assert.throws(() => decodeDataUrl(''), /AVATAR_EMPTY/)
  assert.throws(() => decodeDataUrl(null), /AVATAR_EMPTY/)
  assert.throws(() => decodeDataUrl('not-a-data-url'), /AVATAR_INVALID/)
  assert.throws(() => decodeDataUrl('data:image/png,abc'), /AVATAR_INVALID/) // 非 base64
  assert.throws(() => decodeDataUrl('data:image/png;base64,!!!'), /AVATAR_INVALID/)
  assert.throws(() => decodeDataUrl('data:text/plain;base64,aGk='), /AVATAR_TYPE/)
  assert.throws(() => decodeDataUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw='), /AVATAR_TYPE/)

  // 声明的 MIME 与内容不一致
  assert.throws(
    () => decodeDataUrl(`data:image/png;base64,${Buffer.from('hello').toString('base64')}`),
    /AVATAR_INVALID/,
  )

  // 超过 2 MiB
  const oversized = Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x41)
  assert.equal(oversized.length, 2 * 1024 * 1024 + 1)
  assert.throws(() => decodeDataUrl(`data:image/png;base64,${oversized.toString('base64')}`), /AVATAR_TOO_LARGE/)

  // 空数据 URL 的 base64 体
  assert.throws(() => decodeDataUrl('data:image/png;base64,'), /AVATAR_EMPTY/)
})
