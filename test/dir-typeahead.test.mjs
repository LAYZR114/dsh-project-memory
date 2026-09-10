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

// ===== 「选择目录」功能已于 2026-09-11 按用户要求**整体撤销**（环境不提供可用的系统文件夹对话框）=====

test('已移除：客户端不再有「选择目录」按钮/handler/样式', () => {
  for (const gone of ['选择目录', 'pickFolder', 'pickFolderViaHost', 'openBrowser', 'browseTo', 'getWsPicker', 'pm-pick', 'pm-browse', 'uiWorkspace'])
    assert.ok(!CLIENT_SRC.includes(gone), 'client.js 不应再出现 ' + gone)
  assert.ok(!/action: "pickdir"|action: "browse"/.test(CLIENT_SRC), '客户端不应再调 pickdir/browse 动作')
})

test('已移除：宿主与 API 也不再暴露目录选择能力（不留死代码）', () => {
  for (const gone of ['pickDirectory', 'browseDirectories', 'directoryPickerCapability', 'directoryPicker'])
    assert.ok(!INDEX_SRC.includes(gone), 'index.js 不应再出现 ' + gone)
  const API_SRC = fs.readFileSync(path.join(LIB, 'api.js'), 'utf8')
  for (const gone of ['pickdir', "action === 'browse'", 'pickDirectory', 'browseDirectories'])
    assert.ok(!API_SRC.includes(gone), 'api.js 不应再出现 ' + gone)
  assert.match(API_SRC, /collectProjects/, '现有项目（Typeahead 数据源）必须保留')
})

// ===== 设置页布局：紧凑化（用户反馈"大空位多、按钮要重排"）=====

test('布局：顶部按钮成组右对齐；目录/保存/统计并成一条工具条；统计块不再单独占一行', () => {
  assert.match(CLIENT_SRC, /className: "pm-top-actions"/, '导出/导入/新增 要成组（右对齐），不再散落')
  assert.match(CLIENT_SRC, /className: "pm-toolbar"/, '目录输入+保存+统计要在同一条工具条里')
  assert.match(CLIENT_SRC, /\.pm-toolbar\{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px\}/, '工具条样式必须存在')
  assert.match(CLIENT_SRC, /\.pm-stat-recent\{[^}]*max-width:330px[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/, '"最近：…" 必须单行省略，不能换行撑高')
  assert.ok(!/h\("div", \{ className: "pm-stats" \}/.test(CLIENT_SRC), '不再有独立的 pm-stats 块（已并入工具条）')
  assert.match(CLIENT_SRC, /h\("span", \{ className: "pm-stat", title: "当前项目的记忆条数" \}, "记忆", h\("b", null, memories\.length\)\)/, '记忆数要作为工具条里的小徽标')
  // 用户要求：保存 + 「记忆 N」胶囊紧跟输入框（往左移，与目录搜索框挨着）
  const toolbar = CLIENT_SRC.slice(CLIENT_SRC.indexOf('className: "pm-toolbar"'), CLIENT_SRC.indexOf('className: "pm-bar"'))
  const iSave = toolbar.indexOf('className: "pm-save"')
  const iStat = toolbar.indexOf('记忆", h("b"')
  const iRecent = toolbar.indexOf('pm-stat-recent')
  assert.ok(iSave > 0 && iStat > iSave && iRecent > iStat, '顺序必须是 输入框 → 保存 → 记忆 N → 最近（胶囊紧贴输入框）')
  assert.ok(!/marginLeft: "auto"/.test(toolbar), '保存/记忆胶囊不得再用 margin-left:auto 推到右边')
})

test('布局：标签页/搜索/排序同一行；间距收紧', () => {
  const bar = CLIENT_SRC.slice(CLIENT_SRC.indexOf('className: "pm-bar"'), CLIENT_SRC.indexOf('h("ul", { className: "pm-list"'))
  assert.match(bar, /pm-tab/, '标签页在 pm-bar 里')
  assert.match(bar, /pm-search-btn/, '搜索在 pm-bar 里')
  assert.match(bar, /value: sort/, '排序下拉也在 pm-bar 里（不再单独占一行）')
  assert.match(CLIENT_SRC, /\.pm-bar\{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:nowrap\}/, 'pm-bar 不换行，避免把排序挤到第二行')
  assert.match(CLIENT_SRC, /\.pm-top\{[^}]*margin-bottom:8px\}/, '顶部间距收紧到 8px')
  assert.match(CLIENT_SRC, /\.pm-list\{[^}]*gap:8px/, '列表间距收紧到 8px')
  assert.match(CLIENT_SRC, /\.pm-group\{[^}]*padding:8px 12px/, '分组头 padding 收紧')
})

// ===== 用户第二轮 UI 微调（2026-09-11）：筛选横排 / 搜索可展开 / 排序压窄 / 胶囊左移 =====

test('筛选胶囊：文字必须单行横排（不再竖排）', () => {
  assert.match(CLIENT_SRC, /\.pm-tab\{[^}]*white-space:nowrap[^}]*flex:0 0 auto[^}]*word-break:keep-all/, 'pm-tab 必须 nowrap + 不压缩（否则"全部"会竖排）')
})

test('搜索：**按钮常驻**，点击展开/再点收起；有词时按钮带徽标', () => {
  assert.match(CLIENT_SRC, /const \[searchOpen, setSearchOpen\] = useState\(false\)/, '要有 searchOpen 状态（默认收起）')
  assert.match(CLIENT_SRC, /className: "pm-search-btn" \+ \(\(searchOpen \|\| q\) \? " on" : ""\)/, '按钮**两种状态都常驻**，展开或有词时高亮')
  assert.match(CLIENT_SRC, /onClick: \(\) => setSearchOpen\(\(v\) => !v\)/, '点按钮 = 切换展开/收起（用户要求：再点收起）')
  assert.match(CLIENT_SRC, /searchOpen \? h\("div", \{ key: "search-box", className: "pm-search-box" \}/, '展开时才多出一个输入框盒子（按钮不消失）')
  assert.match(CLIENT_SRC, /q \? h\("span", \{ key: "badge", className: "pm-badge", title: q \}, q\) : null/, '有搜索词时按钮上要显示词的小徽标')
  assert.match(CLIENT_SRC, /\.pm-search-btn\{[^}]*height:30px/, '按钮高度固定 30px（与胶囊/排序对齐）')
  assert.match(CLIENT_SRC, /className: "pm-search-clear", title: "清空搜索"/, '展开态要有清空按钮')
  // 位置：在「已归档」胶囊之后
  const bar = CLIENT_SRC.slice(CLIENT_SRC.indexOf('className: "pm-bar"'), CLIENT_SRC.indexOf('h("ul", { className: "pm-list"'))
  const iTabs = bar.indexOf('"all", "active", "candidate", "archived"')
  const iSearch = bar.indexOf('pm-search-btn')
  assert.ok(iTabs > 0 && iSearch > iTabs, '搜索按钮必须排在四个筛选胶囊之后')
  assert.match(bar, /if \(e\.key === "Escape"\) \{ if \(!q\) setSearchOpen\(false\); else setQ\(""\); \}/, 'Esc：先清词、空词时收起')
})

test('搜索展开不得撑宽整行（防左右滚动条）', () => {
  assert.match(CLIENT_SRC, /\.pm-search-box\{[^}]*flex:0 1 180px[^}]*min-width:0[^}]*overflow:hidden/, '展开盒子 flex:0 1 180px + min-width:0 + overflow:hidden（会主动让位）')
  assert.match(CLIENT_SRC, /\.pm-bar\{[^}]*flex-wrap:nowrap/, 'pm-bar 不换行')
  assert.match(CLIENT_SRC, /\.pm\{[^}]*overflow-x:hidden/, '外层容器禁止横向滚动（双保险）')
  assert.match(CLIENT_SRC, /\.pm-search-box input\{flex:1;min-width:0;/, '输入框吃满盒子剩余宽度（长文本横向滚动，不溢出）')
})

test('排序：常驻最右（不再为搜索让位 —— 让位会撑宽整行）', () => {
  const bar = CLIENT_SRC.slice(CLIENT_SRC.indexOf('className: "pm-bar"'), CLIENT_SRC.indexOf('h("ul", { className: "pm-list"'))
  assert.ok(!/searchOpen && q\)\)/.test(bar), '排序不得再因 searchOpen 让位')
  assert.match(bar, /\(filter !== "archived"\) \? h\("span", \{ style: \{ marginLeft: "auto"/, '排序常驻最右')
})

test('搜索交互细节（参考成熟做法）：光标落位末尾 / ✕ 清空后回焦 / 有词绝不丢弃', () => {
  assert.match(CLIENT_SRC, /const focusEnd = \(el\) => \{[\s\S]{0,200}?el\.setSelectionRange\(n, n\)/, '展开后光标要落在**末尾**（不能顶到开头/全选）')
  assert.match(CLIENT_SRC, /ref: focusEnd,/, '展开的输入框要挂 focusEnd')
  assert.match(CLIENT_SRC, /if \(inp\) inp\.focus\(\);/, '点 ✕ 清空后要**回焦**，用户不用再点一次')
  assert.match(CLIENT_SRC, /if \(e\.key === "Escape"\) \{ if \(!q\) setSearchOpen\(false\); else setQ\(""\); \}/, 'Esc：有词先清词、空词才收起（绝不丢词）')
  assert.match(CLIENT_SRC, /className: "pm-search-clear", title: "清空搜索"/, '✕ 只在有词时出现')
})

test('搜索框宽度：展开后够宽且不溢出（走 flex 让位，不撑破行）', () => {
  assert.match(CLIENT_SRC, /\.pm-search-box\{[^}]*flex:0 1 180px[^}]*min-width:0/, '展开盒 180px 基准、可让位')
  assert.match(CLIENT_SRC, /\.pm-search-box input\{flex:1;min-width:0;/, '输入框吃满盒子剩余宽度（长文本横向滚动）')
  assert.match(CLIENT_SRC, /\.pm-bar\{[^}]*flex-wrap:nowrap/, '不换行，宽度由 flex 分配')
})

test('排序下拉：文案不减、宽度压窄（全角冒号 + 缩短选项文案 + max-width）', () => {
  assert.match(CLIENT_SRC, /\.pm-sort\{flex:0 0 auto;max-width:190px\}/, '排序下拉要限宽')
  for (const label of ['排序：默认', '排序：从新到旧', '排序：重要等级高→低', '排序：自动注入多→少'])
    assert.ok(CLIENT_SRC.includes('"' + label + '"'), '选项文案必须保留（不删字）：' + label)
  assert.match(CLIENT_SRC, /className: "pm-select pm-sort"/, '排序下拉要带 pm-sort 类')
})
