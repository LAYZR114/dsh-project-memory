import { test } from 'node:test'
import assert from 'node:assert'
// 底线记忆→硬守卫机制（GLM 定稿 §1-§5）回归：识别/守卫表/拦截/可逆/工厂状态。
// 与 lib/rule.js selfTest 同源（此处走 node --test 管道；直跑自测见 rule.js selfTest）。
import {
  proposeGuard, rebuildGuardTable, dragGuardCheck, removeGuardFromDoc, guardDenyText, userDeleteConfirmText,
  DENY_WORDS, DUTY_WORDS, createRule,
} from '../lib/rule.js'

const now = new Date().toISOString()
const ids = new Set(['mem-aaa111', 'mem-bbb222'])

// ---- 识别：只认禁止语义；义务语义永不提议守卫 ----
test('proposeGuard 禁止+记忆id → block_delete(memory)', () => {
  const p = proposeGuard('禁止删除 mem-aaa111（核心设计结论）', ids)
  assert.equal(p.propose, true)
  assert.equal(p.guard.action, 'block_delete')
  assert.deepEqual(p.guard.target, { kind: 'memory', id: 'mem-aaa111' })
})
test('proposeGuard 严禁+修改+记忆id → block_update', () => {
  const p = proposeGuard('严禁修改 mem-bbb222', ids)
  assert.equal(p.propose, true)
  assert.equal(p.guard.action, 'block_update')
  assert.equal(p.guard.target.id, 'mem-bbb222')
})
test('proposeGuard 绝不+引号路径 → block_write(path)', () => {
  const p = proposeGuard('绝不编辑 "src\\config.json"', ids)
  assert.equal(p.propose, true)
  assert.equal(p.guard.action, 'block_write')
  assert.equal(p.guard.target.value, 'src\\config.json')
})
test('proposeGuard 义务语义（必须/记得/每次）→ null', () => {
  assert.equal(proposeGuard('必须记得修改 config.json 后跑测试', ids), null)
  assert.equal(proposeGuard('每次写完代码都要跑测试', ids), null)
  assert.equal(proposeGuard('记得提交前检查', ids), null)
})
test('proposeGuard 禁止但无目标 → propose:false（诚实边界）', () => {
  const p = proposeGuard('禁止这件事做得太随意', ids)
  assert.equal(p.propose, false)
  assert.match(p.reason, /未识别/)
})
test('proposeGuard 记忆 id 必须真实存在于 docIds', () => {
  const p = proposeGuard('禁止删除 mem-not-exist', ids)
  assert.ok(!(p && p.propose === true && p.guard.target.kind === 'memory'))
})
test('DENY_WORDS 与 DUTY_WORDS 互斥', () => {
  assert.ok(!DUTY_WORDS.some((w) => DENY_WORDS.includes(w)))
})

// ---- 守卫表 ----
const mk = (over = {}) => ({
  id: over.id, name: over.id, title: over.title || 't' + over.id, description: 'd', body: 'b',
  type: 'project', status: 'active', heat: 0, createdAt: now, updatedAt: now, ...over,
})
const gA = mk({
  id: 'mem-aaa111', title: '禁止删除记忆A',
  guard: { action: 'block_delete', target: { kind: 'memory', id: 'mem-bbb222' }, createdAt: now, blockedCount: 2 },
})
const gB = mk({ id: 'mem-bbb222', title: '禁止写 config', guard: { action: 'block_write', target: { kind: 'path', value: 'config.json' }, createdAt: now } })
const plain = mk({ id: 'mem-ccc333' })
const doc = { version: 2, memories: [gA, gB, plain] }
const table = rebuildGuardTable(doc)
test('rebuildGuardTable 只含 guard 字段记忆', () => {
  assert.equal(table.length, 2)
  assert.deepEqual(table[0], { action: 'block_delete', target: { kind: 'memory', id: 'mem-bbb222' }, sourceId: 'mem-aaa111', title: '禁止删除记忆A', blockedCount: 2 })
})

// ---- 拦截：deny 优先（命中返回 {hit,text}；未命中 null）----
test('dragGuardCheck block_delete 命中记忆目标 → deny', () => {
  const d = dragGuardCheck({ name: 'memory_delete', arguments: { id: 'mem-bbb222' } }, table)
  assert.ok(d && d.hit && d.hit.sourceId === 'mem-aaa111')
  assert.match(d.text, /已被硬守卫拦截/)
})
test('dragGuardCheck 删其他记忆 → 放行', () => {
  assert.equal(dragGuardCheck({ name: 'memory_delete', arguments: { id: 'mem-ccc333' } }, table), null)
})
test('dragGuardCheck block_delete 不拦 memory_update（动作不匹配）', () => {
  assert.equal(dragGuardCheck({ name: 'memory_update', arguments: { id: 'mem-bbb222' } }, table), null)
})
test('dragGuardCheck block_write 路径子串 → deny；其他文件 → 放行', () => {
  const hit = dragGuardCheck({ name: 'write', arguments: { file_path: 'D:\\proj\\config.json' } }, table)
  assert.ok(hit && /写入/.test(hit.text))
  assert.equal(dragGuardCheck({ name: 'write', arguments: { file_path: 'D:\\proj\\other.txt' } }, table), null)
})
test('dragGuardCheck 结构性基线：直改 .dsh-memory.json → deny（不依赖表）', () => {
  const d = dragGuardCheck({ name: 'write', arguments: { file_path: 'D:\\proj\\.dsh-memory.json' } }, [])
  assert.ok(d && !d.hit && /记忆文件/.test(d.text))
})

// ---- @fix user-delete-guard：用户侧不 deny、弹窗确认（GLM §7：守卫约束 agent 不约束用户）----
test('userDeleteConfirmText：弹窗含锁定标题+确定+解除语义', () => {
  const c = userDeleteConfirmText(table[0]) // {action:block_delete, target:{kind:'memory',id:'mem-bbb222'}, title:'禁止删除记忆A', blockedCount:2}
  assert.match(c.question, /该记忆被「禁止删除记忆A」锁定/)
  assert.match(c.question, /确定要删除吗/)
  assert.match(c.detail, /block_delete|禁止删除/)
  assert.match(c.detail, /解除守卫/)
  assert.match(c.detail, /2 次/)
})
test('guardDenyText(删除) 指向用户命令 /memory delete（AI 被拦、用户可绕）', () => {
  const d = guardDenyText(table[0], '删除')
  assert.match(d, /已被硬守卫拦截/)
  assert.match(d, /\/memory delete/)
  assert.match(d, /不约束用户/)
})

// ---- 可逆：/guard remove 后守卫消失（重派生）----
test('removeGuardFromDoc + 重派生守卫消失', () => {
  const r = removeGuardFromDoc(doc, 'mem-bbb222')
  assert.equal(r.removed, true)
  assert.equal(r.memories.find((m) => m.id === 'mem-bbb222').guard, undefined)
  assert.equal(rebuildGuardTable({ version: 2, memories: r.memories }).length, 1)
  assert.equal(removeGuardFromDoc(doc, 'mem-not-exist').removed, false)
})

// ---- 工厂：guardCheck/bumpBlocked/baseline ----
test('createRule 工厂 guardCheck + bumpBlocked + baseline 只升', () => {
  const R = createRule()
  R.rebuild('C:\\x', doc)
  assert.equal(R.guardsOf('C:\\x').length, 2)
  const d = R.guardCheck({ name: 'memory_delete', arguments: { id: 'mem-bbb222' } }, 'C:\\x')
  assert.ok(d && d.hit && d.hit.sourceId === 'mem-aaa111')
  R.bumpBlocked('C:\\x', 'mem-aaa111')
  assert.equal(R.guardsOf('C:\\x')[0].blockedCount, 3)
  assert.equal(R.baselineOf('C:\\x'), 2) // 基线 = 历史最大（2），不随 bump 改变
})
