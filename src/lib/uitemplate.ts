/**
 * 角色卡自带 UI 模板：归一化 + 变量引擎 + 沙箱 iframe 渲染。
 * 行为对齐旧版 app.js 的 uiTemplate 体系（{{path}} 插值、{{#each}} 循环、
 * 自动高度 iframe），模板数据来自卡的 data.uiTemplates / extensions.legacy_ui_templates。
 */
import { uuid } from './id'

// ── 类型 ──

export interface UiTemplate {
  id: string
  name: string
  enabled: boolean
  order: number
  placement: 'top' | 'bottom'
  htmlTemplate: string
  initialVariableState: Record<string, unknown>
  /** 卡内静态运行时变量兜底；会话实时状态在 ChatSession.uiTemplateStates，渲染优先级：会话状态 > 此值 > initialVariableState */
  variableState?: Record<string, unknown>
  variableSchema?: unknown
  updateMode?: string
}

// ── 归一化 ──

const toBool = (v: unknown, dflt = true) =>
  typeof v === 'boolean' ? v : v === undefined || v === null ? dflt : String(v).toLowerCase() !== 'false'

const cloneJson = <T>(v: T): T => (v === undefined ? (undefined as unknown as T) : (JSON.parse(JSON.stringify(v)) as T))

/** 去掉模板外层的 ```html 代码围栏（AI/导出常见） */
export function stripCodeFence(value: unknown): string {
  const text = String(value ?? '').trim()
  const m = text.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\s*```$/)
  return (m ? m[1] : text).trim()
}

function inferInitialVariables(raw: Record<string, any>): Record<string, unknown> {
  if (raw.initialVariableState && typeof raw.initialVariableState === 'object') return cloneJson(raw.initialVariableState)
  for (const k of ['variableState', 'variables']) {
    if (raw[k] && typeof raw[k] === 'object') return cloneJson(raw[k])
  }
  return {}
}

/** 卡内原始模板条目 → 规范 UiTemplate（宽松兼容各种字段名） */
export function normalizeUiTemplate(raw: Record<string, any>): UiTemplate {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `tpl-${uuid().slice(0, 8)}`,
    name: String(raw.name || 'UI模板'),
    enabled: toBool(raw.enabled),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
    placement: raw.placement === 'top' ? 'top' : 'bottom',
    htmlTemplate: stripCodeFence(raw.htmlTemplate || raw.template || ''),
    initialVariableState: inferInitialVariables(raw),
    variableState: raw.variableState && typeof raw.variableState === 'object' ? cloneJson(raw.variableState) : undefined,
    variableSchema: raw.variableSchema,
    updateMode: typeof raw.updateMode === 'string' ? raw.updateMode : 'merge',
  }
}

export function normalizeUiTemplates(list: unknown): UiTemplate[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((t): t is Record<string, any> => !!t && typeof t === 'object')
    .map(normalizeUiTemplate)
    .filter((t) => t.htmlTemplate)
}

// ── 变量引擎（对齐旧版 getUiTemplateValue / renderUiTemplateString）──

interface EachContext {
  root: Record<string, unknown>
  current: unknown
  parentContext: EachContext | null
  index: number
  key: string | number
  length: number
  alias: string
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'

function splitPath(path: string): string[] {
  return String(path || '')
    .trim()
    .replace(/\[(?:'([^']+)'|"([^"]+)"|([^\]]+))\]/g, (_, s, d, b) => `.${s ?? d ?? String(b || '').trim()}`)
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
}

function readPath(source: unknown, path: string): unknown {
  const p = String(path || '').trim()
  if (!p || p === 'this' || p === '.') return source
  if (isObj(source) && Object.prototype.hasOwnProperty.call(source, p)) return source[p]
  return splitPath(p).reduce<any>(
    (acc, key) => (acc !== undefined && acc !== null && acc[key] !== undefined ? acc[key] : undefined),
    source,
  )
}

function getValue(variables: Record<string, unknown>, expr: string, ctx: EachContext | null): unknown {
  const e = String(expr || '').trim()
  if (!e) return undefined
  if (ctx) {
    if (e === 'this' || e === '.') return ctx.current
    if (e === '@index') return ctx.index
    if (e === '@number') return ctx.index + 1
    if (e === '@first') return ctx.index === 0
    if (e === '@last') return ctx.index === ctx.length - 1
    if (e === '@key') return ctx.key
    if (e === 'root') return ctx.root
    if (e.startsWith('root.')) return readPath(ctx.root, e.slice(5))
    if (e.startsWith('../')) {
      let parent = ctx.parentContext
      let path = e
      while (path.startsWith('../')) {
        path = path.slice(3)
        if (path.startsWith('../') && parent?.parentContext) parent = parent.parentContext
      }
      return getValue(ctx.root, path, null)
    }
    if (ctx.alias && (e === ctx.alias || e.startsWith(`${ctx.alias}.`))) {
      return e === ctx.alias ? ctx.current : readPath(ctx.current, e.slice(ctx.alias.length + 1))
    }
    const local = readPath(ctx.current, e)
    if (local !== undefined) return local
  }
  return readPath(variables, e)
}

function stringifyValue(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try { return JSON.stringify(v, null, 2) } catch { return String(v) }
  }
  return String(v)
}

const escapeValue = (v: unknown) =>
  stringifyValue(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function makeCtx(variables: Record<string, unknown>, overrides: Partial<EachContext>): EachContext {
  return {
    root: variables,
    current: variables,
    parentContext: null,
    index: 0,
    key: '',
    length: 1,
    alias: '',
    ...overrides,
  }
}

const EACH_RE = /\{\{\s*#each\s+([^\s}]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\}((?:(?!\{\{\s*#each\b)[\s\S])*?)\{\{\s*\/each\s*\}\}/g

function renderEachBlocks(text: string, variables: Record<string, unknown>, ctx: EachContext): string {
  let output = String(text || '')
  for (let pass = 0; pass < 50; pass++) {
    let replaced = false
    output = output.replace(EACH_RE, (_match, path: string, alias: string, body: string) => {
      replaced = true
      const value = getValue(variables, path, ctx)
      const [itemTpl, emptyTpl = ''] = String(body || '').split(/\{\{\s*else\s*\}\}/i)
      const entries = Array.isArray(value)
        ? value.map((item, index) => ({ item, key: index as string | number, index }))
        : isObj(value)
          ? Object.entries(value).map(([key, item], index) => ({ item, key, index }))
          : []
      if (!entries.length) return renderString(emptyTpl, variables, ctx)
      return entries
        .map(({ item, key, index }) =>
          renderString(itemTpl, variables, makeCtx(variables, {
            current: item,
            parentContext: ctx,
            index,
            key,
            length: entries.length,
            alias: alias || '',
          })))
        .join('')
    })
    if (!replaced) break
  }
  return output
}

function renderString(text: string, variables: Record<string, unknown>, ctx: EachContext | null): string {
  const active = ctx ?? makeCtx(variables, {})
  const withArrays = renderEachBlocks(String(text || ''), variables, active)
  return withArrays.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression: string) => {
    const key = expression.trim()
    if (!key || key === 'else' || key.startsWith('#') || key.startsWith('/')) return match
    return escapeValue(getValue(variables, key, active))
  })
}

/** 模板 → 填好变量的完整 HTML（用运行时变量，缺省为初始变量） */
export function renderUiTemplateHtml(template: UiTemplate, stateOverride?: Record<string, unknown>): string {
  const vars = stateOverride ?? template.variableState ?? template.initialVariableState ?? {}
  return renderString(stripCodeFence(template.htmlTemplate), vars, null)
}

// ── 沙箱 iframe 渲染（对齐旧版 buildExecutableHtmlDocument + createExecutableHtmlIframe）──

const IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-same-origin allow-downloads allow-pointer-lock allow-presentation allow-top-navigation-by-user-activation'

/** iframe 内嵌脚本：自报内容高度 + triggerSlash/data-slash 桥（对齐旧版 scriptShim） */
const HEIGHT_SHIM = `
<script>
(function () {
    var lastHeight = 0, updating = false;

    // ── 交互桥：卡片内脚本调用 window.triggerSlash(text) 把指令/消息送回宿主聊天 ──
    window.triggerSlash = function (text) {
        try { window.parent.postMessage({ type: 'rp-site-send-message', message: String(text) }, '*'); } catch (e) {}
    };

    function updateHeight() {
        if (!window.frameElement || updating) return;
        updating = true;
        requestAnimationFrame(function () {
            var body = document.body, html = document.documentElement;
            if (!body || !html) { updating = false; return; }
            var maxBottom = 0;
            for (var i = 0; i < body.children.length; i++) {
                var child = body.children[i];
                if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK') continue;
                var style = window.getComputedStyle(child);
                if (style.position === 'fixed') continue;
                var rect = child.getBoundingClientRect();
                maxBottom = Math.max(maxBottom, rect.bottom, child.offsetTop + child.offsetHeight);
            }
            var marginBottom = parseFloat(window.getComputedStyle(body).marginBottom) || 0;
            var h = Math.max(maxBottom + marginBottom, body.scrollHeight) + 4;
            if (h !== lastHeight) { lastHeight = h; window.frameElement.style.height = h + 'px'; }
            updating = false;
        });
    }
    window.addEventListener('load', function () {
        updateHeight();
        setTimeout(updateHeight, 200);
        setTimeout(updateHeight, 1000);
    });
    window.addEventListener('resize', updateHeight);
    window.addEventListener('click', function (event) {
        // data-slash 按钮：把指令送回宿主
        var slashTarget = event.target && event.target.closest && event.target.closest('[data-slash]');
        if (slashTarget) {
            event.preventDefault();
            var command = slashTarget.getAttribute('data-slash');
            if (command) window.triggerSlash(command);
        }
        var start = Date.now();
        (function tick() {
            if (Date.now() - start >= 600) return;
            updateHeight();
            requestAnimationFrame(tick);
        })();
    });
    window.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('img').forEach(function (img) { img.addEventListener('load', updateHeight); });
        updateHeight();
    });
    function setupObserver() {
        if (window.ResizeObserver && document.body) {
            new ResizeObserver(updateHeight).observe(document.body);
        } else {
            setInterval(updateHeight, 1000);
        }
    }
    if (document.body) setupObserver();
    else window.addEventListener('DOMContentLoaded', setupObserver);
    if (document.readyState === 'complete') updateHeight();
})();
<\/script>
`

const RESET_STYLE = `<style>
html,body{margin:0!important;padding:0!important;width:100%!important;height:auto!important;min-height:auto!important;word-wrap:break-word!important;box-sizing:border-box!important;overflow:hidden!important;}
::-webkit-scrollbar{display:none;}
*,*::before,*::after{box-sizing:inherit!important;}
img,video,canvas,svg{max-width:100%!important;height:auto!important;}
table{display:block!important;overflow-x:auto!important;max-width:100%!important;}
pre{white-space:pre-wrap!important;word-wrap:break-word!important;max-width:100%!important;}
.container,.reality-panel,.app-container{max-width:100%!important;width:100%!important;margin:0!important;border-radius:0!important;box-shadow:none!important;border:none!important;height:auto!important;min-height:0!important;}
body>div:first-child{margin:0!important;max-width:100%!important;height:auto!important;min-height:0!important;}
#app{height:auto!important;min-height:auto!important;}
.bottom-safe{display:none!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;}
</style>`

/** iframe sandbox 权限（对齐旧版 htmlIframeSandbox） */
export const HTML_IFRAME_SANDBOX = IFRAME_SANDBOX

/**
 * 整页 HTML → 纯文本摘要（托管面板发给主模型用）：
 * 剥 <style>/<script> 与全部标签、并空白，保留新闻/金额等事实文本，超长截断。
 */
export function htmlToDigest(html: string, cap = 2000): string {
  let text = String(html || '')
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|tr|h[1-6]|option|select)>/gi, ' ')
  text = text.replace(/<[^>]+>/g, ' ')
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > cap ? text.slice(0, cap) + '…' : text
}

/**
 * 校验副模型重绘输出的面板 HTML：接受完整文档或较大的容器片段；
 * 拒绝空输出/纯文本/明显残缺（截断保护，失败沿用上一版面板）。
 */
export function validatePanelHtml(raw: string, finishLength = false): boolean {
  const t = String(raw || '').trim()
  if (t.length < 200) return false
  const head = t.slice(0, 300).toLowerCase()
  const looksLikeHtml = head.startsWith('<!doctype') || head.startsWith('<html') || /^<(div|section|main|body)/.test(head)
  if (!looksLikeHtml) return false
  // 截断输出通常连闭合标签都缺失，且远短于正常面板；长度与标签配对都不满足即拒绝
  if (finishLength && !/<\/html>/i.test(t) && !/<\/(div|section|body)>/i.test(t.slice(-200))) return false
  return true
}

/** 裸 HTML 片段 / 完整文档 → iframe srcdoc 文档（带重置样式与高度自适配） */
export function buildHtmlDocument(rawHtml: string): string {
  const shim = HEIGHT_SHIM + RESET_STYLE
  const content = String(rawHtml || '')
  if (/^\s*(<!doctype|<html)/i.test(content.trim())) {
    if (/<head(\s[^>]*)?>/i.test(content)) {
      return content.replace(/<head(\s[^>]*)?>/i, (m) => m + RESET_STYLE + shim)
    }
    if (/<html(\s[^>]*)?>/i.test(content)) {
      return content.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${RESET_STYLE}${shim}</head>`)
    }
    return RESET_STYLE + shim + content
  }
  return `<!DOCTYPE html>\n<html>\n<head>${RESET_STYLE}${shim}</head>\n<body>\n${content}\n</body>\n</html>`
}

/**
 * 模板 → 可直接 v-html 的容器字符串（旧版 renderExecutableHtmlFrame 同构）：
 * 外层 div 包一个沙箱 iframe，iframe 内部脚本自动把自身高度撑到内容高。
 */
export function renderUiTemplateFrame(template: UiTemplate, stateOverride?: Record<string, unknown>): string {
  const html = renderUiTemplateHtml(template, stateOverride)
  if (!html) return ''
  const doc = buildHtmlDocument(html)
  const iframe =
    `<iframe class="ui-tpl-frame" sandbox="${IFRAME_SANDBOX}" scrolling="no" ` +
    `style="width:100%;display:block;border:none;margin:0;padding:0;background:#fff;height:60px;" ` +
    `srcdoc="${doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" loading="lazy"></iframe>`
  return `<div class="ui-tpl-block html-card-container" style="width:100%;overflow:hidden;border-radius:10px;">${iframe}</div>`
}
