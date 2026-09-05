import { describe, expect, it } from 'vitest'
import { htmlToDigest, validatePanelHtml } from '../src/lib/uitemplate'
import { buildPanelRedrawMessages } from '../src/lib/ui-template-state'

describe('htmlToDigest（托管面板 → 纯文本摘要）', () => {
  it('剥 style/script 与标签，保留事实文本并并空白', () => {
    const html = '<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body><div>金库 <b>5000</b> 金币</div><script>var x=1;</script><p>新闻：码头开放</p></body></html>'
    const d = htmlToDigest(html)
    expect(d).toContain('金库 5000 金币')
    expect(d).toContain('新闻：码头开放')
    expect(d).not.toContain('<div')
    expect(d).not.toContain('color:red')
    expect(d).not.toContain('var x=1')
    expect(d).not.toMatch(/\s{2,}/)
  })

  it('解码常见 HTML 实体', () => {
    expect(htmlToDigest('<p>A &amp; B &lt;C&gt;</p>')).toBe('A & B <C>')
  })

  it('超长截断并加省略号', () => {
    const d = htmlToDigest('<p>' + '字'.repeat(5000) + '</p>', 100)
    expect(d.length).toBe(101)
    expect(d.endsWith('…')).toBe(true)
  })

  it('空输入返回空串', () => {
    expect(htmlToDigest('')).toBe('')
  })
})

describe('validatePanelHtml（重绘输出校验）', () => {
  const fullDoc = '<!DOCTYPE html><html><head><style>b{}</style></head><body><div>' + '内容'.repeat(200) + '</div></body></html>'
  const fragment = '<div class="panel">' + '内容'.repeat(200) + '</div>'

  it('接受完整文档与较大的容器片段', () => {
    expect(validatePanelHtml(fullDoc)).toBe(true)
    expect(validatePanelHtml(fragment)).toBe(true)
  })

  it('拒绝空/过短/纯文本输出', () => {
    expect(validatePanelHtml('')).toBe(false)
    expect(validatePanelHtml('<div>短</div>')).toBe(false)
    expect(validatePanelHtml('只是一段普通正文没有标签', false)).toBe(false)
  })

  it('截断保护：finish=length 且无闭合标签时拒绝', () => {
    const truncated = '<!DOCTYPE html><html><body><div>' + '内容'.repeat(150) + '<div>未闭合'
    expect(validatePanelHtml(truncated, false)).toBe(true)
    expect(validatePanelHtml(truncated, true)).toBe(false)
    // 正常完成但结尾有闭合标签的允许通过
    expect(validatePanelHtml(fullDoc, true)).toBe(true)
  })
})

describe('buildPanelRedrawMessages（副模型重绘消息组）', () => {
  it('空面板或空剧情返回空（不发无效请求）', () => {
    expect(buildPanelRedrawMessages('', [{ role: 'user', name: '', content: '剧情' }])).toEqual([])
    expect(buildPanelRedrawMessages('<!DOCTYPE html><html></html>', [])).toEqual([])
  })

  it('system 含硬性要求，user 携带上一版面板与剧情楼层', () => {
    const prev = '<!DOCTYPE html><html><body><div>面板v1</div></body></html>'
    const msgs = buildPanelRedrawMessages(prev, [
      { role: 'user', name: '我', content: '我捡了 100 金币' },
      { role: 'assistant', name: '艾拉', content: '艾拉点头致意' },
    ])
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('UI面板维护器')
    expect(msgs[0].content).toContain('<style> 样式与 <script> 脚本原样保留')
    expect(msgs[1].role).toBe('user')
    expect(msgs[1].content).toContain('面板v1')
    expect(msgs[1].content).toContain('我捡了 100 金币')
    expect(msgs[1].content).toContain('艾拉点头致意')
  })
})
