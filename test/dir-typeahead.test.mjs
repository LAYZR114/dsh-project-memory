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
  assert.match(CLIENT_SRC, /onFocus: \(\) => \{ if \(!dirList\.length && !dirLoadedRef\.current\) loadDirs\(\); \}/, '聚焦只做一次幂等加载（不再每次聚焦都拉取，避免重渲染闪烁）')
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


test('布局：操作条只放 标签页 + 排序（搜索已上移到目录行）；间距收紧', () => {
  const bar = CLIENT_SRC.slice(CLIENT_SRC.indexOf('className: "pm-bar"'), CLIENT_SRC.indexOf('h("ul", { className: "pm-list"'))
  assert.match(bar, /pm-tab/, '标签页在 pm-bar 里')
  assert.ok(!/pm-search/.test(bar), '搜索**不再**在操作条里（已移到「项目目录」那一行）')
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






test('排序下拉：文案不减、宽度压窄（全角冒号 + 缩短选项文案 + max-width）', () => {
  assert.match(CLIENT_SRC, /\.pm-sort\{flex:0 0 auto;max-width:190px\}/, '排序下拉要限宽')
  for (const label of ['排序：默认', '排序：从新到旧', '排序：重要等级高→低', '排序：自动注入多→少'])
    assert.ok(CLIENT_SRC.includes('"' + label + '"'), '选项文案必须保留（不删字）：' + label)
  assert.match(CLIENT_SRC, /className: "pm-select pm-sort"/, '排序下拉要带 pm-sort 类')
})

// ===== 用户第三轮：搜索挪到「项目目录」那一行 =====


// ===== 用户第四轮：搜索控件要与「项目目录」输入框等高 =====

// ===== 用户第四轮（强化）：目录行所有控件必须**固定等高 36px** =====



// ===== 用户定案布局（2026-09-11）：目录行一行紧挨 + 「最近」独立一行在筛选胶囊上方 =====




// ===== 防重复（用户实测"最近胶囊有两个"）：渲染块必须唯一 =====

test('渲染块唯一性：「最近」只出现一次、排序下拉只出现一次（防复制粘贴残留）', () => {
  const count = (re) => (CLIENT_SRC.match(re) || []).length
  // 渲染（h(...)）层面各只能有一处
  assert.equal(count(/className: "pm-recent-row"/g), 1, '「最近」独立行只能有一处渲染')
  assert.equal(count(/className: "pm-stat pm-stat-recent"/g), 1, '「最近：xxx」胶囊只能渲染一次（曾出现两个）')
  assert.equal(count(/className: "pm-select pm-sort"/g), 1, '排序下拉只能渲染一次')
  assert.equal(count(/className: "pm-search"/g), 1, '搜索块只能渲染一次')
  // 注意：pm-save 是**共享样式类**（保存 / 确定导入 / 选这个文件夹…多处复用，属正常）；
  // 真正该唯一的是"目录行里那个保存按钮"，用内容特征判断。
  assert.equal(count(/onClick: submitDir \}, "保存"/g), 1, '目录行的「保存」按钮只能渲染一次')
  assert.equal(count(/className: "pm-stat" \+ \(searchOpen \? " pm-stat-mini" : ""\)/g), 1, '记忆胶囊只能渲染一次')
  // 关键：目录行与筛选行各自的成员，不得互相串场
  const iTool = CLIENT_SRC.indexOf('className: "pm-toolbar"')
  const iRecent = CLIENT_SRC.indexOf('className: "pm-recent-row"')
  const iBar = CLIENT_SRC.indexOf('className: "pm-bar"')
  const iList = CLIENT_SRC.indexOf('h("ul", { className: "pm-list"')
  assert.ok(iTool < iRecent && iRecent < iBar && iBar < iList, '区块顺序必须是 目录行 → 最近行 → 筛选行 → 列表')
  const bar = CLIENT_SRC.slice(iBar, iList)
  assert.ok(!/pm-stat-recent/.test(bar), '筛选行里不得再有「最近」（曾重复导致两个）')
  assert.match(bar, /pm-sort/, '筛选行里必须还有排序下拉')
  assert.ok(!/marginLeft: "auto"/.test(bar), '排序不再顶到最右（改为紧跟「已归档」右边）')
})

// ===== 用户定案：搜索向右展开、「记忆 N」让位动画、零遮挡（2026-09-11） =====



// ===== 搜索与目录行 · 定稿断言（对齐当前真实实现，2026-09-11） =====


test('五控件统一固定高度 36px + 同圆角（不再"哪个矮一截"）', () => {
  for (const [sel, name, extra] of [
    ['\.pm-input\{', '目录输入框', 'border-radius:10px'],
    ['\.pm-save\{', '保存按钮', 'border-radius:10px'],
    ['\.pm-search-btn\{', '搜索按钮', 'border-radius:10px'],
    ['\.pm-search-box\{', '搜索框', 'border-radius:0 10px 10px 0'],
    ['\.pm-stat\{', '记忆胶囊', 'border-radius:999px'],
  ]) {
    const m = CLIENT_SRC.match(new RegExp(sel + '([^}]*)\}'))
    assert.ok(m, name + ' 规则必须存在')
    assert.match(m[1], /height:36px/, name + ' 必须 height:36px')
    assert.match(m[1], /box-sizing:border-box/, name + ' 必须 border-box')
    assert.ok(m[1].includes(extra), name + ' 圆角应为 ' + extra)
  }
})

test('搜索：向右推开（grid 0fr→1fr）+ 「记忆 N」让位动画 + 零遮挡', () => {
  assert.match(CLIENT_SRC, /\.pm-search-slot\{flex:0 0 auto;width:0;overflow:hidden;transition:width \.22s ease-out\}/, '收起态 width:0 + 不可压缩 + 220ms ease-out')
  assert.match(CLIENT_SRC, /\.pm-search-slot\.open\{width:100px\}/, '展开 100px（向右推开胶囊）')
  assert.match(CLIENT_SRC, /\.pm-search-inner\{width:100px;display:flex;align-items:center\}/, '内层固定 100px（外层裁剪，过渡不溢出）')
  assert.ok(!/\.pm-search-box\{[^}]*position:absolute/.test(CLIENT_SRC), '搜索框不得绝对定位覆盖（零遮挡）')
  assert.match(CLIENT_SRC, /\.pm-stat\{[^}]*transition:transform \.22s ease-out/, '胶囊有让位位移动画（被推开是滑过去的）')
  assert.match(CLIENT_SRC, /\.pm-search-btn\.on\{background:#141414;color:#8f8f8f;border-radius:10px 0 0 10px\}/, '展开时按钮右圆角归零 → 与输入框拼成一个整体')
  assert.match(CLIENT_SRC, /searchOpen \? h\("div", \{ key: "slot", className: "pm-search-slot open" \}/, 'slot 只在展开时渲染（收起=卸载，结构性防抢焦点）')
  assert.match(CLIENT_SRC, /onClick: \(\) => \{ if \(searchOpen && !q\) setSearchOpen\(false\); else setSearchOpen\(true\); \}/, '再点按钮：空词收起、有词保持')
  assert.match(CLIENT_SRC, /if \(e\.key === "Escape"\) \{ if \(!q\) setSearchOpen\(false\); else setQ\(""\); \}/, 'Esc：先清词、空词收起')
  assert.match(CLIENT_SRC, /const moveCaretToEnd = \(el\) => \{[\s\S]{0,200}?el\.setSelectionRange\(n, n\)/, '光标落末尾的助手（**只移光标、不抢焦点**）')
  assert.ok(!/const focusEnd = /.test(CLIENT_SRC), '旧的 focusEnd（内含 focus() 且被当回调 ref）必须删除')
})

test('「最近：xxx」独立一行（筛选胶囊上方）、垂直居中、可压缩省略', () => {
  const iRecent = CLIENT_SRC.indexOf('className: "pm-recent-row"')
  const iBar = CLIENT_SRC.indexOf('className: "pm-bar"')
  const iTool = CLIENT_SRC.indexOf('className: "pm-toolbar"')
  assert.ok(iTool < iRecent && iRecent < iBar, '顺序：目录行 → 最近行 → 筛选行')
  assert.match(CLIENT_SRC, /\.pm-recent-row\{display:flex;align-items:center;gap:8px;margin-bottom:8px\}/, '最近行：flex + 垂直居中')
  assert.match(CLIENT_SRC, /\.pm-stat-recent\{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9c9c9\}/, '最近胶囊：可压缩省略 + 提亮')
  assert.ok(!/\.pm-stat-recent\{[^}]*display:block/.test(CLIENT_SRC), '不得 display:block（曾破坏垂直居中）')
  const bar = CLIENT_SRC.slice(iBar, CLIENT_SRC.indexOf('h("ul", { className: "pm-list"'))
  assert.ok(!/pm-stat-recent/.test(bar), '筛选行里不再有「最近」')
  assert.match(bar, /pm-sort/, '筛选行里仍有排序下拉')
})

test('清爽度：核心类各只有 1 条规则（禁止重复追加成屎山）', () => {
  const css = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const CSS = `') + 12, CLIENT_SRC.indexOf('`;', CLIENT_SRC.indexOf('const CSS = `')))
  for (const sel of ['.pm-stat{', '.pm-stat-recent{', '.pm-recent-row{', '.pm-search{', '.pm-search-btn{', '.pm-search-box{', '.pm-search-slot{', '.pm-save{', '.pm-input{', '.pm-toolbar{']) {
    const re = new RegExp('^' + sel.replace(/[.{}]/g, (m) => '\\' + m), 'gm')
    assert.equal((css.match(re) || []).length, 1, sel + ' 必须只有 1 条规则')
  }
  // 精确匹配独立类名（避免把新类 pm-search-inner 误判为废弃的 pm-search-in）
  for (const dead of ['pm-search-lens', 'pm-search-wrap']) assert.ok(!CLIENT_SRC.includes(dead), '废弃类名残留：' + dead)
  assert.ok(!/pm-search-in\{/.test(CLIENT_SRC) && !/@keyframes pm-search-in\{/.test(CLIENT_SRC), '废弃的 pm-search-in 动画/规则已清')
  assert.match(CLIENT_SRC, /\.pm-search-inner\{width:100px;display:flex;align-items:center\}/, '新类 pm-search-inner 存在（固定 100px 由外层裁剪）')
})

// ===== 用户定案图（2026-09-11 第二轮）：按图逐条落实 =====

test('搜索收起态真的不占宽（width:0 + 不可压缩）→ 保存按钮不会被挤出屏', () => {
  const m = CLIENT_SRC.match(/\.pm-search-slot\{([^}]*)\}/)
  assert.ok(m, '.pm-search-slot 规则必须存在')
  assert.match(m[1], /width:0/, '收起态 width 必须为 0')
  assert.match(m[1], /flex:0 0 auto/, '槽必须不可压缩')
  assert.match(m[1], /overflow:hidden/, '槽要裁剪（收起时不显示内容）')
  // 回归防线：槽内固定宽元素绝不能再让"最小内容宽度"变大
  assert.ok(!/\.pm-search-slot\{[^}]*display:grid/.test(CLIENT_SRC), '不得再回到 grid 0fr 方案（它会让内部固定宽计入最小内容宽度）')
})

test('展开的搜索框与按钮拼成一个整体（按钮右圆角归零 + 输入框左边框去掉）', () => {
  assert.match(CLIENT_SRC, /\.pm-search-btn\.on\{[^}]*border-radius:10px 0 0 10px/, '展开时按钮右圆角归零')
  assert.match(CLIENT_SRC, /\.pm-search-box\{[^}]*border-left:none/, '输入框左边框去掉')
  assert.match(CLIENT_SRC, /\.pm-search-box\{[^}]*border-radius:0 10px 10px 0/, '输入框右圆角保留')
})

test('点按钮展开后可以正常打字：不得有"失焦自动收起"', () => {
  assert.ok(!/onBlur: \(\) => setTimeout\(\(\) => \{ if \(!q\) setSearchOpen\(false\) \}, 150\)/.test(CLIENT_SRC), '不得有失焦自动收起（会让刚展开就收起）')
  assert.match(CLIENT_SRC, /onClick: \(\) => \{ if \(searchOpen && !q\) setSearchOpen\(false\); else setSearchOpen\(true\); \}/, '只有再点按钮才收起')
  // 剥离注释后再查（注释里正解释"为什么不能用 autoFocus"，直接搜会被注释骗到）
  const codeOnly = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => {
    const q1 = line.indexOf('"'), q2 = line.lastIndexOf('"')
    const slash = line.indexOf('//')
    if (slash >= 0 && !(q1 >= 0 && slash > q1 && slash < q2)) return line.slice(0, slash)
    return line
  }).join('\n')
  assert.ok(!/autoFocus/.test(codeOnly), '代码中不得使用 autoFocus（该输入框始终在 DOM 中，每次重渲染都抢焦点 → 用户点目录框时字打进搜索框）')
  assert.match(CLIENT_SRC, /const searchInputRef = useRef\(null\)/, '改为在展开时用 effect 聚焦一次')
  assert.match(CLIENT_SRC, /\}, \[searchOpen\]\);/, '聚焦 effect 以 searchOpen 为依赖')
})

// ===== 防"注释吞代码"（2026-09-12 真实事故：保存按钮被 // 整行注掉，测试与自查全被骗过） =====
// 教训：按**源码字符串**匹配无法区分"真代码"和"注释里的代码"。
// 因此这里改用**剥离注释后**再匹配，并额外断言关键元素位于可执行行。

test('剥离注释后，目录行的关键控件必须仍然存在（防被注释吞掉）', () => {
  // 剥离 // 行注释与 /* */ 块注释（保留字符串内的内容近似处理：本文件注释不含引号拼接，够用）
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // 行内 // 之后视为注释（若 // 出现在引号内则保守不裁，交给下面的"代码行"断言兜底）
      const q1 = line.indexOf('"'), q2 = line.lastIndexOf('"')
      const slash = line.indexOf('//')
      if (slash >= 0 && !(q1 >= 0 && slash > q1 && slash < q2)) return line.slice(0, slash)
      return line
    })
    .join('\n')

  const CODE = strip(CLIENT_SRC)
  const must = [
    ['保存按钮', /h\("button", \{ className: "pm-save", onClick: submitDir \}, "保存"\)/],
    ['搜索按钮', /className: "pm-search-btn" \+ \(\(searchOpen \|\| q\) \? " on" : ""\)/],
    ['搜索槽', /searchOpen \? h\("div", \{ key: "slot", className: "pm-search-slot open" \}/],
    ['记忆胶囊', /className: "pm-stat" \+ \(searchOpen \? " pm-stat-mini" : ""\)/],
    ['最近行', /className: "pm-recent-row"/],
    ['排序下拉', /className: "pm-select pm-sort"/],
  ]
  for (const [name, re] of must) assert.match(CODE, re, name + ' 必须出现在**非注释代码**中（曾被注释吞掉）')
})

test('关键控件的渲染语句必须独占可执行行（不得与 // 同行）', () => {
  const lines = CLIENT_SRC.split('\n')
  const keys = ['"pm-save"', '"pm-search-btn"', '"pm-stat" + (searchOpen ? " pm-stat-mini" : "")', '"pm-select pm-sort"', '"pm-recent-row"']
  for (const k of keys) {
    const hit = lines.findIndex((l) => l.includes(k))
    assert.ok(hit >= 0, '必须存在：' + k)
    const line = lines[hit]
    const idx = line.indexOf(k)
    const before = line.slice(0, idx)
    if (before.includes('//')) {
      // 只有当 "//" 位于引号之外时才算被注释
      const q1 = before.indexOf('"'), q2 = before.lastIndexOf('"')
      const slash = before.indexOf('//')
      assert.ok(q1 >= 0 && slash > q1 && slash < q2, '第 ' + (hit + 1) + ' 行的 ' + k + ' 不得被 // 注释掉')
    }
  }
})

test('整文件不得存在"注释后紧跟代码"的吞行（结构化扫描）', () => {
  const lines = CLIENT_SRC.split('\n')
  const bad = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith('//')) continue
    const m = line.match(/\/\/[^\n]*?(?<!\S)\s{0,4}(h\(|const |let |return |if \(|for \()/)
    if (!m) continue
    const idx = line.indexOf('//')
    const commentPart = line.slice(idx, line.indexOf(m[1], idx))
    if (commentPart.length < 60) bad.push('L' + (i + 1))
  }
  assert.deepEqual(bad, [], '这些行疑似"注释吞掉代码"：' + bad.join(', '))
})

// ===== 用户三条硬约束（2026-09-12）：紧贴 / 向右展开 / 🔍 位置不变 =====

test('约束①：收起态四个控件紧贴（输入框不抢剩余空间，空白归胶囊）', () => {
  // 输入框不得用 flex:1（那会吃掉剩余空间 → 与保存/🔍之间出现大空白，用户实测图）
  const m = CLIENT_SRC.match(/\.pm-toolbar \.pm-ac-wrap\{([^}]*)\}/)
  assert.ok(m, '目录输入框样式必须存在')
  assert.ok(!/flex:1\s/.test(m[1]) && !/flex:1;/.test(m[1]), '输入框不得用 flex:1 抢占剩余空间（否则与后面控件不紧贴）')
  assert.match(m[1], /width:170px/, '输入框给固定基准宽度 240px')
  assert.match(m[1], /flex:0 0 auto/, '外壳**禁止伸缩**（flex:0 0 auto，彻底不参与抢空间）')
  // 行尾空白必须由胶囊吸走 → 前面几个自然紧贴
  assert.match(CLIENT_SRC, /\.pm-toolbar \.pm-stat\{margin-left:auto\}/, '胶囊用 margin-left:auto 吸收行尾空白，保证前面紧贴')
  // 其余控件不可压缩
  for (const [sel, name] of [['\.pm-save\{', '保存按钮'], ['\.pm-search\{', '搜索容器'], ['\.pm-search-btn\{', '搜索按钮'], ['\.pm-stat\{', '记忆胶囊']]) {
    const mm = CLIENT_SRC.match(new RegExp(sel + '([^}]*)\}'))
    assert.ok(mm && /flex:0 0 auto/.test(mm[1]), name + ' 必须 flex:0 0 auto')
  }
})

test('约束②③：搜索框在🔍**右侧**展开，且展开时🔍位置不变', () => {
  // 结构顺序：按钮在前、搜索槽在后 → 只可能向右展开
  const iBtn = CLIENT_SRC.indexOf('className: "pm-search-btn"')
  const iSlot = CLIENT_SRC.indexOf('className: "pm-search-slot open"')
  assert.ok(iBtn > 0 && iSlot > iBtn, '搜索槽必须排在🔍按钮**之后**（向右展开）')
  // 🔍 自身固定 40px 且不可压缩
  assert.match(CLIENT_SRC, /\.pm-search-btn\{[^}]*width:40px[^}]*flex:0 0 auto/, '🔍 固定 40px 且不可压缩（展开时自身不动）')
  // 唯一宽度变化源必须是🔍**之后**的槽
  assert.match(CLIENT_SRC, /\.pm-search-slot\{flex:0 0 auto;width:0;overflow:hidden;transition:width \.22s ease-out\}/, '槽收起 0 宽（唯一变化源）')
  assert.match(CLIENT_SRC, /\.pm-search-slot\.open\{width:100px\}/, '槽展开 100px')
  // 👇 关键不变量：🔍 左边的控件在展开前后**宽度必须完全一致**。
  // 反例（曾真实存在）：`.pm-toolbar.pm-toolbar-search .pm-ac-wrap{width:100px}`。
  // 输入框在🔍左边，缩它会把 保存/🔍 一起向左拽 —— 静态解析结果 x: 340 → 300（正好 −40px），
  // 与用户硬约束③「点搜索按钮，按钮自身位置不能移动」直接冲突。
  const css = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const CSS = `') + 12, CLIENT_SRC.indexOf('`;', CLIENT_SRC.indexOf('const CSS = `')))
  // 只看**状态选择器**：形如 `.pm-toolbar.<state> ...{...}`，即工具条上挂了状态类名的规则。
  // 正常的基础规则 `.pm-toolbar .pm-ac-wrap{...}`（无状态类）不算，它是收起/展开共用的固定宽度。
  const stateRules = [...css.matchAll(/\.pm-toolbar\.[\w-]+[^{]*\{[^}]*\}/g)].map((m) => m[0])
  assert.deepEqual(
    stateRules, [],
    '展开态不得有任何改宽度的状态规则（会拖动🔍）：' + stateRules.join(' / '),
  )
  assert.ok(!/pm-toolbar-search/.test(CLIENT_SRC), 'pm-toolbar-search 死类名已移除（展开改宽度方案已废弃）')
})

// ===== CSS 冲突守卫（2026-09-12 事故：.pm-ac-wrap 上 flex:1 覆盖工具条宽度规则 → 改了多轮不生效） =====

test('目录输入外壳(.pm-ac-wrap)只能有一条规则声明布局宽高（禁止多处竞争）', () => {
  const css = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const CSS = `') + 12, CLIENT_SRC.indexOf('`;', CLIENT_SRC.indexOf('const CSS = `')))
  const rules = []
  for (const line of css.split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('/*') || l.startsWith('*')) continue
    for (const m of l.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].includes('pm-ac-wrap')) rules.push({ sel: m[1].trim(), body: m[2].trim() })
    }
  }
  const withFlex = rules.filter((r) => /(^|;)\s*flex\s*:/.test(r.body))
  assert.equal(withFlex.length, 1, '只能有 1 条规则声明 flex（当前 ' + withFlex.length + ' 条：' + withFlex.map((r) => r.sel).join(' / ') + '）')
  // 基础规则（单类选择器）不得再声明宽度/伸缩，避免与工具条规则竞争
  const base = rules.find((r) => r.sel === '.pm-ac-wrap')
  assert.ok(base, '.pm-ac-wrap 基础规则必须存在（给下拉做定位基准）')
  assert.match(base.body, /position:relative/, '基础规则只负责定位')
  assert.ok(!/flex\s*:/.test(base.body), '.pm-ac-wrap 基础规则**不得**再写 flex（曾覆盖工具条宽度规则）')
  assert.ok(!/min-width\s*:/.test(base.body), '.pm-ac-wrap 基础规则不得写 min-width（交给工具条规则）')
})

test('CSS 不得出现"同选择器两条规则声明同一布局属性"（结构化扫描）', () => {
  const css = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const CSS = `') + 12, CLIENT_SRC.indexOf('`;', CLIENT_SRC.indexOf('const CSS = `')))
  const byKey = new Map()
  for (const line of css.split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('/*') || l.startsWith('*')) continue
    for (const m of l.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim()
      if (!sel || sel.startsWith('@') || /^[0-9.]+%$/.test(sel) || sel === 'from' || sel === 'to') continue
      for (const decl of m[2].split(';')) {
        const k = decl.split(':')[0].trim()
        if (!['flex', 'width', 'min-width', 'max-width', 'height'].includes(k)) continue
        const key = sel + '|' + k
        byKey.set(key, (byKey.get(key) || 0) + 1)
      }
    }
  }
  const bad = [...byKey.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  assert.deepEqual(bad, [], '同选择器重复声明布局属性（易造成"改了不生效"）：' + bad.join(', '))
})

test('CSS 模板内不得出现反引号（会提前闭合模板字符串 → 语法错，本轮踩坑 3 次）', () => {
  const tpl = CLIENT_SRC
  const start = tpl.indexOf('const CSS = `') + 'const CSS = `'.length
  const end = tpl.indexOf('`;', start)
  assert.ok(start > 12 && end > start, '必须能定位 CSS 模板区间')
  const cssSeg = tpl.slice(start, end)
  const backticks = (cssSeg.match(/`/g) || []).length
  assert.equal(backticks, 0, 'CSS 段内出现 ' + backticks + ' 个反引号（会把模板字符串截断，导致整份客户端代码语法错误）')
})

// ===== 三个真实缺陷的修复回归（结构审计发现，2026-09-12）=====

test('缺陷①：编辑/新增/删除三条写盘路径必须检查 ok 与 verified（不得谎报成功）', () => {
  // 统一入口 commitEdit 必须同时检查 ok 与 verified
  assert.match(CLIENT_SRC, /const commitEdit = \(next, okMsg, onOk\) => \{/, '必须存在统一的 commitEdit 入口')
  const m = CLIENT_SRC.match(/const commitEdit = \(next, okMsg, onOk\) => \{[\s\S]*?\n\t*\};/)
  assert.ok(m, '必须能取出 commitEdit 实现')
  assert.match(m[0], /if \(!r \|\| !r\.ok\)/, 'commitEdit 必须检查 ok')
  assert.match(m[0], /if \(!r\.verified\)/, 'commitEdit 必须检查 verified（回读校验）')
  assert.match(m[0], /load\(cwd, \{ keepMsg: true \}\)/, '失败必须重新载入磁盘真实数据（不留下乐观假象）')
  // 三处调用必须都走 commitEdit，且不得再有"不看结果就报成功"的旧写法
  assert.match(CLIENT_SRC, /commitEdit\(next, "已保存", \(\) => \{ setEditingId\(null\); setDraft\(null\); \}\)/, '编辑走 commitEdit')
  assert.match(CLIENT_SRC, /commitEdit\(next, "已新增", \(\) => \{ setEditingId\(null\); setDraft\(null\); \}\)/, '新增走 commitEdit')
  assert.match(CLIENT_SRC, /commitEdit\(next, "已删除", \(\) => \{ setPendingDeleteId\(null\); \}\)/, '删除走 commitEdit')
  // ⚠️ 必须**剥离注释**后再查：注释里正描述着这条历史缺陷，直接搜会被注释骗到（本轮踩过同类坑）
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => {
      const q1 = line.indexOf('"'), q2 = line.lastIndexOf('"')
      const slash = line.indexOf('//')
      if (slash >= 0 && !(q1 >= 0 && slash > q1 && slash < q2)) return line.slice(0, slash)
      return line
    }).join('\n')
  const CODE = stripComments(CLIENT_SRC)
  const bad = CODE.match(/persist\(next\)\.then\(\(\) => \{ setMemories\(next\)/g) || []
  assert.equal(bad.length, 0, '（剥离注释后）不得再有"不看 ok/verified 就 setMsg(已保存)"的旧写法（发现 ' + bad.length + ' 处）')
})

test('缺陷②：「撤销」按钮不得依赖提示消息是否存在', () => {
  assert.match(CLIENT_SRC, /\(msg \|\| undoOrder\) \? h\("div", \{ className: "pm-msg" \}/, '有消息或有撤销时都要渲染提示条')
  assert.match(CLIENT_SRC, /msg \|\| "顺序已改变"/, '没有消息时给一句默认文案，保证撤销按钮可见')
  assert.ok(!/msg \? h\("div", \{ className: "pm-msg" \}, msg, undoOrder \?/.test(CLIENT_SRC), '不得再写成"仅当 msg 存在才渲染（撤销会随之消失）"')
})

test('缺陷③：死状态/死变量已清除', () => {
  assert.ok(!/const \[collapsed, setCollapsed\]/.test(CLIENT_SRC), 'collapsed 死状态已删除')
  assert.ok(!/const statusLabel = \{/.test(CLIENT_SRC), 'statusLabel 死变量已删除')
})

// ===== 修复"点目录输入框就闪、无法输入"（2026-09-12 用户实测）=====

test('目录输入框不得再"聚焦即打开下拉"（那是闪烁的来源）', () => {
  // 旧写法（导致闪烁循环）：onFocus 打开下拉 + onChange 打开下拉 + onBlur 延迟关闭
  assert.ok(!/onFocus: \(\) => \{ loadDirs\(\); setDirOpen\(true\); \}/.test(CLIENT_SRC), 'onFocus 不得再直接 setDirOpen(true)（聚焦打开 → 抖动关闭 → 再打开 = 闪烁）')
  assert.ok(!/onBlur: \(\) => setTimeout\(\(\) => setDirOpen\(false\), 150\)/.test(CLIENT_SRC), 'onBlur 不得再延迟关闭（延迟窗口内重渲染会造成抖动）')
  // 新写法：onBlur 立即关闭；下拉仅在有匹配项时渲染
  assert.match(CLIENT_SRC, /onBlur: \(\) => setDirOpen\(false\)/, 'onBlur 立即关闭下拉')
  assert.match(CLIENT_SRC, /\(dirOpen && dirFiltered\(cwd\)\.length\)\s*\n?\s*\? h\("ul", \{ className: "pm-ac" \}/, '仅当"已打开且有匹配项"时才渲染下拉（空列表不再闪出空面板）')
  // 幂等加载：聚焦不重复请求
  assert.match(CLIENT_SRC, /const dirLoadedRef = useRef\(false\)/, '必须有 dirLoadedRef 标记')
  assert.match(CLIENT_SRC, /dirLoadedRef\.current = true/, '加载完成后要置标记')
})

test('输入框提示文本要精简（过长会被截断显示不全）', () => {
  const m = CLIENT_SRC.match(/placeholder: "输入项目目录，回车加载"/)
  assert.ok(m, '目录输入框提示应为"输入项目目录，回车加载"（原文本过长被截断）')
  assert.match(CLIENT_SRC, /placeholder: "搜索…"/, '搜索框提示应为"搜索…"（宽度缩到 100px，"搜索记忆…"显示不全）')
})

// ===== 焦点守卫（2026-09-12 二次事故：回调 ref 里调 focus() 导致每次渲染抢焦点）=====

test('搜索输入框的聚焦只能有一个入口（useEffect），ref 回调绝不可含 focus', () => {
  // 剥离注释，只看真实代码
  const code = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => {
    const q1 = line.indexOf('"'), q2 = line.lastIndexOf('"')
    const slash = line.indexOf('//')
    if (slash >= 0 && !(q1 >= 0 && slash > q1 && slash < q2)) return line.slice(0, slash)
    return line
  }).join('\n')

  // ① 不得有 autoFocus
  assert.ok(!/autoFocus/.test(code), '代码中不得有 autoFocus')
  // ② 回调 ref 里不得出现 focus(
  const refLines = code.split('\n').filter((l) => /ref:\s*\(el\)\s*=>/.test(l))
  assert.ok(refLines.length > 0, '应存在回调 ref')
  for (const l of refLines) {
    assert.ok(!/\.focus\(/.test(l), '回调 ref 内不得调用 focus()（每次渲染都会执行 → 抢焦点）：' + l.trim())
  }
  // ③ 全文 focus() 调用点数量受限（只允许：展开时聚焦、清空后回焦）
  // 先把**行内块注释**也剥掉（如 `catch (e) { /* 忽略 */ }`），否则会把注释里的内容算进调用数
  const codeNoInline = code.replace(/\/\*[\s\S]*?\*\//g, '')
  const focusCalls = (codeNoInline.match(/\.focus\(\)/g) || []).length
  assert.ok(focusCalls <= 2, '全文 focus() 调用不得超过 2 处（展开聚焦 / 清空回焦），实际 ' + focusCalls + ' 处')
  // ④ 核心不变量：searchOpen=false ⟹ DOM 中**不存在**搜索输入框（结构性根治，比"只聚焦一次"标记更强）
  assert.match(CLIENT_SRC, /searchOpen \? h\("div", \{ key: "slot", className: "pm-search-slot open" \}/, 'input 必须随 slot 一起条件渲染（收起=卸载）')
  assert.match(CLIENT_SRC, /\]\)\)\) : null,/, '条件渲染必须有 : null 分支（收起时不渲染）')
  assert.ok(!/searchFocusedOnceRef\.current = true/.test(CLIENT_SRC), '不再依赖"只聚焦一次"标记（元素展开时才创建）')
  // 依赖性警告：确保依赖数组只含 searchOpen（加 q 会导致每次输入都聚焦 → 抢焦点第三次复发）
  assert.match(CLIENT_SRC, /\}, \[searchOpen\]\);/, '聚焦 effect 依赖必须恰为 [searchOpen]')
  assert.ok(!/\}, \[searchOpen, q\]\);/.test(CLIENT_SRC), '依赖中绝不可加入 q')
  // ⑤ 光标工具只移光标、不抢焦点
  assert.match(CLIENT_SRC, /const moveCaretToEnd = \(el\) => \{\s*\n\s*if \(!el\) return;\s*\n\s*try \{ const n = String\(el\.value \|\| ""\)\.length; el\.setSelectionRange\(n, n\) \}/, 'moveCaretToEnd 只做 setSelectionRange（不得含 focus）')
})
