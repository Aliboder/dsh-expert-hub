/**
 * The installed expert library: reading cards, installing drafts, updating,
 * deleting, and reading details.
 *
 * One writer for `$DSH_HOME/experts/<id>/`. Every path is validated against
 * the expert root before any filesystem call.
 *
 * @module dsh-expert-hub/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ID_RE,
  excerptOf,
  expertFromYmlFields,
  normalizeText,
  parseExpertYml,
  sanitizeRoleText,
  serializeExpertYml,
  splitFrontmatter,
} from './format.js'
import { fingerprintOf } from './fingerprint.js'
import { displayPath, expertDirOf, isInside } from './paths.js'
import { categoryLabelOf, readSkillEntries, scanWorkbuddyRoot } from './workbuddy.js'

const MANIFEST = '.expert-source.json'

/** Content hash used inside fingerprints for skill bodies. */
function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)
}

/** Fingerprint a draft from its semantic content (not mtimes). */
export function fingerprintDraft(draft) {
  const skillEntries = (draft.skills ?? [])
    .filter((skill) => skill.hasSkillMd !== false)
    .map((skill) => `${skill.name}:${hashText(skill.content ?? '')}`)
  return fingerprintOf({
    id: draft.id,
    displayName: draft.displayName,
    description: draft.description,
    roleText: draft.roleText,
    skillEntries,
  })
}

/** Convert a draft into the canonical expert.yml metadata object. */
export function expertMetaOf(draft) {
  return {
    id: draft.id,
    displayName: draft.displayName,
    name: draft.name,
    profession: draft.profession,
    professionEn: draft.professionEn,
    description: draft.description,
    descriptionEn: draft.descriptionEn,
    tags: draft.tags,
    category: draft.category,
    categoryLabel: draft.categoryLabel || categoryLabelOf(draft.category),
    quickPrompts: draft.quickPrompts,
    initPrompt: draft.initPrompt,
    order: draft.order ?? 200,
    sourceKind: draft.sourceKind,
    sourceLabel: draft.sourceLabel,
  }
}

/** Ensure the expert root exists. */
export async function ensureExpertsRoot(paths) {
  await mkdir(paths.expertsRoot, { recursive: true })
}

/** Read the source manifest of an installed expert, undefined when absent. */
export async function readManifest(dir) {
  try {
    const parsed = JSON.parse(normalizeText(await readFile(join(dir, MANIFEST), 'utf8')))
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** First image avatar file in a folder, by conventional name. */
async function findAvatar(dir) {
  for (const name of ['avatar.png', 'avatar.jpg', 'avatar.webp']) {
    try {
      if ((await stat(join(dir, name))).isFile()) return { path: join(dir, name), ext: `.${name.split('.').pop()}` }
    } catch {
      // try the next conventional name
    }
  }
  return null
}

/** Copy one draft skill directory into the installed folder, or write its
 * inline content when the draft carries no source directory (AI-imported). */
async function copySkill(skill, targetRoot) {
  if (typeof skill.dir === 'string' && skill.dir !== '') {
    const target = join(targetRoot, 'skills', skill.name)
    await mkdir(join(targetRoot, 'skills'), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await cp(skill.dir, target, { recursive: true, dereference: true, errorOnExist: false })
    return
  }
  if (typeof skill.content === 'string' && skill.content.trim() !== '') {
    const target = join(targetRoot, 'skills', skill.name)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), `${normalizeText(skill.content)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
}

/**
 * Install (or update) one expert draft into the expert library.
 *
 * @param {object} draft - as produced by the WorkBuddy scanner or importers
 * @param {object} paths - createPaths() result
 * @param {{ update?: boolean }} [options]
 * @returns {Promise<{ id: string, dir: string, action: 'install'|'update' }>}
 */
export async function installDraft(draft, paths, options = {}) {
  if (draft === null || typeof draft !== 'object') throw new Error('无效的专家数据')
  if (!ID_RE.test(String(draft.id ?? ''))) throw new Error(`专家 id 不合法：${JSON.stringify(draft.id)}`)
  const id = draft.id
  const dir = expertDirOf(paths.expertsRoot, id)
  await ensureExpertsRoot(paths)

  let exists = false
  try {
    exists = (await stat(dir)).isDirectory()
  } catch {
    exists = false
  }
  const manifest = exists ? await readManifest(dir) : undefined
  if (exists && options.update !== true) {
    throw new Error(manifest === undefined ? '该专家是手动创建的，不能覆盖' : '专家已存在，如需更新请使用更新操作')
  }
  if (exists && manifest === undefined && options.update === true) {
    throw new Error('该专家是手动创建的，不能覆盖')
  }

  const staging = join(paths.expertsRoot, `.staging-${id}-${randomUUID().slice(0, 8)}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    const meta = expertMetaOf(draft)
    await writeFile(join(staging, 'expert.yml'), serializeExpertYml(meta), { encoding: 'utf8', mode: 0o600 })
    await writeFile(join(staging, 'role.md'), `${sanitizeRoleText(draft.roleText ?? '')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    for (const skill of draft.skills ?? []) {
      if (skill?.hasSkillMd === false) continue
      await copySkill(skill, staging)
    }
    if (draft.avatar !== null && typeof draft.avatar?.path === 'string') {
      try {
        await copyFile(draft.avatar.path, join(staging, `avatar${draft.avatar.ext ?? '.png'}`))
      } catch {
        // A dangling avatar never blocks the install.
      }
    }
    const manifestPayload = {
      format: 'expert-hub/v1',
      kind: draft.sourceKind ?? 'path',
      origin: displayPath(String(draft.origin?.origin ?? '')),
      pluginDir: draft.origin?.pluginDir,
      agentFile: draft.origin?.agentFile,
      fingerprint: fingerprintDraft(draft),
      importedAt: new Date().toISOString(),
    }
    await writeFile(join(staging, MANIFEST), `${JSON.stringify(manifestPayload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    // Replace the target only after the staging folder is complete.
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
    return { id, dir, action: exists ? 'update' : 'install' }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Delete one installed expert folder (soft delete: move to the trash). */
export async function deleteExpert(paths, id) {
  const dir = expertDirOf(paths.expertsRoot, id)
  if (!isInside(paths.expertsRoot, dir)) throw new Error('专家目录越界')
  const manifest = await readManifest(dir)
  const yml = await readFileSafe(join(dir, 'expert.yml'))
  if (manifest === undefined && yml === '') throw new Error('该目录不是专家文件夹，拒绝删除')
  // Keep deletions recoverable: move the folder into the plugin's trash
  // instead of deleting it outright.
  const trashRoot = join(paths.stateDir, 'trash')
  await mkdir(trashRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(trashRoot, `${id}-${stamp}`)
  try {
    await rename(dir, target)
    return { id, dir, trash: target }
  } catch (error) {
    // Cross-device or locked folder: fall back to a recursive delete.
    await rm(dir, { recursive: true, force: true })
    return { id, dir, trash: null, warning: `无法移动到回收站，已直接删除：${error?.message ?? error}` }
  }
}

/** Read a file as text, '' on any failure. */
async function readFileSafe(path) {
  try {
    return normalizeText(await readFile(path, 'utf8'))
  } catch {
    return ''
  }
}

/** Build the wire card for one installed expert folder. */
async function cardFromDir(dir, dirName, library = 'global') {
  const yml = await readFileSafe(join(dir, 'expert.yml'))
  const broken = (reason) => ({
    id: dirName,
    displayName: dirName,
    description: '',
    tags: [],
    quickPrompts: [],
    skills: [],
    roleExcerpt: '',
    roleChars: 0,
    teamSize: 1,
    installed: true,
    updatable: false,
    library,
    sourceKind: 'installed',
    sourceLabel: library === 'project' ? '项目专家' : '本机专家',
    order: 999,
    avatarUrl: '',
    broken: reason,
  })
  if (yml.trim() === '') return broken('缺少 expert.yml')
  const fields = expertFromYmlFields(parseExpertYml(yml))
  if (!ID_RE.test(fields.id)) return broken('expert.yml 里的 id 不合法')
  if (fields.id !== dirName) return broken(`文件夹名与 id 不一致（${dirName} ≠ ${fields.id}）`)
  const roleText = await readFileSafe(join(dir, 'role.md'))
  if (roleText.trim() === '' && fields.description === '') return broken('缺少 role.md 且没有描述')
  const skills = await readSkillEntries(dir)
  const avatar = await findAvatar(dir)
  const manifest = await readManifest(dir)
  return {
    id: fields.id,
    displayName: fields.displayName || fields.id,
    name: fields.name || '',
    profession: fields.profession || '',
    professionEn: fields.professionEn || '',
    description: fields.description || excerptOf(roleText, 80),
    descriptionEn: fields.descriptionEn || '',
    tags: fields.tags,
    category: fields.category || '',
    categoryLabel: fields.categoryLabel || categoryLabelOf(fields.category),
    quickPrompts: fields.quickPrompts,
    initPrompt: fields.initPrompt,
    roleExcerpt: excerptOf(roleText),
    roleChars: roleText.length,
    skills: skills
      .filter((skill) => skill.hasSkillMd)
      .map((skill) => ({ name: skill.name, description: skill.description, chars: skill.content.length })),
    teamSize: 1,
    installed: true,
    updatable: false,
    library,
    sourceKind: 'installed',
    sourceLabel: sourceLabelOf(manifest),
    order: fields.order,
    avatarUrl: avatar === null ? '' : `expert-hub/avatar?id=${encodeURIComponent(fields.id)}&scope=installed&library=${library}`,
    dir,
    manifest,
  }
}

/** Human label of an imported expert's origin. */
function sourceLabelOf(manifest) {
  if (manifest === undefined) return '本机自建'
  if (manifest.kind === 'workbuddy') return 'WorkBuddy 专家中心'
  if (manifest.kind === 'ai') return 'AI 整理导入'
  if (manifest.kind === 'custom') return '本机自建'
  if (manifest.kind === 'web') return '网页导入'
  if (manifest.kind === 'path') return '本机目录导入'
  // Legacy dsh-workbuddy-expert manifests carry only sourcePath/pluginDir.
  if (typeof manifest.sourcePath === 'string') return 'WorkBuddy 专家中心'
  return '导入'
}

/** Scan the installed expert library into cards, broken rows included. */
export async function scanInstalled(paths) {
  const library = paths.scope === 'project' ? 'project' : 'global'
  let entries
  try {
    entries = await readdir(paths.expertsRoot, { withFileTypes: true })
  } catch {
    return { cards: [], warnings: [] }
  }
  const cards = []
  const warnings = []
  for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    if (entry.startsWith('.')) continue
    const dir = join(paths.expertsRoot, entry)
    try {
      cards.push(await cardFromDir(dir, entry, library))
    } catch (error) {
      warnings.push(`${entry}：读取失败（${error?.message ?? error}）`)
    }
  }
  cards.sort((a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order))
  return { cards, warnings }
}

/** Read one installed expert's detail (role body + skill bodies). */
export async function readInstalledDetail(paths, id) {
  const dir = expertDirOf(paths.expertsRoot, id)
  const yml = await readFileSafe(join(dir, 'expert.yml'))
  if (yml.trim() === '') throw new Error('该专家不存在')
  const fields = expertFromYmlFields(parseExpertYml(yml))
  const roleText = await readFileSafe(join(dir, 'role.md'))
  const skills = await readSkillEntries(dir)
  return {
    card: await cardFromDir(dir, id, paths.scope === 'project' ? 'project' : 'global'),
    roleText,
    skills: skills
      .filter((skill) => skill.hasSkillMd)
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        path: join(skill.dir, 'SKILL.md'),
      })),
    meta: { sourcePath: fields.category || '', agentFile: '' },
  }
}

/** Resolve the avatar file of an installed expert for serving. */
export async function avatarFileOf(paths, id) {
  const dir = expertDirOf(paths.expertsRoot, id)
  return findAvatar(dir)
}

/**
 * Read the WorkBuddy source into cards, overlaying installed/updatable state.
 *
 * @param {object} paths
 * @param {{ installedFingerprints?: Record<string, string> }} [options]
 */
/**
 * Build the wire card of one WorkBuddy source draft, with installed/updatable
 * overlaid from the current library state.
 *
 * @param {object} draft - readCodebuddyDraft()/scanWorkbuddyRoot() result
 * @param {{ installedFingerprint?: string }} [options]
 */
export function cardFromDraft(draft, options = {}) {
  const installed = options.installed === true
  const comparable = installed && typeof options.installedFingerprint === 'string'
  return {
    id: draft.id,
    displayName: draft.displayName,
    name: draft.name ?? '',
    profession: draft.profession ?? '',
    professionEn: draft.professionEn ?? '',
    description: draft.description ?? '',
    descriptionEn: draft.descriptionEn ?? '',
    tags: draft.tags ?? [],
    category: draft.category ?? '',
    categoryLabel: draft.categoryLabel ?? '',
    quickPrompts: draft.quickPrompts ?? [],
    initPrompt: draft.initPrompt ?? '',
    roleExcerpt: excerptOf(draft.roleText ?? ''),
    roleChars: (draft.roleText ?? '').length,
    skills: (draft.skills ?? [])
      .filter((skill) => skill.hasSkillMd)
      .map((skill) => ({ name: skill.name, description: skill.description, chars: skill.content.length })),
    teamSize: draft.teamSize ?? 1,
    installed,
    updatable: comparable && options.installedFingerprint !== fingerprintDraft(draft),
    sourceKind: draft.sourceKind ?? 'workbuddy',
    sourceLabel: draft.sourceLabel ?? 'WorkBuddy 专家中心',
    order: draft.order ?? 200,
    avatarUrl: `expert-hub/avatar?id=${encodeURIComponent(draft.id)}&scope=workbuddy`,
  }
}

export async function scanAvailable(paths, options = {}) {
  if (paths.sourceDir === '' || paths.sourceDir === undefined) {
    return { cards: [], warnings: [], sourceExists: false }
  }
  let sourceExists = false
  try {
    sourceExists = (await stat(paths.sourceDir)).isDirectory()
  } catch {
    sourceExists = false
  }
  if (!sourceExists) return { cards: [], warnings: [], sourceExists: false }
  const { drafts, warnings } = await scanWorkbuddyRoot(paths.sourceDir)
  const installed = options.installed ?? (await installedState(paths))
  const cards = drafts.map((draft) =>
    cardFromDraft(draft, {
      installed: installed.ids.has(draft.id),
      installedFingerprint: installed.fingerprints[draft.id],
    }),
  )
  cards.sort((a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order))
  return { cards, warnings, sourceExists: true, drafts }
}

/**
 * Installed ids plus the fingerprints this plugin wrote itself. Manifests from
 * older/foreign importers carry a fingerprint of a different algorithm, so they
 * are excluded here — otherwise every legacy expert would look "updatable".
 */
export async function installedState(paths) {
  const { cards, warnings } = await scanInstalled(paths)
  const ids = new Set()
  const fingerprints = {}
  for (const card of cards) {
    if (card.broken !== undefined) continue
    ids.add(card.id)
    const manifest = card.manifest
    if (manifest?.format === 'expert-hub/v1' && typeof manifest.fingerprint === 'string') {
      fingerprints[card.id] = manifest.fingerprint
    }
  }
  return { cards, warnings, ids, fingerprints }
}

/** Installed fingerprints by id (only manifests written by this plugin). */
export async function installedFingerprints(paths) {
  return (await installedState(paths)).fingerprints
}

/** Re-export for routes that need to read the source draft of one id. */
export async function readAvailableDraft(paths, id) {
  if (!ID_RE.test(String(id ?? ''))) throw new Error(`专家 id 不合法：${JSON.stringify(id)}`)
  const { drafts } = await scanWorkbuddyRoot(paths.sourceDir)
  const draft = drafts.find((item) => item.id === id)
  if (draft === undefined) throw new Error('WorkBuddy 里没有这位专家')
  return draft
}
