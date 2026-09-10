// 导入向导回归（用户 2026-09-11 需求）：
//   ① 选好文件后**先弹确认框**（不再直接落盘）②弹窗里插件已自动判断「分类」与「重要等级」并预选
//   ③ 生成标题/简介 + 正文自动排版 ④用户可手动改分类/等级 ⑤确认后按所选分类**置顶**放入 ⑥同一套回读校验。
// 本测试对 **classifyImportMemory** 做真单测（从 client.js 抽取纯函数，注入 labels/organizedText），
// 并对导入流程接线做静态断言（client.js 是手写 React.createElement 单文件，弹窗交互成本高）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { organizeBody } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

function extractFn(src, header) {
  const start = src.indexOf(header)
  assert.ok(start > 0, 'client.js 里应存在：' + header)
  let i = src.indexOf('{', start)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('函数体未闭合：' + header)
}

const labels = { project: '项目', reference: '参考', feedback: '反馈', user: '用户', skill: '技能', knowledge: '知识' }
const organizedText = (b) => organizeBody(String(b || '')).join('\n\n')
const hintsStart = SRC.indexOf('const IMPORT_TYPE_HINTS')
const fnStart = SRC.indexOf('function classifyImportMemory(')
assert.ok(hintsStart > 0 && fnStart > hintsStart, 'client.js 里应存在导入判定常量与函数')
const classify = new Function('labels', 'organizedText',
  SRC.slice(hintsStart, fnStart) + '\n' + extractFn(SRC, 'function classifyImportMemory(') + '\nreturn classifyImportMemory'
)(labels, organizedText)

test('义务语义（必须/禁止/每次…）→ 判为长期有效 + 义务标记', () => {
  const r = classify({ title: '记忆红线', body: '修改记忆必须只用 memory_write，禁止直接改文件。' })
  assert.equal(r.ttl, 'permanent')
  assert.equal(r.obligation, true)
})

test('踩坑/教训类内容 → 判为「反馈」', () => {
  assert.equal(classify({ title: '一次事故复盘', body: '这次踩坑的根因是作用域写错。' }).type, 'feedback')
})

test('偏好/习惯类内容 → 判为「用户」', () => {
  assert.equal(classify({ title: '交流习惯', body: '我喜欢用大白话，以后都这样。' }).type, 'user')
})

test('文档/规范/链接类内容 → 判为「参考」', () => {
  assert.equal(classify({ title: '接口说明', body: '参考官方文档：https://example.com/api 手册见附件。' }).type, 'reference')
})

test('概念/原理类内容 → 判为「知识」', () => {
  assert.equal(classify({ title: '术语表', body: '这个词的定义与原理属于通用知识。' }).type, 'knowledge')
})

test('没有任何线索 → 默认「项目」', () => {
  assert.equal(classify({ title: '今天做了三件事', body: '第一条 第二条 第三条' }).type, 'project')
})

test('合法的显式 type 优先保留；非法 type 被忽略并重新判定', () => {
  assert.equal(classify({ type: 'skill', title: 'x', body: '随手记' }).type, 'skill')
  assert.equal(classify({ type: 'nonsense', title: 'x', body: '这次踩坑了' }).type, 'feedback')
})

test('标题缺失/占位 → 由正文首行生成（≤40 字）；简介缺失 → 由首行生成（≤60 字）', () => {
  const body = '这一行就是标题来源，后面还有很多内容。\n第二段内容。'
  const r = classify({ body })
  assert.equal(r.title, '这一行就是标题来源，后面还有很多内容。')
  assert.equal(r.description, '这一行就是标题来源，后面还有很多内容。')
  const long = classify({ body: 'A'.repeat(80) + '\n第二段' })
  assert.equal(long.title.length, 40, '标题应截断到 40 字')
  assert.equal(long.description.length, 60, '简介应截断到 60 字')
  assert.equal(classify({ title: '未命名', body: '真正的第一行\n第二行' }).title, '真正的第一行', '"未命名"占位应被替换')
})

test('正文自动排版：多空行规整为段间单空行', () => {
  const r = classify({ title: 't', body: '第一段\n\n\n\n第二段\n\n\n第三段' })
  assert.ok(!/\n{3,}/.test(r.body), '不应残留连续 3 个以上换行')
  assert.ok(r.body.includes('第一段') && r.body.includes('第三段'))
})

test('无义务语义时保留原有 phase 等级（不擅自升级）', () => {
  const r = classify({ title: '阶段事项', body: '这个阶段先做 M1。', ttl: 'phase' })
  assert.equal(r.ttl, 'phase')
  assert.equal(r.obligation, false)
})

test('接线：选文件后先弹确认框（不写盘），确认后才 persist', () => {
  assert.match(SRC, /setImportDraft\(\{ items \}\)/, '选好文件后必须进入确认草稿（而不是直接写盘）')
  const importBlock = SRC.slice(SRC.indexOf('const onImportFile = ('), SRC.indexOf('const updateImportItem = ('))
  assert.ok(!/persist\(/.test(importBlock), 'onImportFile 里不得直接写盘')
  const confirmBlock = SRC.slice(SRC.indexOf('const confirmImport = ('), SRC.indexOf('const filtered ='))
  assert.match(confirmBlock, /persist\(next\)\.then/, '确认弹窗的"确定导入"才写盘')
  assert.match(confirmBlock, /if \(!r\.verified\)/, '导入也要过服务端回读校验')
  assert.match(confirmBlock, /items\.concat\(memories\)/, '导入的记忆必须置顶')
})

test('接线：弹窗含分类与重要等级两个选择组件 + 标题/简介可改', () => {
  const modal = SRC.slice(SRC.indexOf('className: "pm-confirm pm-import"'))
  assert.match(modal, /"分类："/, '弹窗要有分类选择组件')
  assert.match(modal, /"重要等级："/, '弹窗要有重要等级选择组件')
  assert.match(modal, /updateImportItem\(i, \{ type: e\.target\.value \}\)/, '分类可手动改')
  assert.match(modal, /updateImportItem\(i, \{ ttl: e\.target\.value \}\)/, '等级可手动改')
  assert.match(modal, /updateImportItem\(i, \{ title: e\.target\.value \}\)/, '自动生成的标题可改')
  assert.match(modal, /onClick: confirmImport/, '弹窗要有"确定导入"（二次确认）')
})
