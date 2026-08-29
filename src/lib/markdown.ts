import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'

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

/** 判定旧版式"整页 HTML"消息（用 sandbox iframe 渲染，不走 markdown） */
export function isFullHtmlMessage(content: string): boolean {
  const t = (content || '').trimStart().slice(0, 200).toLowerCase()
  return t.startsWith('<!doctype html') || t.startsWith('<html')
}
