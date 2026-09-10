// 「保存排序」功能回归测试（设置页排序组件）
// 覆盖：①排序规则本身（default/newest/important/inject） ②UI 接线（按钮只在自动排序时出现、点击后固化顺序并回到默认、10 秒撤销窗口）
// 做法：从 lib/client.js 里抽出 sortList 源码在沙箱里执行（client.js 是 UMD 包裹、依赖浏览器运行时，不能整文件 import），
//       UI 接线用源码断言（这台机器无浏览器环境，保持零依赖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

// —— 抽出 sortList 函数体（含函数声明那一行到匹配的收尾大括号）——
function extractSortList(src) {
  const start = src.indexOf('function sortList(')
  assert.ok(start > 0, 'client.js 里应存在 sortList 函数')
  let i = src.indexOf('{', start), depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('sortList 函数体未闭合')
}
const sortList = new Function(extractSortList(SRC) + '; return sortList')()

const mem = (id, { updatedAt = '2026-01-01T00:00:00Z', heat = 0, proofCount = 0, sources = [] } = {}) => ({ id, updatedAt, heat, proofCount, sources })

test('default（手动）模式不重排，且返回原顺序', () => {
  const list = [mem('a'), mem('c'), mem('b')]
  assert.deepEqual(sortList(list, 'default').map(m => m.id), ['a', 'c', 'b'])
})

test('newest 按更新时间从新到旧', () => {
  const list = [mem('old', { updatedAt: '2026-01-01T00:00:00Z' }), mem('new', { updatedAt: '2026-09-01T00:00:00Z' }), mem('mid', { updatedAt: '2026-05-01T00:00:00Z' })]
  assert.deepEqual(sortList(list, 'newest').map(m => m.id), ['new', 'mid', 'old'])
})

test('important 按热度，再按 proofCount 兜底', () => {
  const list = [mem('a', { heat: 1 }), mem('b', { heat: 5 }), mem('c', { heat: 5, proofCount: 3 })]
  assert.deepEqual(sortList(list, 'important').map(m => m.id), ['c', 'b', 'a'])
})

test('inject 按自动注入次数（sources 长度）从多到少', () => {
  const list = [mem('a', { sources: [1] }), mem('b', { sources: [1, 2, 3] }), mem('c')]
  assert.deepEqual(sortList(list, 'inject').map(m => m.id), ['b', 'a', 'c'])
})

test('排序不改原数组（不可变），也不丢字段', () => {
  const list = [mem('a', { heat: 1 }), mem('b', { heat: 9 })]
  const before = list.map(m => m.id)
  const out = sortList(list, 'important')
  assert.deepEqual(list.map(m => m.id), before, '原数组顺序不应被改动')
  assert.equal(out[0].id, 'b')
  assert.equal(out[0].heat, 9, '字段应原样保留')
})

test('UI 接线：按钮只在自动排序时出现（默认/手动模式不显示）', () => {
  assert.match(SRC, /sort !== "default"\) \? h\("button", \{ className: "pm-btn", onClick: saveSortedOrder/, '应存在条件渲染的「保存排序」按钮')
  assert.match(SRC, /"保存排序"/, '按钮文案应为「保存排序」')
})

// 流程：点按钮 → 弹二次确认（不写盘）→ 确认后写盘 → 服务端回读校验 → 成功弹窗（2 秒自动关）
test('UI 接线：点「保存排序」只弹二次确认，不写盘', () => {
  const fn = SRC.slice(SRC.indexOf('const saveSortedOrder'), SRC.indexOf('const doSaveSortedOrder'))
  assert.match(fn, /setSortConfirm\(/, '应打开二次确认弹窗')
  assert.ok(!/persist\(/.test(fn), '确认之前绝不能写盘')
})

test('UI 接线：确认后才固化顺序（含 sanity 体检 + 回读校验门槛）', () => {
  const fn = SRC.slice(SRC.indexOf('const doSaveSortedOrder'), SRC.indexOf('const undoSortedOrder'))
  assert.match(fn, /sortList\(memories, mode\)/, '应对整个列表应用当前排序规则')
  assert.match(fn, /checkSanity\(next, memories, ids\)/, '应先过 sanity 体检（与拖动排序同一道关）')
  assert.match(fn, /persist\(next\)/, '应走与拖动排序同一条写盘路径')
  assert.match(fn, /r\.verified/, '必须以服务端回读校验结果为准')
  assert.match(fn, /load\(cwd, \{ keepMsg: true \}\)/, '校验不通过时应重新载入磁盘真实顺序，并保留"未生效"提示（keepMsg）')
  assert.match(fn, /setSort\("default"\)/, '校验通过后才切回默认（手动）模式')
  assert.match(fn, /setUndoOrder\(prev\)/, '应记录保存前顺序以供撤销')
  assert.match(fn, /setSortDone\(/, '校验通过后应弹出成功告知弹窗')
})

test('UI 接线：二次确认与成功告知弹窗都在，且成功弹窗 3 秒自动关闭', () => {
  assert.match(SRC, /确认保存排序/, '应有二次确认弹窗标题')
  assert.match(SRC, /确认保存/, '确认按钮文案')
  assert.match(SRC, /已保存为默认顺序/, '应有成功告知弹窗')
  assert.match(SRC, /setTimeout\(\(\) => setSortDone\(null\), 3000\)/, '成功弹窗应 3 秒后自动关闭')
})

test('UI 接线：撤销走同一路径，且 10 秒后自动失效', () => {
  const fn = SRC.slice(SRC.indexOf('const undoSortedOrder'), SRC.indexOf('useEffect(() => {\n\t\t\t\tif (!undoOrder)'))
  assert.match(fn, /persist\(back\)/, '撤销也应走 persist 写盘')
  assert.match(fn, /checkSanity\(back, memories, ids\)/, '撤销也应过 sanity 体检')
  assert.match(SRC, /setTimeout\(\(\) => setUndoOrder\(null\), 10000\)/, '撤销窗口应为 10 秒后自动关闭')
})
