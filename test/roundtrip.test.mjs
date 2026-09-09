// round-trip 测试 —— jsonSafe 的开发时拦截层。
// 目标：验证每个工具经 jsonSafe 清洗后，`JSON.parse(JSON.stringify(...))` 往返不会触发 DSH「lossless JSON」校验拒绝。
// 说明：jsonSafe 是运行时兜底，本测试是开发时拦截（GLM 复核建议）。直接测真实实现 `lib/json-safe.js`，不复制实现，避免双维护漂移。
// 运行：node --test test/roundtrip.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonSafe } from '../lib/json-safe.js'

// 断言：JSON 往返可执行、结果无 undefined、且与输入（经归一后）深度相等。
function assertRoundTrip(v, expected) {
  const cleaned = jsonSafe(v)
  const text = JSON.stringify(cleaned) // 不应抛（无 undefined/循环）
  assert.notEqual(text, undefined, 'JSON.stringify 不应返回 undefined')
  const back = JSON.parse(text)
  // 往返后深层应无 undefined 值
  assert.ok(!hasUndefined(back), '往返结果不应含 undefined')
  if (expected !== undefined) assert.deepEqual(back, expected)
  return back
}

function hasUndefined(v) {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some((x) => x === undefined || hasUndefined(x))
  for (const k in v) if (v[k] === undefined || hasUndefined(v[k])) return true
  return false
}

test('普通对象 round-trip 无丢失', () => {
  const o = { a: 1, b: 'x', c: true, d: null, e: [1, 2, 3] }
  assertRoundTrip(o, o)
})

test('undefined 字段被删，往返无 undefined', () => {
  // 模拟此前踩过的坑：工具返回带 undefined 的字段（phase / why / lastRecalledAt 等）
  const o = {
    id: 'm1',
    title: '标题',
    body: '正文',
    phase: undefined,
    why: undefined,
    howToApply: undefined,
    lastRecalledAt: undefined,
    trigger: 'x',
  }
  const back = assertRoundTrip(o, { id: 'm1', title: '标题', body: '正文', trigger: 'x' })
  assert.ok(!('phase' in back))
  assert.ok(!('why' in back))
})

test('嵌套 undefined（对象内 + 数组内）被清洗', () => {
  const o = { list: [1, undefined, 3], inner: { slug: undefined, alive: true } }
  const back = assertRoundTrip(o, { list: [1, null, 3], inner: { alive: true } })
  assert.deepEqual(back.list, [1, null, 3]) // 数组内 undefined → null（jsonSafe.map）
})

test('null 透传', () => {
  assertRoundTrip({ a: null }, { a: null })
})

test('正常数字 round-trip 安全（含 0、负数、小数、最大安全整数）', () => {
  const o = { zero: 0, neg: -42, float: 3.14, big: 9007199254740991 }
  assertRoundTrip(o, o)
})

test('字符串含特殊字符 / 换行 / 中文 round-trip', () => {
  const o = { title: '含\n换行\t与“引号”的\u3000中文`代码`' }
  assertRoundTrip(o, o)
})

test('顶层 undefined 返回 undefined（交调用层 ?? null 兜底）；空对象/空数组 round-trip', () => {
  // jsonSafe 对顶层 undefined 返回 undefined（对象属性 undefined 才删键）。
  // 工具永远返回对象，顶层 undefined 不会传入；若真有调用层传入顶层 undefined，
  // 需由调用层 ?? null 兜底，本函数不强行转 null（否则对象属性的删键语义会被破坏）。
  assert.equal(jsonSafe(undefined), undefined)
  assertRoundTrip(null, null)
  assertRoundTrip({}, {})
  assertRoundTrip([], [])
})

test('NaN/Infinity 不产生 undefined 键（jsonSafe 不兜底数字，null 化但不崩）', () => {
  const cleaned = jsonSafe({ heat: NaN })
  const back = JSON.parse(JSON.stringify(cleaned)) // 应不抛
  assert.ok(!hasUndefined(back))
  assert.equal(back.heat, null) // JSON 把 NaN 序列化回 null
})

test('记忆工具典型返回结构 round-trip（memory_pending_changes 表格）', () => {
  const o = {
    total: 1,
    table: '| # | 文件路径 | 说明 |\n|---|---|---|\n| 1 | D:\\a\\b.md |  |',
    message: '请把上方表格原样粘贴到回复中报告改动文件。',
  }
  const back = assertRoundTrip(o, o)
  assert.equal(back.total, 1)
  assert.match(back.table, /\| # \| 文件路径 \|/)
})
