// 项目目录 Typeahead 回归（用户 2026-09-11 需求 + 反馈修正）：
//   ① 输入目录 + 回车 → 加载该目录的记忆（不是每敲一个字就加载/记录）
//   ② 下拉（Typeahead）列出"现有项目"：宿主 collectProjects（本进程见过的 cwd + 活跃会话工作目录）
//      ＋ 本地"最近使用"，可搜索、方向键/鼠标选中，选中即加载
//   ③ 【用户反馈修正】历史只在"明确提交"时记录；**没有记忆文件的目录不进下拉**；老垃圾（D:/D、D:/DS）要清掉
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
/** 真·collectProjects（注入它引用的闭包） */
function makeCollect(knownCwds, agents) {
  const cwdFromAgent = (a) => (a && a.session && a.session.header && a.session.header.cwd) || undefined
  return new Function('knownCwds', 'agents', 'cwdFromAgent', 'readDocSync', 'readMemoryFileMtime', 'MEMORY_FILE',
    extractFn(INDEX_SRC, 'function collectProjects()') + '\nreturn collectProjects')(
    knownCwds, agents, cwdFromAgent, readDocSync, readMemoryFileMtime, '.dsh-memory.json')
}
/** 真·cleanRecentDirs（client.js 抽取的纯函数） */
const cleanRecentDirs = new Function(extractFn(CLIENT_SRC, 'function cleanRecentDirs(') + '\nreturn cleanRecentDirs')()

const tmpProject = (memories) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-proj-'))
  if (memories) fs.writeFileSync(path.join(cwd, '.dsh-memory.json'), JSON.stringify({ version: 2, memories }, null, 2), 'utf8')
  return cwd
}
const MEM = (id) => ({ id, title: 't-' + id, description: 'd', body: 'b', type: 'project', status: 'active', updatedAt: '2026-01-01T00:00:00Z', heat: 0 })

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

test('collectProjects：只列"真有记忆文件"的目录，半截路径被过滤（用户反馈修正）', () => {
  const known = new Map()
  const withFile = tmpProject([MEM('m1'), MEM('m2')])
  const emptyFile = tmpProject([])                                // 有文件但 0 条 → 仍算项目（能看到空列表）
  const noFile = path.join(os.tmpdir(), 'pm-none-' + Date.now())  // 没有记忆文件 → 应被过滤
  known.set(withFile, Date.now())
  known.set(emptyFile, Date.now() - 1000)
  known.set(noFile, Date.now())                                   // 最近见到，但没文件
  const out = makeCollect(known, { list: () => [] })()
  const cwds = out.map((p) => p.cwd)
  assert.ok(cwds.includes(withFile))
  assert.ok(cwds.includes(emptyFile), '有文件但 0 条也要列出（用户可能想往里写）')
  assert.ok(!cwds.includes(noFile), '没有记忆文件的目录必须被过滤（D:/D、D:/DS 这类）')
  assert.equal(out[0].cwd, withFile, '仍按"最近见到"排序')
  assert.equal(out[0].count, 2)
})

test('collectProjects：把活跃会话的工作目录也算作"现有项目"', () => {
  const known = new Map()
  const live = tmpProject([MEM('x')])
  const out = makeCollect(known, { list: () => [{ id: 'a1', session: { header: { cwd: live } } }] })()
  assert.equal(out.length, 1)
  assert.equal(out[0].cwd, live)
  assert.equal(out[0].count, 1)
})

test('collectProjects：agents 抛错时不崩（降级为只用已见 cwd）', () => {
  const known = new Map()
  const a = tmpProject([MEM('k')])
  known.set(a, Date.now())
  const out = makeCollect(known, { list: () => { throw new Error('boom') } })()
  assert.equal(out.length, 1)
  assert.equal(out[0].cwd, a)
})

test('collectProjects：去重（末尾斜杠/反斜杠视为同一目录）', () => {
  const known = new Map()
  const a = tmpProject([MEM('d')])
  known.set(a, Date.now()); known.set(a + '\\', Date.now()); known.set(a + '/', Date.now())
  assert.equal(makeCollect(known, { list: () => [] })().length, 1)
})

test('cleanRecentDirs：清掉盘符根与前缀式半截路径（D:/ 、D:/D、D:/DS）', () => {
  const cleaned = cleanRecentDirs(['D:/', 'D:/D', 'D:/DS', 'D:/DeepSeek', 'D:/DSH', 'C:\\', '', '   '])
  assert.deepEqual(cleaned.slice().sort(), ['D:/DSH', 'D:/DeepSeek'].sort(), '只留两条真实目录')
})

test('cleanRecentDirs：保留不相关目录、去重、幂等', () => {
  const once = cleanRecentDirs(['D:/DeepSeek', 'D:/DeepSeek', 'E:/work/pm'])
  assert.deepEqual(once.slice().sort(), ['D:/DeepSeek', 'E:/work/pm'].sort(), '去重且互不为前缀时都保留')
  assert.deepEqual(cleanRecentDirs(once), once, '幂等：再清一次不变')
})

test('API action:projects 返回现有项目列表（真·api.js 路由）', async () => {
  const a = tmpProject([MEM('p1')])
  const api = makeApi({ collectProjects: async () => [{ cwd: a, count: 1, updatedAt: 123, lastSeenAt: 456 }] })
  const r = await api.call({ action: 'projects' })
  assert.equal(r.ok, true)
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

test('接线（用户反馈修正）：load 里不记历史；只在挂载时自动加载；提交才记录', () => {
  const loadBlock = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const load = useCallback('), CLIENT_SRC.indexOf('// —— 项目目录 Typeahead 助手'))
  assert.ok(!/rememberDir\(/.test(loadBlock), 'load 里不得记历史（否则每敲一个字都进历史）')
  assert.ok(!/\}, \[cwd, load\]\)/.test(CLIENT_SRC), '不能再有"cwd 一变就自动加载"的 effect')
  assert.match(CLIENT_SRC, /useEffect\(\(\) => \{ load\(cwd\); \}, \[\]\)/, '只在挂载时加载一次默认目录')
  const submitBlock = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const submitDir = ('), CLIENT_SRC.indexOf('const exportJson'))
  assert.match(submitBlock, /rememberDir\(typed\)/, '回车/保存 提交后才记历史')
  assert.match(CLIENT_SRC, /const pickDir = \(c\) => \{ setCwd\(c\); setDirOpen\(false\); setDirHi\(-1\); rememberDir\(c\); load\(c\);? \}/, '下拉选择也算明确提交 → 记历史并加载')
})

test('接线：下拉读取历史时先清理；组件与交互齐备', () => {
  assert.match(CLIENT_SRC, /cleanRecentDirs\(JSON\.parse\(localStorage\.getItem\("pm\.recentDirs"\)/, '读历史时先 cleanRecentDirs 清理')
  assert.match(CLIENT_SRC, /className: "pm-ac"/, '要有下拉容器')
  assert.match(CLIENT_SRC, /const dirFiltered = \(text\) => \{[\s\S]{0,300}?includes\(q\)/, '输入即过滤（子串匹配）')
  assert.match(CLIENT_SRC, /onMouseDown: \(e\) => \{ e\.preventDefault\(\); pickDir\(p\.cwd\); \}/, '鼠标点选（mousedown 抢在 blur 前）')
  assert.match(CLIENT_SRC, /onFocus: \(\) => \{ loadDirs\(\); setDirOpen\(true\); \}/, '聚焦时拉取现有项目')
  assert.match(CLIENT_SRC, /fetchJson\("\/projects", \{ method: "POST", body: JSON\.stringify\(\{ action: "projects" \}\) \}\)/, '要去宿主取现有项目')
  assert.match(CLIENT_SRC, /h\("button", \{ className: "pm-save", onClick: submitDir \}, "保存"\)/, '"保存"按钮走同一条提交逻辑')
})

// ===== 「选择目录」按钮（用户 2026-09-11 需求）：走官方 directoryPicker =====

/** 真·目录选择三件套（index.js 抽取；ctx/noteCwd 注入）。
 *  pickDirectory 现在复用同级的 directoryPickerCapability()，两者必须一起抽出来。 */
const makeDirPicker = (ctx, noteCwd = () => {}) => new Function('ctx', 'noteCwd',
  extractFn(INDEX_SRC, 'function directoryPickerCapability(') + '\n'
  + extractFn(INDEX_SRC, 'async function pickDirectory(') + '\n'
  + extractFn(INDEX_SRC, 'async function browseDirectories(') + '\n'
  + 'return { pickDirectory, browseDirectories }')(ctx, noteCwd)
const makePickDirectory = (ctx, noteCwd = () => {}) => makeDirPicker(ctx, noteCwd).pickDirectory

test('pickDirectory：优先用宿主 remote 控制器（= 应用自带的系统文件夹对话框）', async () => {
  const noted = []
  // 控制器可用 → 直接返回路径
  const withCtl = makePickDirectory({
    get: (k) => (k === 'directoryPickerController' ? { pick: async () => 'D:/MIMO Code' } : undefined),
  }, (c) => noted.push(c))
  assert.deepEqual(await withCtl(), { ok: true, cwd: 'D:/MIMO Code' })
  assert.deepEqual(noted, ['D:/MIMO Code'])
  // 控制器返回 null（取消）→ cancelled，不再往下试
  const cancel = makePickDirectory({ get: (k) => (k === 'directoryPickerController' ? { pick: async () => null } : undefined) })
  assert.deepEqual(await cancel(), { ok: false, error: 'cancelled' })
  // 控制器抛错 → 落到下一级（native pick）
  const fallback = makePickDirectory({
    get: (k) => (k === 'directoryPickerController'
      ? { pick: async () => { throw new Error('no client') } }
      : { capability: () => ({ kind: 'native', pick: async () => 'D:/DeepSeek' }) }),
  })
  assert.deepEqual(await fallback(), { ok: true, cwd: 'D:/DeepSeek' })
})

test('pickDirectory：原生能力 → pick() 返回路径即成功，并记入 knownCwds', async () => {
  const noted = []
  const pick = makePickDirectory({ get: () => ({ capability: () => ({ kind: 'native', pick: async () => 'D:/DeepSeek' }) }) }, (c) => noted.push(c))
  assert.deepEqual(await pick(), { ok: true, cwd: 'D:/DeepSeek' })
  assert.deepEqual(noted, ['D:/DeepSeek'], '选中的目录要记进 knownCwds（下次下拉里就有）')
})

test('pickDirectory：用户取消（pick 返回 null）→ cancelled（不当作错误刷屏）', async () => {
  const pick = makePickDirectory({ get: () => ({ capability: () => ({ kind: 'native', pick: async () => null }) }) })
  assert.deepEqual(await pick(), { ok: false, error: 'cancelled' })
})

test('pickDirectory：只有浏览能力（browse）→ 如实上报 browse-only，不假装成功', async () => {
  const pick = makePickDirectory({ get: () => ({ capability: () => ({ kind: 'browse', list: async () => ({}), createDirectory: async () => '' }) }) })
  assert.deepEqual(await pick(), { ok: false, error: 'browse-only', browse: true })
})

test('pickDirectory：服务缺失 / capability 抛错 / pick 抛错 → 各自如实返回错误', async () => {
  assert.match((await makePickDirectory({ get: () => undefined })()).error, /不可用/)
  assert.match((await makePickDirectory({ get: () => ({ capability: () => { throw new Error('boom-cap') } }) })()).error, /boom-cap/)
  const throwing = makePickDirectory({ get: () => ({ capability: () => ({ kind: 'native', pick: async () => { throw new Error('boom-pick') } }) }) })
  assert.match((await throwing()).error, /boom-pick/)
})

test('browseDirectories：browse 能力按路径列目录（兜底浏览对话框的数据源）', async () => {
  const listing = { path: 'D:/DeepSeek', home: 'C:/Users/x', crumbs: [], entries: [{ name: 'a', path: 'D:/DeepSeek/a', hidden: false }], truncated: false }
  let asked = null
  const { browseDirectories } = makeDirPicker({ get: () => ({ capability: () => ({ kind: 'browse', list: async (p) => { asked = p; return listing } }) }) })
  assert.deepEqual(await browseDirectories('D:/DeepSeek'), { ok: true, listing })
  assert.equal(asked, 'D:/DeepSeek', '要把目标路径传给官方 list()')
  assert.deepEqual(await browseDirectories(undefined), { ok: true, listing }, '不给路径 → 用家目录')
  assert.equal(asked, undefined)
})

test('browseDirectories：非 browse 能力 / list 抛错 / 返回不合法 → 如实报错', async () => {
  const nativeOnly = makeDirPicker({ get: () => ({ capability: () => ({ kind: 'native', pick: async () => null }) }) })
  assert.match((await nativeOnly.browseDirectories('D:/')).error, /browse unavailable/)
  const throwing = makeDirPicker({ get: () => ({ capability: () => ({ kind: 'browse', list: async () => { throw new Error('denied') } }) }) })
  assert.match((await throwing.browseDirectories('C:/Windows')).error, /denied/)
  const bad = makeDirPicker({ get: () => ({ capability: () => ({ kind: 'browse', list: async () => ({}) }) }) })
  assert.match((await bad.browseDirectories('D:/')).error, /invalid listing/)
})

test('API action:pickdir 透传宿主结果（成功/取消两种）', async () => {
  const okApi = makeApi({ pickDirectory: async () => ({ ok: true, cwd: 'D:/DeepSeek' }) })
  assert.deepEqual(await okApi.call({ action: 'pickdir' }), { ok: true, cwd: 'D:/DeepSeek' })
  const cancelApi = makeApi({ pickDirectory: async () => ({ ok: false, error: 'cancelled' }) })
  assert.deepEqual(await cancelApi.call({ action: 'pickdir' }), { ok: false, error: 'cancelled' })
})

test('API action:pickdir 在 pickDirectory 缺失时安全返回错误（不 500）', async () => {
  const r = await makeApi({}).call({ action: 'pickdir' })
  assert.equal(r.ok, false)
  assert.match(r.error, /picker unavailable/)
})

test('接线：「选择目录」按钮与「保存」同款同尺寸，选中后切目录并加载；取消静默、无原生能力转自带浏览', () => {
  assert.match(CLIENT_SRC, /className: "pm-save pm-pick", onClick: pickFolder/, '按钮必须与「保存」同款（pm-save）并绑到 pickFolder')
  assert.match(CLIENT_SRC, /\.pm-pick\{display:inline-flex;align-items:center;flex:none;padding:8px 18px;font-size:13px\}/, '尺寸要与 .pm-save 一致（同 padding/字号）')
  const block = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const pickFolder = ('), CLIENT_SRC.indexOf('const persist = (next)'))
  assert.match(block, /action: "pickdir"/, '宿主退回路径要调 action:pickdir')
  assert.match(block, /setCwd\(p\);[\s\S]{0,200}?rememberDir\(p\);[\s\S]{0,200}?load\(p\);/, '选中 → 填框 + 记历史 + 立即加载')
  assert.match(block, /err === "cancelled"\) \{ setMsg\(""\); return; \}/, '取消：静默不打扰')
  assert.match(block, /err === "browse-only" \|\| err === "picker unavailable"\)[\s\S]{0,600}?action: "browse", path: start \|\| undefined/, '没有系统对话框 → 先探测 browse 能力再决定弹不弹自家浏览框')
  assert.match(block, /这个环境没有可用的目录选择器，请直接把路径粘进输入框/, '探测失败要直接告诉用户怎么手输（不弹空对话框）')
})

test('接线：优先用客户端官方服务 uiWorkspace.pickDirectory()（惰性取，服务可能晚注册）', () => {
  assert.match(CLIENT_SRC, /let wsPicker;/, '要有客户端 picker 的模块级引用（软依赖）')
  assert.match(CLIENT_SRC, /clientCtx = ctx;/, 'apply 里要记下客户端 ctx（供惰性重取服务）')
  assert.match(CLIENT_SRC, /const getWsPicker = \(\) => \{[\s\S]{0,400}?clientCtx\.get\("uiWorkspace"\)/, 'getWsPicker：每次点击惰性重取 uiWorkspace')
  assert.match(CLIENT_SRC, /const ws = getWsPicker\(\);/, 'pickFolder 要用惰性取的 ws（不是 apply 时的快照）')
  assert.match(CLIENT_SRC, /\.then\(\(p\) => \{ if \(!finish\(p\)\) setMsg\(""\); \}\)/, '返回 null（取消）时静默')
  assert.match(CLIENT_SRC, /\.catch\(\(\) => pickFolderViaHost\(finish\)\)/, 'uiWorkspace 不可用/抛错 → 退回宿主原生路径')
})

test('接线：自带"选择文件夹"浏览对话框（browse 能力兜底）', () => {
  assert.match(CLIENT_SRC, /className: "pm-confirm pm-browse"/, '要有自带浏览对话框')
  assert.match(CLIENT_SRC, /action: "browse", path: p/, '要调宿主 action:browse 列目录')
  assert.match(CLIENT_SRC, /onClick: \(\) => browseTo\(en\.path\)/, '点子目录进入下一层')
  assert.match(CLIENT_SRC, /\(browse\.listing\.crumbs \|\| \[\]\)\.map/, '要有面包屑（可点回上级）')
  assert.match(CLIENT_SRC, /"选这个文件夹"/, '要有"选这个文件夹"按钮')
})
