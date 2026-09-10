// 回归测试：保存排序必须"跨重启 / 跨各种写入"保持住（用户 2026-09-11 实测 bug）
//
// 病根：writeThrough 是唯一写入口，但所有「顺带写入」——召回热度自增(tools.js:107)、
//       记忆增删改(tools.js/commands.js 多处)——都是"默认读 readDoc（按最新重排）→ 原样写回"，
//       于是用户保存的手动顺序**一有写入就被冲掉**；重启后自然看起来"没保存住"。
//       （旧的 save-order-persist 测试注入了 writeAsGiven 假写入器，因此漏掉了这条链路。）
// 修法：writeThrough 默认**保序**——把要写的集合"套回"磁盘现有顺序，磁盘上没有的新记忆放最前；
//       只有显式改序（设置页 /save 传 explicitOrder:true）才按调用方给的顺序落盘。
//
// 本测试跑**真·readDoc + 真·writeThrough**（从 index.js 源码抽取）+ 真·api.js 路由 + 真实临时文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isValid, migrateV1, byNewest, readDocSync } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(here, '..', 'lib')
const INDEX_SRC = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8')
const { registerApiRoute } = await import(pathToFileURL(path.join(LIB, 'api.js')).href)

const T = { a: '2026-01-01T00:00:00Z', b: '2026-05-01T00:00:00Z', c: '2026-09-01T00:00:00Z' }
const MEM = (id) => ({
  id, title: 't-' + id, description: 'd', body: 'b', type: 'project', status: 'active',
  updatedAt: T[id] || '2026-03-01T00:00:00Z', heat: 0,
})

/** 抽取 index.js 里的具名函数（按大括号配对，避免截断）。 */
function extractFn(src, header) {
  const start = src.indexOf(header)
  assert.ok(start > 0, 'index.js 里应存在：' + header)
  let i = src.indexOf('{', start)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('函数体未闭合：' + header)
}

/** 真·readDoc（index.js 抽取）+ 最小 fs 服务（落地真实临时文件）。 */
function makeRealReadDoc() {
  const fsSvc = {
    resolve: async (name, opts) => path.resolve(opts.cwd, name),
    stat: async (p) => { try { const s = await fs.promises.stat(p); return { size: s.size } } catch { return undefined } },
    readText: async (p) => fs.promises.readFile(p, 'utf8'),
    writeText: async (p, text) => { await fs.promises.writeFile(p, text, 'utf8') },
  }
  const backupCorrupt = async () => ({ version: 2, memories: [] })
  const factory = new Function('fs', 'MEMORY_FILE', 'backupCorrupt', 'isValid', 'migrateV1', 'byNewest',
    extractFn(INDEX_SRC, 'async function readDoc(') + '\nreturn readDoc')
  return factory(fsSvc, '.dsh-memory.json', backupCorrupt, isValid, migrateV1, byNewest)
}

/** 真·writeThrough（index.js 抽取）；sanity/派生物链用最小桩，落盘走真实文件。 */
function makeRealWriteThrough() {
  const reports = []
  const storeWriteDoc = async (cwd, memories) => {
    fs.writeFileSync(path.join(cwd, '.dsh-memory.json'), JSON.stringify({ version: 2, memories }, null, 2), 'utf8')
    return true
  }
  const factory = new Function('checkSanity', 'storeWriteDoc', 'afterWrite', 'report', 'readDocSync', 'MEMORY_FILE',
    extractFn(INDEX_SRC, 'async function writeThrough(') + '\nreturn writeThrough')
  const wt = factory(
    () => undefined,                  // checkSanity：本测试聚焦顺序，sanity 另有测试覆盖
    storeWriteDoc,
    async () => {},                   // afterWrite：派生物链与顺序无关
    (m) => { reports.push(String(m)) },
    readDocSync,
    '.dsh-memory.json',
  )
  return { wt, reports }
}

const tmpCwd = (memories) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-orderw-'))
  fs.writeFileSync(path.join(cwd, '.dsh-memory.json'), JSON.stringify({ version: 2, memories }, null, 2), 'utf8')
  return cwd
}
const fileOrder = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, '.dsh-memory.json'), 'utf8')).memories.map((m) => m.id)

/** 真·api.js 路由 + 真 readDoc/writeThrough + 假 req/res。 */
function makeApi({ readDoc, wt }) {
  let handler
  const ctx = { effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } } }
  const webServer = { register: (o) => { handler = o.handler; return () => {} } }
  registerApiRoute(ctx, {
    webServer, readDoc, writeThrough: wt,
    buildCapabilityReport: () => ({}), rl: { resetBaseline() {} },
  })
  assert.ok(handler, 'api.js 应注册出 handler')
  return {
    call: (payload) => new Promise((resolve, reject) => {
      const req = new EventEmitter()
      req.method = 'POST'
      const res = { setHeader() {}, end(s) { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } } }
      handler(req, res)
      setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(payload))); req.emit('end') })
    }),
  }
}

const setup = () => {
  const readDoc = makeRealReadDoc()
  const { wt, reports } = makeRealWriteThrough()
  // 初始文件顺序 a,b,c；但"最新"排序是 c,b,a —— 两者不同，才能暴露重排 bug
  const cwd = tmpCwd([MEM('a'), MEM('b'), MEM('c')])
  return { readDoc, wt, reports, cwd, api: makeApi({ readDoc, wt }) }
}
/** 模拟召回热度自增：正是 tools.js memory_recall 的写法（默认读 → 改 heat → 写回）。 */
const recallHeatBump = async (readDoc, wt, cwd) => {
  const doc = await readDoc(cwd)                       // 默认读 = 按最新重排
  const bumped = doc.memories.map((m) => ({ ...m, heat: (m.heat || 0) + 1 }))
  return wt(cwd, bumped)
}

test('前置：默认读取确实会重排（本 bug 的前提）', async () => {
  const { readDoc, cwd } = setup()
  assert.deepEqual((await readDoc(cwd)).memories.map((m) => m.id), ['c', 'b', 'a'])
  assert.deepEqual(fileOrder(cwd), ['a', 'b', 'c'], '文件里原本是 a,b,c')
})

test('显式改序（设置页 /save）按客户端顺序落盘，且回读校验通过', async () => {
  const { cwd, api } = setup()
  const r = await api.call({ action: 'save', cwd, memories: [MEM('c'), MEM('b'), MEM('a')] })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true, '写盘后回读必须 verified')
  assert.deepEqual(fileOrder(cwd), ['c', 'b', 'a'])
})

test('★核心回归：保存顺序后，召回热度自增写入不得重排文件（旧版就在这里被冲掉）', async () => {
  const { readDoc, wt, cwd, api } = setup()
  // 用户把顺序保存为 c,b,a（与"最新"排序恰好相同，改用 a,c,b 更能说明问题）
  await api.call({ action: 'save', cwd, memories: [MEM('a'), MEM('c'), MEM('b')] })
  assert.deepEqual(fileOrder(cwd), ['a', 'c', 'b'])
  // 之后发生多次"顺带写入"（召回热度自增）——旧版每次都把文件重排成 c,b,a
  for (let i = 0; i < 3; i++) assert.equal(await recallHeatBump(readDoc, wt, cwd), true)
  assert.deepEqual(fileOrder(cwd), ['a', 'c', 'b'], '多次热度自增后，手动顺序必须原样保留')
  const listed = await api.call({ action: 'list', cwd })
  assert.deepEqual(listed.memories.map((m) => m.id), ['a', 'c', 'b'], '设置页读到的仍应是保存的顺序')
})

test('新增记忆：放最前，其余顺序不动（手动模式下新记忆看得见）', async () => {
  const { wt, cwd, api } = setup()
  await api.call({ action: 'save', cwd, memories: [MEM('b'), MEM('c'), MEM('a')] })
  const doc = await (async () => readDocSync(cwd, '.dsh-memory.json', { keepOrder: true }))()
  const added = [{ ...MEM('d'), title: '新记忆' }, ...doc.memories]   // 调用方按"新记忆在最前"传入
  assert.equal(await wt(cwd, added), true)
  assert.deepEqual(fileOrder(cwd), ['d', 'b', 'c', 'a'])
})

test('更新与删除：顺序保持（更新的那条留在原位）', async () => {
  const { wt, cwd, api } = setup()
  await api.call({ action: 'save', cwd, memories: [MEM('c'), MEM('a'), MEM('b')] })
  const cur = readDocSync(cwd, '.dsh-memory.json', { keepOrder: true }).memories
  // 更新 a（内容变了）→ 位置不动
  const updated = cur.map((m) => (m.id === 'a' ? { ...m, title: '改过的 a', updatedAt: '2026-12-31T00:00:00Z' } : m))
  assert.equal(await wt(cwd, updated), true)
  assert.deepEqual(fileOrder(cwd), ['c', 'a', 'b'], '更新后 a 仍应在第二位（不得因 updatedAt 变新被顶到最前）')
  // 删除 b → 其余不动
  const afterDel = readDocSync(cwd, '.dsh-memory.json', { keepOrder: true }).memories.filter((m) => m.id !== 'b')
  assert.equal(await wt(cwd, afterDel), true)
  assert.deepEqual(fileOrder(cwd), ['c', 'a'])
})

test('模拟重启：反复读写后顺序稳定，且仍可再次显式改序', async () => {
  const { readDoc, wt, cwd, api } = setup()
  await api.call({ action: 'save', cwd, memories: [MEM('c'), MEM('a'), MEM('b')] })
  for (let i = 0; i < 2; i++) {
    await recallHeatBump(readDoc, wt, cwd)
    const listed = await api.call({ action: 'list', cwd })     // 每次"重启"后设置页读到的顺序
    assert.deepEqual(listed.memories.map((m) => m.id), ['c', 'a', 'b'])
  }
  const again = await api.call({ action: 'save', cwd, memories: [MEM('b'), MEM('c'), MEM('a')] })
  assert.equal(again.verified, true)
  assert.deepEqual(fileOrder(cwd), ['b', 'c', 'a'], '显式改序仍必须生效')
})

test('★耐久压测：20 轮「重启 + 各种写入」后手动顺序完全不变（回答"多次重启会不会又被扰乱"）', async () => {
  const { readDoc, wt, cwd, api } = setup()
  const manual = ['c', 'a', 'b']
  await api.call({ action: 'save', cwd, memories: manual.map((id) => MEM(id)) })
  assert.deepEqual(fileOrder(cwd), manual)

  for (let cycle = 0; cycle < 20; cycle++) {
    // 模拟一次「重启」：设置页重新加载 → 读到的必须是同一个手动顺序
    const listed = await api.call({ action: 'list', cwd })
    assert.deepEqual(listed.memories.map((m) => m.id).slice(0, 3), manual, '第 ' + cycle + ' 轮重启后顺序被扰动')
    // 使用期间发生的各类写入，全部不得动顺序：
    await recallHeatBump(readDoc, wt, cwd)                                  // ① 召回热度自增（最常见的写入）
    const id = 'n' + cycle
    const cur = readDocSync(cwd, '.dsh-memory.json', { keepOrder: true }).memories
    await wt(cwd, [{ ...MEM(id), title: '新增 ' + cycle }, ...cur])          // ② 新增一条（置顶）
    const after = readDocSync(cwd, '.dsh-memory.json', { keepOrder: true }).memories.filter((m) => m.id !== id)
    await wt(cwd, after)                                                    // ③ 删掉它（其余位置不变）
    await recallHeatBump(readDoc, wt, cwd)                                  // ④ 再召回一次
    assert.deepEqual(fileOrder(cwd), manual, '第 ' + cycle + ' 轮写入后顺序漂移')
  }
  const finalListed = await api.call({ action: 'list', cwd })
  assert.deepEqual(finalListed.memories.map((m) => m.id), manual, '20 轮之后设置页读到的仍是手动顺序')
})
