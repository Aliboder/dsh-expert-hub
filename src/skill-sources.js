/**
 * Local skill discovery for the "add skill" picker.
 *
 * The editor used to ask for a filesystem path. Users should not have to know
 * where every agent keeps its skills, so this module scans the roots that DSH,
 * WorkBuddy and the common coding agents already use (plus a project's own
 * skill folders) and reports the skills it can copy.
 *
 * Discovery is read-only and deliberately shallow: a root is either one skill
 * (a `SKILL.md` at its top level) or a folder whose direct children are skill
 * folders. Copying still goes through `author.importSkillFromPath`, so the
 * safety checks (path validation, replacing a same-name skill, resource files)
 * stay in one place.
 *
 * Pure Node: no Cordis imports.
 *
 * @module dsh-expert-hub/skill-sources
 */

import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { ID_RE, slugify, splitFrontmatter } from './format.js'
import { displayPath } from './paths.js'

const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 512 * 1024
const MAX_ITEMS = 500
const MAX_NAME = 120
const MAX_DESCRIPTION = 180

/** Directories that are never skill containers, even if they have a `skills/` child. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '.npm', '.pnpm', '.yarn',
  '.local', '.ssh', '.gnupg', '.config', '.vscode', '.idea', '.DS_Store',
  'trash', '_backups', 'archive', 'archives', 'dist', 'build', 'out', 'target',
])

/**
 * Known agent homes. `dir` is relative to the user home (or project root);
 * `source` is a stable key, `label` is what the picker shows.
 */
const AGENT_ROOTS = [
  ['.claude', 'claude', 'Claude Code'],
  ['.codex', 'codex', 'Codex'],
  ['.cursor', 'cursor', 'Cursor'],
  ['.gemini', 'gemini', 'Gemini CLI'],
  ['.copilot', 'copilot', 'GitHub Copilot'],
  ['.qwen', 'qwen', 'Qwen Code'],
  ['.opencode', 'opencode', 'OpenCode'],
  ['.windsurf', 'windsurf', 'Windsurf'],
  ['.cline', 'cline', 'Cline'],
  ['.roo', 'roo', 'Roo Code'],
  ['.kiro', 'kiro', 'Kiro'],
  ['.trae', 'trae', 'Trae'],
  ['.augment', 'augment', 'Augment Code'],
  ['.continue', 'continue', 'Continue'],
  ['.amp', 'amp', 'Amp'],
  ['.aider', 'aider', 'Aider'],
  ['.goose', 'goose', 'Goose'],
  ['.workbuddy', 'workbuddy', 'WorkBuddy'],
  ['.codebuddy', 'codebuddy', 'CodeBuddy'],
]

/** `true` when the path exists and is a directory (symlinks followed). */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** `true` when the path exists and is a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Read at most `maxBytes` from the head of a file, without loading a huge file. */
async function readHead(path, maxBytes) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const size = Math.min(info.size, maxBytes)
    if (size <= 0) return { text: '', size: 0, truncated: false }
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, 0)
    return { text: buffer.toString('utf8'), size: info.size, truncated: info.size > size }
  } finally {
    await handle.close()
  }
}

/** Strip quotes/whitespace from one scalar. */
function cleanScalar(value) {
  return typeof value === 'string' ? value.replace(/^['"]|['"]$/g, '').trim() : ''
}

/** First meaningful paragraph of a SKILL.md body, used when frontmatter has no description. */
function firstParagraph(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n')
  const parts = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (parts.length > 0) break
      continue
    }
    if (/^#{1,6}\s+/.test(trimmed)) continue
    if (/^```/.test(trimmed)) continue
    if (/^<\/?[a-z][^>]*>/i.test(trimmed)) continue
    const text = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`>]/g, '')
      .trim()
    if (text !== '') parts.push(text)
    if (parts.join(' ').length > MAX_DESCRIPTION * 2) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION)
}

/** Build one root descriptor. */
function rootOf(path, source, label, scope) {
  return { path, source, label, scope }
}

/** Global roots, in the order the picker should prefer them. */
function globalRoots(home, dshHome) {
  const roots = []
  roots.push(rootOf(join(dshHome, 'skills'), 'dsh', 'DSH 用户技能', 'global'))
  if (resolve(dshHome) !== resolve(join(home, '.dsh'))) {
    roots.push(rootOf(join(home, '.dsh', 'skills'), 'dsh-default', 'DSH 用户技能', 'global'))
  }
  roots.push(rootOf(join(home, '.agents', 'skills'), 'agents', '共享技能池', 'global'))
  for (const [dir, source, label] of AGENT_ROOTS) {
    roots.push(rootOf(join(home, dir, 'skills'), source, label, 'global'))
  }
  return roots
}

/** Project roots: the project's own copies of the same conventions. */
function projectRoots(projectRoot) {
  const roots = [
    rootOf(join(projectRoot, '.dsh', 'skills'), 'dsh-project', 'DSH 项目技能', 'project'),
    rootOf(join(projectRoot, '.agents', 'skills'), 'agents-project', '项目共享技能池', 'project'),
  ]
  for (const [dir, source, label] of AGENT_ROOTS) {
    roots.push(rootOf(join(projectRoot, dir, 'skills'), `${source}-project`, label, 'project'))
  }
  return roots
}

/** Discover `~/.<agent>/skills` roots that are not in the known list. */
async function conventionRoots(home) {
  const roots = []
  const known = new Set(['.dsh', '.agents', '.config', ...AGENT_ROOTS.map(([dir]) => dir)])
  let entries
  try {
    entries = await readdir(home, { withFileTypes: true })
  } catch {
    return roots
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!entry.name.startsWith('.') || known.has(entry.name) || IGNORED_DIRS.has(entry.name)) continue
    const dir = join(home, entry.name, 'skills')
    if (await isDirectory(dir)) {
      const name = entry.name.slice(1)
      roots.push(rootOf(dir, name, `${name} 技能`, 'global'))
    }
  }
  return roots
}

/** Discover `~/.config/<agent>/skills` roots (mostly Linux/macOS layouts). */
async function configRoots(home) {
  const roots = []
  const configDir = join(home, '.config')
  let entries
  try {
    entries = await readdir(configDir, { withFileTypes: true })
  } catch {
    return roots
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const dir = join(configDir, entry.name, 'skills')
    if (await isDirectory(dir)) roots.push(rootOf(dir, `config:${entry.name}`, `${entry.name} 技能`, 'global'))
  }
  return roots
}

/** Read one skill folder and append it to the result set. */
async function addSkill(root, dir, state) {
  const file = join(dir, SKILL_FILE)
  let real
  try {
    real = await realpath(dir)
  } catch {
    real = resolve(dir)
  }
  if (state.seen.has(real)) return
  state.seen.add(real)

  let head
  try {
    head = await readHead(file, MAX_SKILL_BYTES)
  } catch (error) {
    if (error?.code !== 'ENOENT') state.warnings.push(`无法读取技能 ${dir}：${error?.message ?? error}`)
    return
  }
  const parsed = splitFrontmatter(head.text)
  const declaredName = cleanScalar(parsed.fields.name)
  const declaredDescription = cleanScalar(parsed.fields.description)
  const rawName = declaredName || basename(dir)
  const name = rawName.slice(0, MAX_NAME)
  const importName = ID_RE.test(rawName) ? rawName : slugify(rawName, 'skill')
  const description = (declaredDescription || firstParagraph(parsed.body)).slice(0, MAX_DESCRIPTION)
  state.items.push({
    name,
    importName,
    description,
    path: dir,
    pathLabel: displayPath(dir),
    skillFile: file,
    source: root.source,
    sourceLabel: root.label,
    scope: root.scope,
    chars: head.size,
    truncated: head.truncated,
  })
}

/** Scan one root: either a single skill or direct children with SKILL.md. */
async function scanRoot(root, state) {
  if (!(await isDirectory(root.path))) return
  if (await isFile(join(root.path, SKILL_FILE))) {
    await addSkill(root, root.path, state)
    return
  }
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') state.warnings.push(`无法读取技能目录 ${root.path}：${error?.message ?? error}`)
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
    const dir = join(root.path, entry.name)
    if (!(await isDirectory(dir))) continue
    if (!(await isFile(join(dir, SKILL_FILE)))) continue
    await addSkill(root, dir, state)
  }
}

/**
 * Discover every local skill the picker can offer.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] DSH home (`$DSH_HOME` or `~/.dsh`).
 * @param {string} [options.projectRoot] Project root to include, when known.
 * @param {string} [options.home] User home override (tests).
 * @param {number} [options.maxItems] Result cap.
 * @returns {Promise<{items: object[], warnings: string[], truncated: boolean, roots: number}>}
 */
export async function discoverSkills(options = {}) {
  const home = resolve(options.home ?? homedir())
  const dshHome = resolve(options.dshHome ?? join(home, '.dsh'))
  const projectRoot = typeof options.projectRoot === 'string' && options.projectRoot.trim() !== ''
    ? resolve(options.projectRoot)
    : ''
  const maxItems = Number.isFinite(options.maxItems) && options.maxItems > 0
    ? Math.floor(options.maxItems)
    : MAX_ITEMS

  const roots = []
  if (projectRoot !== '') roots.push(...projectRoots(projectRoot))
  roots.push(...globalRoots(home, dshHome))
  roots.push(...await conventionRoots(home))
  roots.push(...await configRoots(home))

  const seenRoots = new Set()
  const state = { items: [], seen: new Set(), warnings: [] }
  let scanned = 0
  for (const root of roots) {
    const key = resolve(root.path)
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    scanned += 1
    await scanRoot(root, state)
  }

  state.items.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
    const byLabel = a.sourceLabel.localeCompare(b.sourceLabel, 'zh-CN')
    if (byLabel !== 0) return byLabel
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  const truncated = state.items.length > maxItems
  return {
    items: truncated ? state.items.slice(0, maxItems) : state.items,
    warnings: state.warnings,
    truncated,
    roots: scanned,
  }
}
