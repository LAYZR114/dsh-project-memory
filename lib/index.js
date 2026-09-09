// dsh-project-memory host half: store(v3) + 5 model tools + /memory command + host RPC routes.
// All seams are read via ctx.get(...) with capability probing (detect -> degrade -> report).
// Official-stable seams only: tools, commands, fs, webServer. High-risk internal seams
// (systemPrompt.context, tools/pre-execute, agent/*) are deliberately NOT used here to stay
// upgrade-resilient; recall works through the tools/memory_recall surface instead.

// lossless JSON 自动防线抽成独立纯函数模块，便于 round-trip 测试直接测真实实现（避免双维护漂移）。
import { jsonSafe } from './json-safe.js'
// GLM 新注入模块（L1-L4）：store/first/scene/rule/hooks。store.js 复用全部存储纯核与写盘策略；
// index.js 只负责装配 + injectMode 分流（scenario=新注入默认 | legacy-full=旧路径金丝雀）。
import { createStore, readDocSync } from './store.js'
import { createFirst } from './first.js'
import { createScene } from './scene.js'
import { createRule, actLabel, targetLabel, removeGuardFromDoc, userDeleteConfirmText } from './rule.js'
import { createHooks } from './hooks.js'

export const name = 'dsh-project-memory'

// DSH services (tools/commands/fs/webServer/agents) are only reachable through the
// `inject` declaration + ctx.<name> property access (super-injector uses
// `inject = ['tools','webServer']` + ctx.webServer/ctx.tools). ctx.get(...) alone
// returns undefined for these, which silently disabled the whole host. Declare them.
export const inject = ['tools', 'commands', 'fs', 'webServer', 'agents', 'approval', 'userQuestions', 'systemPrompt', 'llm']

const MEMORY_FILE = '.dsh-memory.json'

export function apply(ctx, config) {
  // ---- M4-lite 配置（apply 第 2 参注入，来自插件行 config；缺省兜底，改配置需重启宿主）----
  const cfg = config || {}
  const M4_FIELD_W = cfg.fieldWeight || { title: 3, description: 2, body: 0.4 }
  const LEX_WEIGHT = typeof cfg.lexWeight === 'number' ? cfg.lexWeight : 0.7
  const HEAT_WEIGHT = typeof cfg.heatWeight === 'number' ? cfg.heatWeight : 0.3
  const UNIGRAM_W = cfg.unigramWeight || { latin: 1.5, han: 1.0, other: 0.5 }
  const ALIASES = cfg.aliases || {}
  const M4_INJECT_CAP = (typeof cfg.injectCap === 'number') ? cfg.injectCap : 3   // GLM 三层漏斗：T1 注入每轮 ≤3 条
  const SCENE_DOMAINS = cfg.sceneDomains || { json: ['json','配置','数据'], yml: ['yml','yaml','配置'], md: ['md','markdown','文档'], js: ['js','javascript','代码'], ts: ['ts','typescript','代码'] }  // GLM 场景路由表：后缀→域 token（Config 可调）
  const READ_TOOLS = cfg.readTools || ['read','grep','cat','ls','glob','read_file','read_text']
  const INJECT_MODE = cfg.injectMode === 'legacy-full' ? 'legacy-full' : 'scenario'  // GLM 回退开关：scenario（T0收缩+场景触发，默认）| legacy-full（旧版每轮全量）
  // 生效注入路径（金丝雀可回退）：初始按配置；scenario 时新模块 attach 失败 → 降级 legacy-full（旧路径保留，防双份注册）。
  let injectionMode = INJECT_MODE
  const T0_PERM_CAP = (typeof cfg.t0PermCap === 'number') ? cfg.t0PermCap : 3        // 常设限量 top-N（legacy 模式）
  // ---- globalThis 判别探针（GLM §3）：跨实例/跨闭包同一份计数，区分分裂实例 vs 监听器真未触发 vs 注册回归 ----
  // globalThis 在同一进程内跨 apply 实例共享：applyRuns≥2 即分裂实例实锤；=1 且计数>0 则只是读取路径问题；
  // =1 且计数=0 则是监听器真未触发或注册被吞。__pmDiag 用 ??= 防重复初始化覆盖。
  globalThis.__pmDiag ??= { applyRuns: 0, preStep: 0, preExec: 0, postExec: 0, poll: 0 }
  const D = globalThis.__pmDiag
  D.applyRuns++
  try { console.log('[project-memory] apply run #' + D.applyRuns + ' from ' + import.meta.url) } catch (_) {}
  // Services are injected via `inject` and read as ctx.<name> (the super-injector
  // pattern). Read as properties so they resolve reliably.
  const tools = ctx.tools
  const commands = ctx.commands
  const fs = ctx.fs
  const agents = ctx.agents
  const webServer = ctx.webServer
  const approval = ctx.approval
  const userQuestions = ctx.userQuestions
  const systemPrompt = ctx.systemPrompt
  // llm 是可选 seam（压缩协同提炼增强用），非记忆核心：用 ctx.get 运行时探测，缺则 undefined 降级。
  // llm 服务：必须 inject + ctx.llm（super-injector 服务不能用 ctx.get，否则 undefined）。GLM 排查确认。
  const llm = ctx.llm

  // ---- GLM 新注入模块装配（L1-L4：store/first/scene/rule/hooks；金丝雀增量接线）----
  // 数据写路径零改动：工具/RPC/压缩继续用下方本地 readDoc/writeDoc；st 供新模块共享读盘与缓存访问器
  // （scene.plan 对 invert 缓存有 buildInvert 兜底，不依赖 st 缓存新鲜度）。
  // pendingChanges 原声明在 t0Cache 之后（旧 L122），此处提前：createFirst 的 getPending 依赖它（闭包），
  // 且 hk.register 必须赶在旧 context 注册之前判定生效模式（防双份）。
  const pendingChanges = new Map() // 待报改动清单（延迟汇总）：cwd -> [{file, path, note}]；post-execute 累积，N2 检测或 /memory pending clear 清空
  const st = createStore({
    fs, MEMORY_FILE, writePolicy,
    // store 刷新通知（L4 反哺占位）：st 的 refreshT0/refreshIndex/refreshPages 完成后回调。
    // 当前 index.js 写路径仍走本地 writeDoc（数据写路径零改动），首注镜像刷新经 fr.syncMirror 单点维护；
    // 此回调留作将来级联刷新入口（hooks/scene 改为直读 store 缓存时启用）。零副作用。
    enqueueRefresh: () => {},
  })
  const fr = createFirst({ store: st, getPending: (cwd) => pendingChanges.get(cwd) || [], readDocSync: (cwd) => readDocSync(cwd, MEMORY_FILE) })
  const sc = createScene({ store: st, cap: M4_INJECT_CAP, domains: SCENE_DOMAINS })
  const rl = createRule({ store: st, readDocSync: (cwd) => readDocSync(cwd, MEMORY_FILE) })
  const hk = createHooks({ store: st, first: fr, scene: sc, rule: rl, pendingChanges, diag: D, fs })
  // 硬守卫·审计回执（GLM §5）：blockedCount 命中即 +1，经回执回调落盘（writeDoc 原子写，防重启丢审计数）。
  // 回调注册在 apply 期（writeDoc 为函数声明，闭包内可用；触发时机在运行期）。
  {
    const bumpCwdSet = new Set() // 防抖：同一 cwd 并发 bump 只排队一次（读取-修改-写回竞态兜底）
    rl.onGuardBump((cwd, sourceId, count) => {
      try {
        if (bumpCwdSet.has(cwd)) return
        bumpCwdSet.add(cwd)
        readDoc(cwd).then((d) => {
          const i = (d.memories || []).findIndex((m) => m.id === sourceId)
          if (i < 0 || !d.memories[i].guard) return
          const next = [...d.memories]
          const cur = (next[i].guard.blockedCount || 0)
          next[i] = { ...next[i], guard: { ...next[i].guard, blockedCount: Math.max(cur, count) } }
          return writeDoc(cwd, next)
        }).catch(() => {}).finally(() => { bumpCwdSet.delete(cwd) })
      } catch (_) {}
    })
  }
  // injectMode 分流：scenario（默认）→ hk.register(ctx) 接管（新注入：context 三段 + ctx.on 三监听器）；
  // legacy-full → 旧路径照常（下方旧 context/监听器守卫按 injectionMode 判定，scenario 时不注册旧，legacy 时不注册新）。
  // 附加失败降级：hk.register 返回 false/抛错 → injectionMode 回退 legacy-full（旧路径守卫随之放行）。
  // 首步真身预热：apply 时对已知会话同步 warm（agent.list()——启动恢复已有会话）+ agent/created（新/子代理）→ fr.syncWarm 同步读盘建镜像。
  try {
    const agentsSvc = ctx.get && ctx.get('agents')
    if (agentsSvc && typeof agentsSvc.list === 'function') {
      for (const a of (agentsSvc.list() || [])) {
        const wcwd = cwdFromAgent(a)
        fr.syncWarm(wcwd)
        if (wcwd) rl.rebuild(wcwd, readDocSync(wcwd, MEMORY_FILE)) // 启动时重建守卫表（用户优化：含已有守卫）
      }
    }
    if (typeof ctx.on === 'function') {
      ctx.on('agent/created', (payload) => {
        try {
          const wcwd = cwdFromAgent(payload && payload.agent)
          fr.syncWarm(wcwd)
          if (wcwd) rl.rebuild(wcwd, readDocSync(wcwd, MEMORY_FILE))
        } catch (e) {}
      })
    }
  } catch (e) { /* 预热失败 → renderFirst 同步兜底 */ }
  if (INJECT_MODE === 'scenario') {
    let hkOk = false
    try { hkOk = hk.register(ctx) === true } catch (e) { hkOk = false }
    if (hkOk) injectionMode = 'scenario'
    else {
      injectionMode = 'legacy-full'
      console.log('[project-memory] hooks register failed -> injectMode fallback to legacy-full (canary)')
    }
  } else {
    injectionMode = 'legacy-full'
  }
  // M3 事件单独 ctx.on（hooks 不接管）：pollCompaction 在 scenario 模式挂独立 pre-step 触发点——
  // 旧 pre-step 监听器（含 L~401 的 pollCompaction 调用）仅在 legacy-full 注册；provider/canary 触发点不受影响。
  if (injectionMode === 'scenario' && typeof ctx.on === 'function') {
    try {
      ctx.on('agent/pre-step', (payload, next) => {
        try {
          const agent = payload && payload.agent
          const cwd = cwdFromAgent(agent)
          if (cwd) pollCompaction(agent, cwd).catch(() => {})
        } catch (e) { /* 忽略 */ }
        return next()
      })
    } catch (e) { console.log('[project-memory] M3 poll listener failed: ' + (e && e.message ? e.message : e)) }
  }

  // 系统提示约束：引导 AI 只用 memory_* 工具改记忆，禁止直接改 .dsh-memory.json 绕过确认。
  if (injectionMode === 'legacy-full' && systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
    try {
      systemPrompt.context({
        name: 'project-memory-rules',
        order: 1,
        text: '[项目记忆规则] 修改记忆仅经 memory_* 工具（走确认门）；禁止 write/edit/node 直改 .dsh-memory.json。改/删记忆时插件会注入完整规则。',
      })
      // 用户画像恒每轮注入（跟项目记忆规则同层，不随场景）：type:user 行为习惯每次发送对话都注入。
      systemPrompt.context({
        name: 'project-memory-profile',
        order: 2,
        text: (ac) => {
          try {
            const agent = ac && ac.agent
            const cwd = cwdFromAgent(agent)
            if (!cwd) return ''
            // 只首注（子代理诊断）：每轮第一步（assemble 时 phase.step===0）才渲染画像；工具往返/后续 step（step≥1）不重复注入——读文件时不再带画像。
            // 注意：勿用名 st 作局部（已与外层 createStore 实例 st 重名，防遮蔽踩坑），故称 stepNow。
            const stepNow = agent && agent.phase && typeof agent.phase.step === 'number' ? agent.phase.step : 0
            if (stepNow !== 0) return ''
            const e = t0Cache.get(cwd)
            const prof = e && e.profileText ? e.profileText : (t0ProfileText || '')
            return prof ? ('【用户画像】\n' + prof) : ''
          } catch (_) { return '' }
        },
      })
      // T0 常驻层：每轮 provider 渲染「当前项目」的状态快照 + 义务/pinned + permanent 索引。
      // cwd 取自 AssembleContext.agent（核心主动放入，见 F3）；读盘异步，故用 t0Cache（pre-step 刷新）。
      systemPrompt.context({
        name: 'project-memory-t0',
        order: 0,
        text: (ac) => {
          try {
            const agent = ac && ac.agent
            const cwd = cwdFromAgent(agent)
            if (!cwd) return ''
            // B'（GLM §4 触发点正解）：provider 每个 assemble 必被核心调用且有 context.agent，零事件依赖。
            // 把压缩协同轮询挂这里 —— 每次组装系统提示时顺带增量扫 session 的 compaction/summary。
            // 不 await、不阻断渲染；pollCompaction 内部全 try/catch，失败上报 failed: 不抛。
            try { pollCompaction(agent, cwd, 'provider').catch(() => {}) } catch (_) {}
            const e = t0Cache.get(cwd)
            const hit = injectedCache.get(cwd)
            const beh = behaviorCache.get(cwd)
            const pc = pagesCache.get(cwd)
            const pageText = pc && pc.pages && pc.pages.length ? pc.pages.slice(0, 1).map(p => `【${p.question}】\n${String(p.text || '').slice(0, 500)}`).join('\n\n') : ''
            // 待报改动（延迟汇总）常驻催办行：计数 + 前 2 路径示例（省 token；完整表格由 memory_pending_changes 按需返回）
            const pend = pendingChanges.get(cwd) || []
            const pendText = pend.length
              ? `📋 待报告改动：${pend.length} 项（每次改文件后累积，完成对话任务时汇总表格报告）\n` + pend.slice(0, 2).map(x => `  - ${x.path}`).join('\n')
              : ''
            if (!e && !hit && !beh && !pageText && !pendText) return ''
            const parts = []
            if (e && e.text) parts.push(e.text)
            if (beh) parts.push(beh)
            if (pendText) parts.push(pendText)
            if (pageText) parts.push(pageText)
            if (hit) parts.push(hit)
            return parts.join('\n\n')
          } catch (err) { return '' }
        },
      })
    } catch (e) {
      console.log('[project-memory] systemPrompt context register failed: ' + (e && e.message ? e.message : e))
    }
  }
  // T0 渲染缓存：cwd -> { text, at }。pre-step 拿到 agent 后异步刷新，provider 同步读。
  const t0Cache = new Map()
  // T0 排序权重：proofCount 棘轮升权 + 义务/常驻优先 + heat + 时新（让「被证实 N 次的坑」排前）
  function t0Rank(m) {
    const now = Date.now()
    let ageDays = 0
    try { ageDays = (now - new Date(m.updatedAt).getTime()) / 86400000 } catch (e) {}
    if (ageDays < 0) ageDays = 0
    const recency = 1 / (1 + ageDays)
    return (m.proofCount || 0) * 20 + (m.obligation === true || m.pinned === true ? 1000 : 0) + (m.heat || 0) * 2 + recency * 10
  }
  function renderT0Text(memories) {
    const state = memories.filter(m => m.type === 'state').slice(0, 1)
    const oblig = memories.filter(m => m.obligation === true || m.pinned === true)
    const user = memories.filter(m => m.type === 'user' && m.status !== 'archived') // GLM 裁定：type:user 进【用户画像】档
    const perm = memories.filter(m => m.ttl === 'permanent' && !m.obligation && !m.pinned && m.type !== 'user')
    const sortBy = (arr) => arr.slice().sort((a, b) => t0Rank(b) - t0Rank(a))
    // 画像档排序：pinned > proofCount > 新近度（GLM §4），≤8 行截断，溢出 recall 可达
    const sortUser = (arr) => arr.slice().sort((a, b) => {
      const pa = a.pinned === true ? 1 : 0, pb = b.pinned === true ? 1 : 0
      if (pa !== pb) return pb - pa
      const ca = a.proofCount || 0, cb = b.proofCount || 0
      if (ca !== cb) return cb - ca
      return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)
    })
    const rows = []
    if (state.length) rows.push('[当前状态] ' + (state[0].description || state[0].title))
    if (user.length) {
      const capped = sortUser(user).slice(0, 8) // GLM：画像档 ≤8 行
      diagUserTotal = user.length; diagUserRows = capped.length
      t0ProfileText = capped.map(m => `- ${m.title}：${m.description}`).join('\n')
      // 画像不再写进 t0 e.text（避免与 project-memory-profile 重复×2）；由 profile 独立上下文渲染
    } else t0ProfileText = ''
    if (injectionMode === 'scenario') {
      // GLM 批次②：T0 收缩——红线/常设/坑/决策迁场景供给（不改则不注），T0 只画像+状态+心跳行（红线"存在性"提示）。
      const redCount = oblig.length, permCount = perm.length
      rows.push(`【心跳】📌 ${redCount} 条红线/规则 + ${permCount} 条常设知识随场景自动生效（改文件/改记忆/涉及话题时自动提醒）`)
    } else {
      // legacy-full：旧版每轮全量（回退开关）
      if (oblig.length) {
        const rowsO = ['【必须遵守】🔴 以下红线必须无条件遵守（obligation/用户钉选）：']
        for (const m of sortBy(oblig)) {
          const desc = m.description ? (m.description.length > 60 ? m.description.slice(0, 60) + '…' : m.description) : ''
          rowsO.push(`- ${m.title}${desc ? '：' + desc : ''}`)
        }
        rows.push(rowsO.join('\n'))
      }
      if (perm.length) {
        const cappedP = sortBy(perm).slice(0, T0_PERM_CAP)
        rows.push('【常设】\n' + cappedP.map(m => `- [${m.title}](${m.name || m.id}) · ${m.type}${m.proofCount ? ` · ⚙${m.proofCount}` : ''} — ${m.description}`).join('\n')
          + (perm.length > T0_PERM_CAP ? `\n另有 ${perm.length - T0_PERM_CAP} 条常设知识（memory_recall 可查）` : ''))
      }
    }
    let text = rows.join('\n\n')
    if (text.length > 1200) text = text.slice(0, 1200)
    return text
  }
  // ---- M1.5 零 Token 检测：倒排索引 + 命中注入（全代码，检测 0 token）----
  // invertCache: cwd -> Map<触发词, Set<id>>；injectedCache: cwd -> 命中文本（provider 下一轮注入）
  const invertCache = new Map()
  const injectedCache = new Map()
  // 行为检测：behaviorCache(cwd -> 提醒文本) + behaviorFired(cwd -> 本 turn 已提醒的 memoryId 集，洪水控制)
  const behaviorCache = new Map()
  const behaviorFired = new Map()
  // 行为提醒渲染为一行短句（不重注入全文，obligation 红线本来就在 T0）
  function renderBehaviorLine(cat, title) {
    const map = {
      file: `⚠️ 刚完成文件修改：收尾回复须按红线以表格报告改动文件的绝对路径（${title}）。`,
      exec: `⚠️ 刚执行命令：如改动文件，收尾回复须按红线以表格报告改动路径（${title}）。`,
      memory: `⚠️ 刚修改项目记忆：请确认已获得用户批准、且按正确格式反馈（${title}）。`,
    }
    return map[cat] || ''
  }
  function buildInvert(doc) {
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
  async function refreshIndex(cwd) {
    try {
      const doc = await readDoc(cwd)
      invertCache.set(cwd, buildInvert(doc))
    } catch (e) { /* 索引失败不阻塞 */ }
  }
  // 从本轮输入文本查倒排索引，返回命中的记忆 id 集（按命中词数排序）
  function detectHits(cwd, text) {
    const inv = invertCache.get(cwd)
    if (!inv || !text) return []
    const counts = new Map()
    for (const [w, ids] of inv.entries()) {
      if (text.indexOf(w) === -1) continue
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, M4_INJECT_CAP).map((e) => e[0])
  }
  // 从一条 UserMessage 提取文本（content[0].text）
  function extractTextOf(m) {
    try { const b = m && m.content && m.content[0]; return (b && b.text) || '' } catch (e) { return '' }
  }
  // GLM 批次①重要等级派生（确定性，零 schema）：P1=obligation‖pinned（红线）；P2=ttl permanent/phase（常设）；P3=其余。标记对 AI 可见。
  function deriveLevel(m) {
    if (m.obligation === true || m.pinned === true) return 'P1·红线'
    if (m.ttl === 'permanent' || m.ttl === 'phase') return 'P2·常设'
    return 'P3·情境'
  }
  // 命中记忆渲染为「任务相关」文本（片段化：等级标记 + title+description 关键行，不注入 body 全文——避免注入太多 AI 脑子乱；需要全文可 memory_read）。
  function renderHitText(mems) {
    if (!mems.length) return ''
    const rows = ['【任务相关记忆】']
    for (const m of mems.slice(0, M4_INJECT_CAP)) {
      rows.push(`- [${deriveLevel(m)}] ${m.title}：${(m.description || m.body || '').slice(0, 120)}`)
    }
    let text = rows.join('\n')
    if (text.length > 1500) text = text.slice(0, 1500)
    return text
  }
  // 红线即时注入（子代理方案）：话语/场景命中红线记忆 → 一行短句提醒（带 [P1·红线] 等级标记，AI 看到即知必须遵守）。
  function renderRedlineText(mems) {
    if (!mems.length) return ''
    const rows = ['【命中红线】⚠️ 您涉及以下必须遵守：']
    for (const m of mems.slice(0, M4_INJECT_CAP)) rows.push(`- [P1·红线] ${m.title}：${m.description || m.body || ''}`.slice(0, 200))
    return rows.join('\n')
  }
  // GLM 三层漏斗·场景感知注入：read 清空 / edit 域匹配 / memory 相关，≤M4_INJECT_CAP 写 injectedCache（同 pre-step 渲染，cwd 覆盖）。
  async function sceneInject(cwd, nm, exec) {
    try {
      if (!cwd || !nm) return
      const a = (exec && (exec.arguments || exec.args || {})) || {}
      const path = a.file_path || a.path || a.file || ''
      const domTool = /^(write|edit|str_replace_editor)$/i.test(nm)
      const memTool = /^memory_(write|update|delete)$/i.test(nm)
      const readTool = READ_TOOLS.includes(nm) || /^read|^grep|^cat|^ls|^glob/.test(String(nm || ''))
      if (readTool && !domTool && !memTool) { injectedCache.delete(cwd); diagSceneType = 'read-clear'; return }
      const doc = await readDoc(cwd)
      const active = doc.memories.filter((m) => m.status === 'active' && m.type !== 'state')
      let selected = []
      if (domTool) {
        let doms = []
        if (path) { const ext = String(path).replace(/^.*\./, '').toLowerCase(); if (SCENE_DOMAINS[ext]) doms = SCENE_DOMAINS[ext] }
        if (!doms.length && a.path) {
          if (/\.(json)$/i.test(a.path)) doms = SCENE_DOMAINS.json
          else if (/\.(ya?ml)$/i.test(a.path)) doms = SCENE_DOMAINS.yml
          else if (/\.(md)$/i.test(a.path)) doms = SCENE_DOMAINS.md
          else if (/\.(js)$/i.test(a.path)) doms = SCENE_DOMAINS.js
          else if (/\.(ts)$/i.test(a.path)) doms = SCENE_DOMAINS.ts
        }
        if (doms.length) selected = active.filter((m) => {
          const hay = ((m.triggers || []).join(' ') + ' ' + (m.tags || []).join(' ') + ' ' + (m.title || ''))
          return doms.some((t) => hay.indexOf(t) >= 0)
        })
        if (!selected.length) selected = active.slice().sort((x, y) => {
          const px = (x.obligation === true || x.pinned === true) ? 1 : 0, py = (y.obligation === true || y.pinned === true) ? 1 : 0
          if (px !== py) return py - px
          return Date.parse(y.updatedAt || 0) - Date.parse(x.updatedAt || 0)
        }).slice(0, M4_INJECT_CAP)
        diagSceneType = doms.length ? 'edit-domain' : 'edit-fallback'
      } else if (memTool) {
        selected = active.filter((m) => m.obligation === true || m.pinned === true || m.type === 'user' || m.type === 'project')
          .slice().sort((x, y) => { const px = (x.obligation === true || x.pinned === true) ? 1 : 0, py = (y.obligation === true || y.pinned === true) ? 1 : 0; if (px !== py) return py - px; return (y.proofCount || 0) - (x.proofCount || 0) }).slice(0, M4_INJECT_CAP)
        diagSceneType = 'memory-op'
      }
      if (selected.length) {
        const red = selected.filter((m) => m.obligation === true || m.pinned === true)
        const nonRed = selected.filter((m) => !(m.obligation === true || m.pinned === true))
        let txt = renderRedlineText(red)
        if (nonRed.length) txt = (txt ? txt + '\n' : '') + renderHitText(nonRed)
        injectedCache.set(cwd, txt); diagSceneCount = selected.length
      }
      else injectedCache.delete(cwd)
    } catch (e) { diagSceneType = 'failed:' + ((e && e.message) ? e.message : String(e)) }
  }
  // ---- M2 知识页 v1（零 LLM 确定性拼装，可再生工件）----
  // pagesCache: cwd -> { pages: [{id,question,text,sources,rewrittenAt}] }
  const pagesCache = new Map()
  function buildPages(memories) {
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
  async function refreshPages(cwd) {
    try {
      const doc = await readDoc(cwd)
      pagesCache.set(cwd, { pages: buildPages(doc.memories), at: Date.now() })
    } catch (e) { /* 页面重建失败不阻塞 */ }
  }
  async function refreshT0(cwd) {
    if (!cwd || t0Cache.get(cwd) && Date.now() - t0Cache.get(cwd).at < 15000) return
    try {
      const doc = await readDoc(cwd)
      // candidate 是隔离舱：不进 T0 索引，只把 active 记忆喂给 T0 渲染（转正成 active 后才可见）。
      t0Cache.set(cwd, { text: renderT0Text(activeOnly(doc.memories)), profileText: t0ProfileText, at: Date.now() })
      invertCache.set(cwd, buildInvert(doc))
      refreshPages(cwd).catch(() => {})
    } catch (e) { /* 刷新失败不阻塞 */ }
  }
  // pre-step 监听器：每步拿到 agent → 异步刷新该项目的 T0 缓存（provider 下一轮读到）。
  // waterfall 语义：必须调用 next()；刷新不阻塞 step。
  if (injectionMode === 'legacy-full' && typeof ctx.on === 'function') {
    try {
      ctx.on('agent/pre-step', (payload, next) => {
        try {
          D.preStep++
          diagPreStepFired++
          const agent = payload && payload.agent
          if (agent && agent.session) diagAgentHasSession++
          const cwd = cwdFromAgent(agent)
          if (cwd) {
            diagCwdResolved++
            // M1.5：本轮输入查倒排索引 → 命中记忆 → 渲染命中文本（provider 下一轮注入）
            const msgs = (payload && payload.messages) || []
            const input = msgs.map((m) => { try { const b = m && m.content && m.content[0]; return b && b.text || '' } catch (e) { return '' } }).filter(Boolean).join('\n')
            if (input) {
              const hits = detectHits(cwd, input)
              if (hits.length) {
                readDoc(cwd).then((doc) => {
                  const picked = hits.map((id) => doc.memories.find((m) => m.id === id)).filter(Boolean)
                  // T1 反哺（GLM ②）：命中集用 M4-lite 新计分排序取 top-K（触发仍查表，零 LLM；仅重排，不触发写）。
                  let ordered = picked
                  try {
                    if (picked.length > 1) {
                      const idf = (t) => idfWeight(cwd, t, doc)
                      const { scored } = scoreMemory(picked, input.slice(0, 200), idf)
                      if (scored && scored.length) ordered = scored.map((x) => x.m)
                    }
                  } catch (_) { ordered = picked }
                  // 红线即时注入（子代理方案）：话语命中集里 obligation/pinned 红线 → 红线短句提醒（前置于通用注入），其余通用渲染。
                  const redline = ordered.filter((m) => m.obligation === true || m.pinned === true)
                  const nonRed = ordered.filter((m) => !(m.obligation === true || m.pinned === true))
                  let txt = renderRedlineText(redline)
                  if (nonRed.length) txt = (txt ? txt + '\n' : '') + renderHitText(nonRed)
                  injectedCache.set(cwd, txt)
                }).catch(() => {})
              } else {
                injectedCache.delete(cwd)
              }
            }
            refreshT0(cwd).catch(() => {})
          }
          // 通道 B：压缩协同·候选提炼 —— 主动轮询该 agent 的 session，增量扫 compaction/summary。
          // 通道 A（session/event 监听）经验证是架构性死路：session/event 经 agent-scoped emitCtx
          // 做 scope-filtered dispatch，宿主级插件监听器收不到。改用 pre-step 触发点 + snapshotEvents 增量。
          if (cwd) pollCompaction(agent, cwd).catch(() => {})
        } catch (e) { /* 忽略 */ }
        return next()
      })
    } catch (e) { console.log('[project-memory] pre-step listener failed: ' + (e && e.message ? e.message : e)) }
  }

  // ---- 行为检测：tools/pre-execute（工具执行前，官方稳定事件，exec.name/agent 契约字段）----
  // AI 调写文件/执行/记忆写类工具 → 触发「修改文件位置要点」等红线记忆的行为提醒（一行短句）。
  // 洪水控制：每条红线记忆整个会话只提醒一次（避免刷屏稀释显著性）。
  if (injectionMode === 'legacy-full' && typeof ctx.on === 'function') {
    try {
      ctx.on('tools/pre-execute', (exec, next) => {
        try {
          D.preExec++
          diagPreExecFired++
          const nm = exec && exec.name
          const agent = exec && exec.agent
          const cwd = cwdFromAgent(agent)
          if (!nm || !cwd) return next()
          // GLM 规则硬守卫（批次②③，机制守卫不靠提示词）：rule.guardCheck = 结构性基线（.dsh-memory.json 直改）
          // + 记忆派生守卫（block_write/update/delete）。deny 优先于 approval：pre-execute 短路，工具体（含确认门）不执行。
          // 契约：DSH PreToolDecision = { kind:'deny', reason }（dsh-tools prepareExecution：非 allow 读 decision.reason，
          // 无 reason → 不拦截——旧 { kind:'reject', message } 在此 harness 下静默放行，故统一 deny+reason）。
          if (rl && typeof rl.guardCheck === 'function') {
            const gd = rl.guardCheck(exec, cwd)
            if (gd && gd.text) {
              if (gd.hit) { try { rl.bumpBlocked(cwd, gd.hit.sourceId) } catch (_) {} }
              return Promise.resolve({ kind: 'deny', reason: gd.text })
            }
          }
          // 触发清单分类
          let cat
          if (/^(write|edit|str_replace_editor)$/i.test(nm)) cat = 'file'
          else if (/^(pwsh|bash|node|subprocess|shell)$/i.test(nm)) cat = 'exec'
          else if (/^memory_(write|update|delete)$/i.test(nm)) cat = 'memory'
          if (!cat) return next()
          // 命令类工具：执行前快照 cwd 顶层文件（存 promise，post-execute 比对用）
          if (cat === 'exec') execSnapWeak.set(exec, snapshotTopLevel(cwd))
          // 读红线记忆（obligation / 明确要求报路径的），未在本会话提醒过的才触发
          readDoc(cwd).then((doc) => {
            const already = behaviorFired.get(cwd) || new Set()
            const redlines = doc.memories.filter(m => (m.obligation === true || m.pinned === true) && !already.has(m.id))
            if (!redlines.length) return
            const ids = redlines.map(m => m.id)
            const remind = redlines.slice(0, 3).map(m => renderBehaviorLine(cat, m.title)).join('\n')
            if (remind) {
              behaviorCache.set(cwd, remind)
              ids.forEach((id) => already.add(id))
              behaviorFired.set(cwd, already)
            }
          }).catch(() => {})
          // GLM 三层漏斗（场景感知注入）：读类清空 / 编辑域匹配 / 记忆操作相关，≤cap 写 injectedCache（去重）。
          sceneInject(cwd, nm, exec).catch(() => {})
        } catch (e) { /* 忽略 */ }
        return next()
      })
    } catch (e) { console.log('[project-memory] tools/pre-execute listener failed: ' + (e && e.message ? e.message : e)) }
  }

  // ---- P1 结果增强（L3 转述）：tools/post-execute 把改动路径写进工具结果（P1=实施优先级，非记忆分级）----
  // 模型的任务从"想起红线"变成"转述眼前刚看的行"。ContentBlock={type:'text',text}平凡构造，无内部 API 依赖。
  function absPath(cwd, rel) {
    if (!rel) return ''
    const r = String(rel)
    if (/^[A-Za-z]:/.test(r) || r.startsWith('/')) return r
    const base = String(cwd || '').replace(/[\\/]+$/, '')
    return base + '\\' + r.replace(/^[\\/]+/, '')
  }
  // 待报告改动累积（延迟汇总 / L4 代劳）：按 abs 去重（note 取最后），cap 50。
  // 覆盖所有文件类修改：代码/文档（write/edit）与记忆文件（memory_* 工具、/memory 命令）。
  function addPending(cwd, file, abs, note) {
    try {
      let acc = pendingChanges.get(cwd) || []
      const idx = acc.findIndex((x) => x.path === abs)
      if (idx >= 0) acc[idx] = { file, path: abs, note: note || '' }
      else { acc = acc.concat({ file, path: abs, note: note || '' }).slice(-50); pendingChanges.set(cwd, acc) }
    } catch (e) { /* 累积失败不阻塞 */ }
  }

  // ---- 命令写文件前后状态检查（shell 等难直接拿 file_path，故用快照比对兜底）----
  // pre-execute 快照 cwd 顶层文件（name->size），post-execute 重快照比对，变化即记 pendingChanges。
  // 快照只读一次 listDir（不递归、不读内容），成本可控；只比对变化，读取类命令不会误报。
  const execSnapWeak = new WeakMap() // exec 对象 -> Map<name,size>
  async function snapshotTopLevel(cwd) {
    const snap = new Map()
    try {
      if (fs === undefined || typeof fs.listDir !== 'function') return snap
      const dir = await fs.resolve('.', { cwd })
      const entries = await fs.listDir(dir)
      for (const e of entries) snap.set(e.name, e.size === undefined ? 0 : e.size)
    } catch (e) { /* 快照失败 → 空，不误报 */ }
    return snap
  }
  function isExecTool(nm) { return /^(pwsh|bash|node|subprocess|shell|exec)$/i.test(nm || '') }
  // 比对前后快照：返回新增/删除/大小变化的 [name] 列表
  function diffSnapshots(before, after) {
    const changed = []
    const names = new Set([...(before && before.keys() || []), ...(after.keys() || [])])
    for (const n of names) {
      const b = before && before.get(n), a = after.get(n)
      if (b !== a) changed.push(n)
    }
    return changed
  }
  if (injectionMode === 'legacy-full' && typeof ctx.on === 'function') {
    try {
      ctx.on('tools/post-execute', (exec, result, next) => {
        try {
          D.postExec++
          diagPostExecFired++
          console.log('[project-memory] post-execute fired: ' + (exec && exec.name))
          const nm = exec && exec.name
          const agent = exec && exec.agent
          const cwd = cwdFromAgent(agent)
          if (!cwd) return next()
          // isError 的写不记（GLM §4.3：只记实际成功改动）
          if (result && result.isError) return next()
          const a = (exec && exec.arguments) || {}
          const prev = (result && result.content) || []
          // 代码/文档文件：write/edit/str_replace_editor（有明确 file_path）
          if (/^(write|edit|str_replace_editor)$/i.test(nm || '')) {
            const p = a.file_path || a.path || ''
            if (!p) return next()
            const abs = absPath(cwd, p)
            addPending(cwd, p, abs, '')
            const line = { type: 'text', text: `\n📎 本次改动文件：${abs} —— 收尾回复须按红线以表格报告该文件（文件|路径|说明）。` }
            return Promise.resolve({ kind: 'accept', content: [...prev, line] })
          }
          // 记忆文件：memory_write/update/delete 改 .dsh-memory.json（计入待报告改动，杜绝漏报）
          if (/^memory_(write|update|delete)$/i.test(nm || '')) {
            const abs = absPath(cwd, MEMORY_FILE)
            addPending(cwd, MEMORY_FILE, abs, '记忆修改')
            const line = { type: 'text', text: `\n📎 本次改动记忆文件：${abs}（记忆修改已计入待报告改动清单）。` }
            return Promise.resolve({ kind: 'accept', content: [...prev, line] })
          }
          // 命令类工具（pwsh/bash/node 等）：前后快照比对，检测到顶层文件改动 → 记录（兜底难直接拿 file_path 的场景）
          if (isExecTool(nm)) {
            const beforeP = execSnapWeak.get(exec)
            if (beforeP) {
              Promise.resolve(beforeP).then((before) => snapshotTopLevel(cwd).then((after) => {
                const changed = diffSnapshots(before, after)
                for (const n of changed) addPending(cwd, n, absPath(cwd, n), '命令改动')
              })).catch(() => {})
            }
            return next()
          }
          return next()
        } catch (e) { return next() }
      })
    } catch (e) { console.log('[project-memory] tools/post-execute listener failed: ' + (e && e.message ? e.message : e)) }
  }

  // ---- 压缩协同·候选提炼（M3 第一落地项）：检测 checkpoint → 提炼候选 → candidate 隔离舱 ----
  // 通道 A（session/event 监听）经验证是架构性死路：session/event 经 agent-scoped emitCtx 做
  // scope-filtered dispatch，宿主级插件监听器收不到（diagListenerRegistered=false 已证实）。
  // 改用通道 B（pollCompaction）：宿主级 agent/pre-step 触发，增量扫 agent.session.snapshotEvents()。
  // 'compaction/summary'.data.summary 是 ContentBlock[]，即被压缩区间的浓缩摘要（原料足够）。
  // 遵循探测→退化→上报：无 llm / 无 provider-model / 调用抛错 → 静默不提炼（无损），capabilityReport 上报。
  // 靠 session.header.cwd 分键（每项目隔离），cwd 未知直接跳过；lastSeenSeq 按 session id 增量记账。
  const pollLastSeq = new Map()   // sessionId(string) -> 已扫过的最末尾 seq(number)
  // 重启重扫去重线：cwd -> 该 cwd 已落地候选的"最大来源 compactionSeq"。进程首次对该 cwd 读盘初始化，
  // persistCandidates 落盘后同步更新。用于重启后（pollLastSeq 清零）避免把旧压缩事件再次提炼成重复候选。
  const compactionSeenCache = new Map()
  async function cwdMaxCompactionSeq(cwd) {
    if (compactionSeenCache.has(cwd)) return compactionSeenCache.get(cwd)
    let maxSeq = 0
    try {
      const doc = await readDoc(cwd)
      for (const m of doc.memories) {
        if (typeof m.compactionSeq === 'number' && m.compactionSeq > maxSeq) maxSeq = m.compactionSeq
      }
    } catch (e) { /* 读不到则视为无去重线（0），并发下可能多提炼一次，靠内部 titleSimilarity 兜底 */ }
    compactionSeenCache.set(cwd, maxSeq)
    return maxSeq
  }
  // 主动轮询：增量拉取该 agent session 的新增事件，筛出 compaction/summary → 异步提炼。不阻断 pre-step。
  // 起点下限取 max(fork 继承边界, 该 cwd 已落地候选最大 compactionSeq + 1)：前者避免 fork 会话扫父会话前缀，
  // 后者避免重启后重扫旧压缩事件产生重复候选。再叠加 pollLastSeq 增量线。
  async function pollCompaction(agent, cwd, source) {
    try {
      D.poll++
      diagPollScans++
      // 入口诊断：记录 agent 形状 + return 原因，定位「agent.session 为 undefined / poll 提前 return」根因。
      diagPollSource = source || 'unknown'
      diagPollAgentHasSess = !!(agent && agent.session)
      diagPollAgentKeys = (agent && typeof agent === 'object') ? Object.keys(agent).join(',') : String(typeof agent)
      diagPollSessHasSnapshot = !!(agent && agent.session && typeof agent.session.snapshotEvents === 'function')
      const sess = agent && agent.session
      if (!sess || typeof sess.snapshotEvents !== 'function') {
        diagPollReturnReason = (!sess ? 'no-session' : 'no-snapshotEvents')
        return
      }
      diagPollReturnReason = 'proceed'
      const sid = String(sess.id || '')
      // 记录 inheritedEventCount 仅供诊断（不用它当 from 起点，因为它会把继承前缀里的 compaction/summary 排除掉）。
      const ownBoundary = (typeof sess.inheritedEventCount === 'number') ? sess.inheritedEventCount : 0
      const maxSeen = await cwdMaxCompactionSeq(cwd)
      const dedupeFloor = maxSeen < 0 ? 0 : maxSeen + 1
      // from 起点 = 重启去重线（已落地候选最大 compactionSeq+1），绝不用 inheritedEventCount：
      // compaction/summary 是「要捕捉的 checkpoint」，可能落在继承前缀（当前会话恢复后，旧压缩事件 seq < inheritedEventCount），
      // 若用 inheritedEventCount 当起点会永久跳过它们 → diagPollCompaction=0。pollLastSeq 做进程内增量，避免重复扫。
      const last = pollLastSeq.get(sid) || 0
      const from = Math.max(dedupeFloor, last === 0 ? dedupeFloor : last + 1)
      // 详细诊断（在 await 之前就记录 sid/own/from/seq，避免异步未完成时读到初始值假象）。
      diagPollSid = sid
      diagPollOwn = ownBoundary
      diagPollFrom = from
      diagPollSeq = (typeof sess.seq === 'number') ? sess.seq : -1
      const events = sess.snapshotEvents(from)
      diagPollScanEvents = events.length
      let newLast = last
      const seenSummarySeqs = []
      for (const ev of events) {
        const seq = ev && typeof ev.seq === 'number' ? ev.seq : -1
        if (seq > newLast) newLast = seq
        if (ev && ev.type === 'compaction/summary' && ev.data) {
          seenSummarySeqs.push(String(seq))
          diagPollCompaction++
          hasCompactionDetect = true
          const blocks = (ev.data.summary) || []
          const text = blocks.map((b) => (b && b.text) || '').filter(Boolean).join('\n')
          if (!text) continue
          diagPollCompactionText++
          // 串行 await 提炼+落舱：让 canary /memory status 的 await pollCompaction 拿到确定性真实结果。
          // 失败仍上报 failed:（不静默），供能力探测可见。
          try {
            await handleCompactionSummary(cwd, text, ev)
          } catch (e) {
            const msg = (e && e.message) ? e.message : String(e)
            compactionCaptureVal = 'failed:' + msg
            console.log('[project-memory] compaction extract failed (reported): ' + msg)
          }
        }
      }
      diagPollCompactionIds = seenSummarySeqs.join(',')
      if (newLast > last) pollLastSeq.set(sid, newLast)
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      compactionCaptureVal = 'failed:' + msg
      console.log('[project-memory] pollCompaction failed (reported): ' + msg)
    }
  }

  async function handleCompactionSummary(cwd, summaryText, event) {
    // 提炼候选：用 ctx.llm 一次小请求，输出 ≤5 条候选（title/type/ttl/triggers/why）。
    // provider/model 从 llm 探测；不可用则上报 no-llm 静默返回（无损）。
    if (llm === undefined || typeof llm.stream !== 'function') {
      compactionCaptureVal = 'no-llm'
      return
    }
    const route = await probeLlmRoute()
    if (!route) {
      compactionCaptureVal = 'degraded'
      return
    }
    diagLastRoute = (route.provider || '?') + '/' + (route.model || '?')
    diagDistillRunCount++
    // B(冗余治理·换传感器)：把现有 active+candidate 的紧凑摘要附给提炼 LLM，让它「看着现有记忆」工作。
    // 零额外调用（提炼本来就发生）；同主题的候选输出 mergeInto:<slug> 而非新候选，杜绝重复生成候选。
    let existingSummary = ''
    try {
      const doc = await readDoc(cwd)
      const lines = (doc.memories || []).filter((m) => m.status === 'active' || m.status === 'candidate')
        .slice(0, 40)
        .map((m) => `- ${(m.title || '').slice(0, 40)} (${m.name || m.id}) · ${m.type}`)
      existingSummary = lines.join('\n')
    } catch (e) { existingSummary = '' }
    const candidates = await distillCandidates(llm, route, summaryText, existingSummary)
    if (!candidates || !candidates.length) {
      // 候选为空：llm 提炼失败或输出非预期 → 不落盘（无损），记下原因供诊断
      if (!diagDistillErr) diagDistillErr = 'distill-empty-or-failed'
      diagDistillEmptyCount++
      return
    }
    // 来源压缩事件的 seq（未带 seq 时给 undefined，persistCandidates 兜底 0）。
    const seq = event && typeof event.seq === 'number' ? event.seq : undefined
    // 确定性去重（titleSimilarity ≥0.6）+ 限额 → candidate 落盘（writeDoc 原子写）。
    await persistCandidates(cwd, candidates, seq)
  }

  // 探测 llm 的路由（provider/model）。优先级：config-first → listProviders 枚举兜底。无可用路由返回 null。
  async function probeLlmRoute(agent) {
    // 三源回退链（照抄 compaction-basic 房屋模式）：① agent.session.requestHeader()?.config（本回合真实路由，最准）→ ② cfg config → ③ agent.options.provider/model。不依赖猜 provider 名。
    try {
      let rh = null
      try { const h = agent && agent.session && agent.session.requestHeader && agent.session.requestHeader(); rh = h && h.config ? h.config : null } catch (e) { rh = null }
      const routed = rh && rh.provider && rh.model ? { provider: rh.provider, model: rh.model } : undefined
      const configured = cfg.llmProvider && cfg.llmModel ? { provider: cfg.llmProvider, model: cfg.llmModel } : undefined
      const agentOpts = agent && agent.options && agent.options.provider && agent.options.model ? { provider: agent.options.provider, model: agent.options.model } : undefined
      const route = routed ?? configured ?? agentOpts
      if (!route) return null
      // resolveModelInfo 两参只做"确认路由存在"；字段取 info.id（契约无 info.model）
      try {
        if (llm && typeof llm.resolveModelInfo === 'function') {
          const info = await llm.resolveModelInfo(route.provider, route.model)
          if (info) return { provider: route.provider, model: info.id || route.model }
          return { provider: route.provider, model: route.model }
        }
      } catch (e) { return null } // 路由校不中 → null，无风险降级
      return { provider: route.provider, model: route.model }
    } catch (e) { return null }
  }

  // 用 llm.stream 提炼候选：一次小请求，返回 ≤5 条 {title,type,ttl,triggers,why,body,mergeInto?}。
  // 失败/超时/无输出 → 返回 []（无损）。绝不 throw 逃出监听链。
  // B(冗余治理)：existingSummary 是现有 active+candidate 的紧凑摘要；LLM 据此把同主题候选标 mergeInto，不新增。
  async function distillCandidates(llmSvc, route, summaryText, existingSummary) {
    try {
      const sysText = '你是项目记忆提炼器。从下面的会话压缩摘要里，提炼值得永久记住的项目记忆候选（≤5 条）。'
        + '只输出 JSON 数组，每条含 title/type/ttl/triggers/why/body 字段，字段都须非空字符串；type 取 project/reference/feedback/user/skill/knowledge 之一，ttl 取 permanent/phase/event 之一。'
        + '【重要】下面是当前已有的记忆摘要。若某候选与其中一条是同一主题（同一知识的重述/细化），不要新增候选，而是在那条候选上加 `mergeInto: <该记忆的 slug 或 id>` 字段。只有真正的新知识才产出无 mergeInto 的新候选。若无值得记的，输出 []。\\n\\n【现有记忆摘要】\\n'
        + (existingSummary || '（无）')
      const messages = [
        { role: 'system', content: [{ type: 'text', text: sysText }] },
        { role: 'user', content: [{ type: 'text', text: summaryText }] },
      ]
      const chunks = []
      for await (const chunk of llmSvc.stream({ provider: route.provider, model: route.model, messages, maxTokens: 1400, purpose: 'session-title' })) {
        // dsh-llm 把 adapter 抛错压成 finish chunk（而非从 iterator 抛出），必须显式识别，否则错误被吞、蒸馏静默返回 []。
        if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          const f = chunk.reason.failure || {}
          if (!diagDistillErr) diagDistillErr = 'stream-error: ' + (f.code || f.message || 'unknown')
          break
        }
        const t = chunk && (chunk.text || chunk.delta || chunk.content)
        if (typeof t === 'string') chunks.push(t)
      }
      const raw = chunks.join('')
      const parsed = JSON.parse(extractJson(raw))
      if (!Array.isArray(parsed)) { if (!diagDistillErr) diagDistillErr = 'parsed-not-array rawLen=' + raw.length; return [] }
      return parsed.slice(0, 5).filter((c) => c && typeof c.title === 'string' && c.title)
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      if (!diagDistillErr) diagDistillErr = 'distill-threw: ' + msg
      console.log('[project-memory] distillCandidates failed (no-op): ' + msg)
      return []
    }
  }

  // 从模型输出里抽取 JSON 数组（容忍推理/多余文本）。
  function extractJson(raw) {
    const m = String(raw || '').match(/\[[\s\S]*\]/)
    return m ? m[0] : '[]'
  }

  // 确定性去重（titleSimilarity ≥0.6）+ 限额，落盘为 status:'candidate'（隔离舱，不进 T0 索引）。
  // compactionSeq：来源压缩事件 seq，双重作用——审计溯源（这条候选来自哪次压缩）+ 重启重扫去重线
  // （seq ≤ 该 cwd 已有候选最大 compactionSeq 的事件直接跳过，见 cwdMaxCompactionSeq）。
  async function persistCandidates(cwd, candidates, compactionSeq) {
    try {
      const doc = await readDoc(cwd)
      const existing = doc.memories
      const added = []
      // B(冗余治理)：若 LLM 给候选标了 mergeInto（同主题重述），则定位目标记忆做「合并」——
      // 只加【元数据】proofCount+1 + sources 溯源（GLM §5 越界裁定：自动路径绝不改 active 正文，正文合并推迟到 A 确认时）。
      // 否则才作为新候选落舱。
      const merged = []
      for (const c of candidates) {
        const mi = c.mergeInto
        if (mi) {
          const target = existing.find((m) => m.id === mi || (m.id && mi.indexOf(m.id) >= 0) || m.name === mi || m.slug === mi)
          if (target && target.status !== 'archived') {
            target.proofCount = (target.proofCount || 0) + 1
            target.updatedAt = new Date().toISOString()
            if (!target.sources) target.sources = []
            target.sources.push({ at: new Date().toISOString(), compactionSeq: typeof compactionSeq === 'number' ? compactionSeq : 0 })
            merged.push(target.id)
          }
          continue // 没找到目标也当处理过（不新增候选），安全默认
        }
        if (!c.title || added.length >= 5) break
        const title = String(c.title).slice(0, 120)
        const dup = existing.concat(added).some((m) => titleSimilarity(m.title || '', title) >= 0.6)
        if (dup) continue
        // B(冗余治理) 第二道确定性兜底：字面不重复但 rare-token 判「自动合并线」(2.0 精度) → 并入幸存者，不新增候选。
        // 覆盖 LLM 漏标 mergeInto 的情况（"pollCompaction 全链路经验" vs "M3 pollCompaction 根因"这类）。
        // GLM §5 越界裁定：自动路径只写隔离舱 + 元数据（proofCount/sources），【绝不改 active 正文】，正文合并推迟到 A 确认。
        const rType = MEMORY_TYPES.includes(c.type) ? c.type : 'project'
        const rareTarget = existing.find((m) => m.status !== 'archived' && isAutoMerge(cwd, m.title || '', title, m.type, rType, doc))
        if (rareTarget) {
          rareTarget.proofCount = (rareTarget.proofCount || 0) + 1
          rareTarget.updatedAt = new Date().toISOString()
          if (!rareTarget.sources) rareTarget.sources = []
          rareTarget.sources.push({ at: new Date().toISOString(), compactionSeq: typeof compactionSeq === 'number' ? compactionSeq : 0 })
          merged.push(rareTarget.id)
          continue
        }
        const type = MEMORY_TYPES.includes(c.type) ? c.type : 'project'
        const ttl = ['permanent', 'phase', 'event'].includes(c.ttl) ? c.ttl : 'event'
        const mem = {
          id: newId(), name: slugify(title), title,
          description: (c.why || c.body || '').replace(/\s+/g, ' ').slice(0, 140),
          body: c.body || c.why || title,
          type, status: 'candidate', scope: 'project',
          heat: 0, source: 'auto' /* 自动提炼，非用户手写/AI 工具 */,
          tags: [], why: c.why || '', howToApply: '',
          links: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          ttl, phase: null, triggers: Array.isArray(c.triggers) ? c.triggers.slice(0, 8).map(String) : [],
          obligation: false, pinned: false, proofCount: 0,
          compactionSeq: typeof compactionSeq === 'number' ? compactionSeq : 0,
        }
        added.push(mem)
      }
      if (!added.length && !merged.length) return
      const next = existing.concat(added)
      await writeDoc(cwd, next)
      // 同步推进该 cwd 的重启重扫去重线：只进不退（取最大）。
      const prevMax = compactionSeenCache.get(cwd) || 0
      const newMax = typeof compactionSeq === 'number' ? Math.max(prevMax, compactionSeq) : prevMax
      compactionSeenCache.set(cwd, newMax)
      compactionCaptureVal = 'ok'
      console.log('[project-memory] compaction captured ' + added.length + ' candidate(s) for ' + cwd)
    } catch (e) { /* 落盘失败不阻塞；上报 failed */ const msg = (e && e.message) ? e.message : String(e); compactionCaptureVal = 'failed:' + msg; console.log('[project-memory] persistCandidates failed (reported): ' + msg) }
  }
  // 严格 fail-closed：只有 userQuestions.ask 返回明确"批准"才放行；ask 不可用 / 抛错 /
  // 用户拒绝 → 一律不写（避免 AI 静默改记忆）。不再回退到可能放行的 approval，也不降级放行。
  // requireApprovalEx：三选项弹窗（GLM §4）——approve / approve+guard / reject，返回 'approve'|'approve+guard'|'reject'。
  // requireApproval：boolean 兼容封装（其余写路径不变；等价于 requireApprovalEx 的 approve 语义）。
  async function requireApprovalEx(agent, opts) {
    if (userQuestions === undefined) {
      console.log('[project-memory] userQuestions unavailable; memory write refused (fail-closed)')
      return 'reject'
    }
    try {
      const res = await userQuestions.ask({
        agent,
        questions: [{
          id: 'confirm',
          header: (opts && opts.header) || '记忆修改确认',
          question: (opts && opts.question) || '允许执行这条记忆操作？',
          detail: (opts && opts.detail) || '',
          options: (opts && opts.options) || [
            { label: '允许', id: 'approve', description: '批准' },
            { label: '拒绝', id: 'reject', description: '不写入并取消操作' },
          ],
        }],
      })
      const sel = res && res.answers && res.answers[0] && res.answers[0].selected
      if (!Array.isArray(sel) || !sel.length) return 'reject'
      // 兼容：答案可能是选项 id（'approve+guard'/'approve'/'reject'）或标签文字（'允许并装硬守卫'/'允许…'/'拒绝…'/'确定解除并删除'/'取消'）。
      // approve+guard 必须在 approve 之前判定（'允许并装硬守卫' 以 '允许' 开头）；批准优先于拒绝（与旧 requireApproval 语义一致）。
      for (const s of sel) {
        const str = typeof s === 'string' ? s : String(s)
        if (str === 'approve+guard' || str.indexOf('硬守卫') >= 0 || str.indexOf('并装') >= 0) return 'approve+guard'
        if (str === 'approve' || str.indexOf('允许') === 0 || str.indexOf('确定') === 0) return 'approve'
        if (str === 'reject' || str.indexOf('拒绝') === 0 || str.indexOf('取消') === 0) return 'reject'
      }
      return 'reject'
    } catch (e) {
      console.log('[project-memory] confirm ask failed: ' + (e && e.message ? e.message : e))
      return 'reject'
    }
  }
  async function requireApproval(agent, toolName, reason) {
    const verb = toolName === 'memory_delete' ? '删除' : toolName === 'memory_update' ? '更新' : toolName === 'forget' ? '归档' : '新增'
    const res = await requireApprovalEx(agent, {
      header: '记忆修改确认',
      question: '允许' + verb + '这条项目记忆？',
      detail: reason,
      options: [
        { label: '允许' + verb, id: 'approve', description: '批准写入这条记忆' },
        { label: '拒绝', id: 'reject', description: '不写入并取消操作' },
      ],
    })
    // 兼容：some 答案回填的是选项 id('approve') 或文字('允许…')，都算批准（与旧 requireApproval 语义一致）
    return res === 'approve'
  }

  // ---- capability report (probe / degrade / report) ----
  const hasPreStep = typeof ctx.on === 'function'
  const hasT0 = systemPrompt !== undefined && typeof systemPrompt.context === 'function'
  // checkpoint 是否已被 pollCompaction 检测到（扫到过 compaction/summary 后置 true）；用于上报 compactionCapture 状态
  let hasCompactionDetect = false
  // 通道 B 诊断计数器（进程内累计，验证 pollCompaction 是否真的被调用/扫到 compaction/summary）
  let diagPollScans = 0             // pollCompaction 被调用的步次数（agent.session 可读才会真正扫）
  let diagPollCompaction = 0        // 扫到的 compaction/summary 事件数（含无文本）
  let diagPollCompactionText = 0    // 其中有 summary 文本、真正进入提炼的 compaction/summary 数
  let diagPreStepFired = 0          // agent/pre-step 监听器被调用的次数（证明 pre-step 是否派发）
  let diagCwdResolved = 0           // 监听器里 cwd 解析成功的次数（证明 agent.session.header.cwd 可用）
  let diagAgentHasSession = 0       // 监听器里 payload.agent.session 存在的次数
  let diagPreExecFired = 0          // tools/pre-execute 监听器被调用次数（验证工具类事件是否宿主级可收）
  let diagPostExecFired = 0         // tools/post-execute 监听器被调用次数（验证工具类事件是否宿主级可收）
  // poll 详细诊断（最近一次 poll 的真实扫描情况，用于定位 diagPollCompaction=0 的根因）
  let diagPollSid = ''              // 最近一次 poll 的 session id
  let diagPollOwn = -1              // 最近一次 poll 的 inheritedEventCount
  let diagPollFrom = -1             // 最近一次 poll 的 from 起点
  let diagPollSeq = -1              // 最近一次 poll 时的 session seq（日志长度）
  let diagPollScanEvents = 0        // 最近一次 poll 实际扫到的事件数
  let diagPollCompactionIds = ''    // 最近一次 poll 扫到的 compaction/summary seq 列表（逗号分隔）
  // poll 入口/return 诊断：定位「agent.session 为 undefined / pollCompaction 提前 return」的根因
  let diagPollSource = ''           // 触发来源：provider / canary / prestep / unknown
  let diagPollAgentHasSess = false  // 入口时 agent.session 是否存在
  let diagPollAgentKeys = ''        // agent 对象自身的 key 列表（判断 agent 形状）
  let diagPollSessHasSnapshot = false // agent.session.snapshotEvents 是否为函数
  let diagPollReturnReason = ''     // return 原因：no-session / no-snapshotEvents / proceed
  // 提炼/落舱诊断：定位「diagPollCompactionText>0 但 candidate=0」的真因（distill 返回空 / llm 失败 / 落舱失败）。
  let diagDistillRunCount = 0       // handleCompactionSummary 里实际进入 distillCandidates 的次数
  let diagDistillEmptyCount = 0     // distillCandidates 返回空数组的次数（候选为空 → 不落盘）
  let diagDistillErr = ''           // distillCandidates 最近一次失败原因（llm 调用/解析失败）
  let diagPersistErr = ''           // persistCandidates 最近一次失败原因
  let diagLastRoute = ''            // 最近一次探测到的 llm 路由 provider/model（判断路由是否可用）
  let diagRecallRun = 0             // memory_recall 带 query 的调用次数（M4-lite 遥测）
  let diagRecallEmpty = 0           // 词法层召回数为 0 的次数（疑似漏检 → 需 LLM 精排/扩展）
  let diagRecallLastQuery = ''      // 最近一次 recall 的 query（诊断用）
  let diagRerankRun = 0             // LLM 语义精排成功执行的次数（M4-lite）
  let diagRerankFallback = 0        // LLM 精排失败回退词法排序的次数
  let diagUserRows = 0              // 【用户画像】档实际渲染行数（GLM 裁定 type:user 常驻）
  let diagUserTotal = 0             // 用户画像类记忆总数（diagnostic：画像档 8/N）
  let t0ProfileText = ''            // 用户画像独立档（systemPrompt.context project-memory-profile 每轮恒注入，不随场景）
  let diagSceneType = ''            // 场景注入类型：read-clear / edit-domain / edit-fallback / memory-op / failed:*
  let diagSceneCount = 0            // 场景注入条数（GLM 三层漏斗遥测）
  // compactionCapture 的词法级别持久结果（handle/persist 路径覆盖）。'' 表示尚未进入提炼路径，需由 build 时状态推导。
  // 注意：capabilityReport 之前是 const 对象 + 静态属性，diag 字段在对象创建时就被冻结为 0，pollCompaction 后来的自增
  // 永远反映不到 status 输出里（diagPollScans=0 假象）。改为 buildCapabilityReport() 每次实时读取 let 变量。
  let compactionCaptureVal = ''
  function buildCapabilityReport() {
    let cc
    if (llm === undefined || typeof llm.stream !== 'function') cc = 'no-llm'
    else if (compactionCaptureVal) cc = compactionCaptureVal
    else cc = hasCompactionDetect ? 'ok' : (diagPollScans > 0 ? 'polling' : 'no-poll')
    return {
      tools: tools !== undefined ? 'ok' : 'missing',
      commands: commands !== undefined ? 'ok' : 'missing',
      fs: fs !== undefined ? 'ok' : 'missing',
      webServer: webServer !== undefined ? 'ok' : 'missing',
      systemPromptContext: hasT0 ? 'ok' : 'missing',
      injectMode: injectionMode,
      newInjection: injectionMode === 'scenario' ? 'ok' : 'off',
      t0Injection: hasT0 && hasPreStep ? 'ok' : 'degraded',
      inputDetection: hasPreStep ? 'pre-step' : 'degraded',
      invertedIndex: hasPreStep ? 'ok' : 'degraded',
      behaviorDetection: hasPreStep ? 'pre-execute' : 'degraded',
      autoProduce: 'disabled',
      vectorIndex: 'off',
      compactionCapture: cc,
      // 诊断（进程内累计，实时读取，验证 pollCompaction 是否被调用/扫到 compaction/summary）：
      // 两模态共用：scenario 时监听器计数由 hooks 自增（D.*），legacy 时由旧监听器自增（局部 let）；
      // 按生效路径选读，避免"切换后旧计数器假 0"误导排查（GLM §3 全局判别同源）。
      diagPollScans: diagPollScans,
      diagPollCompaction: diagPollCompaction,
      diagPollCompactionText: diagPollCompactionText,
      diagPreStepFired: injectionMode === 'scenario' ? D.preStep : diagPreStepFired,
      diagCwdResolved: injectionMode === 'scenario' ? (D.cwdResolved || 0) : diagCwdResolved,
      diagAgentHasSession: injectionMode === 'scenario' ? (D.agentHasSession || 0) : diagAgentHasSession,
      diagPreExecFired: injectionMode === 'scenario' ? D.preExec : diagPreExecFired,
      diagPostExecFired: injectionMode === 'scenario' ? D.postExec : diagPostExecFired,
      // poll 详细诊断（最近一次 poll 的真实扫描情况，定位 diagPollCompaction=0 根因）：
      diagPollSid: diagPollSid,
      diagPollOwn: diagPollOwn,
      diagPollFrom: diagPollFrom,
      diagPollSeq: diagPollSeq,
      diagPollScanEvents: diagPollScanEvents,
      diagPollCompactionIds: diagPollCompactionIds,
      // poll 入口/return 诊断（定位 agent.session 缺失或提前 return 的根因）：
      diagPollSource: diagPollSource,
      diagPollAgentHasSess: diagPollAgentHasSess,
      diagPollAgentKeys: diagPollAgentKeys,
      diagPollSessHasSnapshot: diagPollSessHasSnapshot,
      diagPollReturnReason: diagPollReturnReason,
      // 提炼/落舱诊断（定位 diagPollCompactionText>0 但 candidate=0 的真因）：
      diagDistillRunCount: diagDistillRunCount,
      diagDistillEmptyCount: diagDistillEmptyCount,
      diagDistillErr: diagDistillErr,
      diagPersistErr: diagPersistErr,
      diagLastRoute: diagLastRoute,
      diagRecallRun: diagRecallRun,
      diagRecallEmpty: diagRecallEmpty,
      diagRecallLastQuery: diagRecallLastQuery,
      diagRerankRun: diagRerankRun,
      diagRerankFallback: diagRerankFallback,
      diagUserRows: diagUserRows,
      diagUserTotal: diagUserTotal,
      diagSceneType: injectionMode === 'scenario' ? (D.sceneType || '') : diagSceneType,
      diagSceneCount: injectionMode === 'scenario' ? (typeof D.sceneCount === 'number' ? D.sceneCount : 0) : diagSceneCount,
      // GLM §3 globalThis 判别：applyRuns≥2 分裂实例 / =1且counts>0 读取路径问题 / =1且counts=0 真未触发
      applyRuns: D.applyRuns,
      gPreStep: D.preStep,
      gPreExec: D.preExec,
      gPostExec: D.postExec,
      gPoll: D.poll,
    }
  }

  if (tools === undefined) {
    // store + commands may still work; log and continue in degraded mode
    console.log('[project-memory] tools service unavailable; model tool surface disabled (degraded)')
  }
  if (fs === undefined) {
    console.log('[project-memory] fs service unavailable; disk storage disabled (degraded)')
  }

  // ---- storage layer (pure functions + fs) ----
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  function bigrams(s) {
    const t = norm(s)
    const set = new Set()
    if (t.length === 0) return set
    if (t.length === 1) { set.add(t); return set }
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
    return set
  }
  function titleSimilarity(a, b) {
    const A = bigrams(a), B = bigrams(b)
    if (A.size === 0 && B.size === 0) return 1
    let inter = 0
    for (const g of A) if (B.has(g)) inter++
    return inter / (A.size + B.size - inter)
  }
  // ---- B(冗余治理) rare-token 判重：统计核心地基第一步 ----
  // 高频/泛词表：这些词在语料里太常见，不算 rare-token（判同主题时权重趋零）。
  const RARE_STOP = new Set(['记忆','项目','插件','修复','页面','功能','设计','记录','设置','工具','用户','系统','内容','方法','进程','机制','状态','当前','配置','问题','经验','一次','相关','执行','监听','提炼','候选','压缩'])
  // 分词：拉丁词(≥3) + CJK 二元组（复用 invertCache 已用的维度）。去停用词后即 rare 候选。
  function tokenizeRare(s) {
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
  // ---- 统计核心地基：IDF 权重表（按 cwd 独立语料，writeDoc 增量维护/惰性重建）----
  // 供两个消费者：① B 判重计分（同主题） ② M4-lite 检索打分（薄消费者，后接）。
  // GLM §3：IDF 必须按 cwd 重算（合并/归档/新增都改语料统计），绝不用过期权重。
  const idfCache = new Map() // cwd -> { map: Map<token,{df}>, totalDoc, dirty }
  function markIdfDirty(cwd) {
    const e = idfCache.get(cwd)
    if (e) e.dirty = true
  }
  function ensureIdf(cwd, doc) {
    let e = idfCache.get(cwd)
    if (e && !e.dirty) return e
    const d = doc || null
    if (!d) return { map: new Map(), totalDoc: 0, dirty: false }
    const df = new Map()
    for (const m of d.memories) {
      if (m.status === 'archived') continue
      const tokens = tokenizeRare((m.title || '') + ' ' + (m.description || ''))
      for (const w of tokens) df.set(w, (df.get(w) || 0) + 1)
    }
    e = { map: df, totalDoc: d.memories.filter((m) => m.status !== 'archived').length, dirty: false }
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
  // rare-token 同主题判定 ——「一个计分器，两道决策线」（GLM §2/§3 裁定）：
  //   计分器输出分数（type 打折后的 idf 加权和）+ 共享 rare token 数 + 是否恰 1 个 df≤2 极罕见词。
  //   两道决策线：B 自动合并(2.0 精度优先) / A 人工提案(1.5 召回优先)，且按 GLM §3 显式矩阵：
  //     ≥2 共享rare → 同type/异type 都判自动；
  //     恰 1 个 df≤2 极罕见词 → 同type 自动、异type 只提案(不自动并)；
  //     仅中频词 → 看总分。
  function scoreRareTopic(cwd, a, b, typeA, typeB, doc) {
    const A = tokenizeRare(a), B = tokenizeRare(b)
    const e = ensureIdf(cwd, doc)
    let weight = 0
    let sharedCount = 0
    let extreme = 0
    for (const w of A) {
      if (!B.has(w)) continue
      if (RARE_STOP.has(w)) continue
      const df = e.map.get(w) || 0
      weight += idfWeight(cwd, w, doc)
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
  function isAutoMerge(cwd, a, b, typeA, typeB, doc) {
    return scoreRareTopic(cwd, a, b, typeA, typeB, doc).decision === 'auto'
  }
  function slugify(s) {
    return String(s || '').toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').replace(/-+/g, '-')
  }
  function makeMemorySlug(title, taken, id) {
    let slug = slugify(title)
    if (!slug) slug = String(id).slice(0, 8)
    let cand = slug, n = 0
    while (taken.has(cand)) { n++; cand = slug + '-' + n }
    return cand
  }
  function isValid(m) {
    return !!m && typeof m.id === 'string' && typeof m.title === 'string' &&
      typeof m.description === 'string' && typeof m.body === 'string' &&
      typeof m.updatedAt === 'string'
  }
  const migrateV1 = (r) => ({
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
  const byNewest = (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()

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
  // 损坏/读失败时的兜底：把原始字节（若已知）写回 .corrupt-<ts> 备份文件，再返回空文档。
  // 这样即使后续 memory_recall 等触发 writeDoc 覆盖，也不会丢原始数据。
  async function backupCorrupt(cwd, target, raw) {
    try {
      if (raw) {
        const bak = await fs.resolve(MEMORY_FILE + '.corrupt-' + Date.now(), { cwd })
        await fs.writeText(bak, raw, undefined, undefined, writePolicy(cwd))
        console.log('[project-memory] memory file corrupt read; backed up raw bytes to .dsh-memory.json.corrupt-*')
      }
    } catch (b) { console.log('[project-memory] corrupt backup failed: ' + (b && b.message ? b.message : b)) }
    return { version: 2, memories: [] }
  }
  // The memory JSON lives in the user's project directory. fs.writeText drops to
  // the backend's own default sandbox mode unless a per-call sandboxPolicy is
  // passed, which can deny the write when the session's workspace root differs
  // from the memory cwd. Memory is a trusted project-data layer, so fence the
  // write at the memory cwd with danger-full-access to guarantee it lands.
  function writePolicy(cwd) {
    return { mode: 'danger-full-access', workspaceRoot: cwd }
  }
  async function writeDoc(cwd, memories) {
    if (fs === undefined) return false
    const target = await fs.resolve(MEMORY_FILE, { cwd })
    await fs.writeText(target, JSON.stringify({ version: 2, memories }, null, 2), undefined, undefined, writePolicy(cwd))
    // GLM §3：任何写（合并/归档/新增）都改变语料统计 → 标记 IDF 表脏，下次惰性重建，绝不用过期权重。
    markIdfDirty(cwd)
    // 硬守卫·单点重建（GLM §5）：writeDoc 后重建内存守卫表（拦截查询只查表不读盘；含 guard 字段落盘/disable）
    rl.rebuild(cwd, { version: 2, memories })
    refreshIndex(cwd).catch(() => {})
    // 编辑/写记忆后 T0 立即刷新（含【用户画像】——确保编辑场景画像恒在，不受 15s 缓存延迟影响）
    refreshT0(cwd).catch(() => {})
    return true
  }
  function searchProjectMemory(memories, query) {
    const words = norm(query).split(' ').filter(Boolean)
    return memories.filter(m => {
      const hay = norm([m.title, m.description, m.body].join(' '))
      return words.every(w => hay.includes(w))
    }).sort(byNewest)
  }
  function activeOnly(memories) { return memories.filter(m => m.status === 'active').sort(byNewest) }

  function scoreOf(m, now) {
    const heat = typeof m.heat === 'number' ? m.heat : 0
    let ageDays = 0
    try { ageDays = (now - new Date(m.updatedAt).getTime()) / 86400000 } catch (e) {}
    if (ageDays < 0) ageDays = 0
    const recency = 1 / (1 + ageDays)
    return heat * 0.6 + recency * 10
  }
  // ---- M4-lite 纯计分函数（可测，供 recallMemory 与回归测试用）。权重集中（应进 Config）。----
  function scoreMemory(mems, query, idfFn) {
    // 返回 [{m, score}] 按 score 降序；score>=0 的才参与召回。mems 为候选数组。
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

  function recallMemory(memories, query, limit, type, doc, cwd) {
    const now = Date.now()
    let base = memories.filter(m => m.status === 'active')
    if (type) base = base.filter(m => m.type === type)
    // M4-lite：词法粗筛（scoreMemory 纯函数）。权重集中（应进 Config，见 M4 调优包 + 别称表）。
    if (query) {
      diagRecallRun++
      diagRecallLastQuery = String(query).slice(0, 80)
      const idf = (t) => (doc && cwd) ? idfWeight(cwd, t, doc) : 1
      const { scored, qWeightSum } = scoreMemory(base, query, idf)
      if (qWeightSum < 0.01) { diagRecallEmpty++; return base.slice().sort((a, b) => scoreOf(b, now) - scoreOf(a, now)).slice(0, limit) }
      if (scored.length === 0) diagRecallEmpty++
      return scored.slice(0, limit).map(x => x.m)
    }
    base = base.slice().sort((a, b) => scoreOf(b, now) - scoreOf(a, now))
    return base.slice(0, limit)
  }

  // ---- cwd resolution ----
  function cwdFromAgent(a) {
    try { if (a && a.session && a.session.header && a.session.header.cwd) return a.session.header.cwd } catch (e) {}
    return undefined
  }
  function ensureCwd(agent) {
    const direct = cwdFromAgent(agent)
    if (direct) return direct
    if (agent && agent.id && agents !== undefined) {
      try { const via = cwdFromAgent(agents.get(agent.id)); if (via) return via } catch (e) {}
    }
    throw new Error('[project-memory] 无法确定项目目录 (cwd)')
  }

  const newId = () => 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
  const outSchema = { type: 'object', additionalProperties: true }
  // jsonSafe 已抽到 ./json-safe.js（文件头 import），此处不再定义，避免重复声明。

  // 记忆分类定义：6 种 type 及其适用场景。tools/memory_write 与 /memory add 用这份定义
  // 引导 AI 根据"事件性质 + 用户说的话"判断该归为哪一类，而不是全部默认 project。
  const TYPE_INFO = {
    project:   '项目事实/进展/设计决策/结构信息（最常用）：当前项目的目标、架构、模块、状态、历史、已知结论。',
    reference: '参考资料/外部知识/学习文档：项目里引用的文档、文章、规范、教程、外部来源。',
    feedback:  '反馈/经验教训/复盘结论：验证后的心得、踩过的坑、改进建议、评审意见。',
    user:      '用户偏好/习惯/明确要求：用户喜欢的风格、明确的指示、个人偏好、工作习惯。',
    skill:     '技能/操作方法：学会的某种工具用法、流程步骤、可复用的技巧。',
    knowledge: '通用知识/领域概念：不特定于本项目但有用的领域知识。',
  }
  const MEMORY_TYPES = Object.keys(TYPE_INFO)

  // 正文自动整理：分段 + 自动编号。与客户端 organizeBody 逻辑一致，保证 AI 写入的记忆
  // 也自动呈现为图二那种清晰分段排列，无需用户/AI 手动排版。
  function organizeBody(body) {
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
  function organizedText(body) { return organizeBody(body).join('\n\n') }

  // ---- M1 写入闸门：Defense 消毒 / 义务词检测 / triggers 提取（全代码，零模型 token）----
  // 1) Defense 消毒：敏感凭证就脱敏为 [REDACTED:credential]，避免记忆里落敏感明文
  const SECRET_RE = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16,}|-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.)/g
  function sanitizeSecret(text) {
    const src = String(text || '')
    const out = src.replace(SECRET_RE, '[REDACTED:credential]')
    let redacted = 0
    try { redacted = (src.match(SECRET_RE) || []).length } catch (e) {}
    return { text: out, redacted }
  }
  // 2) 义务词检测：命中即 obligation:true + ttl:permanent（常驻，不检测）
  const OBLIGATION_RE = /每次|以后|所有|一律|必须|务必|禁止|不要|记得|任何时候/
  function isObligation(text) { return OBLIGATION_RE.test(String(text || '')) }
  // 3) triggers 提取：模型给定用给定；否则从 title/description/body 确定性提取
  function extractTriggers(mem, given) {
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

  // ---- model tools (official stable seam: tools.register) ----
  const toolsDef = [
    {
      name: 'memory_read',
      description: '读取当前项目的记忆。传 id 精确读全文；传 title 精确读；传 query 走关键词检索返回全文；都不传列出激活记忆摘要（标题+描述+热度）。',
      parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, query: { type: 'string' } } },
      output: { schema: outSchema, render: (args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = ensureCwd(exec.agent)
        const doc = await readDoc(cwd)
        const a = args || {}
        let out
        if (a.id) out = doc.memories.filter(m => m.id === a.id)
        else if (a.title) out = doc.memories.filter(m => m.title === a.title)
        else if (a.query) out = searchProjectMemory(doc.memories, a.query)
        else out = activeOnly(doc.memories).map(m => ({ id: m.id, title: m.title, slug: m.name ?? null, type: m.type, status: m.status, heat: m.heat || 0, description: m.description }))
        return jsonSafe({ memories: out })
      },
    },
    {
      name: 'memory_recall',
      description: '语义/混合召回当前项目记忆：按查询词粗筛 + 热度/新鲜度加权排序，返回最相关 top-N。可传 type 过滤；不传 query 按热度返回最热记忆。可选 since（ISO 时间或 YYYY-MM，只召回 updatedAt 在其后的记忆）或 during（YYYY-MM，只召回该月内更新的）。默认返回摘要（不含 body），includeBody:true 才带全文。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, type: { type: 'string', enum: ['project', 'reference', 'feedback', 'user', 'skill', 'knowledge'] }, since: { type: 'string' }, during: { type: 'string' }, includeBody: { type: 'boolean' } } },
      output: { schema: outSchema, render: (args, value) => text(value) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const cwd = ensureCwd(exec.agent)
        const doc = await readDoc(cwd)
        const a = args || {}
        const limit = Math.min(Math.max(a.limit || 8, 1), 50)
        let pool = doc.memories.filter(m => m.status === 'active' || m.status === 'candidate')
        let base = pool
        if (a.since) {
          const sinceStr = String(a.since)
          try {
            const t = /^\d{4}-\d{2}$/.test(sinceStr) ? new Date(sinceStr + '-01T00:00:00Z').getTime() : new Date(sinceStr).getTime()
            if (!isNaN(t)) base = base.filter(m => new Date(m.updatedAt).getTime() >= t)
          } catch (e) {}
        }
        if (a.during) {
          const d = String(a.during)
          const m = d.match(/^(\d{4})-(\d{2})$/)
          if (m) base = base.filter((mem) => { const u = new Date(mem.updatedAt); return u.getUTCFullYear() === Number(m[1]) && (u.getUTCMonth() + 1) === Number(m[2]) })
        }
        // 采用带时间过滤的召回
        let recalled = recallMemory(base, a.query, limit, a.type, doc, cwd)
        // M4-lite：LLM 语义精排层（词法粗筛出的 top-N 再用 LLM 按 query 语义重排 + confidence）。保守回退：llm 不可用/抛错/超时 → 保持词法排序。
        if (a.query && recalled.length > 1 && llm && typeof llm.stream === 'function') {
          try {
            const route = await probeLlmRoute(exec.agent)
            if (route && route.provider && route.model) {
              const candList = recalled.map((m, i) => ({ id: m.id, i, title: m.title, d: (m.description || '').slice(0, 60) }))
              const sys = '你是项目记忆检索精排器。根据查询判断以下候选哪些语义相关，按相关度从高到低输出 JSON 数组，每项 {id, rank, confidence}。只输出 JSON。'
              const user = '查询：' + a.query + '\n候选：\n' + candList.map(c => `[${c.i}] id=${c.id} 标题=${c.title} 描述=${c.d}`).join('\n')
              const messages = [{ role: 'system', content: [{ type: 'text', text: sys }] }, { role: 'user', content: [{ type: 'text', text: user }] }]
              let raw = ''
              for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, maxTokens: 900, purpose: 'session-title' })) {
                if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') break // dsh-llm 把 adapter 错压成 finish-error，显式 break 防静默空
                if (chunk.type === 'content' || chunk.type === 'text') raw += (chunk.text || '')
              }
              const arr = JSON.parse(extractJson(raw))
              if (Array.isArray(arr) && arr.length > 0) {
                const byId = new Map(arr.map(x => [x.id, x]))
                const idMap = new Map(recalled.map((m, i) => [m.id, { m, i }]))
                // 按 LLM rank 升序重排（rank 小的相关），confidence 并入；未命中的保留原词法相对顺序尾部
                const ranked = arr.filter(x => x && x.id && idMap.has(x.id) && typeof x.rank === 'number').sort((a, b) => a.rank - b.rank)
                if (ranked.length > 0) {
                  const ordered = ranked.map(x => idMap.get(x.id).m)
                  const used = new Set(ranked.map(x => x.id))
                  for (const m of recalled) if (!used.has(m.id)) ordered.push(m)
                  recalled = ordered
                  diagRerankRun++
                }
              }
            }
          } catch (e) {
            diagRerankFallback++ // LLM 精排失败 → 保留词法排序（已在上面的 recalled）
          }
        }
        if (recalled.length > 0) {
          let changed = false
          const ids = new Set(recalled.map(m => m.id))
          const nowIso = new Date().toISOString()
          const bumped = doc.memories.map(m => {
            if (ids.has(m.id)) { changed = true; return { ...m, heat: (m.heat || 0) + 1, lastRecalledAt: nowIso } }
            return m
          })
          if (changed) {
            const okRec = await writeDoc(cwd, bumped)
            if (okRec) fr.syncMirror(cwd, bumped) // 首注镜像同步（写成功后才同步）
          }
        }
        const summarize = (m) => ({ id: m.id, title: m.title, type: m.type, heat: m.heat || 0, lastRecalledAt: m.lastRecalledAt ?? null, description: m.description })
        const detailed = (m) => ({ ...summarize(m), body: m.body ?? '' })
        const includeBody = a.includeBody === true
        return jsonSafe({ total: doc.memories.length, recalled: recalled.map(m => includeBody ? detailed(m) : summarize(m)) })
      },
    },
    {
      name: 'memory_write',
      description: '记录一条项目记忆。写入前先判断该信息应归为哪一类 type（不要一律用 project）——project=项目事实/设计决策/进展/结构；reference=参考资料/外部文档；feedback=验证后的心得/经验/踩坑/复盘；user=用户偏好/习惯/明确要求；skill=学会的工具用法/流程步骤；knowledge=通用领域知识。用户说的话或做的事通常暗示 type（"我喜欢/请用…"→user；"参考文档/根据某文"→reference；"这样可行/踩了坑"→feedback；"教你用某工具"→skill）。\n时效 ttl：含"每次/必须/禁止/以后"等义务词 → 常驻（写 permanent）；绑定某阶段 → phase；特定情境触发 → event。可给 triggers（3-8 个触发词，这条记忆何时该被想起），不给则自动提取。event 类描述建议用"条件→动作"句式（如"启动 dev server 前，先查端口"）。title/body 必填，description 为一行钩子。与现有高度相似记忆默认不写；坑类（feedback/event）会合并并 proofCount+1。',
      parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, description: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES }, ttl: { type: 'string', enum: ['permanent', 'phase', 'event'] }, phase: { type: 'string' }, triggers: { type: 'array', items: { type: 'string' } }, pinned: { type: 'boolean' }, why: { type: 'string' }, howToApply: { type: 'string' }, source: { type: 'string', enum: ['manual', 'auto', 'tool', 'feedback'] }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body'] },
      output: { schema: outSchema, render: (args, value) => text(value) },
      async execute(args, exec) {
        const cwd = ensureCwd(exec.agent)
        const a = args || {}
        // 闸门① Defense 消毒（脱敏敏感明文）
        const cleanTitle = sanitizeSecret(a.title).text
        const cleanBody = sanitizeSecret(a.body).text
        const cleanDesc = sanitizeSecret(a.description || a.title).text
        const sanit = (sanitizeSecret(a.title).redacted + sanitizeSecret(a.body).redacted + sanitizeSecret(a.description || a.title).redacted)
        // 闸门② 义务词检测（命中 → obligation:true + ttl:permanent，常驻不检测）
        const obligation = isObligation(cleanTitle + ' ' + cleanDesc + ' ' + cleanBody)
        // 闸门③ triggers 提取
        const baseMem = { title: cleanTitle, description: cleanDesc, body: cleanBody }
        let triggers = extractTriggers(baseMem, a.triggers)
        // 全自动打标（写入时）：①域 tags 精确探测（英文扩展词用词边界，避免"JSON"子串触发 js；中文域词精确匹配）②Config 别称组反向展开
        const autoTags = []
        const hayAll = `${cleanTitle} ${cleanDesc} ${cleanBody}`
        const hayLower = hayAll.toLowerCase()
        for (const [ext, toks] of Object.entries(SCENE_DOMAINS)) {
          const hit = toks.some((t) => {
            const tl = String(t).toLowerCase()
            if (/^[a-z]{2,}$/.test(tl)) { // 英文扩展词：词边界匹配（json 含 JSON；但 js/ts 需边界，避免"JSON"子串触发 js）
              if (/^(js|ts)$/.test(tl)) return new RegExp(`(^|[^a-z])${tl}($|[^a-z])`).test(hayLower)
              return hayLower.indexOf(tl) >= 0
            }
            return hayAll.indexOf(t) >= 0 // 中文域词精确
          })
          if (hit) autoTags.push(ext)
        }
        for (const t of autoTags) if (!triggers.includes(t)) triggers.push(t)
        if (cfg.aliasGroups && Array.isArray(cfg.aliasGroups)) {
          for (const grp of cfg.aliasGroups) {
            if (Array.isArray(grp) && grp.some((w) => hayAll.indexOf(w) >= 0)) {
              for (const w of grp) if (!triggers.includes(w)) triggers.push(w)
            }
          }
        }
        if (triggers.length > 12) triggers = triggers.slice(0, 12)
        const ttl = a.ttl || (a.type === 'user' ? 'permanent' : (obligation ? 'permanent' : 'event'))  // GLM §3：user 类画像天然长期 → ttl 默认 permanent
        const confirmDetail = `新增记忆「${cleanTitle}」(${a.type || 'project'})${sanit ? ` · 已脱敏 ${sanit} 处` : ''}${obligation ? ' · 已识别为义务类（常驻）' : ''}`
        // ---- 底线记忆识别（GLM §3，纯代码零失败模式）：禁止语义 → 三选项弹窗；义务语义只走 P1 提醒，永不提议守卫 ----
        const preDoc = await readDoc(cwd)
        const docIds = new Set(preDoc.memories.map((m) => m.id))
        const proposal = rl.proposeGuard(`${cleanTitle} ${cleanDesc} ${cleanBody}`, docIds)
        let guardToInstall = null
        if (proposal && proposal.propose === true) {
          // 授权（GLM §4）：三选项一次弹窗 + 守卫规格全文展示（动作+目标+来源 = 误解析的唯一纠错窗口）
          // 用户中心（2026-09-09）：插件判目标记忆重要性——P1 重要赞成；P2/P3 提醒"一般/别误锁"，但用户坚持尊重用户意愿。
          const spec = `${actLabel(proposal.guard.action)} 目标 [${targetLabel(proposal.guard.target)}]（来源：本记忆正文；可在 /guard 移除）`
          let importAdvice = ''
          try {
            const tgtMem = proposal.guard.target && proposal.guard.target.kind === 'memory'
              ? preDoc.memories.find((m) => m.id === proposal.guard.target.id)
              : null
            if (tgtMem) {
              const lvl = (tgtMem.obligation === true || tgtMem.pinned === true) ? 'P1 重要'
                : ((tgtMem.ttl === 'permanent' || tgtMem.ttl === 'phase') ? 'P2 常设' : 'P3 情境')
              importAdvice = lvl === 'P1 重要'
                ? '\n【重要性】目标记忆为 P1 重要——上锁合理。'
                : `\n【重要性】目标记忆为 ${lvl}——重要性一般，若仅普通知识不建议上锁（防误锁）；确认要装请选"允许并装硬守卫"（尊重你的选择）。`
            }
          } catch (_) {}
          const gOk = await requireApprovalEx(exec.agent, {
            header: '记忆修改确认',
            question: '允许新增这条项目记忆？',
            detail: confirmDetail + `\n检测到禁止语义，可安装硬守卫：${spec}${importAdvice}`,
            options: [
              { label: '允许（仅加记忆）', id: 'approve', description: '作为 P1 提醒注入，不安装守卫' },
              { label: '允许并装硬守卫', id: 'approve+guard', description: `将安装硬守卫：${spec}` },
              { label: '拒绝', id: 'reject', description: '不写入' },
            ],
          })
          if (gOk === 'reject') return { saved: false, cancelled: true, message: '已取消：用户未批准新增这条项目记忆。' }
          if (gOk === 'approve+guard') {
            guardToInstall = { action: proposal.guard.action, target: proposal.guard.target, createdAt: new Date().toISOString(), blockedCount: 0 }
          }
        } else if (proposal && proposal.propose === false) {
          // 识别失败也要说话（GLM §3）：注明将作为 P1 提醒注入（不安装守卫）——设定期望，符合诚实边界
          const gOk = await requireApprovalEx(exec.agent, {
            header: '记忆修改确认',
            question: '允许新增这条项目记忆？',
            detail: confirmDetail + `\n${proposal.reason}——本记忆将作为 P1 提醒注入（不安装守卫）。`,
            options: [
              { label: '允许', id: 'approve', description: '作为 P1 提醒注入，不安装守卫' },
              { label: '拒绝', id: 'reject', description: '不写入' },
            ],
          })
          if (gOk === 'reject') return { saved: false, cancelled: true, message: '已取消：用户未批准新增这条项目记忆。' }
        } else {
          const ok = await requireApproval(exec.agent, 'memory_write', confirmDetail)
          if (!ok) return { saved: false, cancelled: true, message: '已取消：用户未批准新增这条项目记忆。' }
        }
        const doc = await readDoc(cwd)
        const mem = {
          id: newId(),
          title: cleanTitle,
          description: cleanDesc,
          type: a.type || 'project',
          body: organizedText(cleanBody),
          why: a.why ?? null,
          howToApply: a.howToApply ?? null,
          source: a.source || 'manual',
          tags: Array.isArray(a.tags) && a.tags.length ? a.tags : autoTags,
          scope: 'project',
          status: 'active',
          heat: 0,
          ttl,
          phase: a.phase ?? null,
          triggers,
          obligation,
          pinned: a.pinned === true,
          proofCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          // 硬守卫（GLM §2 零 schema）：用户"允许并装"时 guard 字段进记忆记录（随记忆生命周期；
          // 旧客户端 save 可能丢该字段 → /memory status 按守卫数下降告警，见 rule.js baseline）
          ...(guardToInstall ? { guard: guardToInstall } : {}),
        }
        const sk = `${cleanTitle} ${cleanDesc}`
        const dup = doc.memories.find(m => titleSimilarity(`${m.title} ${m.description}`, sk) >= 0.6)
        if (dup) {
          // 闸门④ 去重棘轮：高度相似的坑类记忆，确定性合并正文 + proofCount+1 升权
          const isProofable = dup.type === 'feedback' || dup.ttl === 'event'
          if (isProofable) {
            const mergedBody = organizedText(dup.body + '\n\n' + cleanBody)
            const bumped = { ...dup, body: mergedBody, proofCount: (dup.proofCount || 0) + 1, updatedAt: new Date().toISOString() }
            const memsAfterMerge = doc.memories.map(m => m.id === dup.id ? bumped : m)
            if (await writeDoc(cwd, memsAfterMerge)) fr.syncMirror(cwd, memsAfterMerge)
            return jsonSafe({ saved: true, merged: true, memory: bumped, message: '发现相似记忆并合并（proofCount 已 +1）：' + dup.title })
          }
          return { saved: false, duplicate: true, similarMemory: dup, message: '发现高度相似的现有记忆，未写入。若为同一事实请用 memory_update 更新；若为新事实请使用更区分性的标题。' }
        }
        const taken = new Set(doc.memories.map(m => m.name).filter(Boolean))
        mem.name = makeMemorySlug(cleanTitle, taken, mem.id)
        const memsAfterWrite = [...doc.memories, mem]
        if (await writeDoc(cwd, memsAfterWrite)) fr.syncMirror(cwd, memsAfterWrite)
        return jsonSafe({ saved: true, memory: mem })
      },
    },
    {
      name: 'memory_update',
      description: '按 id 更新一条记忆，只改提供的字段，updatedAt 强制刷新。status 可为 active/archived/candidate。可调 heat/type/tags/ttl/phase/triggers/obligation/pinned。',
      parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, status: { type: 'string', enum: ['active', 'archived', 'candidate'] }, type: { type: 'string', enum: MEMORY_TYPES }, ttl: { type: 'string', enum: ['permanent', 'phase', 'event'] }, phase: { type: 'string' }, triggers: { type: 'array', items: { type: 'string' } }, obligation: { type: 'boolean' }, pinned: { type: 'boolean' }, heat: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, links: { type: 'array', items: { type: 'string' } } }, required: ['id'] },
      output: { schema: outSchema, render: (args, value) => text(value) },
      async execute(args, exec) {
        const cwd = ensureCwd(exec.agent)
        const a = args || {}
        const doc = await readDoc(cwd)
        const existing = doc.memories.find(m => m.id === a.id)
        const statusNote = (a.status && existing && a.status !== existing.status)
          ? ` · 状态 ${existing.status} → ${a.status}（${a.status === 'archived' ? '归档：不注入/该记忆上的硬守卫随归档失效' : '转正：重新参与注入/场景' }）`
          : (a.status === 'archived' ? ' · 状态 → 归档（不注入/守卫失效）' : '')
        const ok = await requireApproval(exec.agent, 'memory_update', `更新记忆「${existing ? existing.title : (a.id || '')}」${statusNote}`)
        if (!ok) return { saved: false, cancelled: true, message: '已取消：用户未批准更新这条项目记忆。' }
        const idx = doc.memories.findIndex(m => m.id === a.id)
        if (idx < 0) throw new Error(`memory_update: 未找到 id=${a.id}`)
        const old = doc.memories[idx]
        const updated = { ...old }
        if (a.title !== undefined) updated.title = a.title
        if (a.description !== undefined) updated.description = a.description
        if (a.body !== undefined) updated.body = a.body
        if (a.status !== undefined) updated.status = a.status
        if (a.type !== undefined) updated.type = a.type
        if (a.ttl !== undefined) updated.ttl = a.ttl
        if (a.phase !== undefined) updated.phase = a.phase
        if (a.triggers !== undefined) updated.triggers = a.triggers
        if (a.obligation !== undefined) updated.obligation = a.obligation === true
        if (a.pinned !== undefined) updated.pinned = a.pinned === true
        if (a.heat !== undefined) updated.heat = a.heat
        if (a.tags !== undefined) updated.tags = a.tags
        if (a.links !== undefined) updated.links = a.links
        // 守卫可逆（GLM §4）：编辑记忆去掉禁止措辞 → 重派生后守卫消失（guard 字段删除，随 writeDoc 单点重建生效）
        if (updated.guard) {
          try {
            const hayTxt = `${updated.title || ''} ${updated.description || ''} ${updated.body || ''}`
            const aliveIds = new Set(doc.memories.map((m) => m.id))
            const prop = rl.proposeGuard(hayTxt, aliveIds)
            if (!prop || prop.propose !== true) delete updated.guard
          } catch (e) { /* 重派生失败保留原守卫（安全默认） */ }
        }
        updated.updatedAt = new Date().toISOString()
        doc.memories[idx] = updated
        if (await writeDoc(cwd, doc.memories)) fr.syncMirror(cwd, doc.memories)
        return jsonSafe({ saved: true, memory: updated })
      },
    },
    {
      name: 'memory_delete',
      description: '按 id 物理删除一条记忆。找不到 id 抛错。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: { schema: outSchema, render: (args, value) => text(value) },
      async execute(args, exec) {
        const cwd = ensureCwd(exec.agent)
        const a = args || {}
        const doc = await readDoc(cwd)
        const existing = doc.memories.find(m => m.id === a.id)
        const ok = await requireApproval(exec.agent, 'memory_delete', `删除记忆「${existing ? existing.title : (a.id || '')}」`)
        if (!ok) return { saved: false, cancelled: true, message: '已取消：用户未批准删除这条项目记忆。' }
        const idx = doc.memories.findIndex(m => m.id === a.id)
        if (idx < 0) throw new Error(`memory_delete: 未找到 id=${a.id}`)
        doc.memories.splice(idx, 1)
        if (await writeDoc(cwd, doc.memories)) {
          fr.syncMirror(cwd, doc.memories)
          rl.resetBaseline(cwd) // 守卫随记录删除是有意移除（GLM §7 用户侧可绕是特性）→ 基线刷新，避免 status 误报
        }
        return { saved: true, id: a.id }
      },
    },
    {
      name: 'memory_pending_changes',
      description: '返回本次任务待报告的改动文件清单（成品表格文本，供收尾时原样粘贴到回复）。清单由插件在 write/edit 后确定性地累积。调用**不会清空**清单——只有你在回复中实际报告了这些路径后才清空（插件自动检测）。用于完成对话任务时汇总报告改动文件。',
      parameters: { type: 'object', properties: {} },
      output: { schema: outSchema, render: (args, value) => text(value) },
      async execute(args, exec) {
        const cwd = ensureCwd(exec.agent)
        const list = pendingChanges.get(cwd) || []
        if (!list.length) return jsonSafe({ total: 0, table: '', message: '当前无待报告改动' })
        const rows = list.map((x, i) => `| ${i + 1} | ${x.path} | ${x.note || ''} |`).join('\n')
        const table = `| # | 文件路径 | 说明 |\n|---|---|---|\n${rows}`
        return jsonSafe({ total: list.length, table, message: '请把上方表格原样粘贴到回复中报告改动文件。' })
      },
    },
  ]

  for (const def of toolsDef) {
    try {
      tools.register(def)
    } catch (e) {
      console.log('[project-memory] tool register failed for ' + def.name + ': ' + (e && e.message ? e.message : e))
    }
  }

  // ---- /memory command ----
  // ---- A 批量清理（冗余治理·存量候选，GLM 终审清单，一次性确认执行）----
  // A_MERGE_PLAN 用 title 前缀匹配候选(candidate)与目标(active)，语义来自 GLM 终审：
  //   并 target 6、驳(refuted 归档)1。其余 candidate 保持待审不动。
  const A_MERGE_PLAN = [
    { candPrefix: '诊断计数器必须用 globalThis', targetPrefix: '诊断仪表必须用函数实时构建' },                       // #2 并
    { candPrefix: 'Session/event scope-filtered', targetPrefix: '宿主级插件收不到 agent/tools 的 scope-filtered' },      // #3 并
    { candPrefix: '项目记忆插件核心设计方向总结', targetPrefix: '项目记忆插件设计结论' },                                 // #4 并
    { candPrefix: '记忆插件写入门禁与fail-closed原则', targetPrefix: '项目记忆插件设计结论' },                            // #5 并
    { candPrefix: 'provider-driven pollCompaction', targetPrefix: 'M3 pollCompaction 根因定位与修复' },                   // #10 并
    { candPrefix: 'compaction 不是工具、agent 生命周期事件不可靠', targetPrefix: 'M3 pollCompaction 根因定位与修复' },    // #11 改靶并
  ]
  const A_REFUTE = { candPrefix: 'GLM 裁定：宿主层可接收所有后代 scope', refutedNote: '契约推断被实测证伪（与 active「宿主级插件收不到」语义相反）；检测已改 provider 驱动。rare-token 计分只见"同域"不见"同断言"，此对为矛盾对，归档。' }
  // merge 用 title 前缀匹配候选/active；按 GLM 裁定执行（并→mergedInto+幸存者proofCount+正文+sources；驳→refuted归档+refutedNote）。
  function applyMemoryMerge(cwd, doc, agent) {
    return (async () => {
      try {
        const mems = doc.memories
        const plan = A_MERGE_PLAN.map((p) => {
          const cand = mems.find((m) => m.status === 'candidate' && (m.title || '').indexOf(p.candPrefix) === 0)
          const target = mems.find((m) => m.status === 'active' && (m.title || '').indexOf(p.targetPrefix) === 0)
          return { cand, target, note: cand ? (cand.title.slice(0, 30) + ' → ' + (target ? target.title.slice(0, 30) : '?') + '（并）') : '' }
        }).filter((x) => x.cand)
        const refute = mems.find((m) => m.status === 'candidate' && (m.title || '').indexOf(A_REFUTE.candPrefix) === 0)
        const mergeable = plan.filter((x) => x.cand && x.target)
        const preview = [
          '【A 批量清理·GLM 终审清单】',
          '将要并入（target 幸存者加【合并来源·A 确认】段 + proofCount+n）：',
          ...mergeable.map((x) => `  - ${x.note}`),
          refute ? `将驳回归档（refuted + refutedNote）：- ${refute.title.slice(0, 30)}` : '',
          '其余 candidate 保持待审不动。',
        ].filter(Boolean).join('\n')
        // 一次确认（fail-closed）
        const ok = await requireApproval(agent, 'memory', '执行 A 批量清理（' + mergeable.length + ' 并 + ' + (refute ? 1 : 0) + ' 驳）？\n' + preview)
        if (!ok) return { kind: 'success', text: '已取消：用户未批准 A 批量清理。' }
        let mergedCount = 0, refuteCount = 0
        for (const x of mergeable) {
          x.cand.status = 'archived'
          x.cand.mergedInto = x.target.id
          x.cand.updatedAt = new Date().toISOString()
          x.target.proofCount = (x.target.proofCount || 0) + 1
          x.target.updatedAt = new Date().toISOString()
          if (!x.target.sources) x.target.sources = []
          x.target.sources.push({ at: new Date().toISOString(), note: 'A合并:' + x.cand.title.slice(0, 40) })
          const seg = (x.cand.body || x.cand.why || '').trim()
          if (seg) x.target.body = (x.target.body || '') + (x.target.body ? '\n\n' : '') + '【合并来源·A 确认】\n并入候选「' + x.cand.title + '」：\n' + seg
          mergedCount++
        }
        if (refute) {
          refute.status = 'archived'
          refute.refutedNote = A_REFUTE.refutedNote
          refute.updatedAt = new Date().toISOString()
          refuteCount++
        }
        if (await writeDoc(cwd, mems)) fr.syncMirror(cwd, mems)
        addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(A批量清理)')
        return { kind: 'success', text: `A 批量清理完成：连同确认 ${mergedCount} 条候选并入（幸存者已加正文/proofCount/sources），驳回归档 ${refuteCount} 条。其余 candidate 保持待审。` }
      } catch (e) {
        return { kind: 'error', text: 'A 批量清理失败: ' + ((e && e.message) ? e.message : String(e)) }
      }
    })()
  }

  // 近失区日志（GLM §6⑤）：列出 scoreRareTopic 在 1.5≤score<2.0 的 candidate×active 对——"疑似同主题但不够 auto"，
  // 既作审核 UI 的"建议查看"列表，也作参数校准数据回路（这些对是人眼确认/排除的对象）。
  function nearMissList(cwd, doc) {
    return (async () => {
      try {
        const cands = doc.memories.filter((m) => m.status === 'candidate')
        const acts = doc.memories.filter((m) => m.status === 'active')
        const rows = []
        for (const c of cands) {
          for (const a of acts) {
            const r = scoreRareTopic(cwd, c.title || '', a.title || '', c.type, a.type, doc)
            if (r.score >= 1.5 && r.score < 2.0) {
              rows.push(`- [${r.score}] candidate«${c.title.slice(0, 26)}» ↔ active«${a.title.slice(0, 26)}» (shared=${r.shared}, 异type=${r.typeDiff})`)
            }
          }
        }
        const text = rows.length ? `# 近失区（1.5≤score<2.0，疑似同主题未自动并，建议人眼判断）\n${rows.join('\n')}` : '# 近失区：无（当前无 1.5~2.0 疑似对）'
        return { kind: 'success', text }
      } catch (e) {
        return { kind: 'error', text: '近失区查询失败: ' + ((e && e.message) ? e.message : String(e)) }
      }
    })()
  }

  // ---- 硬守卫命令（/memory guard list|remove <序号>，GLM §3-§4）：列出/移除守卫；remove 需二次确认（可逆）----
  async function handleGuardCmd(cwd, doc, sub, agent) {
    try {
      const table = rl.guardsOf(cwd)
      if (!sub || sub === 'list') {
        if (!table.length) {
          return { kind: 'success', text: '# 硬守卫\n（无——没有记忆携带 guard 字段。结构性基线仍生效：write/edit 直改 .dsh-memory.json 会被拦截）' }
        }
        const rows = table.map((g, i) => `| ${i + 1} | ${actLabel(g.action)} | ${targetLabel(g.target)} | ${g.title} | ${g.blockedCount || 0} |`).join('\n')
        return { kind: 'success', text: `# 硬守卫（${table.length}）\n| # | 动作 | 目标 | 来源记忆 | 拦截次数 |\n|---|---|---|---|---|\n${rows}\n\n用法: memory guard remove <序号>（需二次确认）` }
      }
      const m = String(sub || '').match(/^remove\s+(\d+)$/)
      if (!m) return { kind: 'error', text: '用法: memory guard list | memory guard remove <序号>' }
      const idx = Number(m[1])
      if (!Number.isInteger(idx) || idx < 1 || idx > table.length) return { kind: 'error', text: `序号越界（1-${table.length}）` }
      const g = table[idx - 1]
      // 二次确认（fail-closed）：用户明确批准才移除
      const okRemove = await requireApprovalEx(agent, {
        header: '守卫移除确认',
        question: '允许移除这条硬守卫？',
        detail: `${actLabel(g.action)} 目标 [${targetLabel(g.target)}]（来源记忆「${g.title}」，已拦截 ${g.blockedCount || 0} 次）。移除后该操作不再被自动拦截。`,
        options: [
          { label: '允许移除', id: 'approve', description: '删除该守卫（守卫约束 agent，不约束用户——用户侧操作不受影响）' },
          { label: '拒绝', id: 'reject', description: '保留守卫' },
        ],
      })
      if (okRemove !== 'approve') return { kind: 'success', text: '已取消：未批准移除该守卫。' }
      const r = removeGuardFromDoc(doc, g.sourceId)
      if (!r.removed) return { kind: 'error', text: '守卫记录已不存在（可能已随记忆删除）。' }
      if (await writeDoc(cwd, r.memories)) fr.syncMirror(cwd, r.memories)
      rl.resetBaseline(cwd) // 有意移除 → 基线刷新，避免 status 误报"旧客户端丢字段"
      addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(/guard remove)')
      return { kind: 'success', text: `已移除守卫：${actLabel(g.action)} 目标 [${targetLabel(g.target)}]（记忆「${g.title}」）。` }
    } catch (e) {
      return { kind: 'error', text: '守卫操作失败: ' + ((e && e.message) ? e.message : String(e)) }
    }
  }

  const parseMemoryCommand = (raw) => {
    const line = (raw || '').trim()
    if (!line) return { kind: 'list' }
    const lower = line.toLowerCase()
    if (/^list$/.test(lower)) return { kind: 'list' }
    if (/^clean$/.test(lower)) return { kind: 'clean' }
    if (/^status$/.test(lower)) return { kind: 'status' }
    if (/^recall(?=\s|$)/i.test(line)) return { kind: 'recall', text: line.replace(/^recall\s+/i, '').trim() }
    if (/^forget(?=\s|$)/i.test(line)) return { kind: 'forget', target: line.replace(/^forget\s+/i, '').trim() }
    if (/^state(?=\s|$)/i.test(line)) return { kind: 'state', text: line.replace(/^state\s+/i, '').trim() }
    if (/^pending(?=\s|$)/i.test(line)) return { kind: 'pending', sub: line.replace(/^pending\s+/i, '').trim().toLowerCase() }
    if (/^guard(?=\s|$)/i.test(line)) return { kind: 'guard', sub: line.replace(/^guard\s+/i, '').trim().toLowerCase() }
    if (/^merge(?=\s|$)/i.test(line)) return { kind: 'merge' }
    if (/^near(?=\s|$)/i.test(line)) return { kind: 'near' }
    // @fix user-delete-guard：用户路径删除（/memory delete <id|slug>）——此前无 delete 子命令，
    // "delete <id>" 会落入下方 add 分支（被当新增），用户删守卫锁定的记忆只能走"请 AI 删→被 deny"。
    // 命令不经过 tools/pre-execute（只有 AI 工具走守卫 deny），天然区分 AI 工具 vs 用户命令。
    if (/^delete(?=\s|$)/i.test(line)) return { kind: 'delete', target: line.replace(/^delete\s+/i, '').trim() }
    if (/^add(?=\s|$)/i.test(line)) return { kind: 'add', text: line.replace(/^add\s+/i, '').trim() }
    return { kind: 'add', text: line }
  }
  const renderIndex = (memories) => {
    if (memories.length === 0) return '（暂无激活记忆）'
    return memories.map(m => `- [${m.title}](${m.name || m.id}) · ${m.type} · heat ${m.heat || 0} — ${m.description}`).join('\n')
  }

  if (commands !== undefined) {
    try {
      commands.register({
        name: 'memory',
        description: '查看、新增、删除、归档、清理、召回、状态快照、待报告改动、硬守卫或检查项目记忆。新增用 `add [type:] 内容`；`delete <slug|id>` 删除（守卫锁定的记忆弹窗确认后解除守卫并删除——守卫约束 AI 不约束用户）；`state <当前进度>` 更新状态快照；`pending list|clear` 查看/清空待报告改动清单；`guard list` 列出硬守卫、`guard remove <序号>` 移除守卫（二次确认）。',
        input: { hint: '[list|add [type:] <text>|delete <slug|id>|state <text>|pending list|clear|guard list|guard remove <序号>|forget <slug|id>|clean|status|recall <query>]' },
        handler: async (inv) => {
          const cmd = parseMemoryCommand(inv.rawInput)
          try {
            const cwd = ensureCwd(inv.agent)
            const doc = await readDoc(cwd)
            if (cmd.kind === 'list') {
              return { kind: 'success', text: `# 项目记忆（${cwd}）\n${renderIndex(activeOnly(doc.memories))}` }
            }
            if (cmd.kind === 'status') {
              // canary（GLM §3 附带）：命令 handler 宿主级可靠，顺手调一次 pollCompaction 验证宿主代码路径全通。
              // 必须 await：pollCompaction 内含 await（cwdMaxCompactionSeq 读盘），若不 await 则在 /memory status 渲染时
              // 异步任务仍搁在 await 处，后段的 diagPollSid/own/from/seq/scanEvents 尚未赋值，读到的全是初始值（假象）。
              try { await pollCompaction(inv.agent, cwd, 'canary') } catch (_) {}
              const c = { active: 0, archived: 0, candidate: 0 }
              // 待报告改动计数（诊断用）：若 pendingChanges 有数但 gPostExec=0，说明 pendingChanges 另有非 post-execute 来源。
              const pendCount = (pendingChanges.get(cwd) || []).length
              for (const m of doc.memories) c[m.status] = (c[m.status] || 0) + 1
              // 硬守卫状态（GLM §2/§6）：守卫数 + 累计拦截次数；旧客户端 save 丢 guard 字段 → 基线下降告警（可观测而非阻断）
              const guards = rl.guardsOf(cwd)
              const guardBlockedTotal = guards.reduce((s, g) => s + ((g.blockedCount || 0) + 0), 0)
              const guardBase = rl.baselineOf(cwd)
              const guardWarn = guardBase > guards.length
                ? `\n- ⚠️ 守卫数从 ${guardBase} 降至 ${guards.length}：疑似旧客户端保存丢失 guard 字段（守卫静默消失）。请用 /memory guard list 核实；如为误判请检查设置页保存链路。`
                : ''
              const caps = Object.entries(buildCapabilityReport()).map(([k, v]) => `  - ${k}: ${v}`).join('\n')
              const rerankNote = diagLastRoute ? '' : `\n# 检索精排\n- 精排未启用：未配置模型路由（设置中可填 provider/model）；当前为词法粗糙筛（IDF 召回）。`
              return { kind: 'success', text: `# 记忆状态\n- 总数: ${doc.memories.length}\n- active: ${c.active}\n- archived: ${c.archived}\n- candidate: ${c.candidate}\n- 硬守卫: ${guards.length}（累计拦截 ${guardBlockedTotal} 次）${guardWarn}\n- 待报告改动: ${pendCount}\n\n# 能力探测\n${caps}${rerankNote}` }
            }
            if (cmd.kind === 'guard') {
              return await handleGuardCmd(cwd, doc, cmd.sub, inv.agent)
            }
            if (cmd.kind === 'merge') {
              return await applyMemoryMerge(cwd, doc, inv.agent)
            }
            if (cmd.kind === 'near') {
              return await nearMissList(cwd, doc)
            }
            if (cmd.kind === 'recall') {
              const r = recallMemory(doc.memories, cmd.text, 8, undefined, doc, cwd)
              return { kind: 'success', text: r.length ? `# 召回: ${cmd.text}\n${renderIndex(r)}` : `# 召回: ${cmd.text}\n（无命中）` }
            }
            if (cmd.kind === 'clean') {
              const cutoff = Date.now() - 90 * 24 * 3600 * 1000
              const stale = activeOnly(doc.memories).filter(m => new Date(m.updatedAt).getTime() < cutoff)
              return { kind: 'success', text: stale.length ? `# 过期记忆（>90天未更新）\n${renderIndex(stale)}` : '# 无过期记忆' }
            }
            if (cmd.kind === 'forget') {
              const t = cmd.target
              const idx = doc.memories.findIndex(m => m.name === t || m.id === t)
              if (idx < 0) return { kind: 'error', text: `未找到记忆: ${t}` }
              const okForget = await requireApproval(inv.agent, 'memory', `归档记忆「${doc.memories[idx] ? doc.memories[idx].title : t}」`)
              if (!okForget) return { kind: 'success', text: '已取消：用户未批准归档这条项目记忆。' }
              doc.memories[idx].status = 'archived'
              doc.memories[idx].updatedAt = new Date().toISOString()
              if (await writeDoc(cwd, doc.memories)) fr.syncMirror(cwd, doc.memories)
              addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(命令:归档)')
              return { kind: 'success', text: `已归档: ${doc.memories[idx].title}` }
            }
            if (cmd.kind === 'delete') {
              // @fix user-delete-guard（GLM §7 不对称性修复）：用户路径删除守卫锁定的记忆——
              // 不 deny、弹窗确认（确认→解除守卫并删除；取消→保留），不再被 AI 路径的硬守卫直接拦死。
              // 区分：命令（用户，commands.register handler）不经过 tools/pre-execute，无守卫 deny；
              //       AI 工具 memory_delete 经 hooks onPreExecute → rule.guardCheck → {kind:'deny'}（保留见 hooks.js）。
              const t = cmd.target
              if (!t) return { kind: 'error', text: '用法: memory delete <id|slug>' }
              const idx = doc.memories.findIndex((m) => m.id === t || m.name === t)
              if (idx < 0) return { kind: 'error', text: `未找到记忆: ${t}` }
              const targetMem = doc.memories[idx]
              // 守卫判定复用 rl.guardCheck（按 AI 工具形状查 block_delete；只查表不读盘）。
              let gd = null
              try { gd = rl.guardCheck({ name: 'memory_delete', arguments: { id: targetMem.id } }, cwd) } catch (e) { gd = null }
              if (gd && gd.hit) {
                const c = userDeleteConfirmText(gd.hit)
                const uOk = await requireApprovalEx(inv.agent, {
                  header: '记忆删除确认',
                  question: c.question,
                  detail: c.detail,
                  options: [
                    { label: '确定解除并删除', id: 'approve', description: '解除守卫锁定并删除该记忆' },
                    { label: '取消', id: 'reject', description: '保留记忆与守卫' },
                  ],
                })
                if (uOk !== 'approve') return { kind: 'success', text: '已取消：未确认解除守卫并删除该记忆，记忆与守卫均保留。' }
                // 确认 → 解除所有指向该记忆的 block_delete 守卫（guard 字段在来源记忆上），再删记忆本体，一次写盘。
                let mems = doc.memories
                let removedGuard = 0
                for (const g of (rl.guardsOf(cwd) || [])) {
                  if (g.action === 'block_delete' && g.target && g.target.kind === 'memory' && g.target.id === targetMem.id) {
                    const r = removeGuardFromDoc({ version: 2, memories: mems }, g.sourceId)
                    if (r.removed) { mems = r.memories; removedGuard++ }
                  }
                }
                const i2 = mems.findIndex((m) => m.id === targetMem.id)
                if (i2 >= 0) mems = mems.slice(0, i2).concat(mems.slice(i2 + 1))
                if (await writeDoc(cwd, mems)) {
                  fr.syncMirror(cwd, mems)
                  rl.resetBaseline(cwd) // 有意解除守卫 → 基线刷新，避免 status 误报"旧客户端丢字段"
                }
                addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(命令:删除·守卫解除)')
                return { kind: 'success', text: `已删除记忆: ${targetMem.title}${removedGuard ? `（已解除 ${removedGuard} 条守卫锁定）` : ''}` }
              }
              // 未命中守卫：普通确认门（与 memory_delete 工具同语义；走命令入口即用户路径）
              const okDel = await requireApproval(inv.agent, 'memory_delete', `删除记忆「${targetMem.title}」`)
              if (!okDel) return { kind: 'success', text: '已取消：用户未批准删除这条项目记忆。' }
              const i3 = doc.memories.findIndex((m) => m.id === targetMem.id)
              if (i3 >= 0) doc.memories.splice(i3, 1)
              if (await writeDoc(cwd, doc.memories)) fr.syncMirror(cwd, doc.memories)
              addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(命令:删除)')
              return { kind: 'success', text: `已删除记忆: ${targetMem.title}` }
            }
            if (cmd.kind === 'add') {
              const rawAdd = cmd.text
              // 支持 `<type>: <内容>` 显式分类（如 `add reference: 某规范`），否则默认 project
              let addType = 'project'
              let addText = rawAdd
              const tm = String(rawAdd).match(/^\s*(project|reference|feedback|user|skill|knowledge)\s*[:：]\s*(.+)$/i)
              if (tm) { addType = tm[1].toLowerCase(); addText = tm[2] }
              const title = addText.length > 40 ? addText.slice(0, 37) + '…' : addText.split('\n')[0]
              const sk = `${title} ${addText.split('\n')[0]}`
              const dup = doc.memories.find(m => titleSimilarity(`${m.title} ${m.description}`, sk) >= 0.6)
              if (dup) return { kind: 'success', text: `发现重复记忆: [${dup.title}](${dup.name || dup.id})，未新增。` }
              const mem = { id: newId(), title, description: title, type: addType, body: organizedText(addText), source: 'manual', tags: [], scope: 'project', status: 'active', heat: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
              const taken = new Set(doc.memories.map(m => m.name).filter(Boolean))
              const okAdd = await requireApproval(inv.agent, 'memory', `新增记忆「${title}」(${addType})`)
              if (!okAdd) return { kind: 'success', text: '已取消：用户未批准新增这条项目记忆。' }
              mem.name = makeMemorySlug(title, taken, mem.id)
              const memsAfterAdd = [...doc.memories, mem]
              if (await writeDoc(cwd, memsAfterAdd)) fr.syncMirror(cwd, memsAfterAdd)
              addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(命令:新增)')
              return { kind: 'success', text: `已新增记忆: [${title}](${mem.name})` }
            }
            if (cmd.kind === 'state') {
              // 状态快照：唯一一条 type:'state'、slug state-current，新覆盖旧（不进普通去重）
              const text = cmd.text
              if (!text) return { kind: 'error', text: '用法: memory state <当前状态，如"目标 | 进行中 X | 下一步 Y">' }
              const desc = text.length > 80 ? text.slice(0, 77) + '…' : text
              const existing = doc.memories.find(m => m.type === 'state')
              const okState = await requireApproval(inv.agent, 'memory', `更新状态快照「${desc}」`)
              if (!okState) return { kind: 'success', text: '已取消：用户未批准更新状态快照。' }
              const now = new Date().toISOString()
              if (existing) {
                const upd = { ...existing, description: desc, body: organizedText(text), updatedAt: now }
                const memsAfterState = doc.memories.map(m => m.id === existing.id ? upd : m)
                if (await writeDoc(cwd, memsAfterState)) fr.syncMirror(cwd, memsAfterState)
                addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(命令:状态快照)')
                return { kind: 'success', text: `已更新状态快照: ${desc}` }
              }
              const mem = { id: newId(), name: 'state-current', title: '当前项目状态', description: desc, type: 'state', body: organizedText(text), scope: 'project', status: 'active', heat: 0, ttl: 'permanent', triggers: [], obligation: false, pinned: false, proofCount: 0, phase: null, createdAt: now, updatedAt: now }
              const memsAfterState = [...doc.memories, mem]
              if (await writeDoc(cwd, memsAfterState)) fr.syncMirror(cwd, memsAfterState)
              addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(命令:状态快照)')
              return { kind: 'success', text: `已创建状态快照: ${desc}` }
            }
            if (cmd.kind === 'pending') {
              const list = pendingChanges.get(cwd) || []
              if (cmd.sub === 'clear') {
                pendingChanges.delete(cwd)
                return { kind: 'success', text: '已清空待报告改动清单。' }
              }
              if (list.length) {
                const rows = list.map((x, i) => `${i + 1}. ${x.path}`).join('\n')
                const t0 = list.length
                return { kind: 'success', text: `# 待报告改动（${t0} 项）\n${rows}\n完成对话任务时请以表格汇总报告；或用 memory pending clear 清空。` }
              }
              return { kind: 'success', text: '当前无待报告改动。' }
            }
            return { kind: 'error', text: '未知子命令' }
          } catch (e) {
            return { kind: 'error', text: String(e && e.message ? e.message : e) }
          }
        },
      })
    } catch (e) {
      console.log('[project-memory] command register failed: ' + (e && e.message ? e.message : e))
    }
  }
  // ---- /guard 命令（GLM §4/§5 文案引用）：list | remove <序号>（二次确认）——与 /memory guard 同源，守卫可逆 ----
  if (commands !== undefined) {
    try {
      commands.register({
        name: 'guard',
        description: '列出/移除硬守卫（底线记忆机制，GLM 定稿）：`guard list` 列出守卫（序号/动作/目标/来源/拦截次数）；`guard remove <序号>` 移除（需二次确认，可逆）。',
        input: { hint: '[list|remove <序号>]' },
        handler: async (inv) => {
          try {
            const cwd = ensureCwd(inv.agent)
            const doc = await readDoc(cwd)
            const sub = String((inv && inv.rawInput) || '').trim().toLowerCase()
            return await handleGuardCmd(cwd, doc, sub, inv.agent)
          } catch (e) {
            return { kind: 'error', text: String(e && e.message ? e.message : e) }
          }
        },
      })
    } catch (e) {
      console.log('[project-memory] /guard command register failed: ' + (e && e.message ? e.message : e))
    }
  }

  // ---- host RPC route for the settings panel (official stable seam: webServer) ----
  if (webServer !== undefined) {
    try {
      const body = (req) => new Promise((resolve, reject) => {
        let data = ''
        req.on('data', (chunk) => { data += chunk })
        req.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}) } catch (e) { resolve({}) }
        })
        req.on('error', reject)
      })
      const json = (res, obj) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(obj))
      }
      const handler = async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        let payload = {}
        try { payload = await body(req) } catch (e) { payload = {} }
        const action = payload.action
        const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined
        try {
          if (action === 'list') {
            if (!cwd) return json(res, { ok: false, error: 'missing cwd' })
            const doc = await readDoc(cwd)
            return json(res, { ok: true, memories: doc.memories, capabilities: buildCapabilityReport() })
          }
          if (action === 'save') {
            if (!cwd) return json(res, { ok: false, error: 'missing cwd' })
            if (!Array.isArray(payload.memories)) return json(res, { ok: false, error: 'missing memories' })
            // 数据安全防线（GLM §6）：任何一条记录不满足记忆形状 → 整包拒绝、原文件不动，杜绝客户端写坏库。
            const bad = payload.memories.filter((m) => !m || typeof m !== 'object'
              || typeof m.id !== 'string' || typeof m.title !== 'string'
              || typeof m.description !== 'string' || typeof m.body !== 'string'
              || typeof m.updatedAt !== 'string')
            if (bad.length > 0) {
              return json(res, { ok: false, error: 'rejected: ' + bad.length + ' invalid record(s) (not a well-formed memory)' })
            }
            const hasGuard = payload.memories.some((m) => m && m.guard)
            if (await writeDoc(cwd, payload.memories)) {
              fr.syncMirror(cwd, payload.memories)
              // 新客户端（payload 带 guard 字段）保存 = 可信路径 → 基线刷新；旧客户端（丢 guard 字段）
              // 不刷新 → /memory status 按基线下降告警（GLM §2 缓解：可观测而非阻断）
              if (hasGuard) rl.resetBaseline(cwd)
            }
            return json(res, { ok: true, saved: true })
          }
          if (action === 'capabilities') {
            return json(res, { ok: true, capabilities: buildCapabilityReport() })
          }
          return json(res, { ok: false, error: 'unknown action: ' + String(action) })
        } catch (e) {
          return json(res, { ok: false, error: String(e && e.message ? e.message : e) })
        }
      }
      // 装卸干净（审计 6fc8f006）：webServer.register 与 fiber 无绑定——必须包 ctx.effect（照抄 client-connection 官方做法），
      // 否则进程内卸载后 /project-memory/api 路由残留 + 重复装卸路由堆积（register duplicate prefix 被吞→新实例装不上）。
      ctx.effect(() => {
        webServer.register({ kind: 'prefix', path: '/project-memory/api', handler })
      }, 'project-memory: api route')
      console.log('[project-memory] host RPC route mounted at /project-memory/api')
    } catch (e) {
      console.log('[project-memory] webServer route register failed: ' + (e && e.message ? e.message : e))
    }
  }

  console.log('[project-memory] ready: store(v3) + 5 model tools + /memory command + host RPC + capability probe')
}
