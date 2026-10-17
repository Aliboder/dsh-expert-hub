/**
 * Expert file format: the `expert.yml` schema, the frontmatter subset WorkBuddy
 * agents use, and the text sanitizing that keeps foreign prompt bodies from
 * breaking the harness's template interpolation.
 *
 * Pure functions only. Both the Host and the tests import this module.
 *
 * @module dsh-expert-hub/format
 */

/** The one id rule shared by every surface (cards, folders, routes, imports). */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** Current on-disk schema version. */
export const SCHEMA_VERSION = 1

/** Marker written at the top of every expert.yml this plugin owns. */
const SCHEMA_LINE = `schema: ${SCHEMA_VERSION}`

/** Convert CRLF → LF and drop a UTF-8 BOM. */
export function normalizeText(value) {
  if (typeof value !== 'string') return ''
  let text = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Escape unregistered `{{...}}` template groups so the Harness prompt
 * interpolator never sees a name it does not know. Idempotent: it inserts a
 * space between the braces and re-checks until the text stops changing.
 */
export function escapeTemplateGroups(text) {
  if (typeof text !== 'string') return ''
  let current = text
  for (let i = 0; i < 8; i += 1) {
    const next = current.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }')
    if (next === current) return current
    current = next
  }
  return current
}

/** Sanitize a role body written into the prompt path. */
export function sanitizeRoleText(value) {
  return escapeTemplateGroups(normalizeText(value)).trim()
}

/** Derive a one-line plain-text excerpt (markdown markers stripped). */
export function excerptOf(text, limit = 180) {
  const lines = normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('---'))
  const plain = lines
    .join(' ')
    .replace(/^#{1,6}\s*/g, '')
    .replace(/[*_`>~]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= limit) return plain
  return `${plain.slice(0, limit).trimEnd()}…`
}

/** Strip one pair of YAML quotes from a scalar. */
function unquote(value) {
  const text = String(value).trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/** Parse a scalar that may be a flow list, a quoted string or a plain string. */
function parseScalar(raw) {
  const value = String(raw).trim()
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((part) => unquote(part.trim())).filter((part) => part !== '')
  }
  return unquote(value)
}

/**
 * Parse the small YAML subset `expert.yml` uses: top-level scalars and one
 * level of sequences (`tags:`, `quick_prompts:` with `- item` lines).
 * Anything unknown degrades to absent fields instead of throwing.
 *
 * @param {string} text
 * @returns {Record<string, string | string[]>}
 */
export function parseExpertYml(text) {
  const fields = {}
  const lines = normalizeText(text).split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      i += 1
      continue
    }
    if (/^\s/.test(line)) {
      i += 1
      continue
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (match === null) {
      i += 1
      continue
    }
    const key = match[1]
    const rest = match[2].trim()
    if (rest === '') {
      // Possibly a block sequence of `- item` lines.
      const items = []
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]
        if (next.trim() === '') {
          j += 1
          continue
        }
        const item = /^[ \t]*-[ \t]+(.*)$/.exec(next)
        if (item === null) break
        const value = unquote(item[1].trim())
        if (value !== '') items.push(value)
        j += 1
      }
      if (items.length > 0) {
        fields[key] = items
        i = j
      } else {
        fields[key] = ''
        i += 1
      }
      continue
    }
    fields[key] = parseScalar(rest)
    i += 1
  }
  return fields
}

/** Quote a YAML scalar when it would otherwise change meaning. */
function yamlScalar(value) {
  const text = String(value)
  if (text === '') return '""'
  if (/^[A-Za-z0-9\u4e00-\u9fff][^:#\n]*$/.test(text) && !/^(true|false|null|~|\d+)$/.test(text)) {
    return text
  }
  return JSON.stringify(text)
}

/**
 * Serialize the canonical expert.yml. Empty/undefined values are omitted so a
 * diff only shows real fields.
 *
 * @param {object} expert
 */
export function serializeExpertYml(expert) {
  const lines = [SCHEMA_LINE]
  const push = (key, value) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      if (value.length === 0) return
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`)
      return
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      lines.push(`${key}: ${value}`)
      return
    }
    const text = String(value)
    if (text.trim() === '') return
    lines.push(`${key}: ${yamlScalar(text)}`)
  }
  push('id', expert.id)
  push('display_name', expert.displayName)
  push('name_en', expert.name)
  push('profession', expert.profession)
  push('profession_en', expert.professionEn)
  push('description', expert.description)
  push('description_en', expert.descriptionEn)
  push('tags', expert.tags)
  push('category', expert.category)
  push('category_label', expert.categoryLabel)
  push('quick_prompts', expert.quickPrompts)
  push('init_prompt', expert.initPrompt)
  push('order', expert.order)
  push('source_kind', expert.sourceKind)
  push('source_label', expert.sourceLabel)
  return `${lines.join('\n')}\n`
}

/**
 * Normalize raw expert.yml fields into the plugin's expert shape. Tolerant of
 * the legacy (v0) export layout: only id/display_name/description/order.
 */
export function expertFromYmlFields(fields) {
  const text = (key) => (typeof fields[key] === 'string' ? fields[key].trim() : '')
  const list = (key) => {
    const value = fields[key]
    if (!Array.isArray(value)) return []
    return value.map((item) => String(item).trim()).filter((item) => item !== '')
  }
  const orderText = text('order')
  const order = Number.parseInt(orderText, 10)
  return {
    id: text('id'),
    displayName: text('display_name'),
    name: text('name_en'),
    profession: text('profession'),
    professionEn: text('profession_en'),
    description: text('description'),
    descriptionEn: text('description_en'),
    tags: list('tags').slice(0, 8),
    category: text('category'),
    categoryLabel: text('category_label'),
    quickPrompts: list('quick_prompts').slice(0, 6),
    initPrompt: text('init_prompt'),
    order: Number.isFinite(order) ? order : 200,
    sourceKind: text('source_kind'),
    sourceLabel: text('source_label'),
  }
}

/**
 * Split optional `---`-delimited frontmatter from a markdown file.
 * Files without frontmatter return empty fields and the full body.
 *
 * @returns {{ fields: Record<string, string>, body: string }}
 */
export function splitFrontmatter(text) {
  const source = normalizeText(text)
  const lines = source.split('\n')
  if (lines[0] === undefined || lines[0].trim() !== '---') return { fields: {}, body: source }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 0) return { fields: {}, body: source }
  const fields = {}
  let i = 1
  while (i < close) {
    const line = lines[i]
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line.trim())
    if (match === null) {
      i += 1
      continue
    }
    const key = match[1]
    const raw = match[2].trim()
    if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-' || raw === '|+' || raw === '>+') {
      // YAML block scalar: collect the indented lines that follow.
      const folded = raw.startsWith('>')
      const block = []
      let j = i + 1
      while (j < close) {
        const next = lines[j]
        if (next.trim() === '') {
          block.push('')
          j += 1
          continue
        }
        if (!/^[ \t]/.test(next)) break
        block.push(next.replace(/^[ \t]+/, ''))
        j += 1
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop()
      fields[key] = block.join(folded ? ' ' : '\n').trim()
      i = j
      continue
    }
    if (raw !== '') fields[key] = String(parseScalar(raw))
    i += 1
  }
  return { fields, body: lines.slice(close + 1).join('\n') }
}

/** Stable 6-hex FNV-1a suffix (identical algorithm is mirrored in client.js). */
function hashSuffix(text) {
  let hash = 0x811c9dc5
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

/** Slugify a free-form name into a valid expert id (never empty). */
export function slugify(value, fallback = 'expert') {
  const normalized = normalizeText(value)
  const base = normalized
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const ascii = base
    .split('-')
    .map((part) => (/^[\u4e00-\u9fff]+$/.test(part) ? '' : part))
    .filter((part) => part !== '')
    .join('-')
  let candidate = (ascii !== '' ? ascii : `${fallback}-${hashSuffix(normalized)}`).replace(/^-+|-+$/g, '')
  if (!ID_RE.test(candidate)) candidate = `${fallback}-${hashSuffix(normalized)}`
  return ID_RE.test(candidate) ? candidate : fallback
}

/** Read validation: only http(s) URLs may be fetched. */
export function isHttpUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** First non-title paragraph of a README — WorkBuddy's description fallback. */
export function firstParagraph(text) {
  const paragraph = []
  for (const line of normalizeText(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (trimmed.startsWith('#') || trimmed === '---' || trimmed.startsWith('<!--')) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(trimmed)
  }
  return paragraph.join(' ').trim()
}
