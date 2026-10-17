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

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  ID_RE,
  excerptOf,
  expertFromYmlFields,
  normalizeText,
  parseExpertYml,
  sanitizeRoleText,
  serializeExpertYml,
  slugify,
  splitFrontmatter,
} from './format.js'
import { expertDirOf, expandHome } from './paths.js'
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
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    try {
      await writeFile(temp, data, { mode: 0o600, ...options })
      await rename(temp, filePath)
      return
    } catch (error) {
      lastError = error
      await rm(temp, { force: true }).catch(() => {})
      // Windows may briefly lock a just-written/scanned file; retry a few times.
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
    }
  }
  throw lastError
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
  const inlineSkills = normalizeSkillRows(input.skills) ?? []
  const rawPaths = Array.isArray(input.skillPaths) ? input.skillPaths : (input.skillPath !== undefined ? [input.skillPath] : [])
  const skillPaths = []
  for (const raw of rawPaths) {
    const path = cleanPath(raw)
    if (path === '' || skillPaths.includes(path)) continue
    const absolute = expandHome(path)
    try {
      await stat(absolute)
    } catch {
      throw new Error(`技能路径不存在：${path}`)
    }
    skillPaths.push(path)
  }
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
    skills: inlineSkills.map((row) => ({
      name: row.name,
      description: excerptOf(row.content, 120),
      content: row.content,
      hasSkillMd: true,
    })),
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
    if (inlineSkills.length > 0) await replaceSkills(dir, inlineSkills)
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  try {
    for (const path of skillPaths) await importSkillFromPath(id, path, paths)
  } catch (error) {
    // Keep creation atomic: a failed skill import removes the new expert again.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`导入技能失败，专家未创建：${error?.message ?? error}`)
  }

  const detail = await readInstalledDetail(paths, id)
  return detail.card
}

/**
 * Normalize an editable skill list (`[{ name, content }]`) into canonical
 * skill names and sanitized bodies. Invalid names/content throw: the caller is
 * an explicit form submission, not an import that can silently degrade.
 *
 * @param {unknown} value
 * @returns {Array<{ name: string, content: string }>|null}
 */
export function normalizeSkillRows(value) {
  if (!Array.isArray(value)) return null
  const seen = new Set()
  const rows = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const base = textOf(raw.name)
    const name = ID_RE.test(base) ? base : slugify(base, 'skill')
    const content = sanitizeRoleText(raw.content)
    if (content === '') throw new Error(`技能 ${base || '(未命名)'} 的内容不能为空`)
    if (seen.has(name)) throw new Error(`技能名重复：${name}`)
    seen.add(name)
    rows.push({ name, content })
  }
  return rows
}

/** Trim and unquote a pasted filesystem path. */
function cleanPath(value) {
  let text = textOf(value)
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim()
  }
  return text
}

/** Replace an expert's `skills/` tree with the given rows (SKILL.md bodies). */
async function replaceSkills(dir, rows) {
  const skillsDir = join(dir, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const existing = await readdir(skillsDir, { withFileTypes: true }).catch(() => [])
  const keep = new Set(rows.map((row) => row.name))
  for (const entry of existing) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue
    await rm(join(skillsDir, entry.name), { recursive: true, force: true })
  }
  for (const row of rows) {
    const target = join(skillsDir, row.name)
    await mkdir(target, { recursive: true })
    await writeAtomic(join(target, 'SKILL.md'), `${row.content}\n`, { encoding: 'utf8' })
  }
}

/** Read the skill name declared in a SKILL.md frontmatter, if any. */
async function skillNameFromFile(file, fallback, useHeading = false) {
  try {
    const text = normalizeText(await readFile(file, 'utf8'))
    const { fields, body } = splitFrontmatter(text)
    const declared = textOf(fields.name)
    if (declared !== '') return ID_RE.test(declared) ? declared : slugify(declared, 'skill')
    if (useHeading === true) {
      // A bare .md has no folder name to trust; use its first heading.
      for (const line of body.split('\n')) {
        const heading = /^#{1,6}[ \t]+(.+)$/.exec(line.trim())
        if (heading === null) continue
        const name = heading[1].trim()
        if (name !== '') return ID_RE.test(name) ? name : slugify(name, 'skill')
        break
      }
    }
    return slugify(fallback, 'skill')
  } catch {
    return slugify(fallback, 'skill')
  }
}

/**
 * Import one skill (or every skill directly under a folder) into an existing
 * expert. Accepts a skill directory with SKILL.md, a directory containing
 * several skill directories, or a single `.md` file. Existing skill directories
 * with the same name are replaced.
 *
 * @param {string} id expert id
 * @param {string} sourcePath skill dir / skills parent / .md file, `~` allowed
 * @param {object} paths
 * @returns {Promise<object>} updated wire card
 */
export async function importSkillFromPath(id, sourcePath, paths) {
  assertPaths(paths)
  const folderId = typeof id === 'string' ? id.trim() : ''
  if (!ID_RE.test(folderId)) throw new Error(`专家 id 不合法：${JSON.stringify(id)}`)
  const raw = cleanPath(sourcePath)
  if (raw === '') throw new Error('请提供技能目录或 .md 文件路径')
  const source = expandHome(raw)
  let info
  try {
    info = await stat(source)
  } catch {
    throw new Error(`路径不存在：${source}`)
  }
  const dir = expertDirOf(paths.expertsRoot, folderId)
  const skillsDir = join(dir, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const imported = []

  const importOne = async (name, fromDir) => {
    const target = join(skillsDir, name)
    await rm(target, { recursive: true, force: true })
    await cp(fromDir, target, { recursive: true, dereference: true, errorOnExist: false })
    imported.push(name)
  }

  if (info.isFile()) {
    if (!source.toLowerCase().endsWith('.md')) throw new Error('单个文件只支持 .md')
    const name = await skillNameFromFile(source, basename(source, '.md'), true)
    const content = await readFile(source, 'utf8')
    const targetDir = join(skillsDir, name)
    await mkdir(targetDir, { recursive: true })
    await writeAtomic(join(targetDir, 'SKILL.md'), `${normalizeText(content)}\n`, { encoding: 'utf8' })
    imported.push(name)
  } else if (info.isDirectory()) {
    const direct = join(source, 'SKILL.md')
    try {
      await stat(direct)
      await importOne(await skillNameFromFile(direct, basename(source)), source)
    } catch {
      const entries = await readdir(source, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const skillFile = join(source, entry.name, 'SKILL.md')
        try {
          await stat(skillFile)
        } catch {
          continue
        }
        await importOne(await skillNameFromFile(skillFile, entry.name), join(source, entry.name))
      }
    }
  } else {
    throw new Error('路径不是文件或目录')
  }
  if (imported.length === 0) throw new Error('来源里没有找到 SKILL.md')
  return (await readInstalledDetail(paths, folderId)).card
}

/** List soft-deleted experts kept in `$DSH_HOME/expert-hub/trash`. */
export async function listTrash(paths) {
  assertPaths(paths)
  const trashRoot = join(paths.stateDir, 'trash')
  const entries = await readdir(trashRoot, { withFileTypes: true }).catch(() => [])
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(trashRoot, entry.name)
    const deletedAt = /-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/.exec(entry.name)?.[1] ?? ''
    let id = entry.name.replace(/-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/, '')
    let displayName = id
    try {
      const fields = expertFromYmlFields(parseExpertYml(await readFile(join(dir, 'expert.yml'), 'utf8')))
      if (ID_RE.test(fields.id)) id = fields.id
      displayName = fields.displayName || id
    } catch {
      // Broken trash entry: keep the derived name so it can still be restored.
    }
    items.push({ name: entry.name, id, displayName, deletedAt })
  }
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1))
  return items
}

/** Restore one trashed expert folder by its trash entry name. */
export async function restoreTrash(paths, name) {
  assertPaths(paths)
  const entry = textOf(name)
  if (entry === '' || entry.includes('..') || /[\\/]/.test(entry)) throw new Error('回收站条目名不合法')
  const source = join(paths.stateDir, 'trash', entry)
  let fields
  try {
    fields = expertFromYmlFields(parseExpertYml(await readFile(join(source, 'expert.yml'), 'utf8')))
  } catch {
    throw new Error('回收站条目已损坏，无法恢复')
  }
  if (!ID_RE.test(fields.id)) throw new Error('回收站条目缺少合法 id，无法恢复')
  const target = expertDirOf(paths.expertsRoot, fields.id)
  try {
    await stat(target)
    throw new Error(`专家 ${fields.id} 已存在，不能覆盖恢复`)
  } catch (error) {
    if (error?.message?.includes('已存在')) throw error
  }
  await mkdir(paths.expertsRoot, { recursive: true })
  await rename(source, target)
  return (await readInstalledDetail(paths, fields.id)).card
}

/**
 * Permanently remove one trashed expert folder. Irreversible; callers must
 * confirm with the user first.
 */
export async function purgeTrash(paths, name) {
  assertPaths(paths)
  const entry = textOf(name)
  if (entry === '' || entry.includes('..') || /[\\/]/.test(entry)) throw new Error('回收站条目名不合法')
  const target = join(paths.stateDir, 'trash', entry)
  let info
  try {
    info = await stat(target)
  } catch {
    throw new Error('回收站条目不存在')
  }
  if (!info.isDirectory()) throw new Error('回收站条目不是目录')
  await rm(target, { recursive: true, force: true })
  return { name: entry }
}

/**
 * Update an existing expert. Metadata, `roleText`, the avatar and (optionally)
 * the whole skills tree can change; provenance fields are preserved.
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

  if (p.skills !== undefined) {
    const rows = normalizeSkillRows(p.skills)
    if (rows === null) throw new Error('skills 必须是数组')
    await replaceSkills(dir, rows)
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
