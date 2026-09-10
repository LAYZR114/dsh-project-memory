// UI 接线回归：**拖动排序 = 保存排序**（统一优先级，用户 2026-09-11 定调）
//
// 背景：拖动排序本来就会 persist(next) 落盘，但**不看服务端回读校验**——
//       写盘与界面可能悄悄不一致，用户重启后看到"没保存住"的错觉。
// 现要求：拖动提交必须①同一条写盘路径②检查 r.verified③未 verified/失败时按磁盘顺序刷新界面
//       ④给出"顺序已保存"提示并挂上 10 秒撤销（与「保存排序」完全同级）。
// 本测试按项目既有风格做**静态接线断言**（client.js 是手写 React.createElement 单文件，
// 指针拖拽的真行为模拟成本高；写盘/校验逻辑已由 save-order-survives-writes 做真行为覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/** 取拖动提交分支附近的源码窗口（以"拖动 = 保存"标记为锚点）。 */
function dragCommitWindow() {
  const anchor = SRC.indexOf('拖动 = 保存')
  assert.ok(anchor > 0, 'client.js 里应存在"拖动 = 保存"的统一优先级标记')
  return SRC.slice(anchor, anchor + 1600)
}

test('拖动提交与「保存排序」走同一条写盘路径（persist → /save）', () => {
  const w = dragCommitWindow()
  assert.match(w, /persist\(next\)\.then\(/, '拖动提交必须调用 persist(next) 并处理返回值')
  assert.match(SRC, /const persist = \(next\) => fetchJson\("\/save"/, 'persist 必须是 /save 动作')
})

test('拖动提交必须经过服务端回读校验（实测 0.1.3 新增 verified）', () => {
  const w = dragCommitWindow()
  assert.match(w, /if \(!r\.verified\)/, '未 verified 必须单独分支处理')
  assert.match(w, /回读顺序不一致/, '未 verified 的说明文案必须在（用户可见）')
})

test('拖动未生效/失败时按磁盘真实顺序刷新（绝不谎报成功）', () => {
  const w = dragCommitWindow()
  const reloads = w.match(/load\(cwd, \{ keepMsg: true \}\)/g) || []
  assert.ok(reloads.length >= 2, '失败与未 verified 两条分支都要重载磁盘顺序，实际 ' + reloads.length + ' 处')
  assert.match(w, /拖动排序保存失败/, '写盘失败要有明确提示')
})

test('拖动后给出"已保存"提示并挂上 10 秒撤销（与保存排序同级）', () => {
  const w = dragCommitWindow()
  assert.match(w, /setUndoOrder\(prev\)/, '拖动后必须挂撤销（复用同一套 undoOrder）')
  assert.match(w, /顺序已保存（拖动即保存/, '要有"已保存"的明确提示')
})

test('拖动仍只在默认（手动）模式可用；默认模式即文件顺序', () => {
  assert.match(SRC, /sort === "default"\) \? h\("span", \{ className: "pm-grip"/, '拖动手柄只在 default 模式出现')
  assert.match(SRC, /if \(mode === "newest"\)[\s\S]{0,400}?return list;/, 'sortList 的 default 分支必须原样返回（= 文件顺序）')
})
