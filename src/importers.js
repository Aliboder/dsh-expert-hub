/**
 * Importing experts from the web or from a local path.
 *
 * One module owns "foreign payload in → expert drafts out":
 *   - `importFromUrl`  downloads http(s), sniffs zip / tar.gz / markdown / HTML
 *     and unpacks archives into a throw-away directory;
 *   - `importFromPath` reads a local folder, one `.md` agent file, or a local
 *     archive;
 *   - `importFromBuffer` is the same pipeline for an in-memory buffer (tests).
 *
 * Archives are unpacked by a deliberately small, dependency-free reader: the
 * zip central directory + `zlib.inflateRawSync`, and the tar (ustar) 512-byte
 * header format behind `zlib.gunzipSync`. Unknown layouts degrade to readable
 * errors instead of crashes.
 *
 * Security rules (CONTRACT.md §10):
 *   - only http(s) URLs; private / loopback / link-local hosts are refused
 *     unless `options.allowPrivate === true` (tests only);
 *   - downloads are capped (20 MiB by default) and timed out (30s by default);
 *   - archive entry paths must resolve inside the extraction directory
 *     (`NW_ZIP_SLIP` otherwise), absolute paths are refused;
 *   - symlinks and entries with any executable bit are skipped;
 *   - extraction is capped (entry count + total bytes) to blunt zip bombs.
 *
 * Draft objects reference files inside the temporary extraction folder
 * (`skill.dir`, `avatar.path`), so callers MUST install the drafts first and
 * only then call the returned `cleanup()`.
 *
 * @module dsh-expert-hub/importers
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

import { isHttpUrl } from './format.js'
import { expandHome, isInside } from './paths.js'
import { readAgentFileDraft, readDirectoryDrafts } from './workbuddy.js'

/** Default download cap: 20 MiB. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

/** Default download timeout: 30s. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Hard cap on unpacked bytes (protects against zip bombs). */
const MAX_EXTRACT_BYTES = 128 * 1024 * 1024

/** Hard cap on archive entry count. */
const MAX_ENTRY_COUNT = 4096

/** Cap on a local archive file accepted by `importFromPath` before reading it. */
const MAX_LOCAL_ARCHIVE_BYTES = 128 * 1024 * 1024

/** Build a coded, human-readable error. */
function codedError(code, message) {
  return new Error(`${code}: ${message}`)
}

// ---------------------------------------------------------------------------
// Payload classification
// ---------------------------------------------------------------------------

/** True when the buffer looks like printable text (no NUL in the first 4 KiB). */
function looksTextual(bytes) {
  const head = bytes.subarray(0, 4096)
  for (const byte of head) {
    if (byte === 0) return false
  }
  return true
}

/**
 * Classify a downloaded/loaded payload.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} [contentType] lowercase or mixed-case response content type
 * @returns {'zip'|'tar.gz'|'markdown'|'html'|'unknown'}
 */
export function classifyPayload(buffer, contentType = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (bytes.length >= 4) {
    const [b0, b1, b2, b3] = bytes
    if (b0 === 0x50 && b1 === 0x4b && ((b2 === 0x03 && b3 === 0x04) || (b2 === 0x05 && b3 === 0x06))) {
      return 'zip'
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'tar.gz'
  if (bytes.length === 0) return 'unknown'

  const type = String(contentType ?? '').toLowerCase()
  if (type.includes('text/html') || type.includes('application/xhtml')) return 'html'

  const head = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase()
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    /<html[\s>]/.test(head) ||
    /<head[\s>]/.test(head) ||
    /<body[\s>]/.test(head) ||
    /<script[\s>]/.test(head)
  ) {
    return 'html'
  }

  if (type.includes('text/markdown') || type.includes('text/x-markdown')) return 'markdown'
  if (type.startsWith('text/')) return looksTextual(bytes) ? 'markdown' : 'unknown'
  if (type !== '' && !type.includes('octet-stream')) return 'unknown'
  return looksTextual(bytes) ? 'markdown' : 'unknown'
}

// ---------------------------------------------------------------------------
// Private address guard
// ---------------------------------------------------------------------------

/** True for RFC1918 / loopback / link-local / CGNAT IPv4 literals. */
function isPrivateIPv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false
    const value = Number(part)
    if (value > 255) return false
    octets.push(value)
  }
  const [a, b] = octets
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  return false
}

/** Expand an IPv6 literal into 8 numeric groups, undefined when invalid. */
function expandIPv6(address) {
  const value = address.split('%')[0].toLowerCase()
  if (value === '') return undefined
  const halves = value.includes('::') ? value.split('::') : [value, undefined]
  if (halves.length > 2) return undefined
  const head = halves[0] === '' ? [] : halves[0].split(':')
  let groups
  if (halves[1] === undefined) {
    groups = head
  } else {
    const tail = halves[1] === '' ? [] : halves[1].split(':')
    const zeros = 8 - head.length - tail.length
    if (zeros < 0) return undefined
    groups = [...head, ...Array.from({ length: zeros }, () => '0'), ...tail]
  }
  if (groups.length !== 8) return undefined
  const numbers = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
    numbers.push(Number.parseInt(group, 16))
  }
  return numbers
}

/** True for loopback / link-local / unique-local IPv6 literals. */
function isPrivateIPv6(host) {
  const groups = expandIPv6(host)
  if (groups === undefined) return true // unparsable literal → refuse
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1)) return true
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  const mapped = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)
  if (mapped) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    return isPrivateIPv4(v4)
  }
  return false
}

/**
 * True when a URL host must not be fetched by default (private, loopback,
 * link-local or the `localhost` alias). Public hostnames return false; name
 * resolution to a private IP is not checked here (a redirect re-check runs
 * after the response arrives).
 *
 * @param {string} host - `URL#hostname` value (IPv6 may carry brackets)
 */
export function isPrivateHost(host) {
  if (typeof host !== 'string') return true
  let name = host.trim().toLowerCase()
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1)
  if (name.endsWith('.')) name = name.slice(0, -1)
  if (name === '') return true
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::' || name === '::1') return true
  if (name.includes(':')) return isPrivateIPv6(name)
  return isPrivateIPv4(name)
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/** Read a response header defensively (plain objects allowed). */
function headerOf(response, name) {
  try {
    const headers = response?.headers
    if (headers === undefined || headers === null) return ''
    if (typeof headers.get === 'function') return String(headers.get(name) ?? '')
    const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
    return found === undefined ? '' : String(headers[found])
  } catch {
    return ''
  }
}

/** Any positive finite number, else the fallback. */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** `1.5 MiB` style size for error messages. */
function humanBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${bytes} B`
}

/** Download a body with a byte cap; abort the request when the cap is hit. */
async function readBodyLimited(response, maxBytes, controller, timeoutMs) {
  const limit = positiveNumber(maxBytes, DEFAULT_MAX_BYTES)
  const declared = Number(headerOf(response, 'content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    throw codedError('NW_TOO_LARGE', `文件超过大小上限（${humanBytes(limit)}）`)
  }
  const body = response.body
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done === true) break
        if (step.value === undefined || step.value === null) continue
        const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value)
        total += chunk.length
        if (total > limit) {
          controller.abort()
          await reader.cancel().catch(() => {})
          throw codedError('NW_TOO_LARGE', `文件超过大小上限（${humanBytes(limit)}）`)
        }
        chunks.push(chunk)
      }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw codedError('NW_TIMEOUT', `下载超时（${timeoutMs}ms）`)
      }
      throw error
    }
    return Buffer.concat(chunks, total)
  }
  const raw = await response.arrayBuffer().catch((error) => {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw codedError('NW_TIMEOUT', `下载超时（${timeoutMs}ms）`)
    }
    throw error
  })
  const buffer = Buffer.from(raw ?? new ArrayBuffer(0))
  if (buffer.length > limit) throw codedError('NW_TOO_LARGE', `文件超过大小上限（${humanBytes(limit)}）`)
  return buffer
}

/** Fetch `url` into a Buffer, enforcing timeout + size cap. */
async function download(url, options) {
  const { fetchImpl, timeoutMs, maxBytes } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  timer.unref?.()
  try {
    let response
    try {
      response = await fetchImpl(String(url), { signal: controller.signal, redirect: 'follow' })
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw codedError('NW_TIMEOUT', `下载超时（${timeoutMs}ms）`)
      }
      throw codedError('NW_HTTP', `下载失败（${error?.message ?? error}）`)
    }
    if (response === null || typeof response !== 'object') {
      throw codedError('NW_HTTP', '下载失败（没有收到响应）')
    }
    const status = Number(response.status ?? 0)
    if (response.ok === false || (Number.isFinite(status) && status !== 0 && (status < 200 || status >= 300))) {
      throw codedError('NW_HTTP', `下载失败（HTTP ${status || '未知状态'}）`)
    }
    const contentType = headerOf(response, 'content-type').toLowerCase()
    const buffer = await readBodyLimited(response, maxBytes, controller, timeoutMs)
    const finalUrl = typeof response.url === 'string' && response.url !== '' ? response.url : String(url)
    return { buffer, contentType, finalUrl }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Temp directories
// ---------------------------------------------------------------------------

/** Create a random extraction directory under `tmpRoot`. */
async function makeTempRoot(tmpRoot) {
  const base =
    typeof tmpRoot === 'string' && tmpRoot.trim() !== ''
      ? resolve(expandHome(tmpRoot.trim()))
      : join(tmpdir(), 'dsh-expert-hub-import')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, 'import-'))
}

/** Idempotent recursive delete of an extraction directory. */
function cleanupOf(dir) {
  let done = false
  return async () => {
    if (done) return
    done = true
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Unpack an archive into a fresh temp directory (deleted on failure). */
async function extractArchiveToTemp(buffer, kind, tmpRoot) {
  const dir = await makeTempRoot(tmpRoot)
  try {
    if (kind === 'zip') await extractZip(buffer, dir)
    else if (kind === 'tar.gz') await extractTarGz(buffer, dir)
    else throw codedError('NW_UNSUPPORTED', `不支持的压缩格式：${kind}`)
    return dir
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Keep the first draft per id (archives can repeat an id across folders). */
function dedupeDrafts(drafts, warnings) {
  const seen = new Set()
  const kept = []
  for (const draft of drafts) {
    if (typeof draft?.id !== 'string' || draft.id === '') continue
    if (seen.has(draft.id)) {
      warnings.push(`专家 id "${draft.id}" 重复，只保留第一个`)
      continue
    }
    seen.add(draft.id)
    kept.push(draft)
  }
  return kept
}

/** Read an already-unpacked directory into drafts + cleanup. */
async function draftsFromDir(dir, context) {
  let result
  try {
    result = await readDirectoryDrafts(dir, context)
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  const warnings = [...(result.warnings ?? [])]
  const drafts = dedupeDrafts(result.drafts ?? [], warnings)
  return { drafts, warnings, cleanup: cleanupOf(dir) }
}

// ---------------------------------------------------------------------------
// Zip reader (store / deflate only)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 (the one zip stores in its headers). */
function crc32(bytes) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Offset of the End Of Central Directory record, -1 when absent. */
function findZipEocd(bytes) {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff)
  for (let offset = bytes.length - 22; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

/**
 * Normalize one archive entry path. Throws `NW_ZIP_SLIP` for absolute paths
 * and NUL bytes; callers still resolve + confine the result.
 *
 * @returns {{ name: string, isDir: boolean, ignore: boolean }}
 */
function normalizeEntryPath(raw) {
  const value = String(raw)
  if (value.includes('\0')) throw codedError('NW_ZIP_SLIP', '压缩包条目路径包含非法字符')
  let name = value.replace(/\\/g, '/')
  while (name.startsWith('./')) name = name.slice(2)
  const isDir = name.endsWith('/')
  name = name.replace(/\/+$/, '')
  if (name === '' || name === '.') return { name: '', isDir: true, ignore: true }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw codedError('NW_ZIP_SLIP', `压缩包包含绝对路径条目（${value}）`)
  }
  return { name, isDir, ignore: false }
}

/** Resolve an entry inside `root`, refusing escapes. */
function confinedEntryPath(root, rawName) {
  const normalized = normalizeEntryPath(rawName)
  if (normalized.ignore) return normalized
  const destination = resolve(root, normalized.name)
  if (destination === root || !isInside(root, destination)) {
    throw codedError('NW_ZIP_SLIP', `压缩包条目路径越界（zip-slip）：${rawName}`)
  }
  return { ...normalized, destination }
}

/** Shared extraction limits. */
function extractLimits(options = {}) {
  const maxBytes = positiveNumber(options.maxExtractBytes, MAX_EXTRACT_BYTES)
  const maxEntries = positiveNumber(options.maxEntries, MAX_ENTRY_COUNT)
  return { maxBytes, maxEntries }
}

/** True when an entry name is archive junk we never want to install. */
function isArchiveJunk(name) {
  return name.startsWith('__MACOSX/') || basename(name) === '.DS_Store'
}

/**
 * Extract a zip buffer into `targetDir`.
 *
 * Supports the two universal methods (store/deflate) and rejects zip64,
 * encrypted entries and exotic compression as readable errors.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} targetDir directory to unpack into (created when missing)
 * @param {{ maxExtractBytes?: number, maxEntries?: number }} [options]
 * @returns {Promise<{ files: string[], skipped: string[] }>}
 */
export async function extractZip(buffer, targetDir, options = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const root = resolve(String(targetDir))
  await mkdir(root, { recursive: true })
  const limits = extractLimits(options)

  const eocd = findZipEocd(bytes)
  if (eocd < 0) throw codedError('NW_BAD_ZIP', '不是有效的 zip 文件（找不到中央目录结尾记录）')
  const entryCount = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw codedError('NW_ZIP64', '暂不支持 zip64 压缩包，请重新打包为普通 zip 后重试')
  }
  if (entryCount > limits.maxEntries) {
    throw codedError('NW_TOO_LARGE', `压缩包条目过多（${entryCount} > ${limits.maxEntries}）`)
  }
  if (centralOffset + centralSize > bytes.length) {
    throw codedError('NW_BAD_ZIP', 'zip 中央目录超出文件范围（文件可能被截断）')
  }

  const files = []
  const skipped = []
  let cursor = centralOffset
  let total = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw codedError('NW_BAD_ZIP', 'zip 中央目录损坏')
    }
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const expectedCrc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const externalAttrs = bytes.readUInt32LE(cursor + 38)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.length) throw codedError('NW_BAD_ZIP', 'zip 条目名超出文件范围')
    const rawName = bytes.toString('utf8', nameStart, nameEnd)
    cursor = nameEnd + extraLength + commentLength

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw codedError('NW_ZIP64', '暂不支持 zip64 压缩包，请重新打包为普通 zip 后重试')
    }
    if ((flags & 0x0001) !== 0) {
      throw codedError('NW_ZIP_ENCRYPTED', `zip 条目已加密，无法导入（${rawName}）`)
    }

    const entry = confinedEntryPath(root, rawName)
    if (entry.ignore) continue
    if (isArchiveJunk(entry.name)) {
      skipped.push(entry.name)
      continue
    }
    const unixMode = (externalAttrs >>> 16) & 0xffff
    const fileType = unixMode & 0o170000
    if (fileType === 0o120000) {
      skipped.push(entry.name) // symlink
      continue
    }
    const isDirectory = entry.isDir || fileType === 0o040000
    if (isDirectory) {
      await mkdir(entry.destination, { recursive: true }).catch((error) => {
        throw codedError('NW_BAD_ZIP', `创建目录失败（${entry.name}）：${error?.message ?? error}`)
      })
      continue
    }
    if ((unixMode & 0o111) !== 0) {
      skipped.push(entry.name) // executable bit → never materialize
      continue
    }

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw codedError('NW_BAD_ZIP', `zip 条目头损坏（${entry.name}）`)
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataStart > bytes.length || dataEnd > bytes.length) {
      throw codedError('NW_BAD_ZIP', `zip 条目数据越界（${entry.name}）`)
    }
    const compressed = bytes.subarray(dataStart, dataEnd)
    let content
    if (method === 0) {
      content = Buffer.from(compressed)
    } else if (method === 8) {
      try {
        content = inflateRawSync(compressed)
      } catch (error) {
        throw codedError('NW_BAD_ZIP', `zip 条目解压失败（${entry.name}）：${error?.message ?? error}`)
      }
    } else {
      throw codedError('NW_ZIP_METHOD', `不支持的 zip 压缩方式 ${method}（${entry.name}）`)
    }
    if (content.length > 0 && crc32(content) !== expectedCrc) {
      throw codedError('NW_BAD_ZIP', `zip 条目校验失败（${entry.name}）`)
    }
    total += content.length
    if (total > limits.maxBytes) {
      throw codedError('NW_TOO_LARGE', `解压后体积超过上限（${humanBytes(limits.maxBytes)}）`)
    }
    try {
      await mkdir(dirname(entry.destination), { recursive: true })
      await writeFile(entry.destination, content, { mode: 0o600 })
    } catch (error) {
      throw codedError('NW_BAD_ZIP', `写入条目失败（${entry.name}）：${error?.message ?? error}`)
    }
    files.push(entry.name)
  }

  return { files, skipped }
}

// ---------------------------------------------------------------------------
// Tar reader (ustar, GNU long name, pax path)
// ---------------------------------------------------------------------------

/** True when every byte of a 512-byte block is zero (tar end marker). */
function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false
  }
  return true
}

/** Read a NUL-terminated text field from a tar record. */
function readTarText(bytes, offset, length) {
  const end = Math.min(bytes.length, offset + length)
  const text = bytes.toString('utf8', offset, end)
  const nul = text.indexOf('\0')
  return nul < 0 ? text.trim() : text.slice(0, nul).trim()
}

/** Parse an octal (or GNU base-256) tar numeric field. */
function readTarNumber(bytes, offset, length) {
  if ((bytes[offset] & 0x80) !== 0) {
    let value = bytes[offset] & 0x7f
    for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index]
    return Number.isSafeInteger(value) ? value : Number.NaN
  }
  const text = readTarText(bytes, offset, length)
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : Number.NaN
}

/** Parse pax extended-header records into a key/value map. */
function parsePaxRecords(bytes) {
  const fields = {}
  const text = bytes.toString('utf8')
  let offset = 0
  while (offset < text.length) {
    const match = /^(\d+) /.exec(text.slice(offset))
    if (match === null) break
    const length = Number.parseInt(match[1], 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break
    const record = text.slice(offset, offset + length)
    const equals = record.indexOf('=')
    if (equals > 0) {
      const key = record.slice(record.indexOf(' ') + 1, equals)
      if (key !== '') fields[key] = record.slice(equals + 1).replace(/\n$/, '')
    }
    offset += length
  }
  return fields
}

/** Unpack one tar buffer (already gunzipped) into `targetDir`. */
async function extractTar(bytes, targetDir, options = {}) {
  const root = resolve(String(targetDir))
  await mkdir(root, { recursive: true })
  const limits = extractLimits(options)
  if (bytes.length < 512) throw codedError('NW_BAD_TAR', 'tar 内容过短，不是有效的 tar 包')
  if (bytes.toString('latin1', 257, 262) !== 'ustar') {
    throw codedError('NW_BAD_TAR', '不是有效的 tar 包（缺少 ustar 标识）')
  }

  const files = []
  const skipped = []
  let offset = 0
  let total = 0
  let longName = ''
  let paxPath = ''
  let seen = 0

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (isZeroBlock(header)) break
    seen += 1
    if (seen > limits.maxEntries) {
      throw codedError('NW_TOO_LARGE', `tar 条目过多（> ${limits.maxEntries}）`)
    }
    const size = readTarNumber(header, 124, 12)
    if (!Number.isFinite(size) || size < 0) throw codedError('NW_BAD_TAR', 'tar 条目大小字段损坏')
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const mode = readTarNumber(header, 100, 8)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > bytes.length) throw codedError('NW_BAD_TAR', 'tar 条目数据越界（文件可能被截断）')
    const data = bytes.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / 512) * 512

    if (typeflag === 'L') {
      longName = readTarText(data, 0, data.length)
      continue
    }
    if (typeflag === 'K') continue
    if (typeflag === 'x' || typeflag === 'g') {
      const fields = parsePaxRecords(data)
      if (typeflag === 'x' && typeof fields.path === 'string') paxPath = fields.path
      continue
    }
    let entryName = paxPath !== '' ? paxPath : longName !== '' ? longName : ''
    longName = ''
    paxPath = ''
    if (entryName === '') {
      const name = readTarText(header, 0, 100)
      const prefix = readTarText(header, 345, 155)
      entryName = prefix === '' ? name : `${prefix}/${name}`
    }
    if (entryName === '') continue

    if (typeflag === '2' || typeflag === '1') {
      skipped.push(entryName) // symlink / hardlink
      continue
    }
    if (typeflag !== '0' && typeflag !== '5') {
      skipped.push(entryName) // char/block device, fifo or unknown
      continue
    }
    const entry = confinedEntryPath(root, entryName)
    if (entry.ignore) continue
    if (isArchiveJunk(entry.name)) {
      skipped.push(entry.name)
      continue
    }
    const isDirectory = typeflag === '5' || entry.isDir
    if (isDirectory) {
      await mkdir(entry.destination, { recursive: true }).catch((error) => {
        throw codedError('NW_BAD_TAR', `创建目录失败（${entry.name}）：${error?.message ?? error}`)
      })
      continue
    }
    if (Number.isFinite(mode) && (mode & 0o111) !== 0) {
      skipped.push(entry.name)
      continue
    }
    total += size
    if (total > limits.maxBytes) {
      throw codedError('NW_TOO_LARGE', `解压后体积超过上限（${humanBytes(limits.maxBytes)}）`)
    }
    try {
      await mkdir(dirname(entry.destination), { recursive: true })
      await writeFile(entry.destination, Buffer.from(data), { mode: 0o600 })
    } catch (error) {
      throw codedError('NW_BAD_TAR', `写入条目失败（${entry.name}）：${error?.message ?? error}`)
    }
    files.push(entry.name)
  }

  return { files, skipped }
}

/**
 * Extract a `.tar.gz` (or a plain `.tar`) buffer into `targetDir`.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} targetDir
 * @param {{ maxExtractBytes?: number, maxEntries?: number }} [options]
 * @returns {Promise<{ files: string[], skipped: string[] }>}
 */
export async function extractTarGz(buffer, targetDir, options = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    let tarBytes
    try {
      tarBytes = gunzipSync(bytes)
    } catch (error) {
      throw codedError('NW_BAD_GZIP', `gzip 解压失败：${error?.message ?? error}`)
    }
    return extractTar(tarBytes, targetDir, options)
  }
  return extractTar(bytes, targetDir, options)
}

// ---------------------------------------------------------------------------
// Public import entry points
// ---------------------------------------------------------------------------

/** Best-effort `.md` filename from a URL path (used for single-file imports). */
function markdownFileNameFromUrl(url) {
  try {
    const pathname = new URL(String(url)).pathname
    const raw = decodeURIComponent(pathname.split('/').filter((part) => part !== '').pop() ?? '')
    const safe = basename(raw.replace(/\\/g, '/')).replace(/^\.+/, '')
    if (/\.(md|markdown)$/i.test(safe)) return safe
    if (safe !== '') return `${safe.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'expert'}.md`
  } catch {
    // fall through to the generic name
  }
  return 'expert.md'
}

/**
 * Download and import the expert(s) at an http(s) URL.
 *
 * @param {string} url
 * @param {{
 *   tmpRoot?: string,
 *   fetchImpl?: typeof fetch,
 *   allowPrivate?: boolean,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 * }} [options]
 * @returns {Promise<{ drafts: object[], warnings: string[], cleanup: () => Promise<void> }>}
 *   `cleanup` deletes the extraction folder; it must run AFTER the drafts are
 *   installed because drafts point at files inside that folder.
 */
export async function importFromUrl(url, options = {}) {
  const input = typeof url === 'string' ? url.trim() : ''
  if (!isHttpUrl(input)) throw codedError('NW_BAD_URL', '只支持 http/https 链接')
  const parsed = new URL(input)
  const allowPrivate = options.allowPrivate === true
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw codedError('NW_PRIVATE_ADDRESS', `拒绝访问内网/本机地址：${parsed.hostname}`)
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw codedError('NW_FETCH', '当前环境没有可用的 fetch')
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxBytes = positiveNumber(options.maxBytes, DEFAULT_MAX_BYTES)

  const { buffer, contentType, finalUrl } = await download(parsed, { fetchImpl, timeoutMs, maxBytes })

  // A public URL may redirect to a private address; refuse to read that payload.
  if (!allowPrivate) {
    try {
      const final = new URL(finalUrl)
      if (isPrivateHost(final.hostname)) {
        throw codedError('NW_PRIVATE_ADDRESS', `重定向到了内网/本机地址：${final.hostname}`)
      }
    } catch (error) {
      if (String(error?.message ?? '').startsWith('NW_')) throw error
    }
  }

  const kind = classifyPayload(buffer, contentType)
  if (kind === 'html') {
    throw codedError('NW_HTML', '这是网页而不是专家包；请填写专家 zip / tar.gz 的直链，或改用本机路径导入')
  }
  if (kind === 'unknown') {
    throw codedError('NW_UNSUPPORTED', '无法识别的文件类型（仅支持 .zip / .tar.gz / .md）')
  }

  if (kind === 'markdown') {
    const dir = await makeTempRoot(options.tmpRoot)
    try {
      const name = markdownFileNameFromUrl(finalUrl)
      await writeFile(join(dir, name), buffer, { mode: 0o600 })
      const draft = await readAgentFileDraft(join(dir, name), {
        origin: finalUrl,
        kind: 'web',
        sourceLabel: '网页导入',
      })
      const warnings = draft === undefined ? ['下载内容是纯文本，但没有识别出专家角色内容'] : []
      return { drafts: draft === undefined ? [] : [draft], warnings, cleanup: cleanupOf(dir) }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  const dir = await extractArchiveToTemp(buffer, kind, options.tmpRoot)
  return draftsFromDir(dir, { origin: finalUrl, kind: 'web', sourceLabel: '网页导入' })
}

/**
 * Import expert(s) from a local folder, one `.md` agent file, or a local
 * archive (`.zip` / `.tar.gz`).
 *
 * @param {string} inputPath - may start with `~`
 * @param {{ kind?: 'path'|'web', tmpRoot?: string }} [options]
 * @returns {Promise<{ drafts: object[], warnings: string[], cleanup: () => Promise<void> }>}
 */
export async function importFromPath(inputPath, options = {}) {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  if (raw === '') throw codedError('NW_BAD_PATH', '路径为空')
  const absolute = resolve(expandHome(raw))
  let info
  try {
    info = await stat(absolute)
  } catch {
    throw codedError('NW_NOT_FOUND', `路径不存在：${absolute}`)
  }
  const kind = options.kind === 'web' ? 'web' : 'path'
  const sourceLabel = kind === 'web' ? '网页导入' : '本机目录导入'

  if (info.isDirectory()) {
    let result
    try {
      result = await readDirectoryDrafts(absolute, { origin: absolute, kind, sourceLabel })
    } catch (error) {
      throw codedError('NW_UNSUPPORTED', `读取目录失败：${error?.message ?? error}`)
    }
    const warnings = [...(result.warnings ?? [])]
    const drafts = dedupeDrafts(result.drafts ?? [], warnings)
    return { drafts, warnings, cleanup: async () => {} }
  }
  if (!info.isFile()) throw codedError('NW_UNSUPPORTED', `既不是目录也不是文件：${absolute}`)

  if (/\.(md|markdown)$/i.test(absolute)) {
    const draft = await readAgentFileDraft(absolute, { origin: absolute, kind, sourceLabel })
    const warnings = draft === undefined ? ['没有从该文件识别出专家角色内容'] : []
    return { drafts: draft === undefined ? [] : [draft], warnings, cleanup: async () => {} }
  }

  if (/\.(zip|tar\.gz|tgz|tar)$/i.test(absolute)) {
    if (info.size > MAX_LOCAL_ARCHIVE_BYTES) {
      throw codedError('NW_TOO_LARGE', `压缩包过大（上限 ${humanBytes(MAX_LOCAL_ARCHIVE_BYTES)}）`)
    }
    const bytes = await readFile(absolute)
    let archiveKind = classifyPayload(bytes, '')
    if (archiveKind === 'html') {
      throw codedError('NW_HTML', '文件内容是网页而不是压缩包')
    }
    if (archiveKind !== 'zip' && archiveKind !== 'tar.gz') {
      if (/\.(tar|tgz|tar\.gz)$/i.test(absolute)) archiveKind = 'tar.gz'
      else throw codedError('NW_UNSUPPORTED', '压缩包内容无法识别（仅支持 zip / tar.gz）')
    }
    const dir = await extractArchiveToTemp(bytes, archiveKind, options.tmpRoot)
    return draftsFromDir(dir, { origin: absolute, kind, sourceLabel })
  }

  throw codedError('NW_UNSUPPORTED', '只支持专家目录、.md 文件，或 .zip / .tar.gz 压缩包')
}

/**
 * Import from an in-memory payload (used by tests and by callers that already
 * have the bytes). Same classification and safety rules as `importFromUrl`.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{ filename?: string, contentType?: string, tmpRoot?: string }} [options]
 * @returns {Promise<{ drafts: object[], warnings: string[], cleanup: () => Promise<void> }>}
 */
export async function importFromBuffer(buffer, options = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const kind = classifyPayload(bytes, options.contentType ?? '')
  if (kind === 'html') {
    throw codedError('NW_HTML', '这是网页而不是专家包；请提供 zip / tar.gz 压缩包或 .md 文件')
  }
  if (kind === 'unknown') {
    throw codedError('NW_UNSUPPORTED', '无法识别的文件类型（仅支持 .zip / .tar.gz / .md）')
  }
  const filename = typeof options.filename === 'string' ? options.filename : ''
  if (kind === 'markdown') {
    const dir = await makeTempRoot(options.tmpRoot)
    try {
      const name = /\.(md|markdown)$/i.test(basename(filename)) ? basename(filename) : 'expert.md'
      await writeFile(join(dir, name), bytes, { mode: 0o600 })
      const draft = await readAgentFileDraft(join(dir, name), {
        origin: filename !== '' ? filename : name,
        kind: 'web',
        sourceLabel: '网页导入',
      })
      const warnings = draft === undefined ? ['内容是纯文本，但没有识别出专家角色内容'] : []
      return { drafts: draft === undefined ? [] : [draft], warnings, cleanup: cleanupOf(dir) }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
  const dir = await extractArchiveToTemp(bytes, kind, options.tmpRoot)
  return draftsFromDir(dir, {
    origin: filename !== '' ? filename : '本地文件',
    kind: 'web',
    sourceLabel: '网页导入',
  })
}
