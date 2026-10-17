/**
 * dsh-expert-hub 浏览器半（client half）。
 *
 * 模块形态遵循宿主 client bundle 约定：window.__ModuleLoader__.load({ id, factory })、
 * CJS 包装、只通过注入的 require 解析 react 外部依赖、零构建（本文件就是 package.json
 * exports 的 "./client" 产物）。id 必须精确等于包名，否则 loader 拒绝注册。
 *
 * 两个座位（docs/CONTRACT.md §9）：
 *   - settings.section（id 'expert-hub'，order 44，label「专家中心」）
 *       ExpertCenterPage：已安装 / WorkBuddy 市场 / 新建与导入 三个 Tab，
 *       搜索 + 分类筛选 + 排序，详情抽屉（role.md 全文 / 技能正文折叠 /
 *       快捷提示词），编辑表单、新建表单、URL / 本地路径导入、warnings、空态、
 *       骨架屏、内联成功/错误提示、二次确认删除。
 *   - conversation.input.left（id 'expert-hub'，order 40）
 *       ExpertCapsule：当前专家头像 + 名字（无则「专家」），自管 popover（搜索、
 *       当前 ✓、不用专家、列表项头像/名字/职业），POST /switch 切换；请求中禁用
 *       并显示 spinner，错误内联在 popover 内。
 *   - 不注册 conversation.input.overlay：弹层挂在胶囊内部，避免与其他插件抢层。
 *
 * 路由全部为文档相对路径（'expert-hub/state' 等，无前导斜杠，依赖 shell 的
 * <base href="./">）；fetch 带 credentials:'same-origin'；头像直接用接口返回的
 * avatarUrl（同为文档相对 URL）。
 *
 * 刷新：popover 每次打开都重新 GET /state?sessionId=；动作后刷新；apply 时建立
 * 一条 EventSource('expert-hub/events')（事件 state → 重新拉取，断线 5s 重连，
 * 卸载时关闭）供两个座位同时订阅；设置页在 visibilitychange 时刷新。
 *
 * 样式：<style data-plugin="dsh-expert-hub">，selector 前缀 .eh-，只用 --dsw-* token
 * （带硬回退，深浅色都可读），apply 返回的清理函数负责移除该 <style>。
 */
window.__ModuleLoader__.load({
  id: 'dsh-expert-hub',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var NS = 'dsh-expert-hub'
    // 文档相对基址：origin 根路径与带前缀挂载都成立。
    var API_BASE = 'expert-hub'
    var MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)'
    var AVATAR_GLYPH = '🧑‍💻'
    var UNCATEGORIZED = '·uncategorized·'
    var ID_RE = /^[a-z0-9][a-z0-9-]*$/
    var AVATAR_MAX_BYTES = 2 * 1024 * 1024
    var AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp']
    var TABS = [
      { id: 'installed', key: 'tab.installed' },
      { id: 'market', key: 'tab.market' },
      { id: 'create', key: 'tab.create' }
    ]

    var CSS = `
.eh-page { box-sizing: border-box; width: 100%; max-width: 1200px; margin: 0 auto; padding: 4px 2px 28px;
  display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary, inherit); }
.eh-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* ── 页头 ─────────────────────────────────────────────────────────────── */
.eh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px 20px; flex-wrap: wrap; }
.eh-head-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.eh-title { margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; }
.eh-subtitle { margin: 0; max-width: 680px; font-size: 12px; line-height: 1.65;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-counts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.eh-count { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px;
  font-size: 11px; line-height: 1; white-space: nowrap; color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
.eh-count[data-kind="update"] { color: var(--dsw-alias-brand-primary, #4f6ef7);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6ef7) 38%, transparent); }
.eh-head-side { display: flex; align-items: center; gap: 8px; }

/* ── Tabs ─────────────────────────────────────────────────────────────── */
.eh-tabs { display: flex; align-items: center; gap: 3px; width: max-content; max-width: 100%;
  padding: 3px; border-radius: 12px; overflow-x: auto;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.eh-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 13px;
  border: 0; border-radius: 9px; background: transparent; cursor: pointer; white-space: nowrap;
  font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-tab:hover { color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.eh-tab[data-active="true"] { color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0,0,0,.1)); }
.eh-tab-count { font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, inherit); }

/* ── 面板与工具条 ─────────────────────────────────────────────────────── */
.eh-panels { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.eh-panel { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.eh-panel[hidden] { display: none; }
.eh-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; }
.eh-panel-head-side { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eh-section-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
.eh-section-sub { margin: 3px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, inherit); }
.eh-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eh-search-wrap { position: relative; flex: 1 1 230px; min-width: 170px; }
.eh-search-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  font-size: 13px; line-height: 1; pointer-events: none; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-search { box-sizing: border-box; width: 100%; height: 32px; padding: 0 12px 0 29px;
  font-size: 13px; line-height: 20px; outline: none; border-radius: 9px;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); }
.eh-search:focus { border-color: var(--dsw-alias-brand-primary, currentColor); }
.eh-search::placeholder { color: var(--dsw-alias-label-tertiary, inherit); }
.eh-select-wrap { display: inline-flex; }
.eh-select { height: 32px; max-width: 190px; padding: 0 8px; font-size: 12px; outline: none;
  border-radius: 9px; cursor: pointer;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); }
.eh-select:focus { border-color: var(--dsw-alias-brand-primary, currentColor); }
.eh-matchline { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, inherit); }

/* ── 来源目录条 + 批量操作 ────────────────────────────────────────────── */
.eh-source { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 8px 11px;
  border-radius: 10px; font-size: 11px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.eh-source-label { flex: none; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-source-state { flex: none; font-size: 10px; line-height: 1;
  color: var(--dsw-alias-state-success-primary, #2e9e5b); }
.eh-source-state[data-ok="false"] { color: var(--dsw-alias-state-warn-primary, #c77700); }
.eh-source-path { flex: 1 1 200px; min-width: 0; font-family: ${MONO}; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, inherit); overflow-wrap: anywhere; }
.eh-bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eh-bulk-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }

/* ── 卡片网格 ─────────────────────────────────────────────────────────── */
.eh-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(256px, 1fr)); }
.eh-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; min-width: 0;
  padding: 13px; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26));
  transition: border-color .15s ease, box-shadow .15s ease; }
.eh-card:hover { border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.42));
  box-shadow: var(--dsw-shadow-lv1, 0 2px 8px rgba(0,0,0,.08)); }
.eh-card[data-broken="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c77700) 45%, transparent); }
.eh-card[data-updatable="true"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6ef7) 32%, var(--dsw-alias-border-l1, transparent)); }
.eh-card-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.eh-avatar { width: 42px; height: 42px; flex: none; border-radius: 11px; object-fit: cover;
  display: inline-flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16));
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-card-titles { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; }
.eh-card-name-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.eh-card-name { font-size: 14px; line-height: 20px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.eh-card-sub { font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-card-desc { margin: 0; min-height: 32px; font-size: 12px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary, inherit); display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.eh-tags { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.eh-tag { max-width: 100%; padding: 1px 8px; border-radius: 999px; font-size: 10px; line-height: 1.7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.13)); }
.eh-card-meta { display: flex; align-items: center; gap: 5px 10px; flex-wrap: wrap; font-size: 10px;
  line-height: 1.5; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.eh-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.eh-badge { display: inline-flex; align-items: center; gap: 2px; padding: 0 7px; border-radius: 999px;
  font-size: 10px; line-height: 17px; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); }
.eh-badge[data-kind="update"] { color: var(--dsw-alias-brand-primary, #4f6ef7);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6ef7) 40%, transparent); }
.eh-badge[data-kind="warn"] { color: var(--dsw-alias-state-warn-primary, #c77700);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c77700) 42%, transparent); }
.eh-badge[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #2e9e5b);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e9e5b) 36%, transparent); }

/* ── 按钮 ─────────────────────────────────────────────────────────────── */
.eh-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 12px; border-radius: 8px; cursor: pointer;
  font-size: 12px; line-height: 18px; font-weight: 500; white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit); background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32)); }
.eh-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.eh-btn:disabled { opacity: .5; cursor: default; }
.eh-btn[data-variant="primary"] { color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-brand-primary, #4f6ef7); border-color: transparent; }
.eh-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-brand-primary, #4f6ef7); filter: brightness(1.06); }
.eh-btn[data-variant="danger"] { color: var(--dsw-alias-state-error-primary, #d5484f);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d5484f) 45%, transparent); }
.eh-btn[data-variant="danger"]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d5484f) 10%, transparent); }
.eh-btn-sm { height: 26px; padding: 0 9px; font-size: 11px; }
.eh-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; border: 0; border-radius: 8px; cursor: pointer; font-size: 13px; line-height: 1;
  color: var(--dsw-alias-label-secondary, inherit); background: transparent; }
.eh-icon-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.eh-btn:focus-visible, .eh-icon-btn:focus-visible, .eh-tab:focus-visible, .eh-search:focus-visible,
.eh-select:focus-visible, .eh-cap:focus-visible, .eh-pop-item:focus-visible, .eh-pop-none:focus-visible,
.eh-skill-head:focus-visible, .eh-warns-toggle:focus-visible, .eh-textarea:focus-visible,
.eh-input:focus-visible, .eh-file:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 2px; }
.eh-spin { display: inline-block; width: 11px; height: 11px; flex: none; border-radius: 50%;
  border: 1.5px solid currentColor; border-top-color: transparent; animation: eh-spin .9s linear infinite; }
@keyframes eh-spin { to { transform: rotate(360deg); } }

/* ── 提示 / warnings / 空态 / 骨架 ───────────────────────────────────── */
.eh-notice { padding: 8px 12px; border-radius: 9px; font-size: 12px; line-height: 1.6;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); }
.eh-notice[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #2e9e5b);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e9e5b) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e9e5b) 6%, transparent); }
.eh-notice[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #d5484f);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d5484f) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d5484f) 6%, transparent); }
.eh-warns { border-radius: 10px; padding: 2px 11px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c77700) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c77700) 5%, transparent); }
.eh-warns-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 0;
  border: 0; background: none; cursor: pointer; text-align: left; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-warn-primary, #c77700); }
.eh-warns-caret { flex: none; font-size: 10px; line-height: 1; }
.eh-warns-list { margin: 0 0 8px; padding-left: 18px; font-size: 11px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
  padding: 36px 18px; border-radius: 14px;
  border: 1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.32));
  background: var(--dsw-alias-bg-layer-1, transparent); }
.eh-empty-face { font-size: 28px; line-height: 1; margin-bottom: 2px; }
.eh-empty-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-empty-tip { margin: 0; max-width: 420px; font-size: 12px; line-height: 1.65;
  color: var(--dsw-alias-label-tertiary, inherit); }
.eh-empty .eh-btn { margin-top: 6px; }
.eh-skel-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(256px, 1fr)); }
.eh-skel-card { position: relative; height: 172px; overflow: hidden; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
.eh-skel-card::after { content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)), transparent);
  animation: eh-shimmer 1.4s ease-in-out infinite; }
@keyframes eh-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

/* ── 新建 / 导入 / 表单 ───────────────────────────────────────────────── */
.eh-create-layout { display: grid; gap: 14px; align-items: start;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); }
.eh-create-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.eh-panel-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px;
  padding: 14px; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26)); }
.eh-card-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
.eh-form { display: flex; flex-direction: column; gap: 11px; }
.eh-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.eh-label { font-size: 12px; line-height: 18px; font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit); }
.eh-hint { margin: 0; font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-input, .eh-textarea { box-sizing: border-box; width: 100%; padding: 7px 10px; font-size: 13px;
  line-height: 1.5; outline: none; border-radius: 9px; font-family: inherit;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); }
.eh-input:focus, .eh-textarea:focus { border-color: var(--dsw-alias-brand-primary, currentColor); }
.eh-input::placeholder, .eh-textarea::placeholder { color: var(--dsw-alias-label-tertiary, inherit); }
.eh-textarea { resize: vertical; min-height: 62px; }
.eh-textarea.eh-role-input { min-height: 170px; font-family: ${MONO}; font-size: 12px; line-height: 1.65; }
.eh-form-row { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
.eh-form-error { margin: 0; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-state-error-primary, #d5484f); }
.eh-form-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.eh-avatar-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.eh-avatar-preview { width: 50px; height: 50px; flex: none; border-radius: 12px; object-fit: cover;
  display: inline-flex; align-items: center; justify-content: center; font-size: 21px; line-height: 1;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16));
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-avatar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.eh-file { max-width: 100%; font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); }
.eh-import-result { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 9px;
  font-size: 11px; line-height: 1.6; overflow-wrap: anywhere;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.eh-result-title { margin: 0; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.eh-result-list { margin: 0; padding-left: 16px; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-result-warns { display: flex; flex-direction: column; gap: 3px;
  color: var(--dsw-alias-state-warn-primary, #c77700); }

/* ── 遮罩 / 抽屉 / 对话框 ─────────────────────────────────────────────── */
.eh-overlay { position: fixed; inset: 0; z-index: 1000; display: flex;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.38)); }
.eh-drawer { display: flex; flex-direction: column; margin-left: auto; width: min(620px, 100vw);
  height: 100vh; min-width: 0; outline: none;
  background: var(--dsw-alias-bg-base, #fff);
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
  box-shadow: var(--dsw-shadow-lv3, -12px 0 40px rgba(0,0,0,.22));
  animation: eh-slide-in .18s ease-out; }
.eh-dialog { display: flex; flex-direction: column; margin: auto; width: min(640px, calc(100vw - 32px));
  max-height: calc(100vh - 56px); min-width: 0; outline: none; border-radius: 16px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, #1c1c1e);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
  box-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0,0,0,.24));
  animation: eh-pop-in .16s ease-out; }
@keyframes eh-slide-in { from { transform: translateX(24px); opacity: .4; } to { transform: none; opacity: 1; } }
@keyframes eh-pop-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
.eh-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
.eh-dialog-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eh-dialog-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 12px; }
.eh-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
  padding: 11px 16px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }

/* ── 详情 ─────────────────────────────────────────────────────────────── */
.eh-detail-top { display: flex; align-items: center; gap: 12px; min-width: 0; }
.eh-detail-face { width: 56px; height: 56px; flex: none; border-radius: 14px; object-fit: cover;
  display: inline-flex; align-items: center; justify-content: center; font-size: 24px; line-height: 1;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16));
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-detail-titles { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; }
.eh-detail-name { font-size: 16px; line-height: 22px; font-weight: 600; overflow-wrap: anywhere; }
.eh-detail-prof { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); }
.eh-detail-id { font-family: ${MONO}; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, inherit); overflow-wrap: anywhere; }
.eh-detail-desc { margin: 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap;
  overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary, inherit); }
.eh-detail-meta { display: flex; align-items: center; gap: 5px 8px; flex-wrap: wrap; }
.eh-section { overflow: hidden; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26)); }
.eh-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 12px; font-size: 12px; line-height: 18px; font-weight: 600;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); }
.eh-section-count { font-weight: 400; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-role-text { margin: 0; padding: 12px; max-height: 340px; overflow: auto; font-family: ${MONO};
  font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-section-pad { padding: 10px 12px; }
.eh-skill { border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.eh-skill-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; padding: 8px 12px; border: 0; background: transparent; cursor: pointer;
  text-align: left; font-size: 12px; line-height: 18px; color: inherit; }
.eh-skill-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.eh-skill-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eh-skill-meta { display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-skill-body { margin: 0; padding: 0 12px 12px; max-height: 280px; overflow: auto; font-family: ${MONO};
  font-size: 11px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-quick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.eh-quick-item { padding: 3px 9px; border-radius: 8px; font-size: 11px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }

/* ── 会话输入框左侧胶囊 + 自管 popover ────────────────────────────────── */
.eh-cap-wrap { position: relative; display: inline-flex; }
.eh-cap { display: inline-flex; align-items: center; gap: 5px; height: 28px; max-width: 210px;
  padding: 0 10px; border: none; border-radius: 24px; background: transparent; cursor: pointer;
  font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-cap:hover:not(:disabled) { color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.eh-cap:disabled { opacity: .6; cursor: default; }
.eh-cap[data-open="true"] { color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.eh-cap-avatar { width: 18px; height: 18px; flex: none; border-radius: 5px; object-fit: cover;
  display: inline-flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.18)); }
.eh-cap-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eh-cap-caret { display: inline-flex; flex: none; font-size: 10px; line-height: 1;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, inherit));
  transition: transform .12s ease; }
.eh-cap-caret[data-open="true"] { transform: rotate(180deg); }
.eh-pop { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 10000; box-sizing: border-box;
  display: flex; flex-direction: column; width: 320px; max-width: min(360px, calc(100vw - 24px));
  max-height: 350px; overflow-y: auto; padding: 4px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #1c1c1e);
  border: 1px solid var(--dsw-alias-border-inverted, rgba(127,127,127,.35));
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.18));
  animation: eh-pop-in .14s ease-out; }
.eh-pop-head { position: sticky; top: 0; z-index: 1; padding: 2px 2px 6px;
  background: inherit; }
.eh-pop-search { box-sizing: border-box; width: 100%; height: 30px; padding: 0 10px; font-size: 12px;
  outline: none; border-radius: 8px; color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-2, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28)); }
.eh-pop-search:focus { border-color: var(--dsw-alias-brand-primary, currentColor); }
.eh-pop-search::placeholder { color: var(--dsw-alias-label-tertiary, inherit); }
.eh-pop-list { display: flex; flex-direction: column; gap: 1px; }
.eh-pop-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px;
  border: 0; border-radius: 9px; background: transparent; cursor: pointer; text-align: left;
  color: var(--dsw-alias-label-primary, inherit); box-sizing: border-box; }
.eh-pop-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.eh-pop-item[data-current="true"] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6ef7) 8%, transparent); }
.eh-pop-item:disabled { opacity: .55; cursor: default; }
.eh-pop-avatar { width: 26px; height: 26px; flex: none; border-radius: 7px; object-fit: cover;
  display: inline-flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.18)); }
.eh-pop-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; }
.eh-pop-name { font-size: 13px; line-height: 18px; font-weight: 500; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.eh-pop-prof { font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--dsw-alias-label-tertiary, inherit); }
.eh-pop-check { flex: none; font-size: 12px; line-height: 1;
  color: var(--dsw-alias-state-success-primary, #2e9e5b); }
.eh-pop-error { padding: 6px 8px; margin: 2px 0; border-radius: 8px; font-size: 11px; line-height: 1.55;
  color: var(--dsw-alias-state-error-primary, #d5484f);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d5484f) 38%, transparent); }
.eh-pop-empty { padding: 8px; font-size: 12px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, inherit); }
.eh-pop-empty-tip { display: block; margin-top: 2px; font-size: 11px;
  color: var(--dsw-alias-label-tertiary, inherit); }
.eh-pop-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
.eh-pop-none { display: flex; align-items: center; gap: 5px; width: 100%; padding: 7px 8px;
  border: 0; border-radius: 9px; background: transparent; cursor: pointer; text-align: left;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); }
.eh-pop-none:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d5484f) 8%, transparent);
  color: var(--dsw-alias-state-error-primary, #d5484f); }
.eh-pop-none:disabled { opacity: .55; cursor: default; }
.eh-pop-foot { margin-top: 4px; padding: 6px 8px 4px; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, inherit);
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }

@media (max-width: 860px) {
  .eh-create-layout { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .eh-form-row { grid-template-columns: minmax(0, 1fr); }
  .eh-grid, .eh-skel-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .eh-spin, .eh-skel-card::after { animation: none; }
  .eh-drawer, .eh-dialog, .eh-pop { animation: none; }
}
`

    /**
     * 注入本插件的 scoped 样式表（幂等）。返回这次调用创建的 <style>，
     * 由 apply 的清理函数负责移除；已存在时返回 null。
     */
    function ensureStyle () {
      if (typeof document === 'undefined' || document === null) return null
      if (document.head === undefined || document.head === null) return null
      if (typeof document.querySelector === 'function' &&
        document.querySelector('style[data-plugin="' + NS + '"]') !== null) return null
      var tag = document.createElement('style')
      tag.setAttribute('data-plugin', NS)
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    /** 移除 ensureStyle() 创建的 <style>；null-safe。 */
    function removeStyle (tag) {
      if (tag === null || tag === undefined) return
      if (typeof tag.remove === 'function') {
        tag.remove()
        return
      }
      if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag)
    }

    var React = require('react')
    var el = React.createElement

    // ── locale 字典（注册进 client locale 服务；同时作为内置回退）───────────
    var DICTS = {
      zh: {
        'page.label': '专家中心',
        'page.title': '专家中心',
        'page.subtitle': '统一管理本机专家：导入 WorkBuddy 专家、自己创建，按会话切换角色与技能。',
        'page.countInstalled': '已安装 {n}',
        'page.countAvailable': '市场 {n}',
        'page.countUpdatable': '可更新 {n}',
        'page.refresh': '刷新',
        'page.refreshing': '刷新中…',
        'page.retry': '重试',
        'page.close': '关闭',
        'page.cancel': '取消',
        'page.delete': '删除',
        'page.edit': '编辑',
        'page.detail': '详情',
        'page.update': '更新',
        'page.import': '导入',
        'page.busy': '处理中…',
        'page.loading': '加载中…',
        'page.loadFailed': '加载失败',

        'tab.installed': '已安装',
        'tab.market': 'WorkBuddy 市场',
        'tab.create': '新建与导入',

        'search.placeholder': '搜索名称、职业或标签…',
        'search.label': '搜索专家',
        'category.label': '分类筛选',
        'category.all': '全部分类',
        'category.none': '未分类',
        'sort.label': '排序方式',
        'sort.order': '默认顺序',
        'sort.name': '按名称',
        'matches': '匹配 {n} 位专家',

        'installed.emptyTitle': '还没有安装专家',
        'installed.emptyTip': '去 WorkBuddy 市场导入现成专家，或新建一个属于你的专家。',
        'installed.emptyAction': '去市场看看',
        'installed.noMatchTitle': '没有匹配的专家',
        'installed.noMatchTip': '换个关键词，或清除当前的搜索与分类筛选。',
        'installed.clearFilters': '清除筛选',
        'installed.skills': '{n} 个技能',
        'installed.roleChars': '{n} 字角色',
        'installed.updatable': '可更新',
        'installed.broken': '解析失败',
        'installed.confirmDelete': '确认删除',
        'installed.deleteHint': '删除后不可恢复，专家文件夹会从本机移除。',
        'installed.deleteDone': '已删除「{name}」',
        'installed.updateOneDone': '已更新「{name}」',
        'installed.importOneDone': '已导入「{name}」',
        'installed.actionFailed': '操作失败：{message}',

        'market.title': 'WorkBuddy 市场',
        'market.subtitle': '扫描 WorkBuddy 专家目录；更新会用源专家覆盖本机副本。',
        'market.sourceLabel': '来源目录',
        'market.sourceMissing': '来源目录不存在',
        'market.sourceMissingHint': '该路径下没有找到专家目录。请确认 WorkBuddy 已安装，或检查 expert-hub 的 sourcePath 配置。',
        'market.importAll': '全部导入（{n}）',
        'market.updateAll': '全部更新（{n}）',
        'market.emptyTitle': '市场里还没有专家',
        'market.emptyTip': '没有扫描到 WorkBuddy 专家。安装专家后点「刷新」重新扫描。',
        'market.noMatchTitle': '没有匹配的专家',
        'market.noMatchTip': '换个关键词或分类试试。',
        'market.refreshed': '已重新扫描来源目录',
        'market.warningsToggle': '扫描提示（{n}）',
        'market.partialFailed': '成功 {done} 个，失败 {failed} 个',
        'market.importDone': '已导入 {n} 个专家',
        'market.updateDone': '已更新 {n} 个专家',
        'market.importFailed': '导入失败：{message}',

        'create.title': '新建专家',
        'create.subtitle': '填写角色提示词与元信息，保存后即可在会话胶囊里切换使用。',
        'create.displayName': '显示名 *',
        'create.displayNamePlaceholder': '例如：像素君',
        'create.id': '专家 ID',
        'create.idHint': '仅小写字母、数字与连字符，留空自动生成。',
        'create.profession': '职业 / 称号',
        'create.professionPlaceholder': '例如：UI 设计师',
        'create.description': '一句话简介 *',
        'create.descriptionPlaceholder': '这个专家擅长什么？',
        'create.tags': '标签',
        'create.tagsPlaceholder': 'UI设计, 组件库',
        'create.tagsHint': '用逗号分隔，最多 8 个。',
        'create.quickPrompts': '快捷提示词',
        'create.quickPromptsPlaceholder': '帮我搭一套设计规范',
        'create.quickPromptsHint': '每行一条，最多 6 条。',
        'create.role': 'role.md 角色提示词 *',
        'create.roleHint': '支持 Markdown；会作为该专家的系统角色提示注入会话。',
        'create.rolePlaceholder': '你是一位……',
        'create.avatar': '头像',
        'create.avatarHint': 'PNG / JPG / WebP，建议 256×256，最大 2 MB。',
        'create.avatarPick': '选择图片',
        'create.avatarClear': '移除头像',
        'create.avatarInvalid': '头像需为 PNG / JPG / WebP 且不超过 2 MB。',
        'create.submit': '创建专家',
        'create.submitting': '创建中…',
        'create.done': '已创建专家「{name}」',
        'create.failed': '创建失败：{message}',
        'create.requiredName': '请填写显示名。',
        'create.requiredDescription': '请填写一句话简介。',
        'create.requiredRole': '请填写角色提示词。',
        'create.idInvalid': 'ID 只能包含小写字母、数字与连字符。',

        'import.title': '导入专家',
        'import.subtitle': '支持网页地址（zip / tar.gz / md）或本机文件夹、压缩包路径。',
        'import.urlLabel': '网页导入',
        'import.urlPlaceholder': 'https://example.com/expert.zip',
        'import.urlButton': '从网址导入',
        'import.pathLabel': '本地路径导入',
        'import.pathPlaceholder': 'D:\\Experts\\my-expert 或 ~/Downloads/expert.zip',
        'import.pathButton': '从路径导入',
        'import.working': '导入中…',
        'import.done': '导入完成：新增 {n} 个专家',
        'import.failed': '导入失败：{message}',
        'import.invalidUrl': '请输入 http(s) 网址。',
        'import.emptyPath': '请输入本地路径。',
        'import.result': '导入结果',
        'import.resultNew': '新增 {n} 个专家',
        'import.warnings': '提示（{n}）',
        'import.none': '没有导入任何专家。',

        'detail.title': '专家详情',
        'detail.loading': '正在读取详情…',
        'detail.loadFailed': '详情加载失败',
        'detail.skills': '技能',
        'detail.noSkills': '这个专家没有附带技能。',
        'detail.skillChars': '{n} 字',
        'detail.expand': '展开',
        'detail.collapse': '收起',
        'detail.quickPrompts': '快捷提示词',
        'detail.role': '角色提示词（role.md）',
        'detail.noRole': '这个专家还没有角色提示词。',
        'detail.roleChars': '共 {n} 字',
        'detail.use': '在会话中使用',
        'detail.useDone': '已切换到「{name}」',
        'detail.useFailed': '切换失败：{message}',
        'detail.noSession': '当前没有可用会话：请到输入框旁的专家胶囊切换。',
        'detail.notInstalled': '市场里的专家需要先导入，才能在会话中使用。',
        'detail.meta': '来源：{label}',
        'detail.category': '分类：{label}',
        'detail.noDescription': '（这个专家还没有简介）',

        'edit.title': '编辑专家',
        'edit.subtitle': '修改会立即写入本机专家文件夹。',
        'edit.save': '保存',
        'edit.saving': '保存中…',
        'edit.done': '已保存「{name}」',
        'edit.failed': '保存失败：{message}',
        'edit.loadFailed': '读取专家信息失败',
        'edit.roleHint': '修改后覆盖 role.md；清空则保持原角色提示词不变。',
        'edit.avatarKeep': '不选择则保留当前头像。',

        'capsule.label': '专家',
        'capsule.title': '切换当前会话的专家',
        'capsule.noSession': '先创建会话',
        'capsule.openCenter': '在 设置 → 专家中心 管理专家',
        'capsule.search': '搜索专家…',
        'capsule.list': '专家列表',
        'capsule.current': '当前',
        'capsule.none': '不用专家',
        'capsule.switchDone': '已切换到「{name}」',
        'capsule.switchFailed': '切换失败：{message}',
        'capsule.empty': '还没有安装专家',
        'capsule.emptyHint': '去 设置 → 专家中心 导入或新建。',
        'capsule.noMatch': '没有匹配的专家。',
        'capsule.loading': '加载中…',
        'capsule.loadFailed': '加载失败：{message}',
        'capsule.retry': '重试',

        'common.unknown': '未知错误'
      },
      en: {
        'page.label': 'Expert Center',
        'page.title': 'Expert Center',
        'page.subtitle': 'Manage local experts in one place: import WorkBuddy experts, create your own, and switch roles and skills per session.',
        'page.countInstalled': 'Installed {n}',
        'page.countAvailable': 'Market {n}',
        'page.countUpdatable': 'Updates {n}',
        'page.refresh': 'Refresh',
        'page.refreshing': 'Refreshing…',
        'page.retry': 'Retry',
        'page.close': 'Close',
        'page.cancel': 'Cancel',
        'page.delete': 'Delete',
        'page.edit': 'Edit',
        'page.detail': 'Details',
        'page.update': 'Update',
        'page.import': 'Import',
        'page.busy': 'Working…',
        'page.loading': 'Loading…',
        'page.loadFailed': 'Failed to load',

        'tab.installed': 'Installed',
        'tab.market': 'WorkBuddy Market',
        'tab.create': 'Create & Import',

        'search.placeholder': 'Search name, profession, or tag…',
        'search.label': 'Search experts',
        'category.label': 'Filter by category',
        'category.all': 'All categories',
        'category.none': 'Uncategorized',
        'sort.label': 'Sort by',
        'sort.order': 'Default order',
        'sort.name': 'By name',
        'matches': '{n} experts match',

        'installed.emptyTitle': 'No experts installed yet',
        'installed.emptyTip': 'Import ready-made experts from the WorkBuddy market, or create your own expert.',
        'installed.emptyAction': 'Browse the market',
        'installed.noMatchTitle': 'No matching experts',
        'installed.noMatchTip': 'Try another keyword, or clear the current search and category filters.',
        'installed.clearFilters': 'Clear filters',
        'installed.skills': '{n} skills',
        'installed.roleChars': '{n} chars',
        'installed.updatable': 'Update available',
        'installed.broken': 'Broken',
        'installed.confirmDelete': 'Confirm delete',
        'installed.deleteHint': 'This cannot be undone; the expert folder is removed from this machine.',
        'installed.deleteDone': 'Deleted “{name}”',
        'installed.updateOneDone': 'Updated “{name}”',
        'installed.importOneDone': 'Imported “{name}”',
        'installed.actionFailed': 'Action failed: {message}',

        'market.title': 'WorkBuddy Market',
        'market.subtitle': 'Scans the WorkBuddy expert directory; updating overwrites the local copy with the source expert.',
        'market.sourceLabel': 'Source directory',
        'market.sourceMissing': 'Source directory not found',
        'market.sourceMissingHint': 'No expert directory was found at this path. Make sure WorkBuddy is installed, or check expert-hub’s sourcePath configuration.',
        'market.importAll': 'Import all ({n})',
        'market.updateAll': 'Update all ({n})',
        'market.emptyTitle': 'No experts in the market yet',
        'market.emptyTip': 'No WorkBuddy experts were found. Install some experts, then click Refresh to rescan.',
        'market.noMatchTitle': 'No matching experts',
        'market.noMatchTip': 'Try another keyword or category.',
        'market.refreshed': 'Rescanned the source directory',
        'market.warningsToggle': 'Scan notices ({n})',
        'market.partialFailed': '{done} succeeded, {failed} failed',
        'market.importDone': 'Imported {n} experts',
        'market.updateDone': 'Updated {n} experts',
        'market.importFailed': 'Import failed: {message}',

        'create.title': 'Create an expert',
        'create.subtitle': 'Fill in the role prompt and metadata; once saved you can switch to it from the session capsule.',
        'create.displayName': 'Display name *',
        'create.displayNamePlaceholder': 'e.g. Sam',
        'create.id': 'Expert ID',
        'create.idHint': 'Lowercase letters, digits, and hyphens; leave blank to generate automatically.',
        'create.profession': 'Profession / title',
        'create.professionPlaceholder': 'e.g. UI Designer',
        'create.description': 'Short description *',
        'create.descriptionPlaceholder': 'What is this expert good at?',
        'create.tags': 'Tags',
        'create.tagsPlaceholder': 'UI design, design systems',
        'create.tagsHint': 'Comma-separated, up to 8.',
        'create.quickPrompts': 'Quick prompts',
        'create.quickPromptsPlaceholder': 'Help me set up a design system',
        'create.quickPromptsHint': 'One per line, up to 6.',
        'create.role': 'role.md prompt *',
        'create.roleHint': 'Markdown supported; injected into the session as this expert’s system role prompt.',
        'create.rolePlaceholder': 'You are…',
        'create.avatar': 'Avatar',
        'create.avatarHint': 'PNG, JPG, or WebP; 256×256 recommended; max 2 MB.',
        'create.avatarPick': 'Choose image',
        'create.avatarClear': 'Remove avatar',
        'create.avatarInvalid': 'The avatar must be a PNG, JPG, or WebP under 2 MB.',
        'create.submit': 'Create expert',
        'create.submitting': 'Creating…',
        'create.done': 'Created expert “{name}”',
        'create.failed': 'Create failed: {message}',
        'create.requiredName': 'Please enter a display name.',
        'create.requiredDescription': 'Please enter a short description.',
        'create.requiredRole': 'Please enter the role prompt.',
        'create.idInvalid': 'The ID may only contain lowercase letters, digits, and hyphens.',

        'import.title': 'Import experts',
        'import.subtitle': 'Accepts a web URL (zip, tar.gz, md) or a local folder or archive path.',
        'import.urlLabel': 'Import from URL',
        'import.urlPlaceholder': 'https://example.com/expert.zip',
        'import.urlButton': 'Import from URL',
        'import.pathLabel': 'Import from local path',
        'import.pathPlaceholder': 'D:\\Experts\\my-expert or ~/Downloads/expert.zip',
        'import.pathButton': 'Import from path',
        'import.working': 'Importing…',
        'import.done': 'Import complete: {n} new experts',
        'import.failed': 'Import failed: {message}',
        'import.invalidUrl': 'Enter an http(s) URL.',
        'import.emptyPath': 'Enter a local path.',
        'import.result': 'Import result',
        'import.resultNew': '{n} new experts',
        'import.warnings': 'Notices ({n})',
        'import.none': 'No experts were imported.',

        'detail.title': 'Expert details',
        'detail.loading': 'Loading details…',
        'detail.loadFailed': 'Failed to load details',
        'detail.skills': 'Skills',
        'detail.noSkills': 'This expert has no bundled skills.',
        'detail.skillChars': '{n} chars',
        'detail.expand': 'Expand',
        'detail.collapse': 'Collapse',
        'detail.quickPrompts': 'Quick prompts',
        'detail.role': 'Role prompt (role.md)',
        'detail.noRole': 'This expert has no role prompt yet.',
        'detail.roleChars': '{n} chars total',
        'detail.use': 'Use in this session',
        'detail.useDone': 'Switched to “{name}”',
        'detail.useFailed': 'Switch failed: {message}',
        'detail.noSession': 'No session is available here — switch from the expert capsule next to the composer.',
        'detail.notInstalled': 'Import this market expert before using it in a session.',
        'detail.meta': 'Source: {label}',
        'detail.category': 'Category: {label}',
        'detail.noDescription': '(This expert has no description yet.)',

        'edit.title': 'Edit expert',
        'edit.subtitle': 'Changes are written to the local expert folder immediately.',
        'edit.save': 'Save',
        'edit.saving': 'Saving…',
        'edit.done': 'Saved “{name}”',
        'edit.failed': 'Save failed: {message}',
        'edit.loadFailed': 'Failed to load expert data',
        'edit.roleHint': 'Replaces role.md when changed; leave empty to keep the current role prompt.',
        'edit.avatarKeep': 'Leaves the current avatar unchanged when empty.',

        'capsule.label': 'Expert',
        'capsule.title': 'Switch the expert for this session',
        'capsule.noSession': 'Create a session first',
        'capsule.openCenter': 'Manage experts in Settings → Expert Center',
        'capsule.search': 'Search experts…',
        'capsule.list': 'Expert list',
        'capsule.current': 'Current',
        'capsule.none': 'No expert',
        'capsule.switchDone': 'Switched to “{name}”',
        'capsule.switchFailed': 'Switch failed: {message}',
        'capsule.empty': 'No experts installed',
        'capsule.emptyHint': 'Import or create one in Settings → Expert Center.',
        'capsule.noMatch': 'No matching experts.',
        'capsule.loading': 'Loading…',
        'capsule.loadFailed': 'Load failed: {message}',
        'capsule.retry': 'Retry',

        'common.unknown': 'Unknown error'
      }
    }

    /** fallback 翻译：zh 字典 → key，带 {placeholder} 插值。 */
    function fallbackT (key, params) {
      var template = DICTS.zh[key] !== undefined ? DICTS.zh[key] : key
      return interpolate(template, params)
    }

    function interpolate (template, params) {
      if (params === undefined || params === null) return template
      return String(template).replace(/\{(\w+)\}/g, function (whole, name) {
        return params[name] !== undefined ? String(params[name]) : whole
      })
    }

    /** 同源 JSON fetch；把宿主的错误体展开为可读 Error（保留 status/code）。 */
    function api (path, options) {
      var init = Object.assign({ credentials: 'same-origin' }, options || {})
      return fetch(path, init).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (body) {
          if (!response.ok) {
            var error = new Error(errorMessageOf(body, response.status))
            error.status = response.status
            if (body !== null && typeof body === 'object' && body.error !== null &&
              typeof body.error === 'object' && typeof body.error.code === 'string') {
              error.code = body.error.code
            }
            throw error
          }
          return body
        })
      })
    }

    /** 宿主统一错误体 `{ ok:false, error:{ code, message } }` → 一行文案。 */
    function errorMessageOf (body, status) {
      if (body !== null && typeof body === 'object') {
        var detail = body.error
        if (typeof detail === 'string' && detail !== '') return detail
        if (detail !== null && typeof detail === 'object') {
          if (typeof detail.message === 'string' && detail.message !== '') return detail.message
          if (typeof detail.code === 'string' && detail.code !== '') return detail.code
        }
        if (typeof body.message === 'string' && body.message !== '') return body.message
      }
      return 'HTTP ' + status
    }

    /** 同源 JSON POST（mutation 唯一接受的形状）。 */
    function postJson (path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    }

    /** 一行错误文案（client 内联提示用）。 */
    function errorOf (error) {
      try {
        if (error !== null && typeof error === 'object' &&
          typeof error.message === 'string' && error.message !== '') return error.message
        return String(error)
      } catch (e) {
        return DICTS.zh['common.unknown']
      }
    }

    // ── 纯派生（同时导出给离线自检）────────────────────────────────────────

    function strOf (value) {
      return typeof value === 'string' ? value.trim() : ''
    }

    function arrOf (value) {
      return Array.isArray(value) ? value : []
    }

    function listOfStrings (value) {
      var list = arrOf(value)
      var out = []
      for (var i = 0; i < list.length; i++) {
        var text = strOf(list[i])
        if (text !== '') out.push(text)
      }
      return out
    }

    function nameOf (card) {
      if (card === null || typeof card !== 'object') return ''
      var name = strOf(card.displayName)
      return name !== '' ? name : strOf(card.id)
    }

    function professionOf (card) {
      if (card === null || typeof card !== 'object') return ''
      return strOf(card.profession) || strOf(card.professionEn)
    }

    /** Card subtitle: profession, then category, then id — never the name twice. */
    function subOf (card) {
      var profession = professionOf(card)
      var name = nameOf(card)
      if (profession !== '' && profession !== name) return profession
      var category = strOf(card !== null && typeof card === 'object' ? card.categoryLabel : '')
      if (category !== '') return category
      return strOf(card !== null && typeof card === 'object' ? card.id : '')
    }

    function firstGlyph (name) {
      var text = strOf(name)
      if (text === '') return AVATAR_GLYPH
      var glyph = typeof Array.from === 'function' ? Array.from(text)[0] : text.charAt(0)
      return glyph === undefined || glyph === '' ? AVATAR_GLYPH : glyph
    }

    function isBroken (card) {
      return card !== null && typeof card === 'object' && strOf(card.broken) !== ''
    }

    function skillsOf (card) {
      return card !== null && typeof card === 'object' ? arrOf(card.skills) : []
    }

    /**
     * 会话 id 探测（CONTRACT §9）：props.sessionId ?? props.session?.id ??
     * props.session?.sessionId；没有会话时返回 ''（胶囊禁用）。
     */
    function sessionIdOf (props) {
      props = props || {}
      if (typeof props.sessionId === 'string' && props.sessionId.trim() !== '') return props.sessionId.trim()
      var session = props.session
      if (session !== null && typeof session === 'object') {
        if (typeof session.id === 'string' && session.id.trim() !== '') return session.id.trim()
        if (typeof session.sessionId === 'string' && session.sessionId.trim() !== '') return session.sessionId.trim()
      }
      return ''
    }

    function stateUrl (sessionId) {
      var id = strOf(sessionId)
      return API_BASE + '/state' + (id === '' ? '' : '?sessionId=' + encodeURIComponent(id))
    }

    function detailUrl (id, scope) {
      var actualScope = scope === 'workbuddy' ? 'workbuddy' : 'installed'
      return API_BASE + '/detail?id=' + encodeURIComponent(strOf(id)) + '&scope=' + actualScope
    }

    function fetchState (sessionId) {
      return api(stateUrl(sessionId))
    }

    /** 列表 payload 里的一张卡表；非法条目直接丢弃，渲染不因脏数据崩溃。 */
    function cardsOf (payload, key) {
      if (payload === null || typeof payload !== 'object') return []
      var list = payload[key]
      if (!Array.isArray(list)) return []
      var out = []
      for (var i = 0; i < list.length; i++) {
        var card = list[i]
        if (card !== null && typeof card === 'object' && strOf(card.id) !== '') out.push(card)
      }
      return out
    }

    function compareNames (a, b) {
      var an = nameOf(a)
      var bn = nameOf(b)
      if (typeof an.localeCompare === 'function') return an.localeCompare(bn, 'zh-CN')
      return an < bn ? -1 : an > bn ? 1 : 0
    }

    /** order 升序（缺省/非法排最后），同 order 按显示名；'name' 直接按名。 */
    function sortCards (cards, sort) {
      var list = arrOf(cards).slice()
      if (sort === 'name') return list.sort(compareNames)
      return list.sort(function (a, b) {
        var ao = typeof a.order === 'number' && isFinite(a.order) ? a.order : Infinity
        var bo = typeof b.order === 'number' && isFinite(b.order) ? b.order : Infinity
        if (ao !== bo) return ao < bo ? -1 : 1
        return compareNames(a, b)
      })
    }

    function categoryOf (card) {
      if (card === null || typeof card !== 'object') return ''
      return strOf(card.category)
    }

    /** 分类选项（含未分类），标签优先用 categoryLabel，并按出现顺序。 */
    function categoriesOf (cards, t) {
      var map = {}
      var order = []
      var list = arrOf(cards)
      for (var i = 0; i < list.length; i++) {
        var raw = categoryOf(list[i])
        var key = raw === '' ? UNCATEGORIZED : raw
        if (map[key] === undefined) {
          map[key] = {
            id: key,
            label: raw === '' ? t('category.none') : (strOf(list[i].categoryLabel) || raw),
            count: 0
          }
          order.push(key)
        }
        map[key].count++
      }
      var out = []
      for (var j = 0; j < order.length; j++) out.push(map[order[j]])
      return out
    }

    /** 自由文本搜索：中文优先字段 + 英文名 + id + 标签 + 简介。 */
    function searchTextOf (card) {
      var parts = [
        nameOf(card),
        strOf(card.name),
        professionOf(card),
        strOf(card.id),
        strOf(card.description),
        strOf(card.descriptionEn),
        strOf(card.categoryLabel)
      ]
      var tags = listOfStrings(card.tags)
      for (var i = 0; i < tags.length; i++) parts.push(tags[i])
      return parts.join(' ').toLowerCase()
    }

    function filterCards (cards, query, category, sort) {
      var list = arrOf(cards)
      var keyword = strOf(query).toLowerCase()
      var out = []
      for (var i = 0; i < list.length; i++) {
        var card = list[i]
        if (category !== undefined && category !== null && category !== 'all') {
          var raw = categoryOf(card)
          var key = raw === '' ? UNCATEGORIZED : raw
          if (key !== category) continue
        }
        if (keyword !== '' && searchTextOf(card).indexOf(keyword) < 0) continue
        out.push(card)
      }
      return sortCards(out, sort)
    }

    /** normalizeText（src/format.js）：去 UTF-8 BOM、CRLF/CR → LF；非字符串按空串。 */
    function normalizeSlugText (value) {
      if (typeof value !== 'string') return ''
      var text = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
      return text.replace(/\r\n?/g, '\n')
    }

    /** FNV-1a 32-bit 的 6 位后缀，与 src/format.js 的 hashSuffix 逐位一致。 */
    function hashSuffix (text) {
      var hash = 0x811c9dc5
      var chars = typeof Array.from === 'function' ? Array.from(text) : text.split('')
      for (var i = 0; i < chars.length; i++) {
        var point = typeof chars[i].codePointAt === 'function' ? chars[i].codePointAt(0) : chars[i].charCodeAt(0)
        hash ^= point === undefined || point === null ? 0 : point
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      var hex = hash.toString(16)
      while (hex.length < 8) hex = '0' + hex
      return hex.slice(0, 6)
    }

    /**
     * 与 host（src/format.js slugify）同算法的前端预览，避免新建表单里显示的
     * id 与 host 实际生成的不一致：ASCII 段保留；显示名没有 ASCII 字母/数字时
     * 用 `expert-<fnv1a6>`（hash 按 code point 迭代 normalized 文本）。
     */
    function slugifyInput (value) {
      var normalized = normalizeSlugText(value)
      var base = normalized.toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
        .replace(/^-+|-+$/g, '')
      var parts = base.split('-')
      var ascii = []
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i]
        if (part !== '' && !/^[\u4e00-\u9fff]+$/.test(part)) ascii.push(part)
      }
      var fallback = 'expert-' + hashSuffix(normalized)
      var candidate = (ascii.length > 0 ? ascii.join('-') : fallback).replace(/^-+|-+$/g, '')
      if (!ID_RE.test(candidate)) candidate = fallback
      return ID_RE.test(candidate) ? candidate : 'expert'
    }

    /** 标签输入（逗号/中文逗号/顿号/换行）→ 去重后最多 8 个。 */
    function parseTags (value) {
      var text = value === undefined || value === null ? '' : String(value)
      var parts = text.split(/[,，、\n]/)
      var seen = {}
      var out = []
      for (var i = 0; i < parts.length; i++) {
        var tag = strOf(parts[i])
        if (tag === '' || seen[tag] === true) continue
        seen[tag] = true
        out.push(tag)
      }
      return out.slice(0, 8)
    }

    /** 多行输入 → 去空行后最多 limit 条。 */
    function parseLines (value, limit) {
      var text = value === undefined || value === null ? '' : String(value)
      var lines = text.replace(/\r\n?/g, '\n').split('\n')
      var out = []
      for (var i = 0; i < lines.length; i++) {
        var line = strOf(lines[i])
        if (line !== '') out.push(line)
      }
      return out.slice(0, limit)
    }

    /** 文件 → dataURL；校验类型与体积，错误通过 message 参数回传。 */
    function readAvatarFile (file, t, done) {
      if (file === null || file === undefined) {
        done('', t('create.avatarInvalid'))
        return
      }
      if (AVATAR_TYPES.indexOf(strOf(file.type)) < 0) {
        done('', t('create.avatarInvalid'))
        return
      }
      if (typeof file.size === 'number' && file.size > AVATAR_MAX_BYTES) {
        done('', t('create.avatarInvalid'))
        return
      }
      if (typeof FileReader === 'undefined') {
        done('', t('create.avatarInvalid'))
        return
      }
      var reader = new FileReader()
      reader.onload = function () {
        var result = typeof reader.result === 'string' ? reader.result : ''
        if (result.indexOf('data:image/') !== 0) done('', t('create.avatarInvalid'))
        else done(result, '')
      }
      reader.onerror = function () { done('', t('create.avatarInvalid')) }
      reader.readAsDataURL(file)
    }

    /** 状态事件总线：apply 建一条 EventSource，两个座位各自订阅。 */
    function createStateBus () {
      var listeners = []
      return {
        subscribe: function (listener) {
          if (typeof listener !== 'function') return function () {}
          listeners.push(listener)
          return function () {
            var index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          }
        },
        emit: function (payload) {
          var snapshot = listeners.slice()
          for (var i = 0; i < snapshot.length; i++) {
            try { snapshot[i](payload) } catch (error) { /* 一个订阅失败不影响其它 */ }
          }
        }
      }
    }

    /**
     * 订阅 'expert-hub/events'（text/event-stream，事件 state）。断线后 5s
     * 重连；返回的 stop() 幂等关闭连接并清掉重连定时器。
     */
    function startStateEvents (bus) {
      if (typeof EventSource === 'undefined') return function () {}
      var source = null
      var timer = null
      var closed = false

      function closeSource () {
        if (source === null) return
        try { source.close() } catch (error) { /* ignore */ }
        source = null
      }

      function scheduleReconnect () {
        if (closed || timer !== null) return
        timer = setTimeout(function () {
          timer = null
          if (!closed) connect()
        }, 5000)
      }

      function connect () {
        if (closed) return
        closeSource()
        try {
          source = new EventSource(API_BASE + '/events')
        } catch (error) {
          scheduleReconnect()
          return
        }
        source.addEventListener('state', function (event) {
          var payload = null
          try { payload = JSON.parse(event.data) } catch (error) { payload = null }
          bus.emit(payload)
        })
        source.onerror = function () {
          closeSource()
          scheduleReconnect()
        }
      }

      connect()

      return function stop () {
        closed = true
        closeSource()
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
    }

    // ── 共享小组件 ─────────────────────────────────────────────────────────

    /** 头像：avatarUrl 存在且能加载就用 <img>；否则用首字/emoji 占位。 */
    function AvatarFace (props) {
      var card = props.card
      var failedState = React.useState(false)
      var failed = failedState[0]
      var setFailed = failedState[1]
      var url = card !== null && typeof card === 'object' ? strOf(card.avatarUrl) : ''
      if (url !== '' && !failed) {
        return el('img', {
          className: props.className,
          src: url,
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          onError: function () { setFailed(true) }
        })
      }
      return el('span', {
        className: props.glyphClassName !== undefined ? props.glyphClassName : props.className,
        'aria-hidden': 'true'
      }, firstGlyph(nameOf(card)))
    }

    /** 通用遮罩容器：Escape / 点击遮罩关闭，focus 落到面板，锁定 body 滚动。 */
    function Overlay (props) {
      var t = props.t
      var boxRef = React.useRef(null)
      var close = props.onClose

      React.useEffect(function () {
        if (typeof document === 'undefined' || document === null) return undefined
        var onKeyDown = function (event) {
          if (event !== null && event !== undefined && event.key === 'Escape') {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            close()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        var body = document.body
        var previousOverflow = body !== null && body !== undefined ? body.style.overflow : ''
        if (body !== null && body !== undefined) body.style.overflow = 'hidden'
        return function () {
          document.removeEventListener('keydown', onKeyDown)
          if (body !== null && body !== undefined) body.style.overflow = previousOverflow
        }
      }, [])

      React.useEffect(function () {
        var box = boxRef.current
        if (box !== null && box !== undefined && typeof box.focus === 'function') box.focus()
      }, [])

      return el('div', {
        className: 'eh-overlay',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) close()
        }
      }, el('div', {
        className: props.kind === 'drawer' ? 'eh-drawer' : 'eh-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': props.title,
        tabIndex: -1,
        ref: boxRef
      },
        el('header', { className: 'eh-dialog-head' },
          el('h3', { className: 'eh-dialog-title' }, props.title),
          el('button', {
            className: 'eh-icon-btn', type: 'button',
            title: t('page.close'), 'aria-label': t('page.close'),
            onClick: close
          }, '✕')),
        el('div', { className: 'eh-dialog-body' }, props.children),
        props.footer !== undefined && props.footer !== null
          ? el('footer', { className: 'eh-dialog-foot' }, props.footer)
          : null))
    }

    /** 搜索 + 分类 + 排序工具条。 */
    function ExpertToolbar (props) {
      var t = props.t
      var categories = arrOf(props.categories)
      var categoryOptions = [el('option', { key: 'all', value: 'all' }, t('category.all'))]
      for (var i = 0; i < categories.length; i++) {
        categoryOptions.push(el('option', {
          key: categories[i].id,
          value: categories[i].id
        }, categories[i].label + '（' + categories[i].count + '）'))
      }
      return el('div', { className: 'eh-toolbar' },
        el('div', { className: 'eh-search-wrap' },
          el('span', { className: 'eh-search-icon', 'aria-hidden': 'true' }, '⌕'),
          el('input', {
            className: 'eh-search',
            type: 'search',
            value: props.query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.label'),
            onChange: function (event) { props.onQuery(event.target.value) }
          })),
        el('label', { className: 'eh-select-wrap' },
          el('span', { className: 'eh-sr-only' }, t('category.label')),
          el('select', {
            className: 'eh-select',
            value: props.category,
            'aria-label': t('category.label'),
            onChange: function (event) { props.onCategory(event.target.value) }
          }, categoryOptions)),
        props.showSort === true
          ? el('label', { className: 'eh-select-wrap' },
              el('span', { className: 'eh-sr-only' }, t('sort.label')),
              el('select', {
                className: 'eh-select',
                value: props.sort,
                'aria-label': t('sort.label'),
                onChange: function (event) { props.onSort(event.target.value) }
              },
                el('option', { value: 'order' }, t('sort.order')),
                el('option', { value: 'name' }, t('sort.name'))))
          : null)
    }

    /** 空态（含可选行动按钮）。 */
    function EmptyState (props) {
      return el('div', { className: 'eh-empty' },
        el('span', { className: 'eh-empty-face', 'aria-hidden': 'true' }, props.face !== undefined ? props.face : AVATAR_GLYPH),
        el('p', { className: 'eh-empty-title' }, props.title),
        el('p', { className: 'eh-empty-tip' }, props.tip),
        props.actionLabel !== undefined && props.actionLabel !== null
          ? el('button', {
              className: 'eh-btn', type: 'button',
              onClick: props.onAction
            }, props.actionLabel)
          : null)
    }

    function skeletonGrid () {
      var cards = []
      for (var i = 0; i < 6; i++) cards.push(el('div', { className: 'eh-skel-card', key: i }))
      return el('div', { className: 'eh-skel-grid', 'aria-hidden': 'true' }, cards)
    }

    /** 扫描 warnings 折叠盒。 */
    function WarningsBox (props) {
      var t = props.t
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var warnings = arrOf(props.warnings)
      if (warnings.length === 0) return null
      var items = []
      for (var i = 0; i < warnings.length; i++) {
        items.push(el('li', { key: i }, String(warnings[i])))
      }
      return el('div', { className: 'eh-warns' },
        el('button', {
          className: 'eh-warns-toggle', type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { setOpen(!open) }
        },
          el('span', { className: 'eh-warns-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          t('market.warningsToggle', { n: warnings.length })),
        open ? el('ul', { className: 'eh-warns-list' }, items) : null)
    }

    // ── 会话胶囊（conversation.input.left）────────────────────────────────

    function ExpertCapsule (props) {
      var t = props.t
      var bus = props.bus
      var sessionId = strOf(props.sessionId)

      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var queryState = React.useState('')
      var query = queryState[0]
      var setQuery = queryState[1]
      var rootRef = React.useRef(null)
      var searchRef = React.useRef(null)

      var installed = data !== null && Array.isArray(data.installed) ? data.installed : []
      var session = data !== null && data.session !== null && typeof data.session === 'object' ? data.session : null
      var currentId = session !== null ? strOf(session.expertId) : ''
      var currentCard = null
      for (var ci = 0; ci < installed.length; ci++) {
        if (strOf(installed[ci].id) === currentId) {
          currentCard = installed[ci]
          break
        }
      }
      var faceName = currentCard !== null ? nameOf(currentCard) : (session !== null ? strOf(session.displayName) : '')
      var capsuleLabel = faceName !== '' ? faceName : t('capsule.label')
      var faceCard = currentCard !== null ? currentCard : (faceName !== '' ? { displayName: faceName } : null)
      var disabled = sessionId === ''

      function pull () {
        if (sessionId === '') return Promise.resolve(null)
        return fetchState(sessionId).then(function (payload) {
          setData(payload)
          setError('')
          return payload
        }, function (err) {
          setError(t('capsule.loadFailed', { message: errorOf(err) }))
          return null
        })
      }

      React.useEffect(function () { pull() }, [sessionId])

      React.useEffect(function () {
        if (bus === null || bus === undefined || typeof bus.subscribe !== 'function') return undefined
        return bus.subscribe(function () { pull() })
      }, [bus, sessionId])

      // 打开时：外部点击 / Escape 关闭。
      React.useEffect(function () {
        if (!open || typeof document === 'undefined' || document === null) return undefined
        var onPointerDown = function (event) {
          var root = rootRef.current
          if (root === null || root === undefined) return
          if (event.target !== null && event.target !== undefined &&
            typeof root.contains === 'function' && root.contains(event.target)) return
          setOpen(false)
        }
        var onKeyDown = function (event) {
          if (event !== null && event !== undefined && event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      // 打开时聚焦搜索框，键盘用户可直接输入。
      React.useEffect(function () {
        var input = searchRef.current
        if (open && input !== null && input !== undefined && typeof input.focus === 'function') input.focus()
      }, [open])

      function toggleOpen () {
        if (disabled) return
        var next = !open
        setOpen(next)
        if (next) {
          setError('')
          pull()
        }
      }

      function switchTo (expertId) {
        if (disabled || busy !== '') return
        setError('')
        setBusy('switch')
        postJson(API_BASE + '/switch', { sessionId: sessionId, expertId: expertId }).then(function () {
          setOpen(false)
          return pull()
        }, function (err) {
          setError(t('capsule.switchFailed', { message: errorOf(err) }))
          return pull()
        }).then(function () { setBusy('') })
      }

      function pick (card) {
        if (isBroken(card)) return
        switchTo(strOf(card.id))
      }

      function clearExpert () {
        switchTo(null)
      }

      var filtered = filterCards(installed, query, 'all', 'order')
      var items = []
      for (var ii = 0; ii < filtered.length; ii++) {
        items.push(capsuleItem(filtered[ii]))
      }

      function capsuleItem (card) {
        var id = strOf(card.id)
        var current = id !== '' && id === currentId
        var broken = isBroken(card)
        var title = broken ? strOf(card.broken) : (professionOf(card) !== '' ? professionOf(card) : strOf(card.description))
        return el('button', {
          key: id,
          type: 'button',
          role: 'option',
          className: 'eh-pop-item',
          'data-current': current ? 'true' : undefined,
          'aria-selected': current ? 'true' : 'false',
          disabled: busy !== '' || broken,
          title: title,
          onClick: function () { pick(card) }
        },
          el(AvatarFace, { card: card, className: 'eh-pop-avatar', glyphClassName: 'eh-pop-avatar' }),
          el('span', { className: 'eh-pop-main' },
            el('span', { className: 'eh-pop-name' }, nameOf(card)),
            professionOf(card) !== '' && professionOf(card) !== nameOf(card)
              ? el('span', { className: 'eh-pop-prof' }, professionOf(card))
              : null,
            broken ? el('span', { className: 'eh-pop-prof' }, '⚠ ' + strOf(card.broken)) : null),
          current ? el('span', { className: 'eh-pop-check', title: t('capsule.current') }, '✓') : null)
      }

      var listView = null
      if (data === null) {
        listView = el('div', { className: 'eh-pop-empty' }, t('capsule.loading'))
      } else if (filtered.length === 0) {
        if (installed.length === 0) {
          listView = el('div', { className: 'eh-pop-empty' },
            t('capsule.empty'),
            el('span', { className: 'eh-pop-empty-tip' }, t('capsule.emptyHint')))
        } else {
          listView = el('div', { className: 'eh-pop-empty' }, t('capsule.noMatch'))
        }
      } else {
        listView = el('div', { className: 'eh-pop-list', role: 'listbox', 'aria-label': t('capsule.list') }, items)
      }

      var popover = null
      if (open) {
        popover = el('div', {
          className: 'eh-pop',
          role: 'dialog',
          'aria-label': t('capsule.title')
        },
          el('div', { className: 'eh-pop-head' },
            el('input', {
              ref: searchRef,
              className: 'eh-pop-search',
              type: 'search',
              value: query,
              placeholder: t('capsule.search'),
              'aria-label': t('capsule.search'),
              onChange: function (event) { setQuery(event.target.value) }
            })),
          error !== '' ? el('div', { className: 'eh-pop-error', role: 'alert' }, error) : null,
          listView,
          currentId !== '' ? el('div', { className: 'eh-pop-sep', 'aria-hidden': 'true' }) : null,
          currentId !== '' ? el('button', {
            className: 'eh-pop-none', type: 'button',
            disabled: busy !== '',
            title: t('capsule.none'),
            onClick: clearExpert
          }, '✕ ', t('capsule.none')) : null,
          el('div', { className: 'eh-pop-foot' }, t('capsule.openCenter')))
      }

      return el('div', { className: 'eh-cap-wrap', ref: rootRef },
        el('button', {
          className: 'eh-cap',
          type: 'button',
          title: disabled ? t('capsule.noSession') : t('capsule.title'),
          'aria-label': disabled ? t('capsule.noSession') : t('capsule.title'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          'aria-busy': busy !== '' ? 'true' : undefined,
          'data-open': open ? 'true' : undefined,
          disabled: disabled || busy !== '',
          onClick: toggleOpen
        },
          busy !== '' ? el('span', { className: 'eh-spin', 'aria-hidden': 'true' }) : null,
          busy === '' ? el(AvatarFace, { card: faceCard, className: 'eh-cap-avatar', glyphClassName: 'eh-cap-avatar' }) : null,
          el('span', { className: 'eh-cap-label' }, capsuleLabel),
          el('span', {
            className: 'eh-cap-caret',
            'data-open': open ? 'true' : undefined,
            'aria-hidden': 'true'
          }, '▾')),
        popover)
    }

    // ── 专家卡片 ───────────────────────────────────────────────────────────

    function ExpertCardView (props) {
      var t = props.t
      var card = props.card
      var mode = props.mode
      var laneBusy = props.laneBusy === true
      var broken = isBroken(card)
      var updatable = card.updatable === true
      var installed = card.installed === true
      var name = nameOf(card)
      var profession = professionOf(card)
      var desc = strOf(card.description) || strOf(card.roleExcerpt)
      var tags = listOfStrings(card.tags)
      var skills = skillsOf(card)
      var roleChars = typeof card.roleChars === 'number' && isFinite(card.roleChars) ? card.roleChars : 0
      var sourceLabel = strOf(card.sourceLabel)

      var tagNodes = []
      for (var i = 0; i < tags.length && i < 4; i++) {
        tagNodes.push(el('span', { className: 'eh-tag', key: 'tag:' + i, title: tags[i] }, tags[i]))
      }
      if (tags.length > 4) {
        tagNodes.push(el('span', { className: 'eh-tag', key: 'tag:more' }, '+' + (tags.length - 4)))
      }

      var actions = []
      actions.push(el('button', {
        key: 'detail', className: 'eh-btn eh-btn-sm', type: 'button',
        disabled: laneBusy,
        onClick: function () { props.onAction(card, 'detail') }
      }, t('page.detail')))

      if (mode === 'installed') {
        actions.push(el('button', {
          key: 'edit', className: 'eh-btn eh-btn-sm', type: 'button',
          disabled: laneBusy || broken, title: broken ? strOf(card.broken) : undefined,
          onClick: function () { props.onAction(card, 'edit') }
        }, t('page.edit')))
        if (updatable) {
          actions.push(el('button', {
            key: 'update', className: 'eh-btn eh-btn-sm', type: 'button',
            'data-variant': 'primary',
            disabled: laneBusy || broken,
            onClick: function () { props.onAction(card, 'update') }
          }, t('page.update')))
        }
        if (props.confirmDelete === true) {
          actions.push(el('button', {
            key: 'confirm-delete', className: 'eh-btn eh-btn-sm', type: 'button',
            'data-variant': 'danger',
            disabled: laneBusy,
            title: t('installed.deleteHint'),
            onClick: function () { props.onAction(card, 'confirm-delete') }
          }, t('installed.confirmDelete')))
          actions.push(el('button', {
            key: 'cancel-delete', className: 'eh-btn eh-btn-sm', type: 'button',
            disabled: laneBusy,
            onClick: function () { props.onAction(card, 'cancel-delete') }
          }, t('page.cancel')))
        } else {
          actions.push(el('button', {
            key: 'delete', className: 'eh-btn eh-btn-sm', type: 'button',
            'data-variant': 'danger',
            disabled: laneBusy,
            title: t('installed.deleteHint'),
            onClick: function () { props.onAction(card, 'delete') }
          }, t('page.delete')))
        }
      } else {
        if (!installed) {
          actions.push(el('button', {
            key: 'import', className: 'eh-btn eh-btn-sm', type: 'button',
            'data-variant': 'primary',
            disabled: laneBusy || broken,
            onClick: function () { props.onAction(card, 'import') }
          }, t('page.import')))
        } else if (updatable) {
          actions.push(el('button', {
            key: 'update', className: 'eh-btn eh-btn-sm', type: 'button',
            'data-variant': 'primary',
            disabled: laneBusy || broken,
            onClick: function () { props.onAction(card, 'update') }
          }, t('page.update')))
        } else {
          actions.push(el('span', { key: 'installed', className: 'eh-badge', 'data-kind': 'ok' },
            '✓ ', t('tab.installed')))
        }
      }

      var marks = []
      if (updatable) marks.push(el('span', { key: 'up', className: 'eh-badge', 'data-kind': 'update' },
        '↑ ', t('installed.updatable')))
      if (broken) marks.push(el('span', { key: 'bad', className: 'eh-badge', 'data-kind': 'warn' },
        '⚠ ', t('installed.broken')))

      return el('li', {
        className: 'eh-card',
        'data-broken': broken ? 'true' : undefined,
        'data-updatable': updatable ? 'true' : undefined
      },
        el('div', { className: 'eh-card-head' },
          el(AvatarFace, { card: card, className: 'eh-avatar', glyphClassName: 'eh-avatar' }),
          el('div', { className: 'eh-card-titles' },
            el('div', { className: 'eh-card-name-row' },
              el('span', { className: 'eh-card-name', title: name }, name),
              marks),
            el('span', { className: 'eh-card-sub', title: subOf(card) }, subOf(card)))),
        desc !== '' ? el('p', { className: 'eh-card-desc', title: desc }, desc) : null,
        tagNodes.length > 0 ? el('div', { className: 'eh-tags' }, tagNodes) : null,
        el('div', { className: 'eh-card-meta' },
          skills.length > 0 ? el('span', { className: 'eh-meta' }, t('installed.skills', { n: skills.length })) : null,
          el('span', { className: 'eh-meta' }, t('installed.roleChars', { n: roleChars })),
          sourceLabel !== '' ? el('span', { className: 'eh-meta', title: sourceLabel }, sourceLabel) : null),
        el('div', { className: 'eh-actions' }, actions))
    }

    // ── 详情抽屉 ───────────────────────────────────────────────────────────

    function DetailDrawer (props) {
      var t = props.t
      var card = props.card !== null && props.card !== undefined ? props.card : {}
      var scope = props.scope === 'workbuddy' ? 'workbuddy' : 'installed'
      var sessionId = strOf(props.sessionId)
      var laneBusy = props.laneBusy === true

      var detailState = React.useState(null)
      var detail = detailState[0]
      var setDetail = detailState[1]
      var loadingState = React.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var skillState = React.useState('')
      var openSkill = skillState[0]
      var setOpenSkill = skillState[1]

      var cardId = strOf(card.id)

      function load () {
        setLoading(true)
        setError('')
        api(detailUrl(cardId, scope)).then(function (payload) {
          setDetail(payload)
          setLoading(false)
          return payload
        }, function (err) {
          setError(errorOf(err))
          setLoading(false)
          return null
        })
      }

      React.useEffect(function () { load() }, [cardId, scope])

      var current = detail !== null && detail.card !== null && typeof detail.card === 'object' ? detail.card : card
      var roleText = detail !== null && typeof detail.roleText === 'string' ? detail.roleText : ''
      var skills = detail !== null && Array.isArray(detail.skills) ? detail.skills : skillsOf(card)
      var quickPrompts = listOfStrings(current.quickPrompts)
      var tags = listOfStrings(current.tags)
      var description = strOf(current.description) || strOf(current.roleExcerpt)
      var sourceLabel = strOf(current.sourceLabel)
      var categoryLabel = strOf(current.categoryLabel)
      var roleChars = roleText !== '' ? roleText.length : (typeof current.roleChars === 'number' ? current.roleChars : 0)
      // installed 列表里 scope 本身已表明「已安装」，字段缺失时按已安装处理。
      var installedFlag = scope === 'installed' ? current.installed !== false : current.installed === true

      var body = []
      if (loading && detail === null) {
        body.push(el('p', { className: 'eh-hint' }, t('detail.loading')))
      } else if (error !== '' && detail === null) {
        body.push(el('div', { className: 'eh-notice', 'data-kind': 'error', role: 'alert' },
          t('detail.loadFailed') + '：' + error + ' ',
          el('button', {
            className: 'eh-btn eh-btn-sm', type: 'button',
            onClick: load
          }, t('page.retry'))))
      } else {
        body.push(el('div', { className: 'eh-detail-top' },
          el(AvatarFace, { card: current, className: 'eh-detail-face', glyphClassName: 'eh-detail-face' }),
          el('div', { className: 'eh-detail-titles' },
            el('div', { className: 'eh-card-name-row' },
              el('span', { className: 'eh-detail-name' }, nameOf(current)),
              current.updatable === true
                ? el('span', { className: 'eh-badge', 'data-kind': 'update' }, '↑ ', t('installed.updatable'))
                : null,
              current.broken !== undefined && strOf(current.broken) !== ''
                ? el('span', { className: 'eh-badge', 'data-kind': 'warn' }, '⚠ ', t('installed.broken'))
                : null),
            professionOf(current) !== '' ? el('span', { className: 'eh-detail-prof' }, professionOf(current)) : null,
            el('span', { className: 'eh-detail-id' }, strOf(current.id)))))

        body.push(el('div', { className: 'eh-detail-meta' },
          sourceLabel !== '' ? el('span', { className: 'eh-badge' }, t('detail.meta', { label: sourceLabel })) : null,
          categoryLabel !== '' ? el('span', { className: 'eh-badge' }, t('detail.category', { label: categoryLabel })) : null,
          skills.length > 0
            ? el('span', { className: 'eh-badge' }, t('installed.skills', { n: skills.length }))
            : null))

        body.push(el('p', { className: 'eh-detail-desc' }, description !== '' ? description : t('detail.noDescription')))

        if (tags.length > 0) {
          var tagNodes = []
          for (var ti = 0; ti < tags.length; ti++) {
            tagNodes.push(el('span', { className: 'eh-tag', key: 'tag:' + ti }, tags[ti]))
          }
          body.push(el('div', { className: 'eh-tags' }, tagNodes))
        }

        if (quickPrompts.length > 0) {
          var quickNodes = []
          for (var qi = 0; qi < quickPrompts.length; qi++) {
            quickNodes.push(el('span', { className: 'eh-quick-item', key: 'q:' + qi }, quickPrompts[qi]))
          }
          body.push(el('div', { className: 'eh-section' },
            el('div', { className: 'eh-section-head' },
              el('span', null, t('detail.quickPrompts')),
              el('span', { className: 'eh-section-count' }, String(quickPrompts.length))),
            el('div', { className: 'eh-section-pad' },
              el('div', { className: 'eh-quick' }, quickNodes))))
        }

        var skillItems = []
        for (var si = 0; si < skills.length; si++) {
          skillItems.push(skillRow(skills[si], si))
        }
        body.push(el('div', { className: 'eh-section' },
          el('div', { className: 'eh-section-head' },
            el('span', null, t('detail.skills') + '（' + skills.length + '）'),
            el('span', { className: 'eh-section-count' },
              skills.length > 0 ? t('installed.skills', { n: skills.length }) : '')),
          skills.length === 0
            ? el('div', { className: 'eh-section-pad' },
                el('p', { className: 'eh-hint' }, t('detail.noSkills')))
            : el('div', null, skillItems)))

        body.push(el('div', { className: 'eh-section' },
          el('div', { className: 'eh-section-head' },
            el('span', null, t('detail.role')),
            el('span', { className: 'eh-section-count' }, t('detail.roleChars', { n: roleChars }))),
          roleText !== ''
            ? el('pre', { className: 'eh-role-text' }, roleText)
            : el('div', { className: 'eh-section-pad' },
                el('p', { className: 'eh-hint' }, t('detail.noRole')))))

        if (installedFlag && sessionId === '') {
          body.push(el('p', { className: 'eh-hint' }, t('detail.noSession')))
        }
        if (scope === 'workbuddy' && !installedFlag) {
          body.push(el('p', { className: 'eh-hint' }, t('detail.notInstalled')))
        }
      }

      function skillRow (skill, index) {
        var name = strOf(skill.name) || 'skill-' + (index + 1)
        var open = openSkill === name
        var content = typeof skill.content === 'string' ? skill.content : ''
        var chars = typeof skill.chars === 'number' ? skill.chars : content.length
        return el('div', { className: 'eh-skill', key: name },
          el('button', {
            className: 'eh-skill-head', type: 'button',
            'aria-expanded': open ? 'true' : 'false',
            onClick: function () { setOpenSkill(open ? '' : name) }
          },
            el('span', { className: 'eh-skill-name', title: name }, name),
            el('span', { className: 'eh-skill-meta' },
              strOf(skill.description) !== '' ? strOf(skill.description) : '',
              el('span', null, t('detail.skillChars', { n: chars })),
              el('span', { 'aria-hidden': 'true' }, open ? '▾' : '▸'))),
          open
            ? el('pre', { className: 'eh-skill-body' }, content !== '' ? content : t('detail.loading'))
            : null)
      }

      var footer = []
      footer.push(el('button', {
        key: 'close', className: 'eh-btn', type: 'button',
        onClick: props.onClose
      }, t('page.close')))
      if (scope === 'installed') {
        footer.push(el('button', {
          key: 'edit', className: 'eh-btn', type: 'button',
          disabled: laneBusy,
          onClick: function () { props.onEdit(current) }
        }, t('page.edit')))
      } else if (!installedFlag) {
        footer.push(el('button', {
          key: 'import', className: 'eh-btn', type: 'button',
          'data-variant': 'primary',
          disabled: laneBusy || isBroken(current),
          onClick: function () { props.onImport(current) }
        }, t('page.import')))
      }
      if (installedFlag) {
        footer.push(el('button', {
          key: 'use', className: 'eh-btn', type: 'button',
          'data-variant': 'primary',
          disabled: laneBusy || sessionId === '',
          title: sessionId === '' ? t('detail.noSession') : undefined,
          onClick: function () { props.onUse(current) }
        }, t('detail.use')))
      }

      return el(Overlay, {
        t: t,
        kind: 'drawer',
        title: t('detail.title'),
        onClose: props.onClose,
        footer: footer
      }, body)
    }

    // ── 编辑对话框 ─────────────────────────────────────────────────────────

    function EditDialog (props) {
      var t = props.t
      var card = props.card !== null && props.card !== undefined ? props.card : {}
      var cardId = strOf(card.id)

      var phaseState = React.useState('loading')
      var phase = phaseState[0]
      var setPhase = phaseState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var valuesState = React.useState(null)
      var values = valuesState[0]
      var setValues = valuesState[1]
      var avatarState = React.useState('')
      var avatarDataUrl = avatarState[0]
      var setAvatarDataUrl = avatarState[1]
      var avatarErrorState = React.useState('')
      var avatarError = avatarErrorState[0]
      var setAvatarError = avatarErrorState[1]
      var formErrorState = React.useState('')
      var formError = formErrorState[0]
      var setFormError = formErrorState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]

      function load () {
        setPhase('loading')
        setError('')
        api(detailUrl(cardId, 'installed')).then(function (payload) {
          var actual = payload !== null && payload.card !== null && typeof payload.card === 'object'
            ? payload.card
            : card
          setValues({
            displayName: nameOf(actual),
            id: strOf(actual.id),
            profession: strOf(actual.profession),
            description: strOf(actual.description),
            tags: listOfStrings(actual.tags).join(', '),
            quickPrompts: listOfStrings(actual.quickPrompts).join('\n'),
            roleText: payload !== null && typeof payload.roleText === 'string' ? payload.roleText : ''
          })
          setPhase('ready')
          return payload
        }, function (err) {
          setError(errorOf(err))
          setPhase('error')
          return null
        })
      }

      React.useEffect(function () { load() }, [cardId])

      function onChange (field, value) {
        setValues(function (previous) {
          if (previous === null) return previous
          var next = Object.assign({}, previous)
          next[field] = value
          return next
        })
        if (formError !== '') setFormError('')
      }

      function onAvatarFile (event) {
        var input = event !== null && event !== undefined ? event.target : null
        var file = input !== null && input !== undefined && input.files ? input.files[0] : null
        readAvatarFile(file, t, function (dataUrl, message) {
          if (message !== '') {
            setAvatarError(message)
          } else {
            setAvatarError('')
            setAvatarDataUrl(dataUrl)
          }
          if (input !== null && input !== undefined) input.value = ''
        })
      }

      function submit () {
        if (saving || values === null) return
        setFormError('')
        var displayName = strOf(values.displayName)
        var description = strOf(values.description)
        if (displayName === '') {
          setFormError(t('create.requiredName'))
          return
        }
        if (description === '') {
          setFormError(t('create.requiredDescription'))
          return
        }
        var payload = {
          displayName: displayName,
          profession: strOf(values.profession),
          description: description,
          tags: parseTags(values.tags),
          quickPrompts: parseLines(values.quickPrompts, 6)
        }
        var roleText = values.roleText
        if (strOf(roleText) !== '') payload.roleText = roleText
        if (avatarDataUrl !== '') payload.avatarDataUrl = avatarDataUrl
        setSaving(true)
        props.onSave(card, payload).then(function () {
          setSaving(false)
        }, function () {
          setSaving(false)
        })
      }

      if (phase === 'loading') {
        return el(Overlay, { t: t, title: t('edit.title'), onClose: props.onClose },
          el('p', { className: 'eh-hint' }, t('detail.loading')))
      }
      if (phase === 'error') {
        return el(Overlay, { t: t, title: t('edit.title'), onClose: props.onClose },
          el('div', { className: 'eh-notice', 'data-kind': 'error', role: 'alert' },
            t('edit.loadFailed') + '：' + error + ' ',
            el('button', { className: 'eh-btn eh-btn-sm', type: 'button', onClick: load }, t('page.retry'))))
      }

      var previewUrl = avatarDataUrl !== '' ? avatarDataUrl : strOf(card.avatarUrl)
      return el(Overlay, {
        t: t,
        title: t('edit.title'),
        onClose: props.onClose,
        footer: [
          el('button', {
            key: 'cancel', className: 'eh-btn', type: 'button',
            disabled: saving,
            onClick: props.onClose
          }, t('page.cancel')),
          el('button', {
            key: 'save', className: 'eh-btn', type: 'button',
            'data-variant': 'primary',
            disabled: saving || props.laneBusy === true,
            onClick: submit
          }, saving ? t('edit.saving') : t('edit.save'))
        ]
      },
        el('p', { className: 'eh-hint' }, t('edit.subtitle')),
        el(ExpertFormFields, {
          t: t,
          idPrefix: 'eh-edit',
          values: values,
          showId: false,
          onChange: onChange,
          avatarUrl: previewUrl,
          avatarError: avatarError,
          roleHint: t('edit.roleHint'),
          avatarHint: t('edit.avatarKeep'),
          onAvatarFile: onAvatarFile
        }),
        formError !== '' ? el('p', { className: 'eh-form-error', role: 'alert' }, formError) : null)
    }

    // ── 新建表单 ───────────────────────────────────────────────────────────

    function emptyFormValues () {
      return {
        displayName: '',
        id: '',
        profession: '',
        description: '',
        tags: '',
        quickPrompts: '',
        roleText: ''
      }
    }

    function CreateForm (props) {
      var t = props.t
      var valuesState = React.useState(emptyFormValues)
      var values = valuesState[0]
      var setValues = valuesState[1]
      var idTouchedRef = React.useRef(false)
      var submittingState = React.useState(false)
      var submitting = submittingState[0]
      var setSubmitting = submittingState[1]
      var formErrorState = React.useState('')
      var formError = formErrorState[0]
      var setFormError = formErrorState[1]
      var avatarState = React.useState('')
      var avatarDataUrl = avatarState[0]
      var setAvatarDataUrl = avatarState[1]
      var avatarErrorState = React.useState('')
      var avatarError = avatarErrorState[0]
      var setAvatarError = avatarErrorState[1]

      function onChange (field, value) {
        setValues(function (previous) {
          var next = Object.assign({}, previous)
          next[field] = value
          if (field === 'displayName' && !idTouchedRef.current) {
            next.id = slugifyInput(value)
          }
          return next
        })
        if (formError !== '') setFormError('')
      }

      function onIdChange (value) {
        idTouchedRef.current = strOf(value) !== ''
        onChange('id', value)
      }

      function onAvatarFile (event) {
        var input = event !== null && event !== undefined ? event.target : null
        var file = input !== null && input !== undefined && input.files ? input.files[0] : null
        readAvatarFile(file, t, function (dataUrl, message) {
          if (message !== '') {
            setAvatarError(message)
          } else {
            setAvatarError('')
            setAvatarDataUrl(dataUrl)
          }
          if (input !== null && input !== undefined) input.value = ''
        })
      }

      function submit () {
        if (submitting) return
        setFormError('')
        var displayName = strOf(values.displayName)
        var description = strOf(values.description)
        var roleText = values.roleText
        if (displayName === '') {
          setFormError(t('create.requiredName'))
          return
        }
        if (description === '') {
          setFormError(t('create.requiredDescription'))
          return
        }
        if (strOf(roleText) === '') {
          setFormError(t('create.requiredRole'))
          return
        }
        // id 总是显式发送：用户没改过时就是表单里显示的自动 id（与 host
        // 的 slugify 同算法），host 按显式 id 处理并在冲突时追加 -2/-3。
        var id = strOf(values.id)
        if (id === '') id = slugifyInput(displayName)
        if (!ID_RE.test(id)) {
          setFormError(t('create.idInvalid'))
          return
        }
        var expert = {
          id: id,
          displayName: displayName,
          profession: strOf(values.profession),
          description: description,
          tags: parseTags(values.tags),
          quickPrompts: parseLines(values.quickPrompts, 6),
          roleText: roleText
        }
        var input = { expert: expert }
        if (avatarDataUrl !== '') input.avatarDataUrl = avatarDataUrl
        setSubmitting(true)
        props.onCreate(input).then(function (accepted) {
          setSubmitting(false)
          if (accepted === true) {
            idTouchedRef.current = false
            setValues(emptyFormValues())
            setAvatarDataUrl('')
            setAvatarError('')
          }
        }, function () {
          setSubmitting(false)
        })
      }

      return el('div', { className: 'eh-panel-card' },
        el('h3', { className: 'eh-card-title' }, t('create.title')),
        el('p', { className: 'eh-hint' }, t('create.subtitle')),
        el(ExpertFormFields, {
          t: t,
          idPrefix: 'eh-create',
          values: values,
          showId: true,
          onChange: onChange,
          onIdChange: onIdChange,
          avatarUrl: avatarDataUrl,
          avatarError: avatarError,
          roleHint: t('create.roleHint'),
          avatarHint: t('create.avatarHint'),
          onAvatarFile: onAvatarFile,
          onAvatarClear: function () {
            setAvatarDataUrl('')
            setAvatarError('')
          }
        }),
        formError !== '' ? el('p', { className: 'eh-form-error', role: 'alert' }, formError) : null,
        el('div', { className: 'eh-form-actions' },
          el('button', {
            className: 'eh-btn', type: 'button',
            'data-variant': 'primary',
            disabled: submitting || props.laneBusy === true,
            onClick: submit
          }, submitting ? t('create.submitting') : t('create.submit'))))
    }

    /** 新建与编辑共用的字段组（受控）。 */
    function ExpertFormFields (props) {
      var t = props.t
      var values = props.values !== null && props.values !== undefined ? props.values : emptyFormValues()
      var prefix = props.idPrefix || 'eh-form'
      var avatarUrl = props.avatarUrl !== undefined && props.avatarUrl !== null ? props.avatarUrl : ''

      function textField (key, label, placeholder, hint) {
        return el('div', { className: 'eh-field', key: key },
          el('label', { className: 'eh-label', htmlFor: prefix + '-' + key }, label),
          el('input', {
            id: prefix + '-' + key,
            className: 'eh-input',
            type: 'text',
            value: values[key] !== undefined && values[key] !== null ? values[key] : '',
            placeholder: placeholder,
            onChange: function (event) {
              if (key === 'id' && typeof props.onIdChange === 'function') props.onIdChange(event.target.value)
              else props.onChange(key, event.target.value)
            }
          }),
          hint !== '' ? el('p', { className: 'eh-hint' }, hint) : null)
      }

      function areaField (key, label, placeholder, hint, rows, extraClass) {
        return el('div', { className: 'eh-field', key: key },
          el('label', { className: 'eh-label', htmlFor: prefix + '-' + key }, label),
          el('textarea', {
            id: prefix + '-' + key,
            className: 'eh-textarea' + (extraClass !== undefined ? ' ' + extraClass : ''),
            rows: rows,
            value: values[key] !== undefined && values[key] !== null ? values[key] : '',
            placeholder: placeholder,
            onChange: function (event) { props.onChange(key, event.target.value) }
          }),
          hint !== '' ? el('p', { className: 'eh-hint' }, hint) : null)
      }

      return el('div', { className: 'eh-form' },
        el('div', { className: 'eh-form-row' },
          textField('displayName', t('create.displayName'), t('create.displayNamePlaceholder'), ''),
          textField('profession', t('create.profession'), t('create.professionPlaceholder'), '')),
        props.showId === true
          ? textField('id', t('create.id'), '', t('create.idHint'))
          : null,
        areaField('description', t('create.description'), t('create.descriptionPlaceholder'), '', 2),
        el('div', { className: 'eh-form-row' },
          textField('tags', t('create.tags'), t('create.tagsPlaceholder'), t('create.tagsHint')),
          areaField('quickPrompts', t('create.quickPrompts'), t('create.quickPromptsPlaceholder'),
            t('create.quickPromptsHint'), 2)),
        areaField('roleText', t('create.role'), t('create.rolePlaceholder'),
          props.roleHint !== undefined ? props.roleHint : t('create.roleHint'), 8, 'eh-role-input'),
        el('div', { className: 'eh-field' },
          el('span', { className: 'eh-label' }, t('create.avatar')),
          el('div', { className: 'eh-avatar-row' },
            avatarUrl !== ''
              ? el('img', { className: 'eh-avatar-preview', src: avatarUrl, alt: '' })
              : el('span', { className: 'eh-avatar-preview', 'aria-hidden': 'true' }, firstGlyph(values.displayName)),
            el('div', { className: 'eh-avatar-actions' },
              el('input', {
                className: 'eh-file',
                type: 'file',
                accept: 'image/png,image/jpeg,image/webp',
                'aria-label': t('create.avatarPick'),
                onChange: props.onAvatarFile
              }),
              props.onAvatarClear !== undefined && avatarUrl !== ''
                ? el('button', {
                    className: 'eh-btn eh-btn-sm', type: 'button',
                    onClick: props.onAvatarClear
                  }, t('create.avatarClear'))
                : null)),
          el('p', { className: 'eh-hint' },
            props.avatarHint !== undefined ? props.avatarHint : t('create.avatarHint')),
          props.avatarError !== undefined && props.avatarError !== ''
            ? el('p', { className: 'eh-form-error' }, props.avatarError)
            : null))
    }

    // ── 导入盒（URL / 本地路径）───────────────────────────────────────────

    function ImportBox (props) {
      var t = props.t
      var kind = props.kind === 'path' ? 'path' : 'url'
      var valueState = React.useState('')
      var value = valueState[0]
      var setValue = valueState[1]
      var localErrorState = React.useState('')
      var localError = localErrorState[0]
      var setLocalError = localErrorState[1]
      var resultState = React.useState(null)
      var result = resultState[0]
      var setResult = resultState[1]
      var busyKey = props.busyKey !== undefined ? props.busyKey : ''
      var myKey = kind === 'url' ? 'import-web' : 'import-path'
      var working = busyKey === myKey

      function submit () {
        if (working) return
        var trimmed = strOf(value)
        setLocalError('')
        if (trimmed === '') {
          setLocalError(t(kind === 'url' ? 'import.invalidUrl' : 'import.emptyPath'))
          return
        }
        if (kind === 'url' && !/^https?:\/\//i.test(trimmed)) {
          setLocalError(t('import.invalidUrl'))
          return
        }
        setResult(null)
        props.onImport(kind, trimmed).then(function (value) {
          if (value !== null && value !== undefined) setResult(value)
        })
      }

      var resultView = null
      if (result !== null) {
        var imported = arrOf(result.imported)
        var warnings = arrOf(result.warnings)
        var importedNodes = []
        for (var i = 0; i < imported.length; i++) {
          var item = imported[i]
          var id = strOf(item && item.id)
          var dir = strOf(item && item.dir)
          importedNodes.push(el('li', { key: 'i:' + i },
            dir !== '' ? id + ' → ' + dir : id))
        }
        var warningNodes = []
        for (var j = 0; j < warnings.length; j++) {
          warningNodes.push(el('li', { key: 'w:' + j }, String(warnings[j])))
        }
        resultView = el('div', { className: 'eh-import-result' },
          el('p', { className: 'eh-result-title' }, t('import.result')),
          el('p', { className: 'eh-result-title' }, t('import.resultNew', { n: imported.length })),
          importedNodes.length > 0 ? el('ul', { className: 'eh-result-list' }, importedNodes) : null,
          importedNodes.length === 0 && warningNodes.length === 0
            ? el('span', { className: 'eh-hint' }, t('import.none'))
            : null,
          warningNodes.length > 0
            ? el('div', { className: 'eh-result-warns' },
                el('p', { className: 'eh-hint' }, t('import.warnings', { n: warnings.length })),
                el('ul', { className: 'eh-result-list' }, warningNodes))
            : null)
      }

      return el('div', { className: 'eh-panel-card' },
        el('h3', { className: 'eh-card-title' }, t('import.title')),
        el('p', { className: 'eh-hint' }, t('import.subtitle')),
        el('div', { className: 'eh-field' },
          el('label', { className: 'eh-label', htmlFor: 'eh-import-' + kind },
            t(kind === 'url' ? 'import.urlLabel' : 'import.pathLabel')),
          el('input', {
            id: 'eh-import-' + kind,
            className: 'eh-input',
            type: kind === 'url' ? 'url' : 'text',
            value: value,
            placeholder: t(kind === 'url' ? 'import.urlPlaceholder' : 'import.pathPlaceholder'),
            onChange: function (event) {
              setValue(event.target.value)
              if (localError !== '') setLocalError('')
            }
          })),
        localError !== '' ? el('p', { className: 'eh-form-error', role: 'alert' }, localError) : null,
        el('div', { className: 'eh-form-actions' },
          el('button', {
            className: 'eh-btn', type: 'button',
            'data-variant': kind === 'url' ? 'primary' : undefined,
            disabled: busyKey !== '',
            onClick: submit
          },
            working ? el('span', { className: 'eh-spin', 'aria-hidden': 'true' }) : null,
            working ? t('import.working') : t(kind === 'url' ? 'import.urlButton' : 'import.pathButton'))),
        resultView)
    }

    // ── 来源目录条（市场页）───────────────────────────────────────────────

    function SourceBar (props) {
      var t = props.t
      var config = props.config !== null && props.config !== undefined ? props.config : {}
      var path = strOf(config.sourcePath)
      var exists = config.sourceExists !== false
      return el('div', { className: 'eh-source' },
        el('span', { className: 'eh-source-label' }, t('market.sourceLabel')),
        el('span', {
          className: 'eh-source-state',
          'data-ok': exists ? 'true' : 'false',
          'aria-hidden': 'true'
        }, exists ? '●' : '▲'),
        el('code', { className: 'eh-source-path', title: path }, path !== '' ? path : '—'),
        el('button', {
          className: 'eh-btn eh-btn-sm', type: 'button',
          disabled: props.busy === true,
          'aria-busy': props.refreshing === true ? 'true' : undefined,
          onClick: props.onRefresh
        },
          props.refreshing === true ? el('span', { className: 'eh-spin', 'aria-hidden': 'true' }) : null,
          props.refreshing === true ? t('page.refreshing') : t('page.refresh')))
    }

    // ── 设置页（settings.section）─────────────────────────────────────────

    function ExpertCenterPage (props) {
      var t = props.t
      var bus = props.bus
      var sessionId = strOf(props.sessionId)

      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var tabState = React.useState('installed')
      var tab = tabState[0]
      var setTab = tabState[1]
      var queryState = React.useState('')
      var query = queryState[0]
      var setQuery = queryState[1]
      var categoryState = React.useState('all')
      var category = categoryState[0]
      var setCategory = categoryState[1]
      var sortState = React.useState('order')
      var sort = sortState[0]
      var setSort = sortState[1]
      var detailState = React.useState(null)
      var detail = detailState[0]
      var setDetail = detailState[1]
      var editState = React.useState(null)
      var edit = editState[0]
      var setEdit = editState[1]
      var confirmState = React.useState('')
      var confirmKey = confirmState[0]
      var setConfirmKey = confirmState[1]

      function pull () {
        return fetchState(sessionId).then(function (payload) {
          setData(payload)
          setError('')
          return payload
        }, function (err) {
          setError(errorOf(err))
          return undefined
        })
      }

      React.useEffect(function () { pull() }, [sessionId])

      React.useEffect(function () {
        if (bus === null || bus === undefined || typeof bus.subscribe !== 'function') return undefined
        return bus.subscribe(function () { pull() })
      }, [bus, sessionId])

      React.useEffect(function () {
        if (typeof document === 'undefined' || document === null) return undefined
        var onVisibility = function () { if (!document.hidden) pull() }
        document.addEventListener('visibilitychange', onVisibility)
        return function () { document.removeEventListener('visibilitychange', onVisibility) }
      }, [sessionId])

      React.useEffect(function () {
        if (notice === null || notice.kind !== 'ok') return undefined
        var timer = setTimeout(function () { setNotice(null) }, 5000)
        return function () { clearTimeout(timer) }
      }, [notice])

      React.useEffect(function () {
        if (confirmKey === '') return undefined
        var timer = setTimeout(function () { setConfirmKey('') }, 4000)
        return function () { clearTimeout(timer) }
      }, [confirmKey])

      var config = data !== null && data.config !== null && typeof data.config === 'object' ? data.config : {}
      var installed = cardsOf(data, 'installed')
      var available = cardsOf(data, 'available')
      var warnings = data !== null && Array.isArray(data.warnings) ? data.warnings : []
      var counts = data !== null && data.counts !== null && typeof data.counts === 'object' ? data.counts : {}
      var loading = data === null && error === ''
      var laneBusy = busy !== ''

      var installedCategories = categoriesOf(installed, t)
      var marketCategories = categoriesOf(available, t)
      var filteredInstalled = filterCards(installed, query, category, sort)
      var filteredAvailable = filterCards(available, query, category, sort)

      var importable = []
      var updatableCards = []
      for (var ai = 0; ai < available.length; ai++) {
        var candidate = available[ai]
        if (isBroken(candidate)) continue
        if (candidate.installed !== true) importable.push(candidate)
        if (candidate.updatable === true) updatableCards.push(candidate)
      }

      var headInstalled = typeof counts.installed === 'number' ? counts.installed : installed.length
      var headAvailable = typeof counts.available === 'number' ? counts.available : available.length
      var headUpdatable = typeof counts.updatable === 'number' ? counts.updatable : updatableCards.length
      var filterActive = strOf(query) !== '' || category !== 'all'

      function switchTab (id) {
        setTab(id)
        setQuery('')
        setCategory('all')
        setNotice(null)
      }

      function clearFilters () {
        setQuery('')
        setCategory('all')
      }

      function failNotice (key, err) {
        setNotice({ kind: 'error', text: t(key, { message: errorOf(err) }) })
      }

      function refresh () {
        if (laneBusy) return
        setBusy('refresh')
        setNotice(null)
        postJson(API_BASE + '/refresh', {}).then(function () {
          setNotice({ kind: 'ok', text: t('market.refreshed') })
          return pull()
        }, function (err) {
          failNotice('installed.actionFailed', err)
        }).then(function () { setBusy('') })
      }

      function importOne (card, isUpdate) {
        if (laneBusy || isBroken(card)) return
        var id = strOf(card.id)
        if (id === '') return
        setBusy('import:' + id)
        setNotice(null)
        postJson(API_BASE + '/import', { ids: [id] }).then(function (result) {
          var failed = arrOf(result !== null && result !== undefined ? result.failed : null)
          if (failed.length > 0) {
            var reason = strOf(failed[0] !== null && failed[0] !== undefined ? failed[0].error : '')
            failNotice('market.importFailed', new Error(reason !== '' ? reason : 'failed'))
          } else {
            setNotice({
              kind: 'ok',
              text: t(isUpdate ? 'installed.updateOneDone' : 'installed.importOneDone', { name: nameOf(card) })
            })
          }
          return pull()
        }, function (err) {
          failNotice('market.importFailed', err)
        }).then(function () { setBusy('') })
      }

      function importMany (cards, isUpdate) {
        if (laneBusy) return
        var ids = []
        for (var i = 0; i < cards.length; i++) {
          var id = strOf(cards[i].id)
          if (id !== '') ids.push(id)
        }
        if (ids.length === 0) return
        setBusy(isUpdate ? 'update-all' : 'import-all')
        setNotice(null)
        postJson(API_BASE + '/import', { ids: ids }).then(function (result) {
          var imported = arrOf(result !== null && result !== undefined ? result.imported : null)
          var failed = arrOf(result !== null && result !== undefined ? result.failed : null)
          if (failed.length > 0) {
            var detailText = []
            for (var fi = 0; fi < failed.length && fi < 3; fi++) {
              var entry = failed[fi]
              detailText.push(strOf(entry !== null && entry !== undefined ? entry.id : '') + '：' +
                strOf(entry !== null && entry !== undefined ? entry.error : ''))
            }
            setNotice({
              kind: 'error',
              text: t('market.partialFailed', { done: imported.length, failed: failed.length }) +
                (detailText.length > 0 ? '（' + detailText.join('；') + '）' : '')
            })
          } else {
            setNotice({
              kind: 'ok',
              text: t(isUpdate ? 'market.updateDone' : 'market.importDone', { n: imported.length })
            })
          }
          return pull()
        }, function (err) {
          failNotice('market.importFailed', err)
        }).then(function () { setBusy('') })
      }

      function deleteCard (card) {
        if (laneBusy) return
        var id = strOf(card.id)
        if (id === '') return
        setConfirmKey('')
        setBusy('delete:' + id)
        setNotice(null)
        postJson(API_BASE + '/delete', { id: id }).then(function () {
          setNotice({ kind: 'ok', text: t('installed.deleteDone', { name: nameOf(card) }) })
          if (detail !== null && detail.card !== null && detail.card !== undefined &&
            strOf(detail.card.id) === id) setDetail(null)
          return pull()
        }, function (err) {
          failNotice('installed.actionFailed', err)
        }).then(function () { setBusy('') })
      }

      function useInSession (card) {
        if (sessionId === '') {
          setNotice({ kind: 'error', text: t('detail.noSession') })
          return
        }
        if (laneBusy) return
        setBusy('switch')
        setNotice(null)
        postJson(API_BASE + '/switch', { sessionId: sessionId, expertId: strOf(card.id) }).then(function () {
          setNotice({ kind: 'ok', text: t('detail.useDone', { name: nameOf(card) }) })
          return pull()
        }, function (err) {
          failNotice('detail.useFailed', err)
        }).then(function () { setBusy('') })
      }

      function createExpert (input) {
        setNotice(null)
        return postJson(API_BASE + '/create', input).then(function (result) {
          var card = result !== null && result !== undefined ? result.expert : null
          setNotice({ kind: 'ok', text: t('create.done', { name: nameOf(card) }) })
          return pull().then(function () { return true })
        }, function (err) {
          failNotice('create.failed', err)
          return false
        })
      }

      function saveEdit (card, payload) {
        setNotice(null)
        return postJson(API_BASE + '/update', {
          id: strOf(card.id),
          patch: {
            displayName: payload.displayName,
            profession: payload.profession,
            description: payload.description,
            tags: payload.tags,
            quickPrompts: payload.quickPrompts
          },
          roleText: payload.roleText,
          avatarDataUrl: payload.avatarDataUrl
        }).then(function () {
          setNotice({ kind: 'ok', text: t('edit.done', { name: payload.displayName }) })
          setEdit(null)
          return pull().then(function () { return true })
        }, function (err) {
          failNotice('edit.failed', err)
          return false
        })
      }

      function importExternal (kind, value) {
        if (laneBusy) return Promise.resolve(null)
        setBusy(kind === 'url' ? 'import-web' : 'import-path')
        setNotice(null)
        var route = kind === 'url' ? '/import-web' : '/import-path'
        var body = kind === 'url' ? { url: value } : { path: value }
        return postJson(API_BASE + route, body).then(function (result) {
          var imported = arrOf(result !== null && result !== undefined ? result.imported : null)
          var resultWarnings = arrOf(result !== null && result !== undefined ? result.warnings : null)
          setNotice({ kind: 'ok', text: t('import.done', { n: imported.length }) })
          pull()
          return { imported: imported, warnings: resultWarnings }
        }, function (err) {
          failNotice('import.failed', err)
          return null
        }).then(function (value2) {
          setBusy('')
          return value2
        })
      }

      function onCardAction (card, action, mode) {
        var key = mode + ':' + strOf(card.id)
        if (action === 'detail') {
          setDetail({ scope: mode === 'market' ? 'workbuddy' : 'installed', card: card })
          return
        }
        if (action === 'edit') {
          setDetail(null)
          setEdit({ card: card })
          return
        }
        if (action === 'delete') {
          setConfirmKey(key)
          return
        }
        if (action === 'cancel-delete') {
          setConfirmKey('')
          return
        }
        if (action === 'confirm-delete') {
          setConfirmKey('')
          deleteCard(card)
          return
        }
        if (action === 'import') {
          importOne(card, false)
          return
        }
        if (action === 'update') {
          importOne(card, true)
        }
      }

      function cardView (card, mode) {
        var key = mode + ':' + strOf(card.id)
        return el(ExpertCardView, {
          key: key,
          t: t,
          card: card,
          mode: mode,
          laneBusy: laneBusy,
          confirmDelete: confirmKey === key,
          onAction: function (actualCard, action) { onCardAction(actualCard, action, mode) }
        })
      }

      function gridView (cards, mode, emptyTitle, emptyTip, emptyActionLabel, emptyAction, noMatchTitle, noMatchTip) {
        if (loading) {
          return el('div', null,
            el('p', { className: 'eh-sr-only', role: 'status' }, t('page.loading')),
            skeletonGrid())
        }
        if (cards.length === 0) {
          var source = mode === 'installed' ? installed : available
          if (source.length === 0 && !filterActive) {
            return el(EmptyState, {
              t: t,
              face: AVATAR_GLYPH,
              title: emptyTitle,
              tip: emptyTip,
              actionLabel: emptyActionLabel,
              onAction: emptyAction
            })
          }
          return el(EmptyState, {
            t: t,
            face: '⌕',
            title: noMatchTitle,
            tip: noMatchTip,
            actionLabel: t('installed.clearFilters'),
            onAction: clearFilters
          })
        }
        var items = []
        for (var i = 0; i < cards.length; i++) items.push(cardView(cards[i], mode))
        return el('ul', { className: 'eh-grid' }, items)
      }

      var installedPanel = el('section', {
        className: 'eh-panel',
        role: 'tabpanel',
        id: 'eh-panel-installed',
        'aria-labelledby': 'eh-tab-installed',
        hidden: tab !== 'installed' ? true : undefined
      },
        el(ExpertToolbar, {
          t: t,
          query: query,
          onQuery: setQuery,
          category: category,
          onCategory: setCategory,
          categories: installedCategories,
          sort: sort,
          onSort: setSort,
          showSort: true
        }),
        filterActive
          ? el('p', { className: 'eh-matchline', role: 'status' }, t('matches', { n: filteredInstalled.length }))
          : null,
        gridView(
          filteredInstalled, 'installed',
          t('installed.emptyTitle'), t('installed.emptyTip'), t('installed.emptyAction'),
          function () { switchTab('market') },
          t('installed.noMatchTitle'), t('installed.noMatchTip')))

      var marketPanel = el('section', {
        className: 'eh-panel',
        role: 'tabpanel',
        id: 'eh-panel-market',
        'aria-labelledby': 'eh-tab-market',
        hidden: tab !== 'market' ? true : undefined
      },
        el('div', { className: 'eh-panel-head' },
          el('div', { className: 'eh-head-main' },
            el('h3', { className: 'eh-section-title' }, t('market.title')),
            el('p', { className: 'eh-section-sub' }, t('market.subtitle'))),
          el('div', { className: 'eh-panel-head-side' },
            el('button', {
              className: 'eh-btn eh-btn-sm', type: 'button',
              disabled: laneBusy || importable.length === 0,
              onClick: function () { importMany(importable, false) }
            }, t('market.importAll', { n: importable.length })),
            el('button', {
              className: 'eh-btn eh-btn-sm', type: 'button',
              disabled: laneBusy || updatableCards.length === 0,
              onClick: function () { importMany(updatableCards, true) }
            }, t('market.updateAll', { n: updatableCards.length })),
            laneBusy ? el('span', { className: 'eh-bulk-hint' }, t('page.busy')) : null)),
        el(SourceBar, {
          t: t,
          config: config,
          busy: laneBusy,
          refreshing: busy === 'refresh',
          onRefresh: refresh
        }),
        config.sourceExists === false
          ? el('div', { className: 'eh-notice', 'data-kind': 'error', role: 'alert' },
              el('strong', null, t('market.sourceMissing') + '：'),
              t('market.sourceMissingHint'))
          : null,
        el(ExpertToolbar, {
          t: t,
          query: query,
          onQuery: setQuery,
          category: category,
          onCategory: setCategory,
          categories: marketCategories,
          sort: sort,
          onSort: setSort,
          showSort: true
        }),
        filterActive
          ? el('p', { className: 'eh-matchline', role: 'status' }, t('matches', { n: filteredAvailable.length }))
          : null,
        gridView(
          filteredAvailable, 'market',
          t('market.emptyTitle'), t('market.emptyTip'), t('page.refresh'),
          refresh,
          t('market.noMatchTitle'), t('market.noMatchTip')))

      var createPanel = el('section', {
        className: 'eh-panel',
        role: 'tabpanel',
        id: 'eh-panel-create',
        'aria-labelledby': 'eh-tab-create',
        hidden: tab !== 'create' ? true : undefined
      },
        el('div', { className: 'eh-create-layout' },
          el(CreateForm, {
            t: t,
            laneBusy: laneBusy,
            onCreate: createExpert
          }),
          el('div', { className: 'eh-create-side' },
            el(ImportBox, {
              t: t,
              kind: 'url',
              busyKey: busy,
              onImport: importExternal
            }),
            el(ImportBox, {
              t: t,
              kind: 'path',
              busyKey: busy,
              onImport: importExternal
            }))))

      var tabItems = []
      for (var ti = 0; ti < TABS.length; ti++) {
        var tabDef = TABS[ti]
        var activeTab = tab === tabDef.id
        var tabCount = tabDef.id === 'installed' ? headInstalled : (tabDef.id === 'market' ? headAvailable : -1)
        tabItems.push(el('button', {
          key: tabDef.id,
          type: 'button',
          role: 'tab',
          id: 'eh-tab-' + tabDef.id,
          'aria-selected': activeTab ? 'true' : 'false',
          'aria-controls': 'eh-panel-' + tabDef.id,
          className: 'eh-tab',
          'data-active': activeTab ? 'true' : undefined,
          onClick: (function (id) {
            return function () { switchTab(id) }
          })(tabDef.id)
        },
          el('span', null, t(tabDef.key)),
          tabCount >= 0 ? el('span', { className: 'eh-tab-count' }, String(tabCount)) : null))
      }

      // 三个面板都渲染（非活动的 hidden），切 Tab 不丢表单/导入结果状态。
      // 首次加载失败时只留错误提示 + 重试，不渲染空态误导。
      var dataFailed = data === null && error !== ''
      var panel = dataFailed
        ? null
        : el('div', { className: 'eh-panels' }, installedPanel, marketPanel, createPanel)

      return el('div', { className: 'eh-page' },
        el('header', { className: 'eh-head' },
          el('div', { className: 'eh-head-main' },
            el('h2', { className: 'eh-title' }, t('page.title')),
            el('p', { className: 'eh-subtitle' }, t('page.subtitle')),
            el('div', { className: 'eh-counts' },
              el('span', { className: 'eh-count' }, t('page.countInstalled', { n: headInstalled })),
              el('span', { className: 'eh-count' }, t('page.countAvailable', { n: headAvailable })),
              headUpdatable > 0
                ? el('span', { className: 'eh-count', 'data-kind': 'update' }, t('page.countUpdatable', { n: headUpdatable }))
                : null)),
          el('div', { className: 'eh-head-side' },
            el('button', {
              className: 'eh-btn', type: 'button',
              disabled: laneBusy,
              'aria-busy': busy === 'refresh' ? 'true' : undefined,
              onClick: refresh
            },
              busy === 'refresh'
                ? el('span', { className: 'eh-spin', 'aria-hidden': 'true' })
                : el('span', { 'aria-hidden': 'true' }, '⟳'),
              busy === 'refresh' ? t('page.refreshing') : t('page.refresh')))),
        el('div', { className: 'eh-tabs', role: 'tablist', 'aria-label': t('page.title') }, tabItems),
        el(WarningsBox, { t: t, warnings: warnings }),
        notice !== null
          ? el('div', { className: 'eh-notice', 'data-kind': notice.kind, role: 'status' }, notice.text)
          : null,
        error !== ''
          ? el('div', { className: 'eh-notice', 'data-kind': 'error', role: 'alert' },
              t('page.loadFailed') + '：' + error + ' ',
              el('button', {
                className: 'eh-btn eh-btn-sm', type: 'button',
                onClick: function () { setError(''); pull() }
              }, t('page.retry')))
          : null,
        panel,
        detail !== null
          ? el(DetailDrawer, {
              t: t,
              card: detail.card,
              scope: detail.scope,
              sessionId: sessionId,
              laneBusy: laneBusy,
              onClose: function () { setDetail(null) },
              onUse: useInSession,
              onEdit: function (card) { setDetail(null); setEdit({ card: card }) },
              onImport: function (card) {
                setDetail(null)
                importOne(card, card.updatable === true)
              }
            })
          : null,
        edit !== null
          ? el(EditDialog, {
              t: t,
              card: edit.card,
              laneBusy: laneBusy,
              onClose: function () { setEdit(null) },
              onSave: saveEdit
            })
          : null)
    }

    // ── 插件入口 ───────────────────────────────────────────────────────────

    function apply (ctx) {
      ctx = ctx || {}
      var locale = ctx.locale
      var t = fallbackT

      if (locale !== null && locale !== undefined &&
        typeof locale.register === 'function' && typeof locale.bind === 'function') {
        try {
          var bound = locale.bind(NS)
          if (typeof bound === 'function') {
            t = function (key, params) {
              var text = null
              try { text = bound(key, params) } catch (error) { text = null }
              if (typeof text !== 'string' || text === '' || text === key) {
                text = DICTS.zh[key] !== undefined ? DICTS.zh[key] : key
              }
              return interpolate(text, params)
            }
          }
        } catch (error) {
          t = fallbackT
        }
      }

      var bus = createStateBus()
      var slots = ctx.slots
      var styleTag = null
      var stopEvents = function () {}
      var closed = false

      function runEffect (fn) {
        if (typeof ctx.effect === 'function') return ctx.effect(fn)
        return fn()
      }

      if (slots === undefined || slots === null ||
        typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        if (ctx.logger !== null && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn(NS + ': slots service unavailable; expert hub not registered')
        }
        return function cleanupStyles () { removeStyle(styleTag) }
      }

      // 字典注册（locale 服务存在时）；apply 的清理交给 ctx.effect。
      runEffect(function () {
        if (locale === null || locale === undefined || typeof locale.register !== 'function') return undefined
        return locale.register(NS, DICTS)
      })

      // 设置 → 专家中心（全屏页面）。
      runEffect(function () {
        return slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'expert-hub',
            order: 44,
            label: function () { return t('page.label') },
            locale: NS
          }, function (props) {
            props = props || {}
            return el(ExpertCenterPage, {
              t: t,
              bus: bus,
              sessionId: sessionIdOf(props)
            })
          })
        })
      })

      // 会话输入框左侧的专家胶囊（自管 popover，不占用 overlay 座位）。
      runEffect(function () {
        return slots.inject('conversation.input.left', function () {
          return slots.register({
            name: 'conversation.input.left',
            id: 'expert-hub',
            order: 40,
            locale: NS
          }, function (props) {
            props = props || {}
            return el(ExpertCapsule, {
              t: t,
              bus: bus,
              sessionId: sessionIdOf(props)
            })
          })
        })
      })

      // 状态事件流：一个连接，两个座位共享；卸载时关闭（兜底在 cleanup 里）。
      stopEvents = startStateEvents(bus)
      runEffect(function () { return stopEvents })

      styleTag = ensureStyle()

      return function cleanup () {
        if (closed) return
        closed = true
        try { stopEvents() } catch (error) { /* ignore */ }
        removeStyle(styleTag)
        styleTag = null
      }
    }

    // 插件导出：name 必须等于包名；inject 为数组形式（客户端插件运行时）。
    module.exports = { name: NS, inject: ['slots', 'locale'], apply: apply }

    // loader 会忽略未知键；下面这些给离线自检 / 未来的 smoke 脚本使用。
    module.exports.DICTS = DICTS
    module.exports.CSS = CSS
    module.exports.ensureStyle = ensureStyle
    module.exports.removeStyle = removeStyle
    module.exports.stateUrl = stateUrl
    module.exports.detailUrl = detailUrl
    module.exports.sortCards = sortCards
    module.exports.filterCards = filterCards
    module.exports.categoriesOf = categoriesOf
    module.exports.sessionIdOf = sessionIdOf
    module.exports.nameOf = nameOf
    module.exports.slugifyInput = slugifyInput
    module.exports.parseTags = parseTags
    module.exports.parseLines = parseLines
    module.exports.ExpertCapsule = ExpertCapsule
    module.exports.ExpertCenterPage = ExpertCenterPage
    return module.exports
  }
})
