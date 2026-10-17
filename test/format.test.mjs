/**
 * Format tests: the expert.yml subset, frontmatter, sanitizing and slugging.
 */

import assert from 'node:assert/strict'

import {
  ID_RE,
  escapeTemplateGroups,
  expertFromYmlFields,
  excerptOf,
  parseExpertYml,
  sanitizeRoleText,
  serializeExpertYml,
  slugify,
  splitFrontmatter,
} from '../src/format.js'

// expert.yml round-trips every field the writer emits.
const expert = {
  id: 'ui-designer',
  displayName: '像素君',
  name: 'Sam',
  profession: 'UI 设计师',
  professionEn: 'UI Designer',
  description: '精通设计系统和组件库',
  descriptionEn: 'Design systems expert',
  tags: ['UI设计', '组件库'],
  category: '01-ProductDesign',
  categoryLabel: '产品设计',
  quickPrompts: ['帮我搭一套设计规范', '评审现有 UI'],
  initPrompt: '我们设计一个全新的界面',
  order: 200,
  sourceKind: 'workbuddy',
  sourceLabel: 'WorkBuddy 专家中心',
}
const yml = serializeExpertYml(expert)
assert.match(yml, /^schema: 1\n/)
assert.match(yml, /quick_prompts:\n {2}- 帮我搭一套设计规范/)
const parsed = expertFromYmlFields(parseExpertYml(yml))
assert.equal(parsed.id, 'ui-designer')
assert.equal(parsed.displayName, '像素君')
assert.deepEqual(parsed.tags, ['UI设计', '组件库'])
assert.deepEqual(parsed.quickPrompts, ['帮我搭一套设计规范', '评审现有 UI'])
assert.equal(parsed.order, 200)
assert.equal(parsed.categoryLabel, '产品设计')

// Empty lists disappear instead of rendering bare keys.
assert.doesNotMatch(serializeExpertYml({ id: 'a', displayName: 'A', description: 'D', tags: [], quickPrompts: [] }), /tags:/)

// Legacy export (only four fields) parses with sane defaults.
const legacy = expertFromYmlFields(parseExpertYml('id: "old"\ndisplay_name: "旧专家"\ndescription: "desc"\norder: 200\n'))
assert.equal(legacy.id, 'old')
assert.equal(legacy.displayName, '旧专家')
assert.equal(legacy.order, 200)
assert.deepEqual(legacy.tags, [])
assert.equal(legacy.profession, '')

// Frontmatter split: fields + body; files without frontmatter keep the body.
const split = splitFrontmatter('---\nname: demo\ndescription: hi\n---\n\n# Demo\nbody\n')
assert.equal(split.fields.name, 'demo')
assert.equal(split.fields.description, 'hi')
assert.match(split.body.trim(), /^# Demo/)
assert.equal(splitFrontmatter('# no frontmatter').fields.name, undefined)

// Template groups are escaped, idempotently.
const escaped = escapeTemplateGroups('hello {{name}} and {{x}}')
assert.equal(escaped, 'hello { {name} } and { {x} }')
assert.equal(escapeTemplateGroups(escaped), escaped)
assert.equal(sanitizeRoleText('\uFEFFline1\r\nline2\r\n'), 'line1\nline2')

// Slugging keeps ids valid and never returns an empty id.
assert.match(slugify('UI Designer'), ID_RE)
assert.match(slugify('设计专家'), ID_RE)
assert.match(slugify('设计专家'), /^expert-[0-9a-f]{6}$/)
assert.match(slugify('!!!'), /^expert-[0-9a-f]{6}$/)
assert.equal(slugify('UI Designer'), 'ui-designer')

// Excerpt strips markdown noise.
assert.equal(excerptOf('# Title\n\n**Bold** text with [link](https://x)'), 'Title Bold text with link')

console.log('format.test.mjs: ok')
