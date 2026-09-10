// 适配冒烟：用 mock ctx 真跑插件 apply()，覆盖
//   场景 A：没有 webServer（官方 Electron 壳把 webserver 行 disabled 的情形）→ 必须照常激活
//   场景 B：有 webServer → 设置页 RPC 路由注册
//   功能 C：memory_write 真写入（临时目录）→ memory_recall 触发 LLM 精排（验证 text-delta 修复真的生效）
// 只写临时目录，绝不碰 D:\DeepSeek\.dsh-memory.json。用法：node _smoke_apply.mjs
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'D:/DeepSeek/project-memory-bundle/lib/index.js'
const TMP = 'D:/DeepSeek/_smoke_mem'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

function makeFsStub() {
  return {
    resolve: async (name, opts) => path.resolve((opts && opts.cwd) || process.cwd(), name),
    stat: async (p) => { try { const s = await fs.promises.stat(p); return { size: s.size, mtimeMs: s.mtimeMs, isFile: () => s.isFile(), isDirectory: () => s.isDirectory() } } catch { return undefined } },
    readText: async (p) => fs.promises.readFile(p, 'utf8'),
    writeText: async (p, text) => { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, text, 'utf8') },
    listDir: async (p) => fs.promises.readdir(p),
  }
}

function makeCtx({ withWebServer, llmStream }) {
  const reg = { tools: [], commands: [], contexts: [], listeners: [], effects: [], routes: [], injects: [], lateMounts: 0 }
  const services = {}
  const ctx = {
    tools: { register(def) { reg.tools.push(def); return () => {} } },
    commands: { register(def) { reg.commands.push(def); return () => {} } },
    fs: makeFsStub(),
    agents: { list: () => [], get: () => undefined },
    approval: { request: async () => 'allowed-once' },
    userQuestions: { ask: async (req) => { reg.lastAsk = req; return { answers: [{ questionId: 'confirm', selected: ['approve'] }] } } },
    systemPrompt: { context(c) { reg.contexts.push(c); return () => {} } },
    llm: {
      stream: llmStream ?? (async function* () {}),
      resolveModelInfo: async (p, m) => ({ id: m }),
    },
    on(evt, fn) { reg.listeners.push({ evt, fn }); return () => {} },
    effect(fn, label) { reg.effects.push(String(label || '')); const d = fn(); return () => { try { if (typeof d === 'function') d() } catch {} } },
    get(name) { return services[name] },
    // Cordis 的"软依赖等待"：服务出现后回调（模拟 ctx.inject(['webServer'], cb)）
    inject(deps, cb) { reg.injects.push({ deps, cb }); return { then() {}, dispose() {} } },
    _reg: reg,
    _registerWebServerLate() { const svc = { register(o) { reg.routes.push(o); return () => {} } }; services.webServer = svc; for (const it of reg.injects) { if (it.deps.includes('webServer')) { reg.lateMounts++; it.cb(ctx) } } },
  }
  services.agents = ctx.agents
  services.llm = ctx.llm
  if (withWebServer) services.webServer = { register(o) { reg.routes.push(o); return () => {} } }
  return ctx
}

const fakeAgent = (cwd) => ({
  id: 'smoke-agent',
  options: {},
  session: {
    header: { cwd },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    snapshotEvents: () => [],
  },
})

const mod = await import(pathToFileURL(PLUGIN).href)
console.log('=== 导出核对 ===')
console.log('  exports:', Object.keys(mod).join(', '))
console.log('  name:', mod.name)
console.log('  inject:', JSON.stringify(mod.inject))
const assert = (cond, label) => { console.log((cond ? '  ✔ ' : '  ✘ ') + label); if (!cond) process.exitCode = 1 }

console.log('\n=== 场景 A：没有 webServer（桌面壳 webserver disabled）===')
let ctxA
try { ctxA = makeCtx({ withWebServer: false }); mod.apply(ctxA, { llmProvider: 'deepseek-official', llmModel: 'deepseek-v4-flash' }); assert(true, 'apply() 未抛错（说明 webServer 已不是硬依赖，fiber 不会 PENDING）') }
catch (e) { assert(false, 'apply() 抛错: ' + e.message) }
if (ctxA) {
  const names = ctxA._reg.tools.map(t => t.name)
  assert(names.length === 6, '注册工具 6 个: ' + names.join(','))
  assert(names.includes('memory_read') && names.includes('memory_recall') && names.includes('memory_write') && names.includes('memory_update') && names.includes('memory_delete') && names.includes('memory_pending_changes'), '工具名齐全')
  const cmds = ctxA._reg.commands.map(c => c.name)
  assert(cmds.includes('memory') && cmds.includes('guard'), '命令注册: ' + cmds.join(','))
  assert(ctxA._reg.contexts.length >= 1, '注入 provider 注册: ' + ctxA._reg.contexts.map(c => c.name).join(','))
  const evts = [...new Set(ctxA._reg.listeners.map(l => l.evt))]
  assert(evts.includes('agent/pre-step') && evts.includes('tools/pre-execute') && evts.includes('tools/post-execute'), '监听器: ' + evts.join(','))
  assert(ctxA._reg.routes.length === 0, '无 webServer 时未注册路由（不报错、不阻塞）')
  assert(ctxA._reg.injects.length === 1 && ctxA._reg.injects[0].deps.includes('webServer'), '已挂 ctx.inject([webServer]) 等待它就绪（不 PENDING、不丢路由）')
  assert(ctxA._reg.tools[0].parameters && ctxA._reg.tools[0].output && typeof ctxA._reg.tools[0].execute === 'function', '工具定义形状(name/parameters/output/execute)齐备')
}

console.log('\n=== 场景 B：有 webServer（apply 时就绪）===')
const ctxB = makeCtx({ withWebServer: true })
try { mod.apply(ctxB, {}); assert(true, 'apply() 未抛错') } catch (e) { assert(false, 'apply() 抛错: ' + e.message) }
assert(ctxB._reg.routes.length === 1 && ctxB._reg.routes[0].path === '/project-memory/api', '设置页 RPC 路由立即注册: ' + JSON.stringify(ctxB._reg.routes.map(r => ({ kind: r.kind, path: r.path }))))
assert(ctxB._reg.injects.length === 0, '已就绪时不再重复等待（避免重复挂载）')

console.log('\n=== 场景 D：webServer 在 apply 之后才就绪（本次线上故障的回归用例）===')
const ctxD = makeCtx({ withWebServer: false })
mod.apply(ctxD, {})
assert(ctxD._reg.routes.length === 0, 'apply 时无路由（符合预期）')
ctxD._registerWebServerLate()
assert(ctxD._reg.lateMounts === 1, 'webServer 就绪后 ctx.inject 回调被触发 1 次')
assert(ctxD._reg.routes.length === 1 && ctxD._reg.routes[0].path === '/project-memory/api', '晚到的 webServer 也把设置页 RPC 路由挂上了（修复生效）')

console.log('\n=== 场景 C：写入 3 条记忆 + LLM 精排（验证 text-delta 修复）===')
const agent = fakeAgent(TMP)
// LLM 桩：只发官方真实 chunk 类型 'text-delta'，内容是按 idMap 反序的 JSON（用于验证排序真的被改写）
const ctxC = makeCtx({
  withWebServer: false,
  llmStream: async function* () {
    const doc = JSON.parse(fs.readFileSync(path.join(TMP, '.dsh-memory.json'), 'utf8'))
    const ids = doc.memories.map(m => m.id)
    const ranked = ids.slice().reverse().map((id, i) => ({ id, rank: i + 1, confidence: 0.9 }))
    yield { type: 'text-delta', index: 0, text: JSON.stringify(ranked) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})
mod.apply(ctxC, { llmProvider: 'deepseek-official', llmModel: 'deepseek-v4-flash' })
const tools = new Map(ctxC._reg.tools.map(t => [t.name, t]))
const write = tools.get('memory_write')
const recall = tools.get('memory_recall')
const status = ctxC._reg.commands.find(c => c.name === 'memory')
const base = ['\u9879\u76ee\u7ea6\u5b9a', '\u6784\u5efa\u6d41\u7a0b', '\u6392\u9519\u624b\u518c']
for (const [i, t] of base.entries()) {
  const r = await write.execute({ title: t + '\u6d4b\u8bd5', body: '\u5185\u5bb9 ' + t + ' \u5173\u4e8e\u6784\u5efa\u4e0e\u6392\u9519', description: '\u63cf\u8ff0 ' + t, type: 'project' }, { agent })
  if (i === 0) {
    console.log('  ℹ 确认门实际请求: ' + JSON.stringify(ctxC._reg.lastAsk && ctxC._reg.lastAsk.questions || ctxC._reg.lastAsk).slice(0, 400))
    console.log('  ℹ memory_write 返回: ' + JSON.stringify(r).slice(0, 300))
    assert(r && r.saved === true, 'memory_write 写入成功（确认门走通）')
  }
}
const fileOk = fs.existsSync(path.join(TMP, '.dsh-memory.json'))
assert(fileOk, '临时目录已生成 .dsh-memory.json（真实落盘）')
const rr = await recall.execute({ query: '\u6784\u5efa\u6d41\u7a0b\u6392\u9519' }, { agent })
const got = rr && rr.recalled ? rr.recalled : []
assert(got.length >= 2, 'memory_recall 召回 ' + got.length + ' 条（total=' + (rr && rr.total) + '）')
assert(got.length > 0 && String(got[0].title).indexOf('\u6392\u9519\u624b\u518c') === 0, 'LLM 精排真的改写了顺序（首位=' + (got[0] && got[0].title) + '，桩把它排第 1）')
const st = await status.handler({ commandId: 'c1', agent, rawInput: 'status', attachments: [], signal: new AbortController().signal })
const txt = String(st && st.text || '')
const m = txt.match(/diagRerankRun":?\s*(\d+)/) || txt.match(/diagRerankRun[^0-9]{0,4}(\d+)/)
const runN = m ? Number(m[1]) : -1
assert(runN > 0, 'LLM 精排真的执行了（diagRerankRun=' + runN + '）—— text-delta 修复生效')
const mf = txt.match(/diagRerankFallback":?\s*(\d+)/) || txt.match(/diagRerankFallback[^0-9]{0,4}(\d+)/)
console.log('  ℹ diagRerankFallback=' + (mf ? mf[1] : 'n/a') + (String(txt).includes('text-delta') ? '' : ''))
console.log('\n（临时目录仅本次冒烟使用：' + TMP + '）')
