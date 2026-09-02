import { describe, expect, it } from 'vitest'
import { chunkText, cleanTextForVector } from '../src/lib/memories'

describe('cleanTextForVector 入库清洗', () => {
  it('剥离思维链', () => {
    expect(cleanTextForVector('<think>隐藏推理</think>可见正文')).toBe('可见正文')
  })

  it('剥离 UI 变量更新块、代码块、行内代码与 HTML 标签', () => {
    const raw = [
      '正文一段',
      '<ui_template_updates>{"updates":[]}</ui_template_updates>',
      '```js\nconst a=1\n```',
      '行内 `code` 保留其余',
      '<div class="x">面板文本</div>',
    ].join('\n')
    const out = cleanTextForVector(raw)
    expect(out).not.toContain('ui_template_updates')
    expect(out).not.toContain('const a=1')
    expect(out).not.toContain('`code`')
    expect(out).not.toContain('<div')
    expect(out).toContain('正文一段')
    expect(out).toContain('面板文本')
    expect(out).toContain('行内')
  })
})

describe('chunkText 段落分片', () => {
  it('短段落合并到目标长度附近', () => {
    const chunks = chunkText(['短段一', '短段二', '短段三'].join('\n'))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('短段一')
    expect(chunks[0]).toContain('短段三')
  })

  it('超长段落按句拆分，单片不超过硬上限', () => {
    const sentence = '这是一个比较长的句子用来测试拆分逻辑是否能够正常工作。'
    const raw = sentence.repeat(30) // 远超 800
    const chunks = chunkText(raw)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800)
  })

  it('空文本返回空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })
})
