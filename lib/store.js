// dsh-project-memory store layer (v3)：从 lib/index.js 抽取的存储层。
// 纯函数直接 export（逐字照抄原实现，签名兼容）；createStore 工厂注入依赖
// （fs / MEMORY_FILE / writePolicy / enqueueRefresh / renderT0），缓存全部在工厂闭包内。
// 反转依赖：store 不反向依赖渲染层——refresh 完成后仅调 enqueueRefresh(cwd) 通知，
// 渲染层自行读缓存渲染；refreshT0 的 renderT0Text 依赖由注入的 renderT0 回调承担（见文末说明）。

import { existsSync, readFileSync } from 'node:fs'  // 首步真身：context 内同步读盘（DSH fs 服务纯异步，宿主插件可用 node:fs——hooks-codex 先例）

// ---- parseDoc：readDoc/readDocSync 共用的纯解析核（stripBOM→JSON→isValid/migrateV1→排序）----
// opts.keepOrder=true → 保留文件里的**原始数组顺序**（= 用户手动/保存的排序，权威顺序）；
// 默认仍按最新重排（内部消费方行为不变）。2026-09-11：写路径据此把顺序"套回去"，
// 修掉"召回热度自增/增删改一写就把手动顺序冲掉"的 bug。
export function parseDoc(raw, opts) {
  let parsed
  try { parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, '')) } catch (e) { return { version: 2, memories: [] } }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.memories) ? parsed.memories : [])
  const memories = list.filter(isValid).map(migrateV1)
  return { version: 2, memories: (opts && opts.keepOrder) ? memories : memories.sort(byNewest) }
}
// ---- readDocSync：同步读（首步真身——renderFirst/apply 预热用；ENOENT→空 doc；只读，写路径不动）----
export function readDocSync(cwd, MEMORY_FILE_ = '.dsh-memory.json', opts) {
  try {
    const p = `${cwd}${cwd.endsWith('\\') || cwd.endsWith('/') ? '' : '\\'}${MEMORY_FILE_}`
    if (!existsSync(p)) return { version: 2, memories: [] }
    return parseDoc(readFileSync(p, 'utf8'), opts)
  } catch (e) { return { version: 2, memories: [] } }
}

// ---- 倒排索引（命中检测用）：doc -> Map<触发词, Set<id>> ----
export function buildInvert(doc) {
  const m = new Map()
  for (const mem of doc.memories) {
    if (mem.status === 'archived' || mem.type === 'state') continue
    const words = new Set()
    ;(mem.triggers || []).forEach((t) => words.add(String(t).trim()))
    // 兜底：从 title/description 相关词也进索引
    const src = `${mem.title || ''} ${mem.description || ''}`
    const latin = (src.match(/[a-zA-Z]{2,}/g) || []).filter((w) => w.length >= 3)
    latin.forEach((w) => words.add(w.toLowerCase()))
    const t = String(src).replace(/\s+/g, '')
    for (let i = 0; i < t.length - 1; i++) {
      const two = t.slice(i, i + 2)
      if (/\p{Script=Han}/u.test(two)) words.add(two)
    }
    for (const w of words) {
      if (!w) continue
      if (!m.has(w)) m.set(w, new Set())
      m.get(w).add(mem.id)
    }
  }
  return m
}

// ---- 上下文路径 ----
// cwd 取自 AssembleContext.agent.session.header.cwd（F3）
export function cwdFromAgent(a) {
  try { if (a && a.session && a.session.header && a.session.header.cwd) return a.session.header.cwd } catch (e) {}
  return undefined
}
// Windows 绝对路径化：相对路径拼 cwd，绝对路径（C:\ / 开头）原样返回
export function absPath(cwd, rel) {
  if (!rel) return ''
  const r = String(rel)
  if (/^[A-Za-z]:/.test(r) || r.startsWith('/')) return r
  const base = String(cwd || '').replace(/[\\/]+$/, '')
  return base + '\\' + r.replace(/^[\\/]+/, '')
}

// ---- 文本规整 / 相似度 ----
export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
export function bigrams(s) {
  const t = norm(s)
  const set = new Set()
  if (t.length === 0) return set
  if (t.length === 1) { set.add(t); return set }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}
export function titleSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b)
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

// ---- B(冗余治理) rare-token 判重：统计核心地基第一步 ----
// 高频/泛词表：这些词在语料里太常见，不算 rare-token（判同主题时权重趋零）。
export const RARE_STOP = new Set(['记忆','项目','插件','修复','页面','功能','设计','记录','设置','工具','用户','系统','内容','方法','进程','机制','状态','当前','配置','问题','经验','一次','相关','执行','监听','提炼','候选','压缩'])
// 分词：拉丁词(≥3) + CJK 二元组（复用 invertCache 已用的维度）。去停用词后即 rare 候选。
export function tokenizeRare(s) {
  const out = new Set()
  const str = norm(s)
  for (const w of (str.match(/[a-zA-Z]{3,}/g) || [])) out.add(w.toLowerCase())
  const t = str.replace(/\s+/g, '')
  for (let i = 0; i < t.length - 1; i++) {
    const two = t.slice(i, i + 2)
    if (/\p{Script=Han}/u.test(two)) out.add(two)
  }
  return out
}
// 纯 IDF 表构建（无缓存）：doc -> { map: Map<token,df>, totalDoc, dirty:false }（ensureIdf 的纯内核）
export function computeIdf(doc) {
  const df = new Map()
  let totalDoc = 0
  if (doc && Array.isArray(doc.memories)) {
    for (const m of doc.memories) {
      if (m.status === 'archived') continue
      totalDoc++
      const tokens = tokenizeRare((m.title || '') + ' ' + (m.description || ''))
      for (const w of tokens) df.set(w, (df.get(w) || 0) + 1)
    }
  }
  return { map: df, totalDoc, dirty: false }
}
// idf 权重纯函数（log(1+N/df)，df 越小越稀有；token 出现越少分越高）
export function idfOf(e, token) {
  const df = (e && e.map.get(token)) || 0
  const N = Math.max((e && e.totalDoc) || 0, 1)
  if (df === 0) return 0
  return Math.log(1 + N / df)
}
// rare-token 同主题判定 ——「一个计分器，两道决策线」（GLM §2/§3 裁定）：
//   计分器输出分数（type 打折后的 idf 加权和）+ 共享 rare token 数 + 是否恰 1 个 df≤2 极罕见词。
//   两道决策线：B 自动合并(2.0 精度优先) / A 人工提案(1.5 召回优先)，且按 GLM §3 显式矩阵：
//     ≥2 共享rare → 同type/异type 都判自动；
//     恰 1 个 df≤2 极罕见词 → 同type 自动、异type 只提案(不自动并)；
//     仅中频词 → 看总分。
// 纯函数：cwd 仅作签名兼容（原实现按 cwd 缓存 IDF；此处直接从 doc 纯计算，数值一致）。
export function scoreRareTopic(cwd, a, b, typeA, typeB, doc) {
  const A = tokenizeRare(a), B = tokenizeRare(b)
  const e = computeIdf(doc)
  let weight = 0
  let sharedCount = 0
  let extreme = 0
  for (const w of A) {
    if (!B.has(w)) continue
    if (RARE_STOP.has(w)) continue
    const df = e.map.get(w) || 0
    weight += idfOf(e, w)
    sharedCount++
    if (df <= 2) extreme++   // df≤2 = 极罕见（全库仅这几条提到）
  }
  const typeDiff = !!(typeA && typeB && typeA !== typeB)
  if (typeDiff) weight *= 0.75   // type 不同 → 打折
  // GLM §3 决策矩阵（dry-run 肉眼校准 + 更保守）：
  //   纯中频词（extreme=0）即使共享≥3、分数高，仍可能主题不同（"修改文件"可作"机制"或"位置要点"前缀）——
  //   dry-run 暴露 4.8 分中频误合。所以 auto 线要求【含有至少 1 个 df≤2 极罕见词】；纯中频只到 proposal，人眼确认。
  let decision = 'none'
  if (extreme >= 1 && sharedCount >= 2) decision = typeDiff ? 'auto' : 'auto'   // 含极罕见 + ≥2共享：强证据，auto
  else if (extreme === 1) decision = typeDiff ? 'propose' : 'auto'               // 恰 1 极罕见：异type 只提案
  else if (extreme >= 1 && weight >= 2.4) decision = 'auto'                      // 含极罕见且高分
  else if (weight >= 1.5) decision = 'propose'                                   // 无极罕见/低分 → 一律提案，人眼判
  return { score: weight, sharedCount, extreme, typeDiff, decision }
}
// B 自动合并线：decision==='auto' 才自动并（精度优先）
export function isAutoMerge(cwd, a, b, typeA, typeB, doc) {
  return scoreRareTopic(cwd, a, b, typeA, typeB, doc).decision === 'auto'
}

// ---- slug / 校验 / 迁移 ----
export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').replace(/-+/g, '-')
}
export function makeMemorySlug(title, taken, id) {
  let slug = slugify(title)
  if (!slug) slug = String(id).slice(0, 8)
  let cand = slug, n = 0
  while (taken.has(cand)) { n++; cand = slug + '-' + n }
  return cand
}
export function isValid(m) {
  return !!m && typeof m.id === 'string' && typeof m.title === 'string' &&
    typeof m.description === 'string' && typeof m.body === 'string' &&
    typeof m.updatedAt === 'string'
}
export const migrateV1 = (r) => ({
  ...r,
  type: r.type ?? 'project',
  scope: r.scope ?? 'project',
  status: r.status ?? 'active',
  createdAt: r.createdAt ?? r.updatedAt,
  heat: typeof r.heat === 'number' ? r.heat : 0,
  // M1 分级/检测增量字段（缺省兼容）
  ttl: r.ttl ?? (/(每次|以后|所有|一律|必须|务必|禁止|不要|记得|任何时候)/.test(`${r.title||''} ${r.description||''} ${r.body||''}`) ? 'permanent' : 'event'),
  phase: r.phase ?? null,
  triggers: Array.isArray(r.triggers) ? r.triggers : [],
  obligation: r.obligation === true,
  pinned: r.pinned === true,
  proofCount: typeof r.proofCount === 'number' ? r.proofCount : 0,
})
export const byNewest = (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()

// ---- 查询 / 过滤 ----
// 关键词搜索：所有词都命中才算（词的集合 AND）
export function searchProjectMemory(memories, query) {
  const words = norm(query).split(' ').filter(Boolean)
  return memories.filter(m => {
    const hay = norm([m.title, m.description, m.body].join(' '))
    return words.every(w => hay.includes(w))
  }).sort(byNewest)
}
// 只留 active，按 updatedAt 新→旧（candidate 是隔离舱：不进 T0 索引/检索粗池）
export function activeOnly(memories) { return memories.filter(m => m.status === 'active').sort(byNewest) }

// ---- 基础计分 ----
export function scoreOf(m, now) {
  const heat = typeof m.heat === 'number' ? m.heat : 0
  let ageDays = 0
  try { ageDays = (now - new Date(m.updatedAt).getTime()) / 86400000 } catch (e) {}
  if (ageDays < 0) ageDays = 0
  const recency = 1 / (1 + ageDays)
  return heat * 0.6 + recency * 10
}

// ---- M4-lite 纯计分函数（可测，供 recallMemory 与回归测试用）。权重集中（应进 Config）。----
// 默认值即 index.js L23-27 兜底：M4_FIELD_W / LEX_WEIGHT / HEAT_WEIGHT / UNIGRAM_W / ALIASES。
export const DEFAULT_SCORE_CFG = {
  M4_FIELD_W: { title: 3, description: 2, body: 0.4 },
  LEX_WEIGHT: 0.7,
  HEAT_WEIGHT: 0.3,
  UNIGRAM_W: { latin: 1.5, han: 1.0, other: 0.5 },
  ALIASES: {},
}
// 原签名 (mems, query, idfFn) 兼容（调用方 3 参不变）；新增可选第 4 参 cfg（L23-27 配置），不传用默认兜底。
export function scoreMemory(mems, query, idfFn, cfg) {
  // 返回 [{m, score}] 按 score 降序；score>=0 的才参与召回。mems 为候选数组。
  const c = cfg || DEFAULT_SCORE_CFG
  const M4_FIELD_W = c.M4_FIELD_W || { title: 3, description: 2, body: 0.4 }
  const LEX_WEIGHT = typeof c.LEX_WEIGHT === 'number' ? c.LEX_WEIGHT : 0.7
  const HEAT_WEIGHT = typeof c.HEAT_WEIGHT === 'number' ? c.HEAT_WEIGHT : 0.3
  const UNIGRAM_W = c.UNIGRAM_W || { latin: 1.5, han: 1.0, other: 0.5 }
  const ALIASES = c.ALIASES || {}
  const qTokens = tokenizeRare(query)
  for (const ch of String(query).replace(/\s+/g, '')) if (/\p{Script=Han}/u.test(ch)) qTokens.add(ch)
  // 别称表（Config 化）：query 含别称键时展开其别名 token（如"合并"→["聚合","归并"]），增强跨措辞召回。
  if (ALIASES && Object.keys(ALIASES).length) {
    for (const key of Object.keys(ALIASES)) {
      if (query.includes(key)) {
        const arr = ALIASES[key]
        if (Array.isArray(arr)) for (const al of arr) if (al) qTokens.add(String(al).trim())
      }
    }
  }
  const idf = idfFn || (() => 1)
  const qWeights = {}
  let qWeightSum = 0
  for (const t of qTokens) {
    if (/^[a-zA-Z]{3,}$/.test(t)) qWeights[t] = UNIGRAM_W.latin
    else if (/^\p{Script=Han}{2}$/u.test(t)) qWeights[t] = UNIGRAM_W.han
    else qWeights[t] = UNIGRAM_W.other
    qWeightSum += qWeights[t] * (idf(t) || 0)
  }
  const out = []
  const maxHeat = Math.max(1, ...mems.map((m) => (typeof m.heat === 'number' ? m.heat : 0)))
  for (const m of mems) {
    const parts = { title: norm(m.title || ''), description: norm(m.description || ''), body: norm(m.body || '') }
    const hits = { title: new Set(), description: new Set(), body: new Set() }
    for (const t of qTokens) for (const f of Object.keys(parts)) if (parts[f].includes(t)) hits[f].add(t)
    let hitIdf = 0
    for (const t of qTokens) {
      const w = qWeights[t] || 1
      const fw = (hits.title.has(t) ? M4_FIELD_W.title : 0) + (hits.description.has(t) ? M4_FIELD_W.description : 0) + (hits.body.has(t) ? M4_FIELD_W.body : 0)
      if (fw > 0) hitIdf += w * fw * (idf(t) || 0)
    }
    if (hitIdf === 0) continue
    const lex = hitIdf / (qWeightSum || 1)
    const heat = typeof m.heat === 'number' ? m.heat : 0
    const heatNorm = Math.log1p(heat) / Math.log1p(maxHeat)
    const final = LEX_WEIGHT * lex + HEAT_WEIGHT * heatNorm
    out.push({ m, score: final })
  }
  out.sort((a, b) => b.score - a.score)
  return { scored: out, qWeightSum }
}

// ---- M2 知识页 v1（零 LLM 确定性拼装，可再生工件）----
export function buildPages(memories) {
  const pages = []
  const byProof = (a, b) => (b.proofCount || 0) - (a.proofCount || 0) || (b.heat || 0) - (a.heat || 0)
  // pitfalls 坑集页：feedback / event 类，按 proofCount 排序
  const pitfalls = memories.filter(m => (m.type === 'feedback' || m.ttl === 'event') && m.status !== 'archived').sort(byProof)
  if (pitfalls.length) pages.push({
    id: 'pitfalls', question: '本项目已验证的坑', rewrittenAt: new Date().toISOString(),
    sources: pitfalls.slice(0, 30).map(m => m.id),
    text: pitfalls.slice(0, 30).map(m => `- ${m.title}：${m.description}${m.proofCount ? `（已证实${m.proofCount}次）` : ''}`).join('\n'),
  })
  // preferences 偏好页：obligation / pinned / user 类
  const prefs = memories.filter(m => (m.obligation === true || m.pinned === true || m.type === 'user') && m.status !== 'archived').sort(byProof)
  if (prefs.length) pages.push({
    id: 'preferences', question: '用户红线与偏好', rewrittenAt: new Date().toISOString(),
    sources: prefs.slice(0, 30).map(m => m.id),
    text: prefs.slice(0, 30).map(m => `- ${m.title}：${m.description}`).join('\n'),
  })
  // decisions 决策页：project 类中标题含决策/结论/设计 的记忆
  const decisions = memories.filter(m => m.type === 'project' && /决策|结论|设计|架构|方案/.test(m.title || '') && m.status !== 'archived').sort(byProof)
  if (decisions.length) pages.push({
    id: 'decisions', question: '关键决策与结论', rewrittenAt: new Date().toISOString(),
    sources: decisions.slice(0, 30).map(m => m.id),
    text: decisions.slice(0, 30).map(m => `- ${m.title}：${m.description}`).join('\n'),
  })
  return pages
}

// ---- 记忆分级（GLM 批次①，确定性，零 schema）：P1=obligation‖pinned（红线）；P2=ttl permanent/phase（常设）；P3=其余 ----
export function deriveLevel(m) {
  if (m.obligation === true || m.pinned === true) return 'P1·红线'
  if (m.ttl === 'permanent' || m.ttl === 'phase') return 'P2·常设'
  return 'P3·情境'
}

// ---- id ----
export const newId = () => 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

// ---- 正文自动整理：分段 + 自动编号。与客户端 organizeBody 逻辑一致，保证 AI 写入的记忆
//      也自动呈现为清晰分段排列，无需用户/AI 手动排版。 ----
export function organizeBody(body) {
  if (!body) return []
  const raw = String(body).trim()
  if (!raw) return []
  // 分段：双换行 / 数字编号行（1、/1.）/ 列表行（- • *）。列表子项保持原样不编号。
  const hasNumbering = /(^|\n)\s*\d+[\.\、\)]/.test(raw)
  const isList = (s) => /^\s*[-•*]\s/.test(s)
  const isNum = (s) => /^\s*\d+[\.\、\)]/.test(s)
  let segs = raw.split(hasNumbering
    ? /\n\s*\n|\n(?=\s*\d+[\.\、\)])|\n(?=\s*[-•*]\s)/
    : /\n\s*\n|\n(?=\s*[-•*]\s)/)
  // 无编号且无双换行/列表符时，退化为按单换行拆，保证多行纯文字也能分段
  if (!hasNumbering && segs.length <= 1) segs = raw.split('\n')
  segs = segs.map((s) => s.replace(/^(\s*\d+[\.\、\)])\s*\1\s*/g, '$1').trim()).filter(Boolean)
  if (segs.length === 0) return [raw]
  if (!hasNumbering) {
    // 无编号：只给非列表的纯文字段自动编号
    const plain = segs.filter((s) => !isList(s) && !isNum(s))
    if (plain.length > 1) {
      let n = 1
      segs = segs.map((s) => isList(s) || isNum(s) ? s : (n++ + '、' + s))
    }
  } else {
    // 已编号：若数字主段编号重复，按连续序重排（列表子项不动）
    const numSegs = segs.filter(isNum)
    const nums = numSegs.map((s) => parseInt(s.match(/^(\s*\d+)/)[1], 10))
    const uniq = new Set(nums)
    if (uniq.size < nums.length) {
      let n = 1
      segs = segs.map((s) => {
        if (!isNum(s)) return s
        const sepMatch = s.match(/^\s*\d+[\.\、\)]/)
        const sep = sepMatch ? sepMatch[0].slice(-1) : '、'
        return (n++) + sep + s.replace(/^\s*\d+[\.\、\)]\s*/, '').trim()
      })
    }
  }
  return segs
}
export function organizedText(body) { return organizeBody(body).join('\n\n') }

// ---- M1 写入闸门：Defense 消毒 / 义务词检测 / triggers 提取（全代码，零模型 token）----
// 1) Defense 消毒：敏感凭证就脱敏为 [REDACTED:credential]，避免记忆里落敏感明文
export const SECRET_RE = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16,}|-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.)/g
export function sanitizeSecret(text) {
  const src = String(text || '')
  const out = src.replace(SECRET_RE, '[REDACTED:credential]')
  let redacted = 0
  try { redacted = (src.match(SECRET_RE) || []).length } catch (e) {}
  return { text: out, redacted }
}
// 2) 义务词检测：命中即 obligation:true + ttl:permanent（常驻，不检测）
export const OBLIGATION_RE = /每次|以后|所有|一律|必须|务必|禁止|不要|记得|任何时候/
export function isObligation(text) { return OBLIGATION_RE.test(String(text || '')) }
// 3) triggers 提取：模型给定用给定；否则从 title/description/body 确定性提取
export function extractTriggers(mem, given) {
  if (Array.isArray(given) && given.length) return given.slice(0, 12).map((s) => String(s).trim()).filter(Boolean)
  const src = `${mem.title||''} ${mem.description||''} ${mem.body||''}`
  const latin = (src.match(/[a-zA-Z]{2,}/g) || []).filter((w) => w.length >= 3)
  const cjk = []
  const t = String(src || '').replace(/\s+/g, '')
  for (let i = 0; i < t.length - 1; i++) {
    const two = t.slice(i, i + 2)
    if (/[\u4e00-\u9fa5]/.test(two[0]) && /[\u4e00-\u9fa5]/.test(two[1])) cjk.push(two)
  }
  // 标题首 2-3 词元优先
  const titleBigrams = []
  const tt = String(mem.title || '').replace(/\s+/g, '')
  for (let i = 0; i < tt.length - 1; i++) titleBigrams.push(tt.slice(i, i + 2))
  const seen = new Set()
  const out = []
  for (const w of [...titleBigrams.slice(0, 6), ...cjk.slice(0, 40), ...latin.slice(0, 12)]) {
    if (!seen.has(w)) { seen.add(w); out.push(w) }
    if (out.length >= 12) break
  }
  return out
}

// ---- 写盘策略（记忆是可信项目数据层：fs.writeText 默认沙箱会拒绝跨 cwd 写，
//      故在记忆 cwd 围栏 danger-full-access 保证落盘）----
export function writePolicy(cwd) {
  return { mode: 'danger-full-access', workspaceRoot: cwd }
}

// ---- createStore：工厂（非纯，注入依赖；缓存全部在闭包内）----
// deps: { fs, MEMORY_FILE, writePolicy, enqueueRefresh, renderT0 }
//   fs            DSH fs 服务（可 undefined → 降级空文档）
//   MEMORY_FILE   记忆文件名（缺省 '.dsh-memory.json'）
//   writePolicy   写盘策略 (cwd)=>({mode,workspaceRoot})（缺省用上面的 writePolicy）
//   enqueueRefresh (cwd)=>void 刷新通知回调（供渲染层；store 不反向依赖渲染层）
//   renderT0      (activeMemories, doc)=>{text,profileText} T0 文本渲染器（渲染层注入；
//                 不注入则 refreshT0 只缓存 raw + 调 enqueueRefresh，渲染层自行渲染）
export function createStore({ fs, MEMORY_FILE = '.dsh-memory.json', writePolicy: wpInj, enqueueRefresh, renderT0 } = {}) {
  const idfCache = new Map()    // cwd -> { map: Map<token,df>, totalDoc, dirty }
  const t0Cache = new Map()     // cwd -> { text, profileText, at }（渲染层读）
  const invertCache = new Map() // cwd -> Map<触发词, Set<id>>
  const pagesCache = new Map()  // cwd -> { pages, at }
  const wp = typeof wpInj === 'function' ? wpInj : writePolicy
  const notify = (cwd) => { try { if (typeof enqueueRefresh === 'function') enqueueRefresh(cwd) } catch (_) {} }

  function markIdfDirty(cwd) {
    const e = idfCache.get(cwd)
    if (e) e.dirty = true
  }
  // GLM §3：IDF 必须按 cwd 重算（合并/归档/新增都改语料统计），绝不用过期权重。
  function ensureIdf(cwd, doc) {
    let e = idfCache.get(cwd)
    if (e && !e.dirty) return e
    const d = doc || null
    if (!d) return { map: new Map(), totalDoc: 0, dirty: false }
    e = computeIdf(d)  // 复用纯核（与 index.js 原实现逐行等价，避免双维护漂移）
    idfCache.set(cwd, e)
    return e
  }
  // idf 权重（取 log(N/df)，df 越小越稀有；token 出现越少分越高）
  function idfWeight(cwd, token, doc) {
    const e = ensureIdf(cwd, doc)
    const df = e.map.get(token) || 0
    const N = Math.max(e.totalDoc, 1)
    if (df === 0) return 0
    return Math.log(1 + N / df)
  }

  // 损坏/读失败时的兜底：把原始字节（若已知）写回 .corrupt-<ts> 备份文件，再返回空文档。
  // 这样即使后续 memory_recall 等触发 writeDoc 覆盖，也不会丢原始数据。
  async function backupCorrupt(cwd, target, raw) {
    try {
      if (raw) {
        const bak = await fs.resolve(MEMORY_FILE + '.corrupt-' + Date.now(), { cwd })
        await fs.writeText(bak, raw, undefined, undefined, wp(cwd))
        console.log('[project-memory] memory file corrupt read; backed up raw bytes to .dsh-memory.json.corrupt-*')
      }
    } catch (b) { console.log('[project-memory] corrupt backup failed: ' + (b && b.message ? b.message : b)) }
    return { version: 2, memories: [] }
  }

  // The memory JSON lives in the user's project directory。
  async function readDoc(cwd) {
    if (fs === undefined) return { version: 2, memories: [] }
    const target = await fs.resolve(MEMORY_FILE, { cwd })
    const info = await fs.stat(target)
    if (!info) return { version: 2, memories: [] }
    let raw = ''
    try { raw = await fs.readText(target) } catch (e) {
      // 读失败：先备份任何已读字节（若有），再报空，避免后续 writeDoc 覆盖丢数据
      return backupCorrupt(cwd, target, raw)
    }
    let parsed
    try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (e) {
      // parse 失败：原始字节仍在 raw，先备份到 .corrupt-<时间戳> 再报空
      return backupCorrupt(cwd, target, raw)
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.memories) ? parsed.memories : [])
    const memories = list.filter(isValid).map(migrateV1).sort(byNewest)
    return { version: 2, memories }
  }

  async function writeDoc(cwd, memories) {
    if (fs === undefined) return false
    const target = await fs.resolve(MEMORY_FILE, { cwd })
    await fs.writeText(target, JSON.stringify({ version: 2, memories }, null, 2), undefined, undefined, wp(cwd))
    // GLM §3：任何写（合并/归档/新增）都改变语料统计 → 标记 IDF 表脏，下次惰性重建，绝不用过期权重。
    markIdfDirty(cwd)
    refreshIndex(cwd).catch(() => {})
    // 编辑/写记忆后 T0 立即刷新（含【用户画像】——确保编辑场景画像恒在，不受 15s 缓存延迟影响）
    refreshT0(cwd).catch(() => {})
    return true
  }

  async function refreshIndex(cwd) {
    try {
      const doc = await readDoc(cwd)
      invertCache.set(cwd, buildInvert(doc))
      notify(cwd)
    } catch (e) { /* 索引失败不阻塞 */ }
  }

  async function refreshPages(cwd) {
    try {
      const doc = await readDoc(cwd)
      pagesCache.set(cwd, { pages: buildPages(doc.memories), at: Date.now() })
      notify(cwd)
    } catch (e) { /* 页面重建失败不阻塞 */ }
  }

  // refreshT0：渲染层依赖（renderT0Text + t0ProfileText + INJECT_MODE/T0_PERM_CAP），故渲染回调注入。
  async function refreshT0(cwd, renderFn) {
    if (!cwd || t0Cache.get(cwd) && Date.now() - t0Cache.get(cwd).at < 15000) return
    try {
      const doc = await readDoc(cwd)
      // candidate 是隔离舱：不进 T0 索引，只把 active 记忆喂给 T0 渲染（转正成 active 后才可见）。
      const active = activeOnly(doc.memories)
      const renderer = renderFn || renderT0
      let entry
      if (typeof renderer === 'function') {
        let r
        try { r = renderer(active, doc) } catch (e) { r = '' }
        entry = {
          text: typeof r === 'string' ? r : (r && r.text) || '',
          profileText: (r && typeof r === 'object' && r.profileText) || '',
          at: Date.now(),
        }
      } else {
        // 无渲染器：只缓存 raw，通知渲染层自行渲染（store 不反向依赖渲染层）
        entry = { text: '', profileText: '', raw: active, at: Date.now() }
      }
      t0Cache.set(cwd, entry)
      invertCache.set(cwd, buildInvert(doc))
      refreshPages(cwd).catch(() => {})
      notify(cwd)
    } catch (e) { /* 刷新失败不阻塞 */ }
  }

  // 只读访问器（供渲染层同步读缓存；仅返回引用，不复制 live 数据）
  const getT0 = (cwd) => t0Cache.get(cwd)
  const getInvert = (cwd) => invertCache.get(cwd)
  const getPages = (cwd) => pagesCache.get(cwd)

  return { readDoc, writeDoc, refreshIndex, refreshT0, refreshPages, markIdfDirty, ensureIdf, idfWeight, getT0, getInvert, getPages }
}
