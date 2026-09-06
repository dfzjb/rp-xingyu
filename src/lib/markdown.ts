import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'

// 按需注册语言（全量语言包约 1MB，是构建产物的最大单一来源）；
// 未注册语言走 highlight 回调的 getLanguage 分支自动回退默认转义
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdownLang from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import lua from 'highlight.js/lib/languages/lua'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('markdown', markdownLang)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('lua', lua)

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        /* fallthrough */
      }
    }
    return '' // 使用默认转义
  },
})

// 图片只允许 data: 内联图（离线可用、不外泄 referer）
md.renderer.rules.image = (tokens, idx) => {
  const tok = tokens[idx]
  const src = tok.attrGet('src') || ''
  if (!src.startsWith('data:image/')) return ''
  const alt = tok.content ? ` alt="${md.utils.escapeHtml(tok.content)}"` : ''
  const title = tok.attrGet('title')
  const t = title ? ` title="${md.utils.escapeHtml(title)}"` : ''
  return `<img src="${src}"${alt}${t} loading="lazy" />`
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'code', 'pre', 'kbd', 'samp',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'img', 'span', 'div',
    'details', 'summary',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'alt', 'src', 'class', 'target', 'rel',
    'colspan', 'rowspan', 'align', 'loading',
  ],
  ALLOW_DATA_ATTR: false,
}

/** markdown → 安全 HTML（DOMPurify 消毒；链接强制新页打开） */
export function renderMarkdown(text: string): string {
  const raw = md.render(text || '')
  const clean = DOMPurify.sanitize(raw, PURIFY_CONFIG)
  return clean.replace(/<a\s+href=/g, '<a target="_blank" rel="noopener noreferrer" href=')
}

/** 整段 HTML 消息（非 markdown）安全渲染（不套 p 标签） */
export function renderHtml(text: string): string {
  return DOMPurify.sanitize(text || '', PURIFY_CONFIG)
}

/** 判定"整页 HTML"消息（用 sandbox iframe 渲染，不走 markdown）。先取头部再 trim，避免大消息全串复制 */
export function isFullHtmlMessage(content: string): boolean {
  const t = (content || '').slice(0, 200).trimStart().toLowerCase()
  return t.startsWith('<!doctype html') || t.startsWith('<html')
}
