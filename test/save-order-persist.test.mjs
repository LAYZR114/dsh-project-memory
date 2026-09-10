// 「手动顺序能不能真的存住」功能测试（本次线上故障的回归）
// 病根：readDoc 每次读盘都 .sort(byNewest) → 写进去的手动/保存顺序一读就被重排
//      （表现为「保存排序」没反应、拖动排序也一直无效）。
// 本测试直接跑**真·readDoc**（从 index.js 抽出，配真 store 工具函数 + 真实临时文件）
// 以及真·api.js 路由（注入依赖，捕获 handler），验证：
//   ①默认读取仍按最新重排（内部消费方行为不变） ②keepOrder 保留文件顺序
//   ③/list 返回文件真实顺序 ④/save 写盘后回读校验 verified=true，且再次 /list 顺序一致
//   ⑤回读不一致时 verified=false（不谎报成功）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isValid, migrateV1, byNewest } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(here, '..', 'lib')
const INDEX_SRC = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8')
const { registerApiRoute } = await import(pathToFileURL(path.join(LIB, 'api.js')).href)

const MEM = (id, updatedAt) => ({ id, title: 't-' + id, description: 'd', body: 'b', type: 'project', status: 'active', updatedAt, heat: 0 })

// 抽出 index.js 里的 async function readDoc(...) {...}（按大括号配对，避免截断）
function extractFn(src, header) {
  const start = src.indexOf(header)
  assert.ok(start > 0, 'index.js 里应存在：' + header)
  let i = src.indexOf('{', start), depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('函数体未闭合：' + header)
}

// 真·readDoc + 最小 fs 服务（落地真实临时文件）
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

function tmpCwd(order) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-order-'))
  fs.writeFileSync(path.join(cwd, '.dsh-memory.json'), JSON.stringify({ version: 2, memories: order }, null, 2), 'utf8')
  return cwd
}
const readFileOrder = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, '.dsh-memory.json'), 'utf8')).memories.map((m) => m.id)

// 真·api.js 路由 + 注入依赖 + 假 req/res
function makeApi({ readDoc, writeImpl }) {
  let handler
  const ctx = { effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } } }
  const webServer = { register: (o) => { handler = o.handler; return () => {} } }
  registerApiRoute(ctx, {
    webServer,
    readDoc,
    writeThrough: writeImpl,
    buildCapabilityReport: () => ({}),
    rl: { resetBaseline() {} },
  })
  assert.ok(handler, 'api.js 应注册出 handler')
  const call = (payload) => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    const res = { setHeader() {}, end(s) { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } } }
    handler(req, res)
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(payload))); req.emit('end') })
  })
  return { call }
}

// 忠实写盘：按传入顺序原样落盘（= writeThrough → storeWriteDoc 的行为）
const writeAsGiven = async (cwd, mems) => {
  fs.writeFileSync(path.join(cwd, '.dsh-memory.json'), JSON.stringify({ version: 2, memories: mems }, null, 2), 'utf8')
  return true
}

test('默认读取仍按「最新」重排（内部消费方行为不变）', async () => {
  const readDoc = makeRealReadDoc()
  const cwd = tmpCwd([MEM('a', '2026-01-01T00:00:00Z'), MEM('b', '2026-05-01T00:00:00Z'), MEM('c', '2026-09-01T00:00:00Z')])
  const doc = await readDoc(cwd)
  assert.deepEqual(doc.memories.map((m) => m.id), ['c', 'b', 'a'])
})

test('keepOrder 保留文件里的真实顺序（本次修复的核心）', async () => {
  const readDoc = makeRealReadDoc()
  const cwd = tmpCwd([MEM('a', '2026-01-01T00:00:00Z'), MEM('b', '2026-05-01T00:00:00Z'), MEM('c', '2026-09-01T00:00:00Z')])
  const doc = await readDoc(cwd, { keepOrder: true })
  assert.deepEqual(doc.memories.map((m) => m.id), ['a', 'b', 'c'], 'keepOrder 时必须原样返回文件顺序')
})

test('/list 返回文件真实顺序（设置页看到的就是存下来的顺序）', async () => {
  const readDoc = makeRealReadDoc()
  const cwd = tmpCwd([MEM('b', '2026-05-01T00:00:00Z'), MEM('a', '2026-01-01T00:00:00Z')])
  const { call } = makeApi({ readDoc, writeImpl: writeAsGiven })
  const r = await call({ action: 'list', cwd })
  assert.equal(r.ok, true)
  assert.deepEqual(r.memories.map((m) => m.id), ['b', 'a'], '手动顺序 b,a 必须原样返回（不能被重排成 a,b）')
})

test('端到端：保存排序 → 回读校验通过 → 再读仍是该顺序（真·存住）', async () => {
  const readDoc = makeRealReadDoc()
  const cwd = tmpCwd([MEM('a', '2026-01-01T00:00:00Z'), MEM('b', '2026-05-01T00:00:00Z'), MEM('c', '2026-09-01T00:00:00Z')])
  const { call } = makeApi({ readDoc, writeImpl: writeAsGiven })

  // 用户选「从新到旧」后点保存 → 客户端提交 c,b,a
  const want = ['c', 'b', 'a']
  const saved = await call({ action: 'save', cwd, memories: want.map((id) => MEM(id, { a: '2026-01-01T00:00:00Z', b: '2026-05-01T00:00:00Z', c: '2026-09-01T00:00:00Z' }[id])) })
  assert.equal(saved.ok, true)
  assert.equal(saved.verified, true, '回读校验应通过')
  assert.equal(saved.count, 3)
  assert.deepEqual(readFileOrder(cwd), want, '文件里的顺序应就是提交的顺序')

  const relist = await call({ action: 'list', cwd })
  assert.deepEqual(relist.memories.map((m) => m.id), want, '再次打开设置页应看到保存后的顺序')
})

test('端到端：任意手动顺序（非最新序）也能存住', async () => {
  const readDoc = makeRealReadDoc()
  const cwd = tmpCwd([MEM('a', '2026-01-01T00:00:00Z'), MEM('b', '2026-05-01T00:00:00Z'), MEM('c', '2026-09-01T00:00:00Z')])
  const { call } = makeApi({ readDoc, writeImpl: writeAsGiven })
  const want = ['b', 'a', 'c'] // 既不是文件序，也不是最新序
  const saved = await call({ action: 'save', cwd, memories: want.map((id) => MEM(id, '2026-05-01T00:00:00Z')) })
  assert.equal(saved.verified, true)
  const relist = await call({ action: 'list', cwd })
  assert.deepEqual(relist.memories.map((m) => m.id), want)
})

test('回读不一致时必须 verified=false（绝不谎报成功）', async () => {
  const readDoc = makeRealReadDoc()
  const cwd = tmpCwd([MEM('a', '2026-01-01T00:00:00Z'), MEM('b', '2026-05-01T00:00:00Z')])
  // 故意写一个"错的"顺序（模拟写盘被别的东西重排）
  const badWrite = async (c, mems) => {
    fs.writeFileSync(path.join(c, '.dsh-memory.json'), JSON.stringify({ version: 2, memories: [...mems].reverse() }, null, 2), 'utf8')
    return true
  }
  const { call } = makeApi({ readDoc, writeImpl: badWrite })
  const saved = await call({ action: 'save', cwd, memories: [MEM('a', '2026-01-01T00:00:00Z'), MEM('b', '2026-05-01T00:00:00Z')] })
  assert.equal(saved.ok, true)
  assert.equal(saved.verified, false, '顺序不一致必须上报 verified:false')
  assert.equal(saved.mismatchAt, 0, '应指出首个不同位置')
})
