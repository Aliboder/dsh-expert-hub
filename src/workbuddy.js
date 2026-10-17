/**
 * WorkBuddy expert scanner.
 *
 * Reads the local WorkBuddy (CodeBuddy plugin marketplace) experts tree into
 * "expert drafts" the installer can copy into the DSH expert library. Pure
 * read: nothing is written, no script is executed, no archive is unpacked.
 *
 * Source layout (one directory per expert):
 *   <root>/<pluginDir>/
 *     .codebuddy-plugin/plugin.json   rich metadata (zh/en names, tags, prompts)
 *     agents/<name>.md                YAML frontmatter + persona body
 *     skills/<skill>/SKILL.md         optional, copied whole on install
 *     avatars/*.png|jpg|webp          optional
 *     README.md                       optional description fallback
 *
 * The same reader also accepts the DSH expert folder layout (expert.yml +
 * role.md + skills/) so the online importer can reuse it.
 *
 * @module dsh-expert-hub/workbuddy
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import {
  ID_RE,
  excerptOf,
  firstParagraph,
  normalizeText,
  slugify,
  splitFrontmatter,
} from './format.js'

/** Default WorkBuddy experts directory, echoed to the UI verbatim. */
export const DEFAULT_SOURCE_PATH = '~/.workbuddy/plugins/marketplaces/experts/plugins'

/** WorkBuddy category ids → Chinese labels the UI can show directly. */
export const CATEGORY_LABELS = {
  '01-ProductDesign': '产品设计',
  '02-Engineering': '工程开发',
  '03-DataAI': '数据与AI',
  '04-Marketing': '市场运营',
  '05-Content': '内容创作',
  '06-ContentCreative': '内容创作',
  '06-Productivity': '效率办公',
  '07-Finance': '财务会计',
  '08-HR': '人力资源',
  '09-Legal': '法务合规',
  '10-ProjectQuality': '项目质量',
  '10-Education': '教育学习',
  '11-Service': '客户服务',
  '12-Other': '其他',
  '17-CampusGuide': '校园指南',
}

/** Human label for a category id; unknown ids lose the numeric prefix. */
export function categoryLabelOf(id) {
  if (typeof id !== 'string' || id.trim() === '') return ''
  const key = id.trim()
  if (CATEGORY_LABELS[key] !== undefined) return CATEGORY_LABELS[key]
  return key.replace(/^\d+-/, '')
}

/** Trimmed string helper. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Localized field picker: `.zh` first, then `.en`, then a plain string. */
function localized(value, prefer) {
  if (typeof value === 'string') return value.trim()
  if (value === null || typeof value !== 'object') return ''
  const zh = textOf(value.zh)
  const en = textOf(value.en)
  if (prefer === 'en') return en || zh
  return zh || en
}

/** Read a JSON file, returning undefined for missing/unparsable input. */
async function readJson(path) {
  try {
    return JSON.parse(normalizeText(await readFile(path, 'utf8')))
  } catch {
    return undefined
  }
}

/** Read text, returning '' when missing. */
async function readText(path) {
  try {
    return normalizeText(await readFile(path, 'utf8'))
  } catch {
    return ''
  }
}

/** True when path is a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Sorted directory names matching the predicate; [] when missing. */
async function listDir(dir, keep) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((entry) => keep(entry) && !entry.name.startsWith('.')).map((entry) => entry.name).sort()
}

/** Skill name → safe kebab-case name for the DSH skills registry. */
export function skillNameOf(dirName) {
  const slug = slugify(dirName, 'skill')
  return slug === dirName ? dirName : slug
}

/** First heading/paragraph of a SKILL.md body as a routing description. */
export function skillDescriptionOf(markdown) {
  const { fields, body } = splitFrontmatter(markdown)
  const stated = textOf(fields.description) || textOf(fields.when_to_use) || textOf(fields.whenToUse)
  if (stated !== '') return stated.slice(0, 200)
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    return trimmed.replace(/^#+\s*/, '').slice(0, 200)
  }
  return 'expert skill'
}

/**
 * Normalize one agent markdown file into the draft's role text.
 * Frontmatter is metadata only; the body is the persona.
 */
export function roleTextOfAgentFile(markdown) {
  return splitFrontmatter(markdown).body.trim()
}

/**
 * Read the skills tree of a plugin directory into draft skill entries.
 * Each entry carries the source directory (copied at install time) and the
 * SKILL.md content (used for previews and registry descriptions).
 */
export async function readSkillEntries(pluginDir) {
  const names = await listDir(join(pluginDir, 'skills'), (entry) => entry.isDirectory())
  const entries = []
  for (const name of names) {
    const dir = join(pluginDir, 'skills', name)
    const skillFile = join(dir, 'SKILL.md')
    const content = normalizeText(await readText(skillFile))
    entries.push({
      name: skillNameOf(name),
      sourceName: name,
      dir,
      hasSkillMd: content !== '',
      content,
      description: content === '' ? '' : skillDescriptionOf(content),
    })
  }
  return entries
}

/** Resolve an avatar file path (png/jpg/jpeg/webp) from a plugin directory. */
export async function readAvatar(pluginDir, declared) {
  const candidates = []
  const declaredPath = textOf(declared).replace(/^\.\//, '')
  if (declaredPath !== '') candidates.push(join(pluginDir, declaredPath))
  const avatars = await listDir(join(pluginDir, 'avatars'), (entry) => entry.isFile())
  for (const name of avatars) {
    if (/\.(png|jpe?g|webp)$/i.test(name)) candidates.push(join(pluginDir, 'avatars', name))
  }
  for (const path of candidates) {
    if (/\.(png|jpe?g|webp)$/i.test(path) && (await isFile(path))) {
      return { path, ext: extname(path).toLowerCase().replace('.jpeg', '.jpg') }
    }
  }
  return null
}

/** Best-effort id from a directory name. */
function idOfDirectory(dir, fallback) {
  const name = basename(dir)
  return ID_RE.test(name) ? name : slugify(fallback ?? name, 'expert')
}

/** Append a team roster to the lead agent's persona. */
function teamRoleText(leadBody, members) {
  const valid = members.filter((member) => textOf(member?.id) !== '')
  if (valid.length === 0) return leadBody
  const roster = valid
    .map((member) => {
      const name = localized(member.name, 'zh') || textOf(member.id)
      const profession = localized(member.profession, 'zh')
      return `- ${name}${profession === '' ? '' : `（${profession}）`}`
    })
    .join('\n')
  return `${leadBody}\n\n## 团队成员\n你是这个团队的负责人，下面是对内分工（当前会话由你统一对外输出，按需参考各成员职责）：\n${roster}`
}

/**
 * Read one CodeBuddy plugin directory into an expert draft.
 *
 * @param {string} pluginDir absolute plugin directory
 * @param {{ origin: string, sourceLabel?: string, kind?: 'workbuddy'|'web'|'path' }} context
 * @returns {Promise<object|undefined>} draft, or undefined when the directory
 *   carries neither a plugin manifest nor agents
 */
export async function readCodebuddyDraft(pluginDir, context) {
  const manifest = await readJson(join(pluginDir, '.codebuddy-plugin', 'plugin.json'))
  const agentFiles = await listDir(join(pluginDir, 'agents'), (entry) => entry.isFile() && entry.name.endsWith('.md'))
  if (manifest === undefined && agentFiles.length === 0) return undefined
  if (agentFiles.length === 0) return undefined

  const pluginName = basename(pluginDir)
  const isTeam = manifest?.expertType === 'team' || agentFiles.length > 1
  const members = Array.isArray(manifest?.members) ? manifest.members : []
  const leadId = textOf(manifest?.teamInfo?.leadAgent) || textOf(manifest?.agentName)
  let primary = agentFiles[0]
  if (isTeam && leadId !== '' && agentFiles.includes(`${leadId}.md`)) primary = `${leadId}.md`
  const markdown = await readText(join(pluginDir, 'agents', primary))
  const { fields: agentFields } = splitFrontmatter(markdown)
  const roleText = isTeam ? teamRoleText(roleTextOfAgentFile(markdown), members) : roleTextOfAgentFile(markdown)

  const id = isTeam && ID_RE.test(pluginName)
    ? pluginName
    : ID_RE.test(textOf(agentFields.name))
      ? textOf(agentFields.name)
      : idOfDirectory(pluginDir, pluginName)
  if (!ID_RE.test(id)) return undefined

  const profession = localized(manifest?.profession, 'zh')
  const professionEn = localized(manifest?.profession, 'en')
  const personaName = localized(manifest?.displayName, 'zh')
  const agentDisplayName = localized(agentFields.displayName, 'zh')
  const lead = members.find((member) => textOf(member?.id) === (leadId || textOf(agentFields.name)))
  const leadName = localized(lead?.name, 'zh')
  const leadProfession = localized(lead?.profession, 'zh')
  // Prefer a Han persona name ("像素君"); fall back to the functional
  // profession ("广工百事通") when the source persona name is an ASCII handle.
  const displayName = isTeam
    ? leadName || leadProfession || profession || pluginName
    : (/[\u4e00-\u9fff]/.test(personaName) ? personaName : '') ||
      profession ||
      personaName ||
      (/[\u4e00-\u9fff]/.test(agentDisplayName) ? agentDisplayName : '') ||
      id
  const name = localized(manifest?.displayName, 'en') || localized(agentFields.displayName, 'en') || id
  const description =
    localized(manifest?.displayDescription, 'zh') ||
    textOf(manifest?.description) ||
    firstParagraph(await readText(join(pluginDir, 'README.md'))) ||
    textOf(agentFields.description) ||
    profession
  const descriptionEn =
    localized(manifest?.displayDescription, 'en') || textOf(agentFields.description) || ''
  const category = textOf(manifest?.categoryId)
  const tags = Array.isArray(manifest?.tags)
    ? manifest.tags
        .map((tag) => (typeof tag === 'string' ? tag : localized(tag, 'zh')))
        .filter((tag) => tag !== '')
        .slice(0, 8)
    : []
  const quickPrompts = Array.isArray(manifest?.quickPrompts)
    ? manifest.quickPrompts
        .map((prompt) => (typeof prompt === 'string' ? prompt : localized(prompt, 'zh')))
        .filter((prompt) => prompt !== '')
        .slice(0, 6)
    : []
  const initPrompt = localized(manifest?.defaultInitPrompt, 'zh')
  const skills = await readSkillEntries(pluginDir)
  const declaredAvatar = isTeam ? textOf(lead?.avatar) : textOf(manifest?.avatar)
  const avatar = await readAvatar(pluginDir, declaredAvatar)
  const teamSize = isTeam ? (members.length > 0 ? members.length : agentFiles.length) : 1

  return {
    id,
    displayName,
    name,
    profession: profession || '',
    professionEn,
    description: description || 'WorkBuddy 专家',
    descriptionEn,
    tags,
    category,
    categoryLabel: categoryLabelOf(category),
    quickPrompts,
    initPrompt,
    order: 200,
    roleText,
    skills,
    avatar,
    teamSize,
    sourceKind: context.kind ?? 'workbuddy',
    sourceLabel: context.sourceLabel ?? 'WorkBuddy 专家中心',
    origin: {
      kind: context.kind ?? 'workbuddy',
      origin: context.origin,
      pluginDir: pluginName,
      agentFile: primary,
    },
  }
}

/**
 * Read a DSH expert folder (`expert.yml` + `role.md` + `skills/`) into a draft.
 * Used by path/web imports of already-exported expert folders.
 *
 * @param {string} dir absolute folder
 * @param {{ origin: string, sourceLabel?: string, kind?: 'web'|'path' }} context
 */
export async function readExpertFolderDraft(dir, context) {
  const ymlText = await readText(join(dir, 'expert.yml'))
  if (ymlText.trim() === '') return undefined
  const { parseExpertYml, expertFromYmlFields } = await import('./format.js')
  const fields = expertFromYmlFields(parseExpertYml(ymlText))
  const roleText = (await readText(join(dir, 'role.md'))).trim()
  const id = ID_RE.test(fields.id) ? fields.id : idOfDirectory(dir, fields.displayName)
  if (roleText === '' && fields.description === '') return undefined
  const skills = await readSkillEntries(dir)
  const avatar = (await readAvatar(dir)) ?? (await fileAsAvatar(join(dir, 'avatar.png')))
  return {
    id,
    displayName: fields.displayName || id,
    name: fields.name,
    profession: fields.profession,
    professionEn: fields.professionEn,
    description: fields.description || '本地专家',
    descriptionEn: fields.descriptionEn,
    tags: fields.tags,
    category: fields.category,
    categoryLabel: fields.categoryLabel || categoryLabelOf(fields.category),
    quickPrompts: fields.quickPrompts,
    initPrompt: fields.initPrompt,
    order: fields.order,
    roleText,
    skills,
    avatar,
    teamSize: 1,
    sourceKind: context.kind ?? 'path',
    sourceLabel: context.sourceLabel ?? '本机目录',
    origin: { kind: context.kind ?? 'path', origin: context.origin, pluginDir: basename(dir) },
  }
}

/** Wrap a fixed avatar.png path into the avatar descriptor shape. */
async function fileAsAvatar(path) {
  if (!(await isFile(path))) return null
  return { path, ext: '.png' }
}

/**
 * Read a bare agent markdown file (single-role expert) into a draft.
 *
 * @param {string} file absolute `.md` path
 * @param {{ origin: string, kind?: 'web'|'path' }} context
 */
export async function readAgentFileDraft(file, context) {
  const markdown = await readText(file)
  if (markdown.trim() === '') return undefined
  const { fields } = splitFrontmatter(markdown)
  const name = textOf(fields.name) || basename(file, '.md')
  const id = ID_RE.test(name) ? name : slugify(name, 'expert')
  const displayName = localized(fields.displayName, 'zh') || name
  const roleText = roleTextOfAgentFile(markdown)
  if (roleText.trim() === '') return undefined
  return {
    id,
    displayName,
    name: localized(fields.displayName, 'en') || name,
    profession: localized(fields.profession, 'zh'),
    professionEn: localized(fields.profession, 'en'),
    description: textOf(fields.description) || excerptOf(roleText, 80),
    descriptionEn: '',
    tags: [],
    category: '',
    categoryLabel: '',
    quickPrompts: [],
    initPrompt: '',
    order: 200,
    roleText,
    skills: [],
    avatar: null,
    teamSize: 1,
    sourceKind: context.kind ?? 'path',
    sourceLabel: context.kind === 'web' ? '网页导入' : '本机文件',
    origin: { kind: context.kind ?? 'path', origin: context.origin, pluginDir: basename(file) },
  }
}

/**
 * Scan a WorkBuddy experts root into drafts.
 *
 * @param {string} root absolute experts root
 * @param {{ sourceLabel?: string, onWarning?: (message: string) => void }} [options]
 * @returns {Promise<{ drafts: object[], warnings: string[] }>}
 */
export async function scanWorkbuddyRoot(root, options = {}) {
  const drafts = []
  const warnings = []
  const warn = (message) => {
    warnings.push(message)
    options.onWarning?.(message)
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`WorkBuddy 目录不可读：${root}（${error?.message ?? error}）`)
    return { drafts, warnings }
  }
  const seen = new Set()
  for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    if (entry.startsWith('git:') || entry.startsWith('.')) continue
    try {
      const draft = await readCodebuddyDraft(join(root, entry), {
        origin: root,
        kind: 'workbuddy',
        sourceLabel: options.sourceLabel ?? 'WorkBuddy 专家中心',
      })
      if (draft === undefined) {
        warn(`${entry}：没有可识别的专家清单，已跳过`)
        continue
      }
      if (seen.has(draft.id)) {
        warn(`专家 id "${draft.id}" 重复（${entry}），保留第一个`)
        continue
      }
      seen.add(draft.id)
      drafts.push(draft)
    } catch (error) {
      warn(`${entry}：读取失败（${error?.message ?? error}）`)
    }
  }
  // Some marketplaces ship one brand persona name for several experts
  // ("鹏城信息AI专家"); a shared display name is useless in the picker, so
  // fall back to the functional profession for the duplicates only.
  const nameCounts = new Map()
  for (const draft of drafts) nameCounts.set(draft.displayName, (nameCounts.get(draft.displayName) ?? 0) + 1)
  for (const draft of drafts) {
    if ((nameCounts.get(draft.displayName) ?? 0) > 1 && draft.profession !== '') {
      draft.displayName = draft.profession
    }
  }
  return { drafts, warnings }
}

/**
 * Detect and read the expert(s) contained in one directory (already unpacked).
 *
 * @param {string} dir absolute directory
 * @param {{ origin: string, kind?: 'web'|'path', sourceLabel?: string }} context
 * @returns {Promise<{ drafts: object[], warnings: string[] }>}
 */
export async function readDirectoryDrafts(dir, context) {
  const drafts = []
  const warnings = []
  const direct = await readCodebuddyDraft(dir, context)
  if (direct !== undefined) return { drafts: [direct], warnings }
  const folder = await readExpertFolderDraft(dir, context)
  if (folder !== undefined) return { drafts: [folder], warnings }

  // Layout: the archive nested everything under one or more subdirectories.
  const children = await listDir(dir, (entry) => entry.isDirectory())
  for (const child of children) {
    const childDir = join(dir, child)
    const codebuddy = await readCodebuddyDraft(childDir, context)
    if (codebuddy !== undefined) {
      drafts.push(codebuddy)
      continue
    }
    const expert = await readExpertFolderDraft(childDir, context)
    if (expert !== undefined) drafts.push(expert)
  }
  if (drafts.length > 0) return { drafts, warnings }

  // Layout: a bare agent markdown file.
  const files = await listDir(dir, (entry) => entry.isFile() && entry.name.endsWith('.md'))
  for (const file of files) {
    const agent = await readAgentFileDraft(join(dir, file), context)
    if (agent !== undefined) drafts.push(agent)
  }
  if (drafts.length === 0) warnings.push(`目录里没有找到可识别的专家：${dir}`)
  return { drafts, warnings }
}
