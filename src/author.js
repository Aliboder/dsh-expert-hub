/**
 * Authoring experts: creating, editing and deleting the user's own experts.
 *
 * Writes the canonical DSH expert folder (`expert.yml` + `role.md` +
 * `avatar.*` + `.expert-source.json`) under `$DSH_HOME/experts/<id>`. Skills are
 * never touched here: an expert's `skills/` tree belongs to whatever produced
 * it, and editing metadata must not delete it.
 *
 * Every path goes through `paths.expertDirOf`, which validates the id and
 * proves the resolved directory stays inside the expert root (CONTRACT.md §10).
 * Written files use mode 0o600; updates are written to a temp sibling and
 * renamed so a crash never leaves a half-written YAML file behind.
 *
 * @module dsh-expert-hub/author
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ID_RE,
  excerptOf,
  expertFromYmlFields,
  normalizeText,
  parseExpertYml,
  sanitizeRoleText,
  serializeExpertYml,
  slugify,
} from './format.js'
import { expertDirOf } from './paths.js'
import {
  deleteExpert,
  ensureExpertsRoot,
  expertMetaOf,
  fingerprintDraft,
  readInstalledDetail,
} from './store.js'

/** Avatar payload cap: 2 MiB (CONTRACT §7 allows an 8 MiB body for avatars). */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** Supported avatar mime types and their canonical file extension. */
const AVATAR_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
}

/** Number of `-2`, `-3`, … suffixes tried before giving up on a free id. */
const MAX_ID_ATTEMPTS = 50

/** The manifest file name the store reads back for provenance. */
const MANIFEST = '.expert-source.json'

/** Validate the `createPaths()` result before touching the filesystem. */
function assertPaths(paths) {
  if (paths === null || typeof paths !== 'object' || typeof paths.expertsRoot !== 'string') {
    throw new Error('缺少专家库路径配置（paths.expertsRoot）')
  }
}

/** Trimmed, normalized single-line text or ''. */
function textOf(value) {
  return typeof value === 'string' ? normalizeText(value).trim() : ''
}

/** Normalize a user list: arrays stay arrays, strings split on `pattern`. */
function listOf(value, limit, pattern) {
  let items = []
  if (Array.isArray(value)) {
    items = value.map((item) => textOf(item)).filter((item) => item !== '')
  } else if (typeof value === 'string') {
    items = normalizeText(value)
      .split(pattern)
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }
  return items.slice(0, limit)
}

/** True when the image bytes match the declared mime type. */
function matchesAvatarMagic(mime, data) {
  if (mime === 'image/png') {
    return (
      data.length >= 8 &&
      data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  }
  if (mime === 'image/webp') {
    return data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP'
  }
  return false
}

/**
 * Decode an `avatarDataUrl` (`data:image/png;base64,…`).
 *
 * Only png/jpeg/webp are accepted, the decoded bytes must actually match the
 * declared format, and the payload is capped at 2 MiB.
 *
 * @param {string} dataUrl
 * @returns {{ mime: string, ext: string, data: Buffer }}
 */
export function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.trim() === '') {
    throw new Error('AVATAR_EMPTY: 头像数据为空')
  }
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(dataUrl.trim())
  if (match === null) {
    throw new Error('AVATAR_INVALID: 不是合法的 data URL（需要 data:image/png;base64,... 形式）')
  }
  const headerParts = match[1].split(';').map((part) => part.trim())
  const mime = (headerParts[0] ?? '').toLowerCase()
  if (!headerParts.slice(1).some((part) => part.toLowerCase() === 'base64')) {
    throw new Error('AVATAR_INVALID: 仅支持 base64 编码的图片 data URL')
  }
  const ext = AVATAR_EXTENSIONS[mime]
  if (ext === undefined) {
    throw new Error(`AVATAR_TYPE: 不支持的头像格式：${mime || '(空)'}（仅支持 png/jpeg/webp）`)
  }
  const compact = match[2].replace(/\s+/g, '')
  if (compact === '') throw new Error('AVATAR_EMPTY: 头像数据为空')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('AVATAR_INVALID: 头像 base64 数据不合法')
  }
  const data = Buffer.from(compact, 'base64')
  if (data.length === 0) throw new Error('AVATAR_EMPTY: 头像数据为空')
  if (data.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `AVATAR_TOO_LARGE: 头像不能超过 2 MiB（当前 ${(data.length / 1024 / 1024).toFixed(2)} MiB）`,
    )
  }
  if (!matchesAvatarMagic(mime, data)) {
    throw new Error('AVATAR_INVALID: 头像内容与声明的图片格式不一致')
  }
  return { mime, ext, data }
}

/**
 * Write a file through a temp sibling + rename (atomic on the same volume).
 *
 * @param {string} filePath
 * @param {string|Buffer} data
 * @param {{ encoding?: 'utf8' }} [options]
 */
async function writeAtomic(filePath, data, options = {}) {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  try {
    await writeFile(temp, data, { mode: 0o600, ...options })
    await rename(temp, filePath)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Create a free `<id>` directory (suffixing `-2`, `-3`, … on collision). */
async function allocateExpertDir(paths, baseId) {
  await ensureExpertsRoot(paths)
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? baseId : `${baseId}-${attempt + 1}`
    if (!ID_RE.test(candidate)) continue
    const dir = expertDirOf(paths.expertsRoot, candidate)
    try {
      await mkdir(dir)
      return { id: candidate, dir }
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error(`无法分配唯一的专家 id（${baseId} 的同名目录过多）`)
}

/** Delete `avatar.png|jpg|jpeg|webp`, except the one just written. */
async function removeAvatarFiles(dir, keepName) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^avatar\.(png|jpe?g|webp)$/i.test(entry.name)) continue
    if (entry.name === keepName) continue
    await rm(join(dir, entry.name), { force: true }).catch(() => {})
  }
}

/**
 * Create a self-authored expert.
 *
 * @param {object} input
 * @param {string} [input.id] - optional explicit id (validated; suffixed on collision)
 * @param {string} input.displayName
 * @param {string} input.roleText
 * @param {string} [input.description]
 * @param {string} [input.name]
 * @param {string} [input.profession]
 * @param {string[]|string} [input.tags]
 * @param {string[]|string} [input.quickPrompts]
 * @param {string} [input.initPrompt]
 * @param {string} [input.category]
 * @param {number} [input.order]
 * @param {string} [input.avatarDataUrl]
 * @param {object} paths - `createPaths()` result
 * @returns {Promise<object>} wire card of the new expert
 */
export async function createExpert(input, paths) {
  assertPaths(paths)
  if (input === null || typeof input !== 'object') throw new Error('无效的专家数据')

  const displayName = textOf(input.displayName)
  const roleText = sanitizeRoleText(input.roleText)
  if (displayName === '') throw new Error('显示名不能为空')
  if (roleText === '') throw new Error('角色提示词（roleText）不能为空')

  let explicitId = ''
  if (input.id !== undefined && input.id !== null && String(input.id).trim() !== '') {
    explicitId = String(input.id).trim()
    if (!ID_RE.test(explicitId)) {
      throw new Error(
        `专家 id 不合法：${JSON.stringify(explicitId)}（只允许小写字母、数字、连字符，且以字母或数字开头）`,
      )
    }
  }
  const baseId = explicitId !== '' ? explicitId : slugify(displayName)
  if (!ID_RE.test(baseId)) throw new Error(`无法从显示名生成合法的专家 id：${JSON.stringify(displayName)}`)

  let avatar = null
  if (input.avatarDataUrl !== undefined && input.avatarDataUrl !== null && String(input.avatarDataUrl).trim() !== '') {
    avatar = decodeDataUrl(input.avatarDataUrl)
  }

  const order = Number(input.order)
  const draft = {
    id: baseId,
    displayName,
    name: textOf(input.name),
    profession: textOf(input.profession),
    professionEn: textOf(input.professionEn),
    description: textOf(input.description) || excerptOf(roleText, 80),
    descriptionEn: textOf(input.descriptionEn),
    tags: listOf(input.tags, 8, /[\n,，、]+/),
    category: textOf(input.category),
    categoryLabel: textOf(input.categoryLabel),
    quickPrompts: listOf(input.quickPrompts, 6, /\n+/),
    initPrompt: textOf(input.initPrompt),
    order: Number.isFinite(order) ? order : 200,
    roleText,
    skills: [],
    sourceKind: 'custom',
    sourceLabel: '本机自建',
  }

  const { id, dir } = await allocateExpertDir(paths, baseId)
  draft.id = id
  try {
    const meta = expertMetaOf(draft)
    await writeFile(join(dir, 'expert.yml'), serializeExpertYml(meta), { encoding: 'utf8', mode: 0o600 })
    await writeFile(join(dir, 'role.md'), `${roleText}\n`, { encoding: 'utf8', mode: 0o600 })
    if (avatar !== null) {
      await writeFile(join(dir, `avatar${avatar.ext}`), avatar.data, { mode: 0o600 })
    }
    const manifest = {
      kind: 'custom',
      origin: '',
      fingerprint: fingerprintDraft(draft),
      importedAt: new Date().toISOString(),
    }
    await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  const detail = await readInstalledDetail(paths, id)
  return detail.card
}

/**
 * Update an existing expert. Only metadata, `roleText` and the avatar can
 * change; `skills/` and provenance fields are preserved.
 *
 * @param {string} id
 * @param {object} patch
 * @param {object} paths
 * @returns {Promise<object>} wire card after the update
 */
export async function updateExpert(id, patch, paths) {
  assertPaths(paths)
  const folderId = typeof id === 'string' ? id.trim() : ''
  if (!ID_RE.test(folderId)) throw new Error(`专家 id 不合法：${JSON.stringify(id)}`)
  const dir = expertDirOf(paths.expertsRoot, folderId)

  let ymlText
  try {
    ymlText = await readFile(join(dir, 'expert.yml'), 'utf8')
  } catch {
    throw new Error('专家不存在')
  }
  const fields = expertFromYmlFields(parseExpertYml(ymlText))
  if (!ID_RE.test(fields.id)) throw new Error('专家目录里的 expert.yml 无法解析，无法更新')
  if (fields.id !== folderId) throw new Error(`文件夹名与 id 不一致（${folderId} ≠ ${fields.id}）`)

  const p = patch !== null && typeof patch === 'object' ? patch : {}
  const merged = { ...fields }

  const applyText = (key, value) => {
    if (typeof value !== 'string') return
    const text = normalizeText(value).trim()
    if (text === '') return
    merged[key] = text
  }
  applyText('displayName', p.displayName)
  applyText('name', p.name)
  applyText('profession', p.profession)
  applyText('description', p.description)
  applyText('initPrompt', p.initPrompt)
  if (p.tags !== undefined) merged.tags = listOf(p.tags, 8, /[\n,，、]+/)
  if (p.quickPrompts !== undefined) merged.quickPrompts = listOf(p.quickPrompts, 6, /\n+/)
  if (p.order !== undefined) {
    const order = Number(p.order)
    if (Number.isFinite(order)) merged.order = order
  }

  let nextRoleText = null
  if (p.roleText !== undefined) {
    if (typeof p.roleText !== 'string') throw new Error('角色提示词必须是一段文本')
    const sanitized = sanitizeRoleText(p.roleText)
    if (sanitized === '') throw new Error('角色提示词不能为空')
    nextRoleText = sanitized
  }

  let nextAvatar = null
  if (p.avatarDataUrl !== undefined && p.avatarDataUrl !== null && String(p.avatarDataUrl).trim() !== '') {
    nextAvatar = decodeDataUrl(p.avatarDataUrl)
  }

  const meta = {
    id: folderId,
    displayName: merged.displayName || folderId,
    name: merged.name,
    profession: merged.profession,
    professionEn: merged.professionEn,
    description: merged.description,
    descriptionEn: merged.descriptionEn,
    tags: merged.tags,
    category: merged.category,
    categoryLabel: merged.categoryLabel,
    quickPrompts: merged.quickPrompts,
    initPrompt: merged.initPrompt,
    order: merged.order,
    sourceKind: merged.sourceKind || 'custom',
    sourceLabel: merged.sourceLabel || '本机自建',
  }

  await writeAtomic(join(dir, 'expert.yml'), serializeExpertYml(meta), { encoding: 'utf8' })
  if (nextRoleText !== null) {
    await writeAtomic(join(dir, 'role.md'), `${nextRoleText}\n`, { encoding: 'utf8' })
  }
  if (nextAvatar !== null) {
    const avatarName = `avatar${nextAvatar.ext}`
    await writeFile(join(dir, avatarName), nextAvatar.data, { mode: 0o600 })
    await removeAvatarFiles(dir, avatarName)
  }

  const detail = await readInstalledDetail(paths, folderId)
  return detail.card
}

/**
 * Delete one installed expert folder.
 *
 * @param {string} id
 * @param {object} paths
 * @returns {Promise<{ id: string, dir: string }>}
 */
export async function deleteExpertCard(id, paths) {
  assertPaths(paths)
  return deleteExpert(paths, id)
}
