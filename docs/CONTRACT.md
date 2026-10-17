# dsh-expert-hub 内部契约（v0.1）

这份文档是 Host 半、Client 半与导入模块之间的唯一接口约定。改动接口必须先改这里。

## 1. 定位

DSH 专家中心：把 WorkBuddy 落盘专家、用户自建专家、网上导入的专家统一成一种
"DSH 专家文件夹"，在会话中挂载（角色提示词 + skills），并可在会话间切换。

**不执行任何专家自带脚本、不加载专家自己的 cordis 行**（WorkBuddy 专家里即使有
`scripts/`、`.mcp.json`、agent.cordis.yml 也一律忽略）。专家只贡献两样东西：
`role.md` 正文与 `skills/<name>/SKILL.md`。

## 2. 目录与文件

```
$DSH_HOME/expert-hub/                 # 插件自己的状态目录
└─ state.json                         # { version:1, selections:{ [sessionId]: { expertId, at } } }

$DSH_HOME/experts/<id>/               # 已安装的 DSH 专家（唯一专家库根）
├─ expert.yml                         # 元数据（见 §3）
├─ role.md                            # 角色提示词正文
├─ skills/<name>/SKILL.md             # 0..N 个 skill，可带任意资源文件
├─ avatar.png | avatar.jpg | avatar.webp
└─ .expert-source.json                # 导入归属/指纹（可选，仅导入的专家有）
```

兼容旧版 `dsh-workbuddy-expert` 导出的专家文件夹：`expert.yml` 只有
`id` / `display_name` / `description` / `order`，其余字段可缺；同样能识别。

## 3. expert.yml（本插件写入的规范格式）

```yaml
schema: 1
id: ui-designer                      # 必填，^[a-z0-9][a-z0-9-]*$，必须等于文件夹名
display_name: 像素君                  # 必填，中文优先显示名
name_en: Sam                         # 可选
profession: UI 设计师                 # 可选，职能/称号
profession_en: UI Designer
description: 精通设计系统和组件库…      # 必填，一句话简介
description_en: Expert in design systems…
tags: ["UI设计", "组件库"]            # 可选，最多 8 个
category: 01-ProductDesign           # 可选，WorkBuddy categoryId 原样保存
category_label: 产品设计              # 可选，中文分类名
quick_prompts:                       # 可选，最多 6 条
  - "帮我搭一套设计规范"
init_prompt: "我们设计一个全新的界面…"  # 可选，首次使用提示
order: 200                           # 可选，默认 200
source_kind: workbuddy|custom|web|path  # 可选
source_label: WorkBuddy 专家中心       # 可选，来源展示文案
```

写入器只写非空字段；读取器允许未知字段（忽略）。

## 4. `.expert-source.json`（仅导入来源写入）

```json
{
  "kind": "workbuddy",
  "origin": "~/.workbuddy/plugins/marketplaces/experts/plugins",
  "pluginDir": "ui-designer",
  "agentFile": "ui-designer.md",
  "fingerprint": "<sha256 hex>",
  "importedAt": "2026-10-18T00:00:00.000Z"
}
```

指纹算法（`src/fingerprint.js` 导出的 `fingerprintOf`）：
`sha256("expert-hub/v1\n" + id + "\n" + display_name + "\n" + description + "\n" + roleText + "\n" + 技能树 [rel:size:mtimeMs])`。
用它判断 WorkBuddy 源专家是否比已安装副本更新（`updatable`）。

## 5. 卡片（Card）JSON —— 所有列表接口共用

```ts
type Card = {
  id: string
  displayName: string          // 中文优先
  name?: string                // 英文名/原名
  profession?: string
  professionEn?: string
  description: string
  descriptionEn?: string
  tags: string[]
  category?: string            // 原样 id
  categoryLabel?: string       // 中文分类标签
  quickPrompts: string[]
  initPrompt?: string
  avatarUrl?: string           // 文档相对 URL：'expert-hub/avatar?id=<id>&scope=installed|source'
  roleExcerpt: string          // role.md 前 ~180 字，纯文本
  roleChars: number
  skills: Array<{ name: string; description: string; chars: number }>
  teamSize: number             // WorkBuddy 团队卡里的 agent 数，普通专家=1
  sourceKind: 'installed' | 'workbuddy'
  sourceLabel: string          // 展示用："WorkBuddy 专家中心" / "本机自建" / "网页导入"
  installed: boolean           // 当前是否已存在于 $DSH_HOME/experts
  updatable: boolean           // 仅 WorkBuddy 来源：源指纹与已安装指纹不同
  order: number
  broken?: string              // 存在但解析失败时给出原因；broken 卡不可使用
}
```

**列表接口不返回 `roleText` 与 skill 正文**；详情接口按需返回（性能约定）。

## 6. 会话状态

```ts
type SessionState = {
  sessionId: string
  expertId: string | null
  displayName?: string
  applied: boolean     // true=已挂载到 live agent；false=已登记、等 agent 出现后自动挂载
}
```

选择保存在 `state.json` 的 `selections`；`agent/created` 与 `agent/pre-step` 是恢复时机，
`session/disposed` 时删除对应选择。未打开的旧会话也可先选（`queued`）。

## 7. HTTP 路由（全部同源、loopback、`no-store`）

基址：文档相对 `expert-hub`（无前导斜杠，宿主 shell 的 `<base href="./">` 约定）。

统一错误：HTTP 4xx/5xx + `{ ok:false, error:{ code, message } }`。
成功：HTTP 200 + `{ ok:true, ... }`。所有 mutation 只接受 `POST` + `application/json`，
body 上限 1 MiB（头像单独 8 MiB）。

| # | 方法 | 路径 | 入参 | 出参 |
|---|------|------|------|------|
| 1 | GET | `/state?sessionId=` | — | `{ ok, revision, config:{ sourcePath, sourceExists, expertsRoot }, counts:{ installed, available, updatable }, installed:Card[], available:Card[], warnings:string[], session?:SessionState }` |
| 2 | GET | `/detail?id=&scope=installed\|workbuddy` | — | `{ ok, card:Card, roleText, skills:[{name, description, content}] , meta:{ sourcePath?, agentFile? } }` |
| 3 | GET | `/avatar?id=&scope=installed\|workbuddy` | — | 图片字节（png/jpg/webp）；找不到统一 404 |
| 4 | POST | `/switch` | `{ sessionId, expertId: string \| null }` | `{ ok, session:SessionState }` |
| 5 | POST | `/refresh` | `{}` | `{ ok, revision, counts }` |
| 6 | POST | `/import` | `{ ids: string[] }` | `{ ok, imported:{id,dir}[], failed:{id,error}[] }`；已安装的 id 走"更新"（覆盖为源内容），自建专家不会被覆盖 |
| 7 | POST | `/import-web` | `{ url: string }` | `{ ok, experts:Card[], imported:{id,dir}[] , warnings:string[] }` |
| 8 | POST | `/import-path` | `{ path: string }` | 同 7 |
| 9 | POST | `/create` | `{ expert:{ id?, displayName, description, profession?, tags?, roleText, category? }, avatarDataUrl? }` | `{ ok, expert:Card }` |
| 10 | POST | `/update` | `{ id, patch:{ displayName?, description?, profession?, tags?, quickPrompts? }, roleText?, avatarDataUrl? }` | `{ ok, expert:Card }` |
| 11 | POST | `/delete` | `{ id }` | `{ ok }` |
| 12 | GET | `/events` | — | `text/event-stream`；事件 `state`，data 为 `{ revision }`；每 25s 一行 `: ping` |

`scope` 缺省 `installed`。`available`（WorkBuddy 市场）用 `scope=workbuddy`。

## 8. 示例

```jsonc
// GET /state
{
  "ok": true, "revision": 7,
  "config": { "sourcePath": "~/.workbuddy/plugins/marketplaces/experts/plugins", "sourceExists": true, "expertsRoot": "~/.dsh/experts" },
  "counts": { "installed": 4, "available": 13, "updatable": 2 },
  "installed": [ { "id": "ui-designer", "displayName": "像素君", "profession": "UI 设计师", "description": "…", "tags": ["UI设计"], "avatarUrl": "expert-hub/avatar?id=ui-designer&scope=installed", "roleExcerpt": "…", "skills": [{ "name": "impeccable", "description": "…", "chars": 10412 }], "installed": true, "updatable": false, "sourceKind": "installed", "sourceLabel": "WorkBuddy 专家中心", "order": 200 } ],
  "available": [ … ], "warnings": [],
  "session": { "sessionId": "abc", "expertId": "ui-designer", "displayName": "像素君", "applied": true }
}
```

## 9. Client 座位

| 座位（slot） | 组件 | 说明 |
|---|---|---|
| `settings.section` | `ExpertCenterPage` | `id:'expert-hub'`, `order:44`, `label:专家中心` |
| `conversation.input.left` | `ExpertCapsule` | `id:'expert-hub'`, `order:40`；胶囊 + 自管 popover |
| `conversation.input.overlay` | 不注册（弹层挂在胶囊内部，避免与其它插件的 overlay 冲突） |

Client 取会话 id：`props.sessionId ?? props.session?.id ?? props.session?.sessionId`（可能都没有）。

模块形态（宿主 client bundle 约定，`client.js` 必须这样声明）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-expert-hub',          // 必须等于 package.json name，否则 loader 拒绝
  factory(require) {
    const React = require('react')
    // ...
    return { name: 'dsh-expert-hub', inject: ['slots', 'locale'], apply(ctx) { /* ... */ } }
  },
})
```

`apply` 里用 `ctx.effect(() => ctx.slots.inject(seat, () => ctx.slots.register(opts, render)))`，
并返回一个清理函数（移除注入的 `<style data-plugin>`）。样式用 `--dsw-*` token，
`<style>` 内 selector 前缀 `.eh-`。

## 10. 写入安全

- 所有写路径必须先 `resolve(expertsRoot, id)` 并确认结果仍在 `expertsRoot` 内；
- id 必须匹配 `^[a-z0-9][a-z0-9-]*$`；
- 导入 zip 必须防 zip-slip（条目路径不得逃逸临时目录），解压后只读取白名单文件；
- 删除只允许 `expertsRoot` 下、且 `expert.yml` 可解析的目录；
- 不写 profile 目录、不改用户其它文件。

## 11. 测试约定

`npm test` = `node test/run.mjs`，跑 `test/*.test.mjs`，全部 node-only（无浏览器、无真实 dsh 进程）。
每个模块至少覆盖：正常路径 + 坏输入 + 边界（超长/缺字段/路径逃逸）。
