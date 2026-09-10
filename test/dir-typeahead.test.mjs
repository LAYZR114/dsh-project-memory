// 项目目录 Typeahead 回归（用户 2026-09-11 需求）：
//   ① 输入目录 + 回车 → 加载该目录的记忆（原来只有点"保存"才行）
//   ② 下拉（Typeahead）列出"现有项目"：宿主 collectProjects（本进程见过的 cwd + 活跃会话工作目录）
//      ＋ 本地"最近使用"，可搜索、可用方向键/鼠标选中，选中即加载
// 本测试：宿主聚合函数真单测（从 index.js 抽取）+ 真 api.js 路由 action:projects + client.js 接线断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readDocSync, readMemoryFileMtime } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(here, '..', 'lib')
const INDEX_SRC = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8')
const CLIENT_SRC = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8')
const { registerApiRoute } = await import(pathToFileURL(path.join(LIB, 'api.js')).href)

function extractFn(src, header) {
  const start = src.indexOf(header)
  assert.ok(start > 0, '应存在：' + header)
  let i = src.indexOf('{', start)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('未闭合：' + header)
}
/** 真·collectProjects（注入它引用的闭包变量） */
const makeCollectProjects = () => new Function(
  'knownCwds', 'agents', 'cwdFromAgent', 'readDocSync', 'readMemoryFileMtime', 'MEMORY_FILE',
  extractFn(INDEX_SRC, 'function collectProjects()') + '\nreturn collectProjects',
)(...(() => {
  const knownCwds = new Map()
  const agents = { list: () => [] }
  const cwdFromAgent = (a) => (a && a.session && a.session.header && a.session.header.cwd) || undefined
  return [knownCwds, agents, cwdFromAgent, readDocSync, readMemoryFileMtime, '.dsh-memory.json']
})())

const tmpProject = (memories) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-proj-'))
  if (memories) fs.writeFileSync(path.join(cwd, '.dsh-memory.json'), JSON.stringify({ version: 2, memories }, null, 2), 'utf8')
  return cwd
}
const MEM = (id) => ({ id, title: 't-' + id, description: 'd', body: 'b', type: 'project', status: 'active', updatedAt: '2026-01-01T00:00:00Z', heat: 0 })

/** 真·api.js 路由 + 注入 deps + 假 req/res */
function makeApi(deps) {
  let handler
  const ctx = { effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } } }
  const webServer = { register: (o) => { handler = o.handler; return () => {} } }
  registerApiRoute(ctx, { webServer, readDoc: async () => ({ memories: [] }), writeThrough: async () => true, buildCapabilityReport: () => ({}), rl: { resetBaseline() {} }, ...deps })
  assert.ok(handler, 'api.js 应注册出 handler')
  return {
    call: (payload) => new Promise((resolve, reject) => {
      const req = new EventEmitter(); req.method = 'POST'
      const res = { setHeader() {}, end(s) { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } } }
      handler(req, res)
      setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(payload))); req.emit('end') })
    }),
  }
}

test('collectProjects：合并"见过的 cwd"，带记忆条数；无记忆文件的目录 count=0', () => {
  const knownCwds = new Map()
  const agents = { list: () => [] }
  const cwdFromAgent = (a) => (a && a.session && a.session.header && a.session.header.cwd) || undefined
  const collect = new Function('knownCwds', 'agents', 'cwdFromAgent', 'readDocSync', 'readMemoryFileMtime', 'MEMORY_FILE',
    extractFn(INDEX_SRC, 'function collectProjects()') + '\nreturn collectProjects')(knownCwds, agents, cwdFromAgent, readDocSync, readMemoryFileMtime, '.dsh-memory.json')
  const a = tmpProject([MEM('m1'), MEM('m2')])
  const b = tmpProject([])          // 空目录（连文件都没有）
  knownCwds.set(a, Date.now())
  knownCwds.set(b, Date.now() - 60000) // b 更早见到 → 排在后面
  const out = collect()
  assert.equal(out.length, 2)
  assert.equal(out[0].cwd, a, '最近见到的排前面')
  assert.equal(out[0].count, 2, 'a 有 2 条记忆')
  assert.equal(out[1].cwd, b)
  assert.equal(out[1].count, 0)
  assert.ok(typeof out[0].updatedAt === 'number')
})

test('collectProjects：把活跃会话的工作目录也算作"现有项目"', () => {
  const knownCwds = new Map()
  const live = tmpProject([MEM('x')])
  const agents = { list: () => [{ id: 'a1', session: { header: { cwd: live } } }] }
  const cwdFromAgent = (a) => (a && a.session && a.session.header && a.session.header.cwd) || undefined
  const collect = new Function('knownCwds', 'agents', 'cwdFromAgent', 'readDocSync', 'readMemoryFileMtime', 'MEMORY_FILE',
    extractFn(INDEX_SRC, 'function collectProjects()') + '\nreturn collectProjects')(knownCwds, agents, cwdFromAgent, readDocSync, readMemoryFileMtime, '.dsh-memory.json')
  const out = collect()
  assert.equal(out.length, 1, '活跃会话目录应被收进来')
  assert.equal(out[0].cwd, live)
  assert.equal(out[0].count, 1)
})

test('collectProjects：agents 抛错时不崩（降级为只用已见 cwd）', () => {
  const knownCwds = new Map()
  const a = tmpProject([MEM('k')])
  knownCwds.set(a, Date.now())
  const agents = { list: () => { throw new Error('boom') } }
  const collect = new Function('knownCwds', 'agents', 'cwdFromAgent', 'readDocSync', 'readMemoryFileMtime', 'MEMORY_FILE',
    extractFn(INDEX_SRC, 'function collectProjects()') + '\nreturn collectProjects')(knownCwds, agents, () => undefined, readDocSync, readMemoryFileMtime, '.dsh-memory.json')
  const out = collect()
  assert.equal(out.length, 1)
  assert.equal(out[0].cwd, a)
})

test('collectProjects：去重（末尾斜杠/反斜杠视为同一目录）', () => {
  const knownCwds = new Map()
  const a = tmpProject([MEM('d')])
  knownCwds.set(a, Date.now())
  knownCwds.set(a + '\\', Date.now())
  knownCwds.set(a + '/', Date.now())
  const collect = new Function('knownCwds', 'agents', 'cwdFromAgent', 'readDocSync', 'readMemoryFileMtime', 'MEMORY_FILE',
    extractFn(INDEX_SRC, 'function collectProjects()') + '\nreturn collectProjects')(knownCwds, { list: () => [] }, () => undefined, readDocSync, readMemoryFileMtime, '.dsh-memory.json')
  assert.equal(collect().length, 1, '同一个目录的三种写法应合并成一条')
})

test('API action:projects 返回现有项目列表（真·api.js 路由）', async () => {
  const a = tmpProject([MEM('p1')])
  const api = makeApi({ collectProjects: async () => [{ cwd: a, count: 1, updatedAt: 123, lastSeenAt: 456 }] })
  const r = await api.call({ action: 'projects' })
  assert.equal(r.ok, true)
  assert.equal(r.projects.length, 1)
  assert.deepEqual(Object.keys(r.projects[0]).sort(), ['count', 'cwd', 'lastSeenAt', 'updatedAt'])
})

test('API action:projects 在 collectProjects 缺失时安全返回空数组（不 500）', async () => {
  const api = makeApi({})
  const r = await api.call({ action: 'projects' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.projects, [])
})

test('接线：输入框回车 → submitDir（输入即加载；下拉选中项优先）', () => {
  assert.match(CLIENT_SRC, /if \(e\.key === "Enter"\) \{ e\.preventDefault\(\); submitDir\(\);? \}/, '回车必须触发 submitDir')
  assert.match(CLIENT_SRC, /if \(e\.key === "ArrowDown"\)/, '要支持方向键下')
  assert.match(CLIENT_SRC, /if \(e\.key === "ArrowUp"\)/, '要支持方向键上')
  assert.match(CLIENT_SRC, /if \(e\.key === "Escape"\)/, '要支持 Esc 关闭')
  assert.match(CLIENT_SRC, /const submitDir = \(\) => \{[\s\S]{0,400}?const typed = String\(cwd \|\| ""\)\.trim\(\)/, '回车默认按"输入的目录"加载')
})

test('接线：下拉组件存在且可搜索；选中即加载并记入最近使用', () => {
  assert.match(CLIENT_SRC, /className: "pm-ac"/, '要有下拉容器')
  assert.match(CLIENT_SRC, /const dirFiltered = \(text\) => \{[\s\S]{0,300}?includes\(q\)/, '输入即过滤（子串匹配）')
  assert.match(CLIENT_SRC, /const pickDir = \(c\) => \{ setCwd\(c\); setDirOpen\(false\); setDirHi\(-1\); rememberDir\(c\); load\(c\);? \}/, '选中 → 填框 + 关下拉 + 记最近 + 立即加载')
  assert.match(CLIENT_SRC, /onMouseDown: \(e\) => \{ e\.preventDefault\(\); pickDir\(p\.cwd\); \}/, '鼠标点选（用 mousedown 抢在 blur 前）')
  assert.match(CLIENT_SRC, /onFocus: \(\) => \{ loadDirs\(\); setDirOpen\(true\); \}/, '聚焦时拉取现有项目')
})

test('接线：现有项目来自宿主 action:projects + 本地最近使用，且"保存"按钮等同回车', () => {
  assert.match(CLIENT_SRC, /fetchJson\("\/projects", \{ method: "POST", body: JSON\.stringify\(\{ action: "projects" \}\) \}\)/, '要去宿主取现有项目')
  assert.match(CLIENT_SRC, /localStorage\.getItem\("pm\.recentDirs"\)/, '要合并本地最近使用')
  assert.match(CLIENT_SRC, /h\("button", \{ className: "pm-save", onClick: submitDir \}, "保存"\)/, '"保存"按钮走同一条提交逻辑')
  assert.match(CLIENT_SRC, /if \(r\.ok\) rememberDir\(c\);/, '成功加载过就记入最近使用')
})
