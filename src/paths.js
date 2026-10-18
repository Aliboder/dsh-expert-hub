/**
 * Path resolution for dsh-expert-hub.
 *
 * One owner for every location the plugin reads or writes, so the routes, the
 * store and the importers can never disagree about where "experts" live.
 * Pure Node — no Cordis imports.
 *
 * @module dsh-expert-hub/paths
 */

import { homedir } from 'node:os'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Expand a leading `~`/`~/` against the OS home; anything else passes through. */
export function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the harness home with the same precedence the Harness uses:
 * explicit config > non-blank `$DSH_HOME` > `~/.dsh`.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : undefined
  return resolve(expandHome(configured ?? fromEnv ?? join(homedir(), '.dsh')))
}

/** Every location the plugin owns, resolved once per apply(). */
export function createPaths({ dshHome, sourcePath }) {
  const home = resolveDshHome(dshHome)
  const root = join(home, 'experts')
  const rawSource = typeof sourcePath === 'string' && sourcePath.trim() !== '' ? sourcePath.trim() : ''
  return {
    scope: 'global',
    projectRoot: '',
    dshHome: home,
    expertsRoot: root,
    stateDir: join(home, 'expert-hub'),
    stateFile: join(home, 'expert-hub', 'state.json'),
    sourcePath: rawSource,
    sourceDir: expandHome(rawSource),
  }
}

/**
 * Resolve project-level expert paths. Project experts live beside project
 * skills under `<project>/.dsh/experts`, so they travel with the repository.
 *
 * @param {object} base - global createPaths() result
 * @param {string} projectRoot
 */
export function projectPaths(base, projectRoot) {
  const root = resolve(projectRoot)
  return {
    ...base,
    scope: 'project',
    projectRoot: root,
    expertsRoot: join(root, '.dsh', 'experts'),
    stateDir: join(root, '.dsh', 'expert-hub'),
  }
}

/**
 * Find the project root for one session's working directory: the nearest
 * ancestor that contains `.git`, otherwise the directory itself. Mirrors the
 * project-skill convention used by DSH skill sources.
 *
 * @param {string} cwd
 * @returns {Promise<string|undefined>}
 */
export async function findProjectRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || !isAbsolute(cwd)) return undefined
  let start
  try {
    start = await realpath(resolve(cwd))
    if (!(await stat(start)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  let current = start
  for (;;) {
    try {
      await lstat(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return start
      current = parent
    }
  }
}

/** True when `child` resolves inside `parent` (both absolute). */
export function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  if (base === target) return true
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`)
}

/** Only keep the given id when it is a safe single path segment. */
export function safeId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : undefined
}

/** Build an absolute path for `id` and prove it stays inside `root`. */
export function expertDirOf(root, id) {
  const safe = safeId(id)
  if (safe === undefined) throw new Error(`invalid expert id: ${JSON.stringify(id)}`)
  const dir = join(root, safe)
  if (!isInside(root, dir)) throw new Error(`expert id escapes the expert root: ${JSON.stringify(id)}`)
  return dir
}

/** Trimmed display form of a path: `$HOME` back to `~`, separators to `/`. */
export function displayPath(value) {
  if (typeof value !== 'string' || value === '') return value
  const home = homedir()
  let text = value
  if (value === home) return '~'
  if (value.startsWith(`${home}${sep}`)) text = `~${value.slice(home.length)}`
  return text.replace(/\\/g, '/')
}
