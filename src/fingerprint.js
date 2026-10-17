/**
 * Content fingerprints for imported experts.
 *
 * One algorithm, one place: the installer writes it into
 * `.expert-source.json`, the store compares it against the WorkBuddy source to
 * decide `updatable`. It intentionally hashes only semantic content (metadata
 * + role body + skill tree shape), so editing the *installed copy* never
 * pretends an update is available.
 *
 * @module dsh-expert-hub/fingerprint
 */

import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Bump when the hashed payload changes meaning. */
export const FINGERPRINT_FORMAT = 'expert-hub/v1'

/**
 * Deterministic listing of a skills tree: `rel:size:mtimeMs` lines, sorted.
 * Missing directories yield an empty list.
 *
 * @param {string} dir - absolute skills directory
 * @returns {Promise<string[]>}
 */
export async function skillTreeEntries(dir) {
  const entries = []
  async function walk(current) {
    let listed
    try {
      listed = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of listed) {
      if (entry.name.startsWith('.')) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(path)
        entries.push(`${path.slice(dir.length + 1)}:${info.size}:${Math.trunc(info.mtimeMs)}`)
      } catch {
        // Vanished mid-walk: the folder is changing; the caller re-runs.
      }
    }
  }
  await walk(dir)
  entries.sort()
  return entries
}

/**
 * Hash the semantic content of one expert.
 *
 * @param {{ id: string, displayName?: string, description?: string, roleText?: string, skillEntries?: string[] }} input
 * @returns {string} lowercase hex sha256
 */
export function fingerprintOf(input) {
  const hash = createHash('sha256')
  hash.update(FINGERPRINT_FORMAT)
  hash.update('\n')
  hash.update(String(input.id ?? ''))
  hash.update('\n')
  hash.update(String(input.displayName ?? ''))
  hash.update('\n')
  hash.update(String(input.description ?? ''))
  hash.update('\n')
  hash.update(String(input.roleText ?? ''))
  for (const entry of input.skillEntries ?? []) {
    hash.update('\n')
    hash.update(entry)
  }
  return hash.digest('hex')
}
