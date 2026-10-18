/**
 * Durable per-session expert selections.
 *
 * The Harness session log must stay free of plugin-private event types (its
 * replay path fail-closes on unknown types), so the selection lives in the
 * plugin's own sidecar and is replayed when the agent appears.
 *
 * File: `$DSH_HOME/expert-hub/state.json`
 *   { version: 1, selections: { [sessionId]: { expertId, at } } }
 *
 * @module dsh-expert-hub/selections
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const VERSION = 1
const MAX_ENTRIES = 500

/** Normalize an untrusted state document into `{ version, selections }`. */
export function normalizeState(value) {
  if (value === null || typeof value !== 'object') return { version: VERSION, selections: {} }
  const source = value.selections !== null && typeof value.selections === 'object' ? value.selections : {}
  const selections = {}
  for (const [sessionId, entry] of Object.entries(source)) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (entry === null || typeof entry !== 'object') continue
    const expertId = typeof entry.expertId === 'string' && entry.expertId !== '' ? entry.expertId : null
    const library = entry.library === 'project' ? 'project' : 'global'
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : Date.now()
    selections[sessionId] = { expertId, library, at }
  }
  return { version: VERSION, selections }
}

/**
 * Open (or initialize) the sidecar.
 *
 * @param {string} stateFile absolute path
 * @param {{ warn?: (message: string) => void }} [logger]
 */
export async function openSelections(stateFile, logger = {}) {
  const warn = logger.warn ?? (() => {})
  let state = { version: VERSION, selections: {} }
  try {
    state = normalizeState(JSON.parse(await readFile(stateFile, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`专家选择记录读取失败，已从空状态开始：${error?.message ?? error}`)
  }
  let saveChain = Promise.resolve()

  /** Persist the current state atomically (write tmp + rename). */
  function save() {
    const snapshot = { version: VERSION, selections: { ...state.selections } }
    saveChain = saveChain.then(async () => {
      try {
        await mkdir(dirname(stateFile), { recursive: true })
        const tmp = join(dirname(stateFile), `.state-${process.pid}-${Date.now()}.tmp`)
        await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, stateFile)
      } catch (error) {
        warn(`专家选择记录保存失败：${error?.message ?? error}`)
      }
    })
    return saveChain
  }

  /** Drop the oldest entries when the sidecar grows past the cap. */
  function prune() {
    const entries = Object.entries(state.selections)
    if (entries.length <= MAX_ENTRIES) return
    entries.sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
    for (const [sessionId] of entries.slice(0, entries.length - MAX_ENTRIES)) delete state.selections[sessionId]
  }

  return {
    /** @returns {{expertId: string|null, library: 'global'|'project', at: number} | undefined} */
    get(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return state.selections[sessionId]
    },
    /** Record a selection (null clears it) and persist. */
    set(sessionId, expertId, library = 'global') {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      if (expertId === null || expertId === undefined) {
        delete state.selections[sessionId]
      } else {
        state.selections[sessionId] = {
          expertId: String(expertId),
          library: library === 'project' ? 'project' : 'global',
          at: Date.now(),
        }
      }
      prune()
      void save()
      return state.selections[sessionId]
    },
    /** Forget one session entirely. */
    remove(sessionId) {
      if (typeof sessionId !== 'string') return
      if (state.selections[sessionId] === undefined) return
      delete state.selections[sessionId]
      void save()
    },
    /** Wait for pending writes (tests / shutdown). */
    flush: () => saveChain,
    /** Raw copy for diagnostics. */
    snapshot: () => ({ version: VERSION, selections: { ...state.selections } }),
  }
}
