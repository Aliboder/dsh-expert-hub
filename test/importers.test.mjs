/**
 * Tests for src/importers.js — node:test only, no browser, no network.
 *
 * Run alone:   node test/importers.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync, gzipSync } from 'node:zlib'

import {
  classifyPayload,
  extractTarGz,
  extractZip,
  importFromBuffer,
  importFromPath,
  importFromUrl,
  isPrivateHost,
} from '../src/importers.js'

// ---------------------------------------------------------------------------
// Fixtures: minimal zip / tar writers (the point of the exercise)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Build a zip buffer. entries: {name, data?, mode?, method?}. */
function makeZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    const method = entry.method ?? (data.length > 0 ? 8 : 0)
    const compressed = method === 8 ? deflateRawSync(data) : data
    const crc = crc32(data)
    const mode = entry.mode ?? (entry.name.endsWith('/') ? 0o40755 : 0o100644)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, compressed)
    const localOffset = offset
    offset += local.length + name.length + compressed.length

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // made by unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((mode & 0xffff) * 65536, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
  }
  const localBuffer = Buffer.concat(localParts)
  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(localBuffer.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localBuffer, centralBuffer, eocd])
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Math.max(0, Math.trunc(value))
    .toString(8)
    .padStart(length - 1, '0')
  buffer.write(text, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

/** Build a tar buffer. entries: {name, data?, mode?, type?, linkname?}. */
function makeTar(entries) {
  const parts = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    const header = Buffer.alloc(512)
    header.write(String(entry.name ?? '').slice(0, 100), 0, 100, 'utf8')
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, data.length)
    writeTarOctal(header, 136, 12, 0)
    header.write('        ', 148, 8, 'ascii') // checksum placeholder
    header[156] = (entry.type ?? '0').charCodeAt(0)
    if (typeof entry.linkname === 'string') header.write(entry.linkname.slice(0, 100), 157, 100, 'utf8')
    header.write('ustar', 257, 5, 'latin1')
    header[262] = 0
    header.write('00', 263, 2, 'latin1')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(String(sum).padStart(6, '0'), 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    parts.push(header, data)
    const padding = data.length % 512 === 0 ? 0 : 512 - (data.length % 512)
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

/** One pax extended record: "<len> key=value\n". */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (String(length).length + body.length !== length) length = String(length).length + body.length
  return `${length}${body}`
}

const EXPERT_YML = 'schema: 1\nid: demo\ndisplay_name: 演示专家\ndescription: 用于测试的专家\n'
const EXPERT_ROLE = '你是一位演示专家。'

/** Zip payload of a nested DSH expert folder (with one skill). */
function demoExpertZip() {
  return makeZip([
    { name: 'demo/expert.yml', data: EXPERT_YML },
    { name: 'demo/role.md', data: EXPERT_ROLE },
    { name: 'demo/skills/helper/SKILL.md', data: '# Helper\n\n帮助技能' },
  ])
}

async function tempDir(prefix = 'eh-importers-') {
  return mkdtemp(join(tmpdir(), prefix))
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('isPrivateHost 拒绝回环/私网/链路本地地址', () => {
  for (const host of [
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '127.9.8.7',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.10.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateHost(host), true, host)
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2001:db8::1']) {
    assert.equal(isPrivateHost(host), false, host)
  }
  assert.equal(isPrivateHost(''), true)
})

test('classifyPayload 按 magic / content-type 分类', () => {
  assert.equal(classifyPayload(demoExpertZip()), 'zip')
  assert.equal(classifyPayload(makeZip([])), 'zip')
  assert.equal(classifyPayload(gzipSync(makeTar([{ name: 'a', data: 'x' }]))), 'tar.gz')
  assert.equal(classifyPayload(Buffer.from('# 专家\n\n正文')), 'markdown')
  assert.equal(classifyPayload(Buffer.from('纯文本'), 'text/plain'), 'markdown')
  assert.equal(classifyPayload(Buffer.from('<!doctype html><html></html>')), 'html')
  assert.equal(classifyPayload(Buffer.from('<html><body>x</body></html>')), 'html')
  assert.equal(classifyPayload(Buffer.from('x'), 'text/html'), 'html')
  assert.equal(classifyPayload(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]), 'application/pdf'), 'unknown')
  assert.equal(classifyPayload(Buffer.alloc(0)), 'unknown')
})

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

test('extractZip 正常解压、跳过可执行文件', async () => {
  const root = await tempDir()
  try {
    const out = join(root, 'out')
    const result = await extractZip(
      makeZip([
        { name: 'demo/expert.yml', data: EXPERT_YML },
        { name: 'demo/scripts/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o100755 },
        { name: 'demo/readme.md', data: 'hi' },
      ]),
      out,
    )
    assert.deepEqual(result.files.sort(), ['demo/expert.yml', 'demo/readme.md'])
    assert.deepEqual(result.skipped, ['demo/scripts/run.sh'])
    assert.equal(await readFile(join(out, 'demo', 'expert.yml'), 'utf8'), EXPERT_YML)
    assert.equal(existsSync(join(out, 'demo', 'scripts', 'run.sh')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extractZip 拒绝 zip-slip 与绝对路径', async () => {
  const root = await tempDir()
  try {
    const out = join(root, 'extract')
    await assert.rejects(() => extractZip(makeZip([{ name: '../evil.txt', data: 'x' }]), out), /NW_ZIP_SLIP/)
    assert.equal(existsSync(join(root, 'evil.txt')), false)
    await assert.rejects(() => extractZip(makeZip([{ name: '/etc/evil.txt', data: 'x' }]), out), /NW_ZIP_SLIP/)
    await assert.rejects(() => extractZip(makeZip([{ name: 'C:/evil.txt', data: 'x' }]), out), /NW_ZIP_SLIP/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extractZip 拒绝 zip64、未知压缩方式、加密条目', async () => {
  const root = await tempDir()
  try {
    const out = join(root, 'out')
    const zip64 = Buffer.from(demoExpertZip())
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10) // fake "too many entries"
    await assert.rejects(() => extractZip(zip64, out), /NW_ZIP64/)

    await assert.rejects(
      () => extractZip(makeZip([{ name: 'a.txt', data: 'x', method: 99 }]), out),
      /NW_ZIP_METHOD/,
    )

    await assert.rejects(
      () => extractZip(makeZip([{ name: 'a.txt', data: 'x', flags: 0x0001 }]), out),
      /NW_ZIP_ENCRYPTED/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('importFromBuffer 从 zip 得到 drafts，cleanup 删除临时目录', async () => {
  const tmpRoot = await tempDir()
  try {
    const result = await importFromBuffer(demoExpertZip(), { filename: 'demo.zip', tmpRoot })
    assert.equal(result.drafts.length, 1)
    const draft = result.drafts[0]
    assert.equal(draft.id, 'demo')
    assert.equal(draft.displayName, '演示专家')
    assert.equal(draft.roleText, EXPERT_ROLE)
    assert.equal(draft.sourceLabel, '网页导入')
    assert.equal(draft.skills.length, 1)
    assert.equal(draft.skills[0].name, 'helper')

    const extracted = resolve(draft.skills[0].dir, '..', '..', '..')
    assert.equal(existsSync(extracted), true)
    await result.cleanup()
    assert.equal(existsSync(extracted), false)
    assert.deepEqual(await readdir(tmpRoot), [])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('importFromBuffer 的 zip-slip 失败后不留临时目录', async () => {
  const tmpRoot = await tempDir()
  try {
    await assert.rejects(
      importFromBuffer(makeZip([{ name: '../evil.txt', data: 'x' }]), { tmpRoot }),
      /NW_ZIP_SLIP/,
    )
    assert.deepEqual(await readdir(tmpRoot), [])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('空 zip 不抛错，只给出 warnings', async () => {
  const tmpRoot = await tempDir()
  try {
    const result = await importFromBuffer(makeZip([]), { tmpRoot })
    assert.deepEqual(result.drafts, [])
    assert.ok(result.warnings.length >= 1)
    await result.cleanup()
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// tar / tar.gz
// ---------------------------------------------------------------------------

test('extractTarGz 正常解压、跳过符号链接与可执行文件', async () => {
  const root = await tempDir()
  try {
    const out = join(root, 'out')
    const tar = makeTar([
      { name: 'demo/expert.yml', data: EXPERT_YML },
      { name: 'demo/role.md', data: EXPERT_ROLE },
      { name: 'demo/scripts/run.sh', data: '#!/bin/sh\n', mode: 0o755 },
      { name: 'demo/link', type: '2', linkname: 'expert.yml' },
    ])
    const result = await extractTarGz(gzipSync(tar), out)
    assert.deepEqual(result.files.sort(), ['demo/expert.yml', 'demo/role.md'])
    assert.deepEqual(result.skipped.sort(), ['demo/link', 'demo/scripts/run.sh'])
    assert.equal(await readFile(join(out, 'demo', 'role.md'), 'utf8'), EXPERT_ROLE)
    assert.equal(existsSync(join(out, 'demo', 'scripts', 'run.sh')), false)
    assert.equal(existsSync(join(out, 'demo', 'link')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extractTarGz 支持 GNU 长名与 pax path，并拒绝 tar-slip', async () => {
  const root = await tempDir()
  try {
    const out = join(root, 'out')
    const longName = 'a-very-long-directory-name-that-does-not-fit-in-100-bytes/expert.yml'
    const tar = makeTar([
      { name: '././@LongLink', type: 'L', data: Buffer.from(`${longName}\0`) },
      { name: 'short.yml', data: EXPERT_YML },
      { name: '././@PaxHeader', type: 'x', data: Buffer.from(paxRecord('path', 'pax-dir/pax.md')) },
      { name: 'ignored.md', data: 'pax 内容' },
    ])
    const result = await extractTarGz(tar, out) // plain tar (no gzip) is accepted too
    assert.ok(result.files.includes(longName))
    assert.ok(result.files.includes('pax-dir/pax.md'))
    assert.equal(await readFile(join(out, longName), 'utf8'), EXPERT_YML)
    assert.equal(await readFile(join(out, 'pax-dir', 'pax.md'), 'utf8'), 'pax 内容')

    const slipping = makeTar([{ name: '../evil.txt', data: 'x' }])
    await assert.rejects(() => extractTarGz(slipping, join(root, 'out2')), /NW_ZIP_SLIP/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('gzip 里不是 tar 时给出可读错误', async () => {
  await assert.rejects(() => extractTarGz(gzipSync(Buffer.from('plain text')), join(tmpdir(), 'unused')), /NW_BAD_TAR/)
  await assert.rejects(() => extractTarGz(Buffer.from('not gzip at all'), join(tmpdir(), 'unused')), /NW_BAD_TAR/)
})

test('importFromBuffer 从 tar.gz 得到 drafts', async () => {
  const tmpRoot = await tempDir()
  try {
    const tar = makeTar([
      { name: 'demo/expert.yml', data: EXPERT_YML },
      { name: 'demo/role.md', data: EXPERT_ROLE },
    ])
    const result = await importFromBuffer(gzipSync(tar), { filename: 'demo.tar.gz', tmpRoot })
    assert.equal(result.drafts.length, 1)
    assert.equal(result.drafts[0].id, 'demo')
    await result.cleanup()
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Single markdown / HTML / unsupported
// ---------------------------------------------------------------------------

test('importFromBuffer 识别单个 .md 专家', async () => {
  const tmpRoot = await tempDir()
  try {
    const result = await importFromBuffer(Buffer.from('---\nname: coach\ndisplay_name: 教练\n---\n你是一位教练。'), {
      filename: 'coach.md',
      tmpRoot,
    })
    assert.equal(result.drafts.length, 1)
    assert.equal(result.drafts[0].id, 'coach')
    assert.equal(result.drafts[0].roleText, '你是一位教练。')
    await result.cleanup()
    assert.deepEqual(await readdir(tmpRoot), [])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('importFromBuffer 拒绝 HTML 与未知二进制', async () => {
  await assert.rejects(importFromBuffer(Buffer.from('<!doctype html><html><body>hi</body></html>')), /NW_HTML/)
  await assert.rejects(importFromBuffer(Buffer.from([0x00, 0x01, 0x02, 0x03])), /NW_UNSUPPORTED/)
})

// ---------------------------------------------------------------------------
// importFromUrl: private hosts, limits, timeouts, content handling
// ---------------------------------------------------------------------------

/** Build a fetchImpl returning a fixed Response. */
function fetchResponse(body, contentType = '') {
  return async () => new Response(body, { status: 200, headers: contentType === '' ? {} : { 'content-type': contentType } })
}

test('importFromUrl 拒绝私网 URL（默认 allowPrivate=false）', async () => {
  for (const url of [
    'http://127.0.0.1:8080/expert.zip',
    'http://localhost/expert.zip',
    'http://10.0.0.2/expert.zip',
    'http://172.16.3.4/expert.zip',
    'http://192.168.1.2/expert.zip',
    'http://169.254.1.1/expert.zip',
    'http://[::1]/expert.zip',
  ]) {
    await assert.rejects(importFromUrl(url, { fetchImpl: fetchResponse('x') }), /NW_PRIVATE_ADDRESS/, url)
  }
  await assert.rejects(importFromUrl('ftp://example.com/x.zip'), /NW_BAD_URL/)
  await assert.rejects(importFromUrl('not a url'), /NW_BAD_URL/)
})

test('importFromUrl 拒绝重定向到私网地址', async () => {
  const response = new Response('x', { status: 200 })
  Object.defineProperty(response, 'url', { value: 'http://10.1.1.1/expert.zip' })
  await assert.rejects(importFromUrl('http://example.com/x.zip', { fetchImpl: async () => response }), /NW_PRIVATE_ADDRESS/)
})

test('importFromUrl 识别 HTML 并拒绝', async () => {
  await assert.rejects(
    importFromUrl('http://example.com/expert', {
      fetchImpl: fetchResponse('<html><body>下载页</body></html>', 'text/html'),
    }),
    /NW_HTML/,
  )
})

test('importFromUrl HTTP 错误、超限与超时', async () => {
  await assert.rejects(importFromUrl('http://example.com/x.zip', { fetchImpl: async () => new Response('no', { status: 404 }) }), /NW_HTTP/)

  const big = Buffer.alloc(256, 0x41)
  await assert.rejects(
    importFromUrl('http://example.com/x.zip', { fetchImpl: fetchResponse(big, 'application/zip'), maxBytes: 16 }),
    /NW_TOO_LARGE/,
  )
  const declaredBig = new Response(big, { headers: { 'content-length': '1000000', 'content-type': 'application/zip' } })
  await assert.rejects(importFromUrl('http://example.com/x.zip', { fetchImpl: async () => declaredBig, maxBytes: 1024 }), /NW_TOO_LARGE/)

  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted === true) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        return
      }
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
        once: true,
      })
    })
  await assert.rejects(importFromUrl('http://example.com/x.zip', { fetchImpl: hangingFetch, timeoutMs: 25 }), /NW_TIMEOUT/)
})

test('importFromUrl 下载 zip 并交给 workbuddy 读取（allowPrivate 测试开关）', async () => {
  const tmpRoot = await tempDir()
  try {
    const url = 'http://127.0.0.1:9/expert.zip'
    const result = await importFromUrl(url, {
      allowPrivate: true,
      fetchImpl: fetchResponse(demoExpertZip(), 'application/zip'),
      tmpRoot,
    })
    assert.equal(result.drafts.length, 1)
    assert.equal(result.drafts[0].id, 'demo')
    assert.equal(result.drafts[0].origin.origin, url)
    await result.cleanup()
    assert.deepEqual(await readdir(tmpRoot), [])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('importFromUrl 下载单个 markdown', async () => {
  const result = await importFromUrl('http://example.com/coach.md', {
    fetchImpl: fetchResponse('# Coach\n\n你是一位教练。', 'text/markdown'),
  })
  assert.equal(result.drafts.length, 1)
  assert.equal(result.drafts[0].id, 'coach')
  await result.cleanup()
})

// ---------------------------------------------------------------------------
// importFromPath
// ---------------------------------------------------------------------------

test('importFromPath 读取专家目录', async () => {
  const root = await tempDir()
  try {
    const dir = join(root, 'my-expert')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'expert.yml'),
      'schema: 1\nid: my-expert\ndisplay_name: 本地专家\ndescription: 来自目录\n',
      'utf8',
    )
    await writeFile(join(dir, 'role.md'), '你是本地专家。\n', 'utf8')
    const result = await importFromPath(dir)
    assert.equal(result.drafts.length, 1)
    assert.equal(result.drafts[0].id, 'my-expert')
    assert.equal(result.drafts[0].displayName, '本地专家')
    await result.cleanup() // no-op, but must not throw
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('importFromPath 读取单个 .md 与本地 zip', async () => {
  const root = await tempDir()
  try {
    const md = join(root, 'coach.md')
    await writeFile(md, '---\nname: coach\ndisplay_name: 教练\n---\n你是一位教练。\n', 'utf8')
    const single = await importFromPath(md)
    assert.equal(single.drafts.length, 1)
    assert.equal(single.drafts[0].id, 'coach')
    await single.cleanup()

    const zipPath = join(root, 'demo.zip')
    await writeFile(zipPath, demoExpertZip())
    const archive = await importFromPath(zipPath)
    assert.equal(archive.drafts.length, 1)
    assert.equal(archive.drafts[0].id, 'demo')
    await archive.cleanup()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('importFromPath 拒绝不存在的路径与不支持的文件', async () => {
  const root = await tempDir()
  try {
    await assert.rejects(importFromPath(join(root, 'missing')), /NW_NOT_FOUND/)
    await assert.rejects(importFromPath(''), /NW_BAD_PATH/)
    const txt = join(root, 'note.txt')
    await writeFile(txt, 'hello', 'utf8')
    await assert.rejects(importFromPath(txt), /NW_UNSUPPORTED/)
    const empty = join(root, 'empty')
    await mkdir(empty, { recursive: true })
    const result = await importFromPath(empty)
    assert.deepEqual(result.drafts, [])
    assert.ok(result.warnings.length >= 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
