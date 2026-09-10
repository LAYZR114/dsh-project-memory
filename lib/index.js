// dsh-project-memory host half: store(v3) + 5 model tools + /memory command + host RPC routes.
// All seams are read via ctx.get(...) with capability probing (detect -> degrade -> report).
// Official-stable seams only: tools, commands, fs, webServer. High-risk internal seams
// (systemPrompt.context, tools/pre-execute, agent/*) are deliberately NOT used here to stay
// upgrade-resilient; recall works through the tools/memory_recall surface instead.

// lossless JSON 自动防线抽成独立纯函数模块，便于 round-trip 测试直接测真实实现（避免双维护漂移）。
import { jsonSafe } from './json-safe.js'
// GLM 新注入模块（L1-L4）：store/first/scene/rule/hooks。store.js 复用全部存储纯核与写盘策略；
// index.js 只负责装配 + injectMode 分流（scenario=新注入默认 | legacy-full=旧路径金丝雀）。
import { createStore, readDocSync, readMemoryFileMtime } from './store.js'
// 轻量化·批次A：纯函数单元搬到 store.js（逐字等价，见 store.js L27-398）；此处只 import 不重复实现。
// 漂移函数（ensureIdf/idfWeight/scoreRareTopic/scoreMemory/isAutoMerge）保留本地实现，见备份 .bak-light-A 与迁移说明。
import { buildInvert, deriveLevel, buildPages, norm, bigrams, titleSimilarity, RARE_STOP, tokenizeRare, slugify, makeMemorySlug, isValid, migrateV1, byNewest, searchProjectMemory, activeOnly, scoreOf, newId, organizeBody, organizedText, SECRET_RE, sanitizeSecret, OBLIGATION_RE, isObligation, extractTriggers, writePolicy } from './store.js'
import { createFirst } from './first.js'
import { createScene } from './scene.js'
import { createRule, actLabel, targetLabel, removeGuardFromDoc, userDeleteConfirmText } from './rule.js'
import { createHooks } from './hooks.js'
// 轻量化·批次D：模型工具/命令/RPC 拆到独立文件（工厂依赖传参，见 tools/commands/api.js——只搬移不重写）。
import { createTools } from './tools.js'
import { registerCommands } from './commands.js'
import { registerApiRoute } from './api.js'

export const name = 'dsh-project-memory'

// DSH services are reachable through the `inject` declaration + ctx.<name> property access.
// 硬依赖清单：缺任一 → Cordis 让本 fiber 永久 PENDING（无超时）→ 插件整体不激活。
// webServer 故意【不在】此清单：官方 Electron 壳（apps/desktop-host 组合）把 webserver 行
// disabled: true，硬 inject 会让插件在那种壳里永不激活；改为 apply 内 ctx.get('webServer')
// 软读 → 缺失即降级（设置页 RPC 关闭，能力上报 missing），其余功能照常（探测→退化→上报）。
export const inject = ['tools', 'commands', 'fs', 'agents', 'approval', 'userQuestions', 'systemPrompt', 'llm']

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
  // [legacy-full-only] 退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除（GLM §5 贯穿项）。
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
  // webServer 软依赖（不在 inject 里）：官方 Electron 壳 disabled 了 webserver 行，
  // 硬 inject 会让整个 fiber 永久 PENDING；此处 ctx.get 探测 → 缺失即降级（设置页 RPC 关闭）。
  // 注意：它也可能是本插件 apply **之后**才就绪 → 不能只在这里取一次（见文末 mountApi：用 ctx.inject 等它就绪）。
  let webServer = ctx.get('webServer')
  const approval = ctx.approval
  const userQuestions = ctx.userQuestions
  const systemPrompt = ctx.systemPrompt
  // llm 是可选 seam（压缩协同提炼增强用），非记忆核心：用 ctx.get 运行时探测，缺则 undefined 降级。
  // llm 服务：必须 inject + ctx.llm（super-injector 服务不能用 ctx.get，否则 undefined）。GLM 排查确认。
  const llm = ctx.llm

  // ---- GLM 新注入模块装配（L1-L4：store/first/scene/rule/hooks；金丝雀增量接线）----
  // 数据写路径统一经 writeThrough（唯一入口）：工具/RPC/压缩/派生物走 writeThrough（sanity→纯落盘→afterWrite 链）；
  // st 供新模块共享读盘与缓存访问器（scene.plan 对 invert 缓存有 buildInvert 兜底，不依赖 st 缓存新鲜度）。
  // pendingChanges 原声明在 t0Cache 之后（旧 L122），此处提前：createFirst 的 getPending 依赖它（闭包），
  // 且 hk.register 必须赶在旧 context 注册之前判定生效模式（防双份）。
  const pendingChanges = new Map() // 待报改动清单（延迟汇总）：cwd -> [{file, path, note}]；post-execute 累积，N2 检测或 /memory pending clear 清空
  // 见过的项目目录（2026-09-11）：cwd -> 最后一次见到的时间(ms)。设置页「项目目录」的 Typeahead 下拉据此列出"现有项目"。
  // 来源：工具调用解析出的 cwd（ensureCwd）、每次读盘（readDoc）、活跃会话的工作目录（collectProjects 里查 agents）。
  const knownCwds = new Map()
  const noteCwd = (cwd) => {
    if (typeof cwd !== 'string' || !cwd.trim()) return
    const k = cwd.replace(/[\\/]+$/, '')
    if (!k) return
    knownCwds.set(k, Date.now())
  }
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
  // 硬守卫·审计回执（GLM §5）：blockedCount 命中即 +1，经回执回调落盘（writeThrough 原子写，防重启丢审计数）。
  // 回调注册在 apply 期（writeThrough 为函数声明，闭包内可用；触发时机在运行期）。
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
          return writeThrough(cwd, next)
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
  // [legacy-full-only] 旧 context 注入（旧 t0 每轮全量数据）退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
  // [legacy-full-only] 旧缓存（refreshT0 用）退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
  // [legacy-full-only] 退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
  async function refreshIndex(cwd) {
    try {
      const doc = await readDoc(cwd)
      invertCache.set(cwd, buildInvert(doc))
    } catch (e) { /* 索引失败不阻塞 */ }
  }
  // 从本轮输入文本查倒排索引，返回命中的记忆 id 集（按命中词数排序）
  // [legacy-full-only] 退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
  async function refreshPages(cwd) {
    try {
      const doc = await readDoc(cwd)
      pagesCache.set(cwd, { pages: buildPages(doc.memories), at: Date.now() })
    } catch (e) { /* 页面重建失败不阻塞 */ }
  }
  // [legacy-full-only] 退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
  // [legacy-full-only] 旧 pre-step 监听器退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
  // [legacy-full-only] 旧 pre-execute 监听器退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
  // [legacy-full-only] 旧 post-execute 监听器退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
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
    // 确定性去重（titleSimilarity ≥0.6）+ 限额 → candidate 落盘（writeThrough 原子写）。
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
      await writeThrough(cwd, next)
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
  // askConfirm：统一确认弹窗（GLM §4）——新增/更新/删除/归档/加守卫/删守卫六场景共用。
  //   入参 {header, question, detail, options, guardSpec, protectSelf}。options 显式给出时逐字透传（保文案/选项一字节不改）；
  //   guardSpec = 守卫规格全文（"将安装硬守卫：…"原样展示），命中禁止语义时让 askConfirm 建"允许并装硬守卫"选项；
  //   protectSelf = true 时含"允许并装硬守卫（保护这条记忆）"选项（approve+guard-self，目标=新记忆本身）。
  //   返回决策值：'approve' | 'approve+guard' | 'approve+guard-self' | 'reject'（fail-closed：任何不确定 → 'reject'）。
  async function askConfirm(agent, { header, question, detail, options, guardSpec, protectSelf } = {}) {
    let opts
    if (Array.isArray(options) && options.length) {
      opts = options.slice()
    } else if (typeof guardSpec === 'string' && guardSpec) {
      opts = [
        { label: '允许（仅加记忆）', id: 'approve', description: '作为 P1 提醒注入，不安装守卫' },
        { label: '允许并装硬守卫', id: 'approve+guard', description: '将安装硬守卫：' + guardSpec },
        { label: '拒绝', id: 'reject', description: '不写入' },
      ]
    } else if (protectSelf === true) {
      opts = [
        { label: '允许', id: 'approve', description: '正常写入' },
        { label: '允许并装硬守卫（保护这条记忆）', id: 'approve+guard-self', description: '安装守卫：禁止删除/更新【这条记忆本身】（防误删/误改；可在 /guard 移除）' },
        { label: '拒绝', id: 'reject', description: '不写入' },
      ]
    } else {
      opts = [
        { label: '允许', id: 'approve', description: '批准' },
        { label: '拒绝', id: 'reject', description: '不写入并取消操作' },
      ]
    }
    if (userQuestions === undefined) {
      console.log('[project-memory] userQuestions unavailable; memory write refused (fail-closed)')
      return 'reject'
    }
    try {
      const res = await userQuestions.ask({
        agent,
        questions: [{
          id: 'confirm',
          header: header || '记忆修改确认',
          question: question || '允许执行这条记忆操作？',
          detail: detail || '',
          options: opts,
        }],
      })
      const sel = res && res.answers && res.answers[0] && res.answers[0].selected
      if (!Array.isArray(sel) || !sel.length) return 'reject'
      // 兼容：答案可能是选项 id（'approve+guard-self'/'approve+guard'/'approve'/'reject'）或标签文字
      //（'允许并装硬守卫（保护这条记忆）'/'允许并装硬守卫'/'允许…'/'拒绝…'/'确定解除并删除'/'取消'）。
      // 判定顺序（GLM §4 不变量③）：approve+guard-self 先于 approve+guard（其标签 '允许并装硬守卫（保护这条记忆）'
      // 同时含 '并装'/'硬守卫'，必须优先）；approve+guard 先于 approve（'允许并装硬守卫' 以 '允许' 开头）；
      // 批准优先于拒绝（与旧 requireApproval 语义一致）。
      for (const s of sel) {
        const str = typeof s === 'string' ? s : String(s)
        if (str === 'approve+guard-self' || str.indexOf('保护这条记忆') >= 0) return 'approve+guard-self'
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
  // requireApprovalEx：兼容别名（原三选项弹窗签名）；统一走 askConfirm，保持既有调用点语义与文案不变。
  async function requireApprovalEx(agent, opts) {
    return askConfirm(agent, opts)
  }
  // requireApproval：boolean 兼容封装（其余写路径不变；等价于 askConfirm 的 approve 语义：approve → true，其余 → false）。
  async function requireApproval(agent, toolName, reason) {
    const verb = toolName === 'memory_delete' ? '删除' : toolName === 'memory_update' ? '更新' : toolName === 'forget' ? '归档' : '新增'
    const res = await askConfirm(agent, {
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
  // norm/bigrams/titleSimilarity/RARE_STOP/tokenizeRare 已移入 store.js（逐字 import，见文件头）。
  // ---- 统计核心地基：IDF 权重表（按 cwd 独立语料，writeThrough 增量维护/惰性重建）----
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
  // slugify/makeMemorySlug/isValid/migrateV1/byNewest 已移入 store.js（逐字 import，见文件头）。
  // opts.keepOrder=true → 保留文件里的**原始数组顺序**（= 用户的手动/保存排序）。
  // 默认（不传）仍按"最新"重排，内部消费方（注入/检索/T0）沿用旧行为不变。
  // 为什么必须留这个开关：设置页的手动排序与「保存排序」依赖真实存储顺序；若读取一律重排，
  // 写进去的手动顺序一读就被冲掉（老 bug：拖动排序看似无效、保存排序"没反应"）。
  async function readDoc(cwd, opts) {
    if (fs === undefined) return { version: 2, memories: [] }
    // 记下"这个项目目录存在"（设置页「项目目录」Typeahead 用）。
    // 用 typeof 判定：老测试会把 readDoc 单独抽出来跑（作用域里没有 noteCwd）——不能因此抛错。
    if (typeof noteCwd === 'function') noteCwd(cwd)
    const target = await fs.resolve(MEMORY_FILE, { cwd })
    const info = await fs.stat(target)
    if (!info) return { version: 2, memories: [] }
    let raw = ''
    try { raw = await fs.readText(target) } catch (e) {
      // 读失败：先备份任何已读字节（若有），再报空，避免后续 writeThrough 覆盖丢数据
      return backupCorrupt(cwd, target, raw)
    }
    let parsed
    try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (e) {
      // parse 失败：原始字节仍在 raw，先备份到 .corrupt-<时间戳> 再报空
      return backupCorrupt(cwd, target, raw)
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.memories) ? parsed.memories : [])
    const memories = list.filter(isValid).map(migrateV1)
    return { version: 2, memories: (opts && opts.keepOrder) ? memories : memories.sort(byNewest) }
  }
  // 损坏/读失败时的兜底：把原始字节（若已知）写回 .corrupt-<ts> 备份文件，再返回空文档。
  // 这样即使后续 memory_recall 等触发 writeThrough 覆盖，也不会丢原始数据。
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
  // writePolicy 已移入 store.js（逐字 import，见文件头）。
  // 轻量化·批次B：本地 writeDoc 已废除——所有写路径统一经 writeThrough（单一入口）。
  // 原写后逻辑（markIdfDirty / rl.rebuild / refreshIndex / refreshT0）已搬入 afterWrite 链；
  // 调用方派生的 fr.syncMirror 也已上收 afterWrite。见本文件「writeThrough 唯一入口」块（MEMORY_TYPES 之后）。
  // searchProjectMemory/activeOnly/scoreOf 已移入 store.js（逐字 import，见文件头）。
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
    if (direct) { noteCwd(direct); return direct }
    if (agent && agent.id && agents !== undefined) {
      try { const via = cwdFromAgent(agents.get(agent.id)); if (via) { noteCwd(via); return via } } catch (e) {}
    }
    throw new Error('[project-memory] 无法确定项目目录 (cwd)')
  }
  /**
   * 取目录选择能力（`ctx.directoryPicker.capability()`）；pickDirectory / browseDirectories 共用。
   * @returns {{ok:true,cap:object}|{ok:false,error:string}}
   */
  function directoryPickerCapability() {
    let svc
    try { svc = ctx.get('directoryPicker') } catch (e) { svc = undefined }
    if (svc === undefined || typeof svc.capability !== 'function') {
      return { ok: false, error: 'directoryPicker 不可用（本环境没有目录选择能力）' }
    }
    try {
      const cap = svc.capability()
      if (!cap || typeof cap.kind !== 'string') return { ok: false, error: 'capability invalid' }
      return { ok: true, cap }
    } catch (e) {
      return { ok: false, error: 'capability failed: ' + (e && e.message ? e.message : e) }
    }
  }

  /**
   * 弹系统"选择文件夹"对话框（「选择目录」按钮的**原生退回路径**）。
   * 只有 `kind==='native'` 的环境有系统对话框；`browse` 环境如实报 browse-only（客户端改用自带浏览对话框）。
   * @returns {Promise<{ok:true,cwd:string}|{ok:false,error:string,browse?:boolean}>}
   */
  async function pickDirectory() {
    const got = directoryPickerCapability()
    if (!got.ok) return got
    const cap = got.cap
    if (cap.kind !== 'native' || typeof cap.pick !== 'function') {
      return { ok: false, error: 'browse-only', browse: true } // 没有原生对话框：如实上报，不假装成功
    }
    try {
      const picked = await cap.pick(AbortSignal.timeout(300000)) // 5 分钟上限；用户取消 → null
      if (typeof picked !== 'string' || !picked) return { ok: false, error: 'cancelled' }
      noteCwd(picked)
      return { ok: true, cwd: picked }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
  }

  /**
   * 列出某目录下的子目录（设置页自带"选择文件夹"浏览对话框用；走 browse 能力）。
   * @param path - 目标目录；省略则用家目录。
   * @returns {Promise<{ok:true,listing:object}|{ok:false,error:string}>}
   */
  async function browseDirectories(path) {
    const got = directoryPickerCapability()
    if (!got.ok) return got
    const cap = got.cap
    if (typeof cap.list !== 'function') return { ok: false, error: 'browse unavailable' }
    try {
      const listing = await cap.list(typeof path === 'string' && path ? path : undefined, AbortSignal.timeout(20000))
      if (!listing || typeof listing.path !== 'string') return { ok: false, error: 'invalid listing' }
      return { ok: true, listing }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
  }

  /**
   * 汇总"现有项目目录"（设置页「项目目录」Typeahead 下拉的数据源）。
   * 来源三处合并：①本进程见过的 cwd（noteCwd）②活跃会话的工作目录（agents.list()）③当前默认目录。
   * 每条附：count=该项目记忆条数、updatedAt=记忆文件最后修改时间。
   * @returns [{ cwd, count, updatedAt, lastSeenAt }]，按 lastSeenAt 新→旧、再按条数多→少排序。
   */
  function collectProjects() {
    const now = Date.now()
    const seen = new Map()
    const add = (c, t) => {
      if (typeof c !== 'string' || !c.trim()) return
      const k = c.replace(/[\\/]+$/, '')
      if (!k) return
      const prev = seen.get(k)
      if (!prev) seen.set(k, { cwd: k, lastSeenAt: t || now })
      else if ((t || now) > prev.lastSeenAt) prev.lastSeenAt = t || now
    }
    for (const [cwd, t] of knownCwds) add(cwd, t)
    try {
      const list = (agents !== undefined && typeof agents.list === 'function') ? agents.list() : []
      for (const a of list) add(cwdFromAgent(a), now)
    } catch (e) { /* agents 不可用：只用已见 cwd，不阻断 */ }
    const out = []
    for (const item of seen.values()) {
      let count = 0
      try { count = (readDocSync(item.cwd, MEMORY_FILE, { keepOrder: true }).memories || []).length } catch (e) { count = 0 }
      const updatedAt = readMemoryFileMtime(item.cwd, MEMORY_FILE)
      // ★ 只列"真有记忆文件"的目录：用户输入过程中的半截路径（D:/D、D:/DS…）没有文件 → 过滤掉，
      //   否则它们会灌满 Typeahead 下拉（用户 2026-09-11 实测反馈：历史记录太频繁）。
      if (!(updatedAt > 0)) continue
      out.push({ cwd: item.cwd, count, updatedAt, lastSeenAt: item.lastSeenAt })
    }
    out.sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || (b.count - a.count) || a.cwd.localeCompare(b.cwd))
    return out
  }

  // newId 已移入 store.js（逐字 import，见文件头）。
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

  // ==================== 轻量化·批次B：writeThrough 唯一入口（GLM §3 定稿）====================
  // 写路径统一铁律：任何写入口（memory_* 工具 / /memory 命令 / RPC save / 派生落盘）一律经
  // writeThrough(cwd, memories)。禁止任何调用方直连存储写（store.writeDoc / fs.writeText）——
  // 那是唯一可以绕过 sanity + afterWrite 派生物链的旁路，会直接破坏守卫表/首注镜像/IDF/索引/T0。
  // 顺序：防线1 sanity（坏数据不落盘）→ 防线2 纯原子落盘 → 防线3 afterWrite 派生物链（守卫表最先）。
  function report(msg) {
    try { console.log('[project-memory] ' + msg) } catch (_) {}
  }
  // 防线1：五项 sanity（GLM §3）。任一记忆缺 id / title / description / body / updatedAt（须字符串）
  // 或 type 非法 → 返回错误文本（writeThrough ABORTED，不落盘）。type 合法集 = MEMORY_TYPES ∪ {state}
  // （state 是 /memory state 系统快照类型，非 AI 可选的 6 类，但属合法写）。返回 null 表示健康。
  function checkSanity(memories) {
    const list = Array.isArray(memories) ? memories : (memories && Array.isArray(memories.memories) ? memories.memories : null)
    if (!list) return 'not an array of memories'
    const allowedTypes = new Set(MEMORY_TYPES); allowedTypes.add('state')
    for (const m of list) {
      if (!m || typeof m !== 'object') return 'non-object record'
      if (typeof m.id !== 'string' || !m.id) return 'missing id'
      if (typeof m.title !== 'string' || !m.title) return 'missing title'
      if (typeof m.description !== 'string') return 'missing description'
      if (typeof m.body !== 'string') return 'missing body'
      if (typeof m.updatedAt !== 'string') return 'missing updatedAt'
      if (m.type !== undefined && (typeof m.type !== 'string' || !allowedTypes.has(m.type))) return 'invalid type: ' + String(m.type)
    }
    return null
  }
  // 防线2：纯原子落盘（store 纯函数——不搬任何缓存/守卫/镜像副作用；副作用全在 afterWrite 链）。
  // 仅 fs 直写 .dsh-memory.json（带 writePolicy 保证跨沙箱落盘）；不做任何内存态修改。
  async function storeWriteDoc(cwd, memories) {
    if (fs === undefined) return false
    const mlist = Array.isArray(memories) ? memories : (memories && memories.memories ? memories.memories : [])
    const target = await fs.resolve(MEMORY_FILE, { cwd })
    await fs.writeText(target, JSON.stringify({ version: 2, memories: mlist }, null, 2), undefined, undefined, writePolicy(cwd))
    return true
  }
  // 防线3 + 派生物：写后有序重建链。guardTable（rl.rebuild）必须最先——后续步（拦截查询/场景/镜像）
  // 都依赖「看到新数据的守卫表」，绝不能用旧表（GLM 风险 c：保守卫不失效）。
  // 每步独立 try/catch，单步失败不阻断后续（报告 afterWrite.<step> failed，不静默）。
  async function afterWrite(cwd, memories) {
    const steps = [
      ['guardTable', () => rl.rebuild(cwd, { version: 2, memories })],  // 守卫表最先（拦截依赖新表）
      ['syncMirror', () => fr.syncMirror(cwd, memories)],               // 首注镜像新鲜度（上收自各调用方）
      ['idf',        () => markIdfDirty(cwd)],                          // IDF 表脏标记（惰性重建）
      ['index',      () => refreshIndex(cwd)],                          // 倒排索引重建
      ['t0',         () => refreshT0(cwd)],                             // [legacy-full-only] T0 渲染缓存 + 页面刷新（refreshT0 内部联调 refreshPages）退役条件：scenario 稳定 1-2 周 + 全功能回归 + 用户确认；届时连同 Config 枚举一并移除。
    ]
    for (const [nm, fn] of steps) { try { await fn() } catch (e) { report('afterWrite.' + nm + ' failed: ' + (e && e.message ? e.message : e)) } }
  }
  // writeThrough：唯一写入口。防线1 sanity 拦截坏数据（不落盘）→ 防线2 纯落盘 → 防线3 派生物链。
  // 返回 true=成功（已落盘 + 派生物链已跑），false=sanity 拦截或落盘失败（不承诺派生物执行）。
  // ★ 保序铁律（2026-09-11 修 bug）：**磁盘上的现有顺序 = 用户的手动/保存排序，是权威顺序**。
  //   除"显式改序"（设置页 /save 传 opts.explicitOrder=true）外，任何写入都不得重排文件：
  //   把本次要写的集合"套回"磁盘顺序；磁盘上不存在的新记忆放最前（手动模式下可见），保持调用方给定顺序。
  //   老 bug：召回热度自增(tools.js)/增删改都是"默认读(按最新重排) → 原样写回"，
  //   于是用户保存的顺序一有写入就被冲掉——重启后自然看起来"没保存住"。
  async function writeThrough(cwd, memories, opts) {
    let ordered = memories
    if (!(opts && opts.explicitOrder)) {
      try {
        const diskIds = readDocSync(cwd, MEMORY_FILE, { keepOrder: true }).memories.map((m) => m && m.id)
        if (diskIds.length > 0) {
          const pos = new Map(diskIds.map((id, i) => [id, i]))
          const fresh = []
          const known = []
          for (const m of memories) { if (m && pos.has(m.id)) known.push(m); else fresh.push(m) }
          known.sort((a, b) => pos.get(a.id) - pos.get(b.id))
          ordered = fresh.concat(known)
        }
      } catch (e) { ordered = memories } // 读不到盘（首次写入）→ 保持调用方顺序
    }
    const bad = checkSanity(ordered)
    if (bad) { report('writeThrough ABORTED: ' + bad); return false }
    const ok = await storeWriteDoc(cwd, ordered)
    if (!ok) { report('writeThrough storeWriteDoc failed (fs unavailable?)'); return false }
    await afterWrite(cwd, ordered)
    return true
  }
  // ==================== writeThrough 唯一入口（end）====================

  // organizeBody/organizedText/SECRET_RE/sanitizeSecret/OBLIGATION_RE/isObligation/extractTriggers
  // 已移入 store.js（逐字 import，见文件头）。

  // ==================== 轻量化·批次D：工具/命令/RPC 面已拆到 tools.js/commands.js/api.js ====================
  // deps 对象：把 index.js 共享层（只读函数/写路径铁律/本地计数）以传参方式注入新工厂（只搬移不重写）。
  // 可变计数（diagRerankRun/diagRerankFallback）与只读路由（diagLastRoute）是 apply 内 let 绑定，
  // 必须经 getter/setter 桥接（解构/直接赋值会断链——见 tools.js 注释）；其余直接引用 apply/module 作用域同名。
  const deps = {
    // —— 共享层（只读函数 + 写路径铁律 + 确认门，留在 index.js，不入新文件）——
    ensureCwd, readDoc, writeThrough, askConfirm, requireApproval,
    collectProjects, // 设置页「项目目录」Typeahead 的"现有项目"来源（api.js action: projects）
    pickDirectory,   // 设置页「选择目录」按钮：官方 directoryPicker 原生对话框（api.js action: pickdir）
    browseDirectories, // 设置页自带"选择文件夹"浏览对话框（browse 能力，api.js action: browse）
    absPath, addPending, pendingChanges, rl, cfg, MEMORY_FILE,
    buildCapabilityReport, pollCompaction, recallMemory, scoreRareTopic,
    probeLlmRoute, extractJson, llm, text, outSchema,
    // —— 模块级 import（store.js / json-safe.js / rule.js）——
    searchProjectMemory, activeOnly, jsonSafe, newId, organizedText,
    titleSimilarity, makeMemorySlug, sanitizeSecret, isObligation,
    extractTriggers, actLabel, targetLabel, removeGuardFromDoc, userDeleteConfirmText,
    // —— DSH seam（super-injector：ctx.*，已注入为 apply 局部）——
    tools, commands, webServer,
    // —— apply 局部常量 ——
    SCENE_DOMAINS, MEMORY_TYPES,
    // —— 跨模块可变计数 / 只读路由桥（getter/setter 断链防护）——
    get diagRerankRun() { return diagRerankRun },
    set diagRerankRun(v) { diagRerankRun = v },
    get diagRerankFallback() { return diagRerankFallback },
    set diagRerankFallback(v) { diagRerankFallback = v },
    get diagLastRoute() { return diagLastRoute },
  }

  // —— 三入口：新工厂内部自注册（tools.js 内部 tools.register；commands.js 内部 commands.register；
  //    api.js 经 ctx.effect 装卸 webServer 路由）。apply 不再含任何工具/命令/RPC 逻辑。——
  createTools(deps)
  registerCommands(deps)
  // webServer 软依赖的**挂载时机**（0.1.2 修复）：不在 inject 里可避免"官方壳无 webserver → fiber 永久 PENDING"，
  // 但它可能在本插件 apply 之后才就绪——只在 apply 时 ctx.get 一次会**静默丢路由**（症状：设置页报
  // "SyntaxError: Unexpected end of JSON input"，因为 /project-memory/api 404/空响应）。
  // 因此：已就绪 → 立即挂；未就绪 → ctx.inject(['webServer'], ...) 等它就绪再挂（服务消失时随该 fiber 自动卸载）。
  const mountApi = (wctx) => {
    try {
      const svc = (wctx && typeof wctx.get === 'function' ? wctx.get('webServer') : undefined) || webServer
      if (svc === undefined) return
      webServer = svc
      registerApiRoute(wctx || ctx, Object.assign({}, deps, { webServer: svc }))
    } catch (e) { report('registerApiRoute failed: ' + (e && e.message ? e.message : e)) }
  }
  if (webServer !== undefined) {
    mountApi(undefined)
  } else if (typeof ctx.inject === 'function') {
    try { ctx.inject(['webServer'], (wctx) => mountApi(wctx)) } catch (e) { report('ctx.inject(webServer) failed: ' + (e && e.message ? e.message : e)) }
  }

  console.log('[project-memory] ready: store(v3) + 5 model tools + /memory command + host RPC + capability probe')
}
