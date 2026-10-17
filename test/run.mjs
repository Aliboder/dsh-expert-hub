/**
 * Test runner: every `test/*.test.mjs` runs in its own Node process so one
 * failure cannot hide the next file's results.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

let failed = 0
for (const file of files) {
  process.stdout.write(`\n── ${file} ──\n`)
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit', cwd: dirname(here) })
  if (result.status !== 0) failed += 1
}

if (failed > 0) {
  process.stderr.write(`\n${failed} test file(s) failed\n`)
  process.exit(1)
}
process.stdout.write(`\nall ${files.length} test file(s) passed\n`)
