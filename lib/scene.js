// L2 场景触发层：detectScene(env) 四源归一 → deriveLevel → extractFragment → cap3+去重 → sceneCache
// 纯函数 export（供 selftest，零 ctx 可测）；createScene 工厂是 L2 唯一写入点（sceneCache/behaviorCache）。
// 依赖 store.js 纯核（buildInvert/deriveLevel/organizeBody/computeIdf/idfOf/norm/tokenizeRare），
// 不反向依赖 index.js / first.js——接线时在 index.js import 本层替换 detectHits+sceneInject。
// GLM §6 前提（L2 合并行为提醒时 P1 不置顶不许合并）：rankScene 等级主键 + renderScene 显式分区，
// 双保险保证 [P1·红线] 恒置顶；行为行（Behavior）由 plan 单独返回、调用方拼在 L2 文本尾部。

import { buildInvert, deriveLevel, organizeBody, computeIdf, idfOf, norm, tokenizeRare } from './store.js'
export { deriveLevel } // 复出：级别派生唯一出处（store.js），场景层转发防双维护漂移

// ---- 默认场景域表（GLM 场景路由表：后缀→域 token；Config 可经 createScene({domains}) 参数化覆盖）----
export const DEFAULT_SCENE_DOMAINS = {
  json: ['json', '配置', '数据'],
  yml: ['yml', 'yaml', '配置'],
  md: ['md', 'markdown', '文档'],
  js: ['js', 'javascript', '代码'],
  ts: ['ts', 'typescript', '代码'],
}
export const DEFAULT_READ_TOOLS = ['read', 'grep', 'cat', 'ls', 'glob', 'read_file', 'read_text']

// ---- 仲裁权重（rankScene 用）：等级 > 场景权重 > IDF > 命中数 > 新旧，全部确定性 ----
export const LEVEL_RANK = { 'P1·红线': 3, 'P2·常设': 2, 'P3·情境': 1 }
export const SCENE_WEIGHT = { file: 4, memory: 3, utt: 2, bash: 1 }

// ---- detectScene：四源归一（file 域 > memory_* > bash/pwsh 行为 > 话语倒排）----
// env = { cwd?, tool?, filePath?, input?, memories?|doc?, invert?, domains?, readTools? }
//   返回值：{ source, domain?, ids[], behavior?, clearBehavior?, hits? }
//     source: 'file'|'memory'|'bash'|'utt'|'read'|'none'（单一源，按优先级短路）
//     domain: file 源命中的后缀（'js' 等）
//     ids:    话题片段候选 id（bash/read/none 恒空）
//     behavior: {cat:'file'|'exec'|'memory', ids:P1红线id}——行为行载荷（bash/pwsh 纯行为行）
//     clearBehavior: read=true（清旧：行为行清除信号；话题片段不清，调用方保留现场景）
//     hits:   utt 源 id→命中词数（供 rankScene 次级排序）
export function detectScene(env = {}) {
  const doc = env.doc || (env.memories ? { memories: env.memories } : null)
  const mems = (doc && Array.isArray(doc.memories)) ? doc.memories : []
  const tool = String(env.tool || '').toLowerCase()
  const readTools = env.readTools || DEFAULT_READ_TOOLS
  const isRead = readTools.includes(tool) || /^(read|grep|cat|ls|glob)/.test(tool)
  const isDom = /^(write|edit|str_replace_editor)/.test(tool)
  const isMem = /^memory_(write|update|delete)/.test(tool)
  const isExec = /^(pwsh|bash|node|subprocess|shell|exec)/.test(tool)
  const active = mems.filter((m) => m.status !== 'archived' && m.type !== 'state')
  const redlineIds = active.filter((m) => m.obligation === true || m.pinned === true).map((m) => m.id)

  // 读类：只清旧不新注（行为行清除信号；topic ids 恒空——不清话题片段）
  if (isRead) return { source: 'read', ids: [], clearBehavior: true }

  // ① file 域（write|edit|str_replace_editor）：后缀→域表→triggers/tags/title 含域 token
  if (isDom) {
    const domains = env.domains || DEFAULT_SCENE_DOMAINS
    const path = String(env.filePath || env.path || '').toLowerCase()
    const ext = /\.([a-z0-9]+)$/.test(path) ? path.replace(/^.*\./, '') : ''
    let doms = domains[ext] || []
    if (!doms.length) { for (const [k, v] of Object.entries(domains)) if (path.endsWith('.' + k)) { doms = v; break } }
    let ids = []
    if (doms.length) {
      ids = active.filter((m) => {
        const hay = ((m.triggers || []).join(' ') + ' ' + (m.tags || []).join(' ') + ' ' + (m.title || ''))
        return doms.some((t) => {
          const tl = String(t).toLowerCase()
          if (/^(js|ts)$/.test(tl)) return new RegExp(`(^|[^a-z])${tl}($|[^a-z])`).test(String(hay).toLowerCase())  // js/ts 词边界（避免 'js'⊂'json' 误命中）
          return hay.indexOf(t) >= 0
        })
      }).map((m) => m.id)
      if (!ids.length) ids = redlineIds.slice() // 域空命中：红线兜底（红线重点）
    } else ids = redlineIds.slice() // 无域表：纯红线兜底
    return { source: 'file', domain: doms.length ? ext : undefined, ids, behavior: { cat: 'file', ids: redlineIds } }
  }

  // ② memory_*：相关记忆 = P1 ∪ type:user ∪ type:project（红线+画像+项目态）
  if (isMem) {
    const ids = active.filter((m) => m.obligation === true || m.pinned === true || m.type === 'user' || m.type === 'project').map((m) => m.id)
    return { source: 'memory', ids, behavior: { cat: 'memory', ids: redlineIds } }
  }

  // ③ bash|pwsh：纯行为行（不注话题片段）
  if (isExec) return { source: 'bash', ids: [], behavior: { cat: 'exec', ids: redlineIds } }

  // ④ 话语倒排（input→buildInvert 命中，按命中词数预排序）
  const input = String(env.input || '')
  if (!input || !mems.length) return { source: 'none', ids: [], hits: {} }
  const inv = env.invert || buildInvert({ memories: mems })
  const counts = new Map()
  for (const [w, ids] of inv.entries()) {
    if (input.indexOf(w) === -1) continue
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1)
  }
  const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
  if (!ids.length) return { source: 'none', ids: [], hits: {} }
  return { source: 'utt', ids, hits: Object.fromEntries(counts) }
}

// ---- rankScene：优先级仲裁（结果序即注入序）----
// scored: [{m, source?, idf?, hit?}]；env: {cap=3, doc?}（doc 用于 IDF 兜底计算）
// 排序键：等级（P1>P2>P3 恒置顶）→ 场景权重（file>memory>utt>bash）→ IDF → 命中数 → updatedAt。
export function rankScene(scored, env = {}) {
  const cap = typeof env.cap === 'number' ? env.cap : 3
  const e = env.doc ? computeIdf(env.doc) : null
  const idfOfM = (m) => {
    if (!e) return 0
    let s = 0
    for (const tok of tokenizeRare((m.title || '') + ' ' + (m.description || ''))) s += idfOf(e, tok)
    return s
  }
  const list = (scored || []).map((s) => ({
    m: s.m,
    source: s.source || 'utt',
    idf: (typeof s.idf === 'number' && s.idf >= 0) ? s.idf : idfOfM(s.m),
    hit: typeof s.hit === 'number' ? s.hit : 0,
  })).filter((x) => x.m)
  list.sort((a, b) => {
    const la = LEVEL_RANK[deriveLevel(a.m)] || 0, lb = LEVEL_RANK[deriveLevel(b.m)] || 0
    if (la !== lb) return lb - la
    const wa = SCENE_WEIGHT[a.source] || 0, wb = SCENE_WEIGHT[b.source] || 0
    if (wa !== wb) return wb - wa
    if (a.idf !== b.idf) return b.idf - a.idf
    if (a.hit !== b.hit) return b.hit - a.hit
    return Date.parse(b.m.updatedAt || 0) - Date.parse(a.m.updatedAt || 0)
  })
  return list.slice(0, cap)
}

// ---- dedupeScene：同 turn 去重（id，保序）----
export function dedupeScene(ids) {
  const seen = new Set()
  const out = []
  for (const id of (ids || [])) if (id && !seen.has(id)) { seen.add(id); out.push(id) }
  return out
}

// ---- 命中行抽取：body 分段（organizeBody）中含 triggers/命中 token 的段；无命中段用 description ----
function pickHitLine(m, toks) {
  const segs = organizeBody(m.body || '')
  if (segs.length) {
    const cands = segs.filter((s) => toks.some((t) => norm(s).includes(t)))
    if (cands.length) {
      return cands.slice(0, 2).map((s) => s.length > 110 ? s.slice(0, 110) + '…' : s).join('；')
    }
  }
  const desc = String(m.description || '').replace(/\s+/g, ' ').trim()
  if (desc) return desc.length > 110 ? desc.slice(0, 110) + '…' : desc
  return String(m.title || '').slice(0, 60)
}

// ---- extractFragment：单条片段（不注 body 全文；需要全文 memory_read）----
// m     记忆对象；doc 可选上下文（doc.byId 优先）；source 显示标签（'file'|'file:js'|'memory'|'bash'|'utt'）
// tokens 可选命中 token 列表（缺省用 m.triggers）
// 返回 { id, level, source, text }；text = `[P·级|域] title ▸ 命中行…（[来源:slug]·memory_read 可查）`
export function extractFragment(m, doc, source = 'utt', tokens) {
  const mm = (doc && doc.byId && doc.byId[m.id]) || m
  const toks = (tokens && tokens.length ? tokens : (mm.triggers || [])).map((x) => norm(String(x))).filter(Boolean)
  const level = deriveLevel(mm)
  const slug = mm.name || mm.slug || mm.id || ''
  const text = `[${level}|${source}] ${mm.title} ▸ ${pickHitLine(mm, toks)}（[来源:${slug}]·memory_read 可查）`
  return { id: mm.id, level, source, text }
}

// ---- renderScene：拼装 L2 注入文本（cap3；红线 P1 恒置顶）----
// ids 已按 rankScene/plan 排序，此处仍显式按等级分区（双保险），保证 P1 永不沉底。
// 行为行（behavior）不属于片段文本，由调用方拼在尾部（P1 置顶前提满足后才允许合并）。
export function renderScene(ids, doc, env = {}) {
  const list = dedupeScene(ids)
  if (!list.length) return ''
  const byId = new Map(((doc && doc.memories) || []).map((m) => [m.id, m]))
  const mems = list.map((id) => byId.get(id)).filter(Boolean)
  const cap = typeof env.cap === 'number' ? env.cap : 3
  const ranked = mems.map((m, i) => ({ m, i })).sort((a, b) =>
    (LEVEL_RANK[deriveLevel(b.m)] || 0) - (LEVEL_RANK[deriveLevel(a.m)] || 0) || a.i - b.i).map((x) => x.m)
  const scenes = ranked.slice(0, cap).map((m) => extractFragment(m, doc, env.source || 'utt', env.tokens))
  if (!scenes.length) return ''
  const rows = ['【场景记忆】']
  for (const s of scenes) rows.push('- ' + s.text)
  let text = rows.join('\n')
  if (text.length > 1500) text = text.slice(0, 1500)
  return text
}

// ---- 行为行渲染（与 index.js 现状模板一致；cat: file/exec/memory）----
export function renderBehaviorLine(cat, title) {
  const map = {
    file: `⚠️ 刚完成文件修改：收尾回复须按红线以表格报告改动文件的绝对路径（${title}）。`,
    exec: `⚠️ 刚执行命令：如改动文件，收尾回复须按红线以表格报告改动路径（${title}）。`,
    memory: `⚠️ 刚修改项目记忆：请确认已获得用户批准、且按正确格式反馈（${title}）。`,
  }
  return map[cat] || ''
}

// ---- createScene：L2 唯一写入点（sceneCache/behaviorCache 全在工厂闭包）----
// { store?, cap=3, domains? } → { plan(env), clearBehavior(cwd) }
// plan(env) 返回结构化 { source, domain?, ids, scenes, behavior, clearBehavior? }（调用方消费）：
//   ids/scenes 已按 rankScene 排序且 cap（P1 置顶）；behavior 为行为行文本（'' 则无）；read → clearBehavior。
// env 需带 memories 或 doc（或 store 仅用于同步 invert 缓存）；cwd 用于分键缓存。
export function createScene({ store, cap = 3, domains } = {}) {
  const dom = { ...DEFAULT_SCENE_DOMAINS, ...(domains || {}) }
  const sceneCache = new Map()    // cwd -> { source, domain, ids, scenes, behavior, at }
  const behaviorCache = new Map() // cwd -> 行为行文本（单一写入点：plan）
  const behaviorFired = new Map() // cwd -> Set<id>（洪水控制：每条红线整个会话只提醒一次）

  function plan(env = {}) {
    const cwd = env.cwd || ''
    const det = detectScene({ ...env, domains: dom })
    // 读类：只清旧（行为行清除信号），不新注；话题片段不清（调用方保留现场景）
    if (det.source === 'read') {
      if (det.clearBehavior) behaviorCache.delete(cwd)
      return { source: 'read', clearBehavior: true, ids: [], scenes: [], behavior: '' }
    }
    const doc = env.doc || (env.memories ? { memories: env.memories } : null)
    if (!doc || !Array.isArray(doc.memories)) {
      return { source: det.source || 'none', domain: det.domain, ids: [], scenes: [], behavior: behaviorCache.get(cwd) || '' }
    }
    const mems = doc.memories
    const byId = new Map(mems.map((m) => [m.id, m]))
    // ---- 行为行（file/memory/bash）：P1 红线 → 洪水控制 → 一行短句；未新触发则沿用缓存（跨步持续提醒）----
    let behavior = ''
    if (det.behavior && det.behavior.ids && det.behavior.ids.length) {
      const fired = behaviorFired.get(cwd) || new Set()
      const fresh = det.behavior.ids.filter((id) => !fired.has(id) && byId.has(id))
      if (fresh.length) {
        const lines = fresh.slice(0, 3).map((id) => renderBehaviorLine(det.behavior.cat, (byId.get(id) || {}).title || id)).filter(Boolean)
        if (lines.length) {
          behavior = lines.join('\n')
          behaviorCache.set(cwd, behavior)
          fresh.slice(0, 3).forEach((id) => fired.add(id))
          behaviorFired.set(cwd, fired)
        }
      }
    }
    // 未新触发（utt/none 等源）：沿用缓存行为行（跨步持续提醒，直到 read 场景 clearBehavior）
    if (!behavior) behavior = behaviorCache.get(cwd) || ''
    // ---- 话题 ids：detectScene → 同 turn 去重 → rankScene（P1 置顶/场景权重/IDF，cap）→ 片段 ----
    let inv = env.invert
    if (!inv && store && typeof store.getInvert === 'function' && cwd) { try { inv = store.getInvert(cwd) } catch (_) {} }
    if (!inv) inv = buildInvert(doc)
    let uttTok = null
    if (det.source === 'utt' && env.input) {
      uttTok = new Map()
      const input = String(env.input)
      for (const [w, ids] of inv.entries()) {
        if (input.indexOf(w) === -1) continue
        for (const id of ids) {
          if (!uttTok.has(id)) uttTok.set(id, [])
          uttTok.get(id).push(w)
        }
      }
    }
    const tokensFor = (id) => {
      if (uttTok && uttTok.has(id)) return uttTok.get(id)
      if (det.domain && dom[det.domain]) return dom[det.domain]
      return undefined
    }
    const pool = dedupeScene(det.ids || []).map((id) => ({
      m: byId.get(id),
      source: det.source === 'file' ? 'file' : det.source === 'memory' ? 'memory' : 'utt',
      hit: (det.hits && det.hits[id]) || 0,
    })).filter((x) => x.m)
    const ranked = rankScene(pool, { cap, doc })
    const ids = dedupeScene(ranked.map((x) => x.m.id))
    const srcTag = det.source === 'file' && det.domain ? 'file:' + det.domain : (det.source || 'utt')
    const scenes = ids.map((id) => extractFragment(byId.get(id), doc, srcTag, tokensFor(id)))
    sceneCache.set(cwd, { source: det.source, domain: det.domain, ids, scenes, behavior, at: Date.now() })
    return { source: det.source, domain: det.domain, ids, scenes, behavior }
  }
  // 行为行清除（read 场景调用；idempotent——已清/不存在均返回 false）
  function clearBehavior(cwd) {
    const had = behaviorCache.has(cwd)
    behaviorCache.delete(cwd)
    return had
  }
  return { plan, clearBehavior }
}

// ---- selftest：四源/等级/片段/仲裁/置顶/去重/plan 断言（node 直跑）----
// 运行：node -e "import('./lib/scene.js').then(m=>{const r=m.selfTest();console.log(JSON.stringify(r,null,2));process.exit(r.ok?0:1)})"
export function selfTest() {
  const results = []
  const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: String(extra || '') })
  const now = new Date().toISOString()
  const mk = (id, over = {}) => ({
    id, name: id, title: '标题' + id, description: '描述' + id, body: '',
    type: 'project', status: 'active', ttl: 'event', phase: null,
    triggers: [], tags: [], heat: 0, proofCount: 0,
    obligation: false, pinned: false, updatedAt: now, createdAt: now, ...over,
  })
  const red = mk('r1', { title: '修改文件必须报告', triggers: ['修改文件'], ttl: 'permanent', obligation: true, body: '修改文件时必须报告\n报告路径是红线\n禁止绕过' })
  const perm = mk('p2', { title: 'JS 代码规范', triggers: ['javascript', '代码'], ttl: 'permanent', body: '写 JS 注意\n代码规范如下\n缩进两格' })
  const ev = mk('e3', { title: '某次修复经验', triggers: ['坑', '修复'], ttl: 'event', description: '某次修复的临时经验' })
  const mems = [red, perm, ev]
  const doc = { memories: mems }

  // ---- ① 四源归一 ----
  let d = detectScene({ input: '需要修改文件，注意红线', memories: mems })
  check('utt 话语命中', d.source === 'utt' && d.ids.includes('r1'), JSON.stringify(d))
  d = detectScene({ tool: 'write', filePath: 'src/a.js', input: '修改文件', memories: mems })
  check('file 域优先于话语', d.source === 'file' && d.domain === 'js' && d.ids.includes('p2') && !d.ids.includes('e3'), JSON.stringify(d))
  d = detectScene({ tool: 'edit', filePath: 'a.md', memories: mems })
  check('file md 域零命中→红线兜底', d.source === 'file' && d.domain === 'md' && d.ids.join(',') === 'r1' && d.behavior.cat === 'file', JSON.stringify(d))
  d = detectScene({ tool: 'memory_update', memories: mems })
  check('memory 源', d.source === 'memory' && d.ids.includes('r1') && d.behavior.cat === 'memory', JSON.stringify(d))
  d = detectScene({ tool: 'pwsh', memories: mems })
  check('bash 纯行为行', d.source === 'bash' && d.ids.length === 0 && d.behavior && d.behavior.cat === 'exec' && d.behavior.ids.includes('r1'), JSON.stringify(d))
  d = detectScene({ tool: 'read', filePath: 'x.js', memories: mems })
  check('read 清旧不新注', d.source === 'read' && d.clearBehavior === true && d.ids.length === 0, JSON.stringify(d))
  check('read 不清话题片段', !('clear' in d) || d.clear !== true, JSON.stringify(d))
  d = detectScene({ input: '无关内容 abcdefgh', memories: mems })
  check('无场景零输出', d.source === 'none' && d.ids.length === 0, JSON.stringify(d))

  // ---- ② 等级 ----
  check('P1 红线', deriveLevel(red) === 'P1·红线', deriveLevel(red))
  check('P2 常设', deriveLevel(perm) === 'P2·常设', deriveLevel(perm))
  check('P3 情境', deriveLevel(ev) === 'P3·情境', deriveLevel(ev))

  // ---- ③ 片段 ----
  let f = extractFragment(red, doc, 'file:js', ['修改文件'])
  check('片段含标题+命中行+来源', f.text.includes('修改文件必须报告') && f.text.includes('修改文件时必须报告') && f.text.includes('memory_read'), f.text)
  check('片段不注 body 全文', !f.text.includes('禁止绕过'), f.text)
  check('片段前缀 [P1·红线|file:js]', f.text.startsWith('[P1·红线|file:js] '), f.text)
  const f2 = extractFragment(ev, doc, 'utt')
  check('无命中段用 description', f2.text.includes('▸ 某次修复的临时经验'), f2.text)

  // ---- ④ 仲裁：等级 → 场景权重 → IDF ----
  const rk = rankScene([{ m: ev, source: 'utt' }, { m: perm, source: 'file' }, { m: red, source: 'bash' }], { cap: 3 })
  check('P1 恒置顶', rk[0].m.id === 'r1', rk.map((x) => x.m.id).join(','))
  check('同级场景权重 file>utt', rk[1].m.id === 'p2' && rk[2].m.id === 'e3', rk.map((x) => x.m.id).join(','))
  const rareA = mk('ra', { title: '超稀有词甲', ttl: 'permanent' })
  const rareB = mk('rb', { title: '常见词乙', ttl: 'permanent' })
  const rk3 = rankScene([{ m: rareB, source: 'file', idf: 1 }, { m: rareA, source: 'file', idf: 5 }], { cap: 3 })
  check('同等级同权重 IDF 降序', rk3[0].m.id === 'ra', rk3.map((x) => x.m.id).join(','))
  const rk4 = rankScene([
    { m: red, source: 'file' }, { m: perm, source: 'file' },
    { m: ev, source: 'utt' }, { m: rareA, source: 'file' },
  ], { cap: 3 })
  check('cap=3 截断', rk4.length === 3 && !rk4.some((x) => x.m.id === 'e3'), rk4.map((x) => x.m.id).join(','))

  // ---- ⑤ 渲染置顶 ----
  const txt = renderScene(['e3', 'r1', 'p2'], doc, { source: 'utt' })
  const lines = txt.split('\n')
  check('renderScene P1 置顶', lines.length === 4 && lines[1].includes('[P1·红线|'), lines.slice(1).join(' | '))
  check('renderScene P2/P3 顺次', lines[2].includes('[P2·常设|') && lines[3].includes('[P3·情境|'), lines.slice(1).join(' | '))
  check('renderScene 头部', txt.includes('【场景记忆】'), txt.slice(0, 30))

  // ---- ⑥ 去重 ----
  check('dedupe 保序去重', JSON.stringify(dedupeScene(['a', 'b', 'a', 'c'])) === JSON.stringify(['a', 'b', 'c']), dedupeScene(['a', 'b', 'a', 'c']).join(','))

  // ---- ⑦ createScene.plan（单一写入点）----
  const S = createScene()
  const p = S.plan({ cwd: 'C:\\x', tool: 'write', filePath: 'a.js', memories: mems })
  check('plan 结构化 ids+scenes', Array.isArray(p.ids) && p.ids.includes('p2') && Array.isArray(p.scenes) && p.scenes.length === 1 && p.source === 'file', JSON.stringify({ ids: p.ids, source: p.source }))
  check('plan write 行为行', p.behavior.includes('刚完成文件修改') && p.behavior.includes('修改文件必须报告'), p.behavior)
  const p2 = S.plan({ cwd: 'C:\\x', input: '随便问问无关内容', memories: mems })
  check('行为行跨步持续（untouched）', p2.behavior.includes('刚完成文件修改'), p2.behavior)
  check('plan utt 无场景零输出', p2.ids.length === 0 && p2.scenes.length === 0, JSON.stringify(p2.ids))
  const pb = S.plan({ cwd: 'C:\\y', tool: 'pwsh', memories: mems })
  check('plan bash 纯行为行', pb.ids.length === 0 && pb.behavior.includes('刚执行命令'), JSON.stringify({ ids: pb.ids, behavior: pb.behavior }))
  const pr = S.plan({ cwd: 'C:\\y', tool: 'read', memories: mems })
  check('plan read clearBehavior', pr.clearBehavior === true && pr.ids.length === 0 && pr.behavior === '', JSON.stringify(pr))
  check('read 已清行为后 clearBehavior=false', S.clearBehavior('C:\\y') === false, '')
  const fz = S.plan({ cwd: 'C:\\z', tool: 'write', filePath: 'a.js', memories: mems })
  check('写后行为可清', fz.behavior !== '' && S.clearBehavior('C:\\z') === true && S.clearBehavior('C:\\z') === false, '')

  return { ok: results.every((r) => r.ok), total: results.length, failed: results.filter((r) => !r.ok), results }
}
