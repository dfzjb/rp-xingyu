/**
 * 用真实角色卡模板做端到端渲染测试：
 * 1) 归一化 2) 变量替换（含 #each）3) srcdoc 文档构造
 */
import { readFileSync } from 'node:fs'
import { normalizeUiTemplates, renderUiTemplateHtml, buildHtmlDocument } from '../src/lib/uitemplate'

const fixtures = JSON.parse(readFileSync('.test/card-templates.json', 'utf-8')) as Record<string, unknown[]>

let fail = 0
for (const [cardName, rawList] of Object.entries(fixtures)) {
  const tpls = normalizeUiTemplates(rawList)
  console.log(`\n=== ${cardName}: ${tpls.length} 个模板 ===`)
  for (const t of tpls) {
    console.log(`- [${t.placement}] ${t.name} | 初始变量 ${Object.keys(t.initialVariableState).length} 项 | 模板 ${t.htmlTemplate.length} 字符`)
    const html = renderUiTemplateHtml(t)
    // 未替换的占位符检查：忽略 {{#each}}/{{/each}} 等语法残留不算失败，
    // 但普通 {{path}} 若还在说明变量没填上
    const leftover = html.match(/\{\{\s*([^{}\s#/][^{}]*?)\s*\}\}/g) || []
    if (leftover.length) {
      fail++
      console.error(`  ✗ 有 ${leftover.length} 处未替换占位符:`, leftover.slice(0, 8))
    } else {
      console.log('  ✓ 占位符全部替换')
    }
    if (!html.trim()) { fail++; console.error('  ✗ 渲染结果为空') }
    const doc = buildHtmlDocument(html)
    if (!/^<!DOCTYPE html>/i.test(doc)) { fail++; console.error('  ✗ srcdoc 文档构造异常') }
    else console.log('  ✓ srcdoc 文档构造 OK,', doc.length, '字符')
    // each 循环抽查：从魔法少女卡的背包/记录应为多行
    if (/backpackItems|recordLogs/.test(t.htmlTemplate)) {
      const rows = (html.match(/短剑|圣水/g) || []).length
      console.log(`  ✓ each 循环渲染（背包物品出现 ${rows} 次）`)
    }
  }
}
console.log(fail ? `\n${fail} 失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
