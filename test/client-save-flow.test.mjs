// 「保存排序」端到端行为测试（真渲染 + 真点击）
// 为什么需要它：上一轮只做文本匹配（断言源码里出现 checkSanity(...)），
// 结果漏掉了「checkSanity 被定义在拖动指针函数内部、保存排序里根本取不到」的
// ReferenceError —— 表现就是点了「确认保存」弹窗不消失、毫无反应。
// 本测试用迷你 React 运行时真渲染设置页组件、真调用按钮 onClick，覆盖：
//   ①按钮仅在自动排序时出现 ②点击只弹确认、确认前不写盘 ③取消不写盘
//   ④确认后按当前规则写盘 ⑤verified=true → 成功弹窗 + 回默认 + 按钮消失
//   ⑥verified=false → 如实提示"未生效" + 重新载入磁盘顺序（不谎报成功）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

const MEM = (id, updatedAt, heat = 0) => ({
  id, title: 'T-' + id, description: 'd-' + id, body: 'b', type: 'project', status: 'active',
  ttl: 'event', updatedAt, heat, proofCount: 0, source: 'manual', createdAt: updatedAt, triggers: [], tags: [],
})
const LIST = [MEM('a', '2026-01-01T00:00:00Z'), MEM('b', '2026-05-01T00:00:00Z'), MEM('c', '2026-09-01T00:00:00Z')]
const tick = () => new Promise((r) => setTimeout(r, 0))

// —— 迷你 React 运行时（只实现组件用到的 hooks；setState 不自动重渲染，由测试显式 render）——
function makeRuntime() {
  const state = []
  let cursor = 0
  const effects = []
  let mounted = false
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState: (init) => {
      const i = cursor++
      if (state.length <= i) state[i] = typeof init === 'function' ? init() : init
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
  }
  return {
    react,
    reset: () => { cursor = 0 },
    mountEffects: () => { if (mounted) return; mounted = true; for (const e of effects) { const d = e(); if (typeof d === 'function') d() } },
  }
}

function mount(respond) {
  let reg
  globalThis.window = { __ModuleLoader__: { load: (r) => { reg = r } } }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const payload = init && init.body ? JSON.parse(init.body) : {}
    calls.push({ url, payload })
    return { json: async () => respond(payload) }
  }
  new Function(SRC)()
  assert.ok(reg && typeof reg.factory === 'function', 'client.js 应通过 __ModuleLoader__ 注册工厂')
  const rt = makeRuntime()
  const mod = reg.factory(() => rt.react)
  let Comp = null
  const ctx = { effect: (fn) => { fn(); return () => {} }, slots: { inject: (s, f) => f(), register: (o, C) => { Comp = C; return () => {} } } }
  mod.apply(ctx)
  assert.ok(Comp, 'apply() 应把设置页组件注册进 settings.section')
  return { render: () => { rt.reset(); return Comp() }, mountEffects: rt.mountEffects, calls }
}

// —— 元素树工具 ——
const walk = (node, fn) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, fn); return }
  fn(node)
  for (const c of node.children || []) walk(c, fn)
}
const textOf = (n) => (typeof n === 'string' ? n : (n && typeof n === 'object' ? (n.children || []).map(textOf).join('') : ''))
const allOf = (tree, type) => { const out = []; walk(tree, (n) => { if (n.type === type) out.push(n) }); return out }
const btn = (tree, t) => allOf(tree, 'button').find((b) => textOf(b).includes(t))
const sel = (tree) => allOf(tree, 'select')[0]
const saveCalls = (calls) => calls.filter((c) => c.payload.action === 'save')
const listCalls = (calls) => calls.filter((c) => c.payload.action === 'list')

async function readyTree(respond) {
  const env = mount(respond)
  env.render()
  env.mountEffects()      // 触发首次 load()
  await tick(); await tick()
  return { ...env, tree: env.render() }
}

test('选中自动排序后出现「保存排序」；默认模式下不出现', async () => {
  const { render, tree } = await readyTree((p) => (p.action === 'list' ? { ok: true, memories: LIST } : { ok: true }))
  assert.ok(!btn(tree, '保存排序'), '默认模式下不应显示「保存排序」')
  sel(tree).props.onChange({ target: { value: 'newest' } })
  assert.ok(btn(render(), '保存排序'), '选中自动排序后应显示「保存排序」')
})

test('点「保存排序」只弹确认，确认前不写盘；取消也不写盘', async () => {
  const { render, calls, tree } = await readyTree((p) => (p.action === 'list' ? { ok: true, memories: LIST } : { ok: true }))
  sel(tree).props.onChange({ target: { value: 'newest' } })
  btn(render(), '保存排序').props.onClick()
  let t = render()
  assert.ok(textOf(t).includes('确认保存排序'), '应弹出二次确认弹窗')
  assert.equal(saveCalls(calls).length, 0, '确认前绝不能写盘')
  btn(t, '取消').props.onClick()
  t = render()
  assert.ok(!textOf(t).includes('确认保存排序'), '取消后弹窗应关闭')
  assert.equal(saveCalls(calls).length, 0, '取消后也不能写盘')
})

test('确认后按当前规则写盘，verified=true → 成功弹窗 + 回到默认 + 按钮消失', async () => {
  const { render, calls, tree, mountEffects } = await readyTree((p) => (p.action === 'list' ? { ok: true, memories: LIST } : { ok: true, saved: true, verified: true, count: 3 }))
  void mountEffects
  sel(tree).props.onChange({ target: { value: 'newest' } })
  btn(render(), '保存排序').props.onClick()
  btn(render(), '确认保存').props.onClick()      // ← 这一行以前会抛 ReferenceError
  await tick(); await tick()
  const saved = saveCalls(calls)
  assert.equal(saved.length, 1, '确认后应写盘一次')
  assert.deepEqual(saved[0].payload.memories.map((m) => m.id), ['c', 'b', 'a'], '应按「从新到旧」的顺序写盘')
  const t = render()
  assert.ok(textOf(t).includes('确认保存排序') === false, '确认后确认弹窗应关闭')
  assert.ok(textOf(t).includes('已保存为默认顺序'), '应弹出成功告知弹窗')
  assert.equal(sel(t).props.value, 'default', '应回到默认（手动）模式')
  assert.ok(!btn(t, '保存排序'), '默认模式下按钮应再次消失')
  assert.ok(textOf(t).includes('已按「从新到旧」保存为默认顺序'), '提示条应说明结果')
})

test('verified=false → 如实提示未生效 + 重新载入磁盘顺序，且不谎报成功', async () => {
  const { render, calls, tree } = await readyTree((p) => (p.action === 'list' ? { ok: true, memories: LIST } : { ok: true, saved: true, verified: false, count: 3, mismatchAt: 0 }))
  const listBefore = listCalls(calls).length
  sel(tree).props.onChange({ target: { value: 'newest' } })
  btn(render(), '保存排序').props.onClick()
  btn(render(), '确认保存').props.onClick()
  await tick(); await tick()
  const t = render()
  assert.ok(textOf(t).includes('保存排序未生效'), '应如实提示未生效')
  assert.ok(!textOf(t).includes('已保存为默认顺序'), '绝不能出现成功弹窗')
  assert.ok(listCalls(calls).length > listBefore, '应重新载入磁盘真实顺序')
})

test('写盘被拒（ok:false）→ 提示失败，不误报成功', async () => {
  const { render, calls, tree } = await readyTree((p) => (p.action === 'list' ? { ok: true, memories: LIST } : { ok: false, error: 'rejected: sanity' }))
  sel(tree).props.onChange({ target: { value: 'important' } })
  btn(render(), '保存排序').props.onClick()
  btn(render(), '确认保存').props.onClick()
  await tick(); await tick()
  const t = render()
  assert.equal(saveCalls(calls).length, 1)
  assert.ok(!textOf(t).includes('已保存为默认顺序'), '被拒时不得出现成功弹窗')
  assert.ok(/保存失败|保存排序失败/.test(textOf(t)), '应提示失败：' + textOf(t).slice(0, 200))
})
