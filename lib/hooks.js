// L4 编排层（GLM 定稿 §5）：唯一接触 ctx 的层——注册 systemPrompt.context 三段 + ctx.on 三监听器。
// createHooks({ store, first, scene, rule, pendingChanges, diag, fs }) →
//   { register(ctx), registerContext(systemPrompt), onPreStep, onPreExecute, onPostExecute, getScene }
// 分工：store=readDoc/writeDoc/索引缓存；first=首注 L1（renderFirst/ensureWarm/getFirstCache）；
//   scene=四源检测+片段+行为（createScene.plan 单一写入点，behaviorCache 工厂内）；
//   rule=规则文案+硬守卫（brief/full/guard/injectFull）；pendingChanges=待报清单同步 Map（注入，不复制）；
//   diag=注入的诊断计数器对象（本层只自增，不构建报告）；fs=可选（命令快照比对用，缺则降级不误报）。
// 本层不 import index.js、不反向依赖 L1-L3；index.js 接线只需一行 hooks.register(ctx)。
// 事件契约（已验证，照抄 index.js L357-549）：agent/pre-step(payload,next) / tools/pre-execute(exec,next) /
//   tools/post-execute(exec,result,next)；waterfall 必须 call next()；guard 命中 reject 短路不调 next。
// 探测→降级：systemPrompt.context / ctx.on 不可用 → 静默跳过（capabilityReport 由接线层探查）。

import { cwdFromAgent, absPath } from './store.js'
import { MEMORY_FILE } from './rule.js'

// ---- 默认兜底（rule 实例缺 brief 时用 rule.js 纯导出；正常接线走注入的 rule）----
// 说明：rule.js createRule 已返回 { brief, full, guard, injectFull }，这里仅保证缺依赖时零抛错。

export function createHooks({ store, first, scene, rule, pendingChanges, diag, fs } = {}) {
  // 场景缓存（注入内容）：cwd -> { source, domain, ids, sceneText, behavior, ruleFull, at }
  // plan（scene.createScene）是 L2 唯一写入点；本层只缓存其结构化结果供 context 同步读。
  const injectedCache = new Map()
  // 命令类工具前后快照比对（exec 对象 -> Promise<Map<name,size>>；post-execute 取用）
  const execSnapWeak = new WeakMap()

  const bump = (k) => { try { if (diag) diag[k] = (typeof diag[k] === 'number' ? diag[k] : 0) + 1 } catch (e) {} }

  // ---- 待报告改动累积（照抄 index.js L467-476：abs 去重、note 取最后、cap 50）----
  function addPending(cwd, file, abs, note) {
    try {
      if (!pendingChanges || typeof pendingChanges.get !== 'function') return
      let acc = pendingChanges.get(cwd) || []
      const idx = acc.findIndex((x) => x.path === abs)
      if (idx >= 0) acc[idx] = { file, path: abs, note: note || '' }
      else { acc = acc.concat({ file, path: abs, note: note || '' }).slice(-50); pendingChanges.set(cwd, acc) }
    } catch (e) { /* 累积失败不阻塞 */ }
  }

  // ---- 命令快照比对（照抄 index.js L481-502；fs 可选注入，缺则空快照→不误报）----
  async function snapshotTopLevel(cwd) {
    const snap = new Map()
    try {
      if (!fs || typeof fs.listDir !== 'function') return snap
      const dir = await fs.resolve('.', { cwd })
      const entries = await fs.listDir(dir)
      for (const e of entries) snap.set(e.name, e.size === undefined ? 0 : e.size)
    } catch (e) { /* 快照失败 → 空，不误报 */ }
    return snap
  }
  function isExecTool(nm) { return /^(pwsh|bash|node|subprocess|shell|exec)$/i.test(nm || '') }
  function diffSnapshots(before, after) {
    const changed = []
    const names = new Set([...(before && before.keys() || []), ...(after.keys() || [])])
    for (const n of names) {
      const b = before && before.get(n), a = after.get(n)
      if (b !== a) changed.push(n)
    }
    return changed
  }

  // ---- scene.plan 结果 → 注入缓存条目（L2 数据 → L4 同步读缓存）----
  function setInjected(cwd, p, ruleFullText) {
    try {
      if (!cwd || !p) return
      const scenes = Array.isArray(p.scenes) ? p.scenes : []
      let sceneText = scenes.length ? '【场景记忆】\n' + scenes.map((s) => '- ' + (s && s.text || '')).join('\n') : ''
      if (sceneText.length > 1500) sceneText = sceneText.slice(0, 1500)
      injectedCache.set(cwd, {
        source: p.source || 'none', domain: p.domain,
        ids: Array.isArray(p.ids) ? p.ids : [],
        sceneText, behavior: p.behavior || '', ruleFull: ruleFullText || '', at: Date.now(),
      })
      if (diag) { diag.sceneType = p.source || 'none'; if (scenes.length) diag.sceneCount = scenes.length }
    } catch (e) { /* 缓存失败不阻塞 */ }
  }
  // 只读访问器（context text 同步读；spec 的 scene.getScene——createScene 未暴露缓存，故本层自持）
  function getScene(cwd) { return injectedCache.get(cwd) }

  // ---- registerContext：三段 context 注册（order 照抄 index.js：t0=0 / rules=1 / profile=2）----
  // context text 全部同步读：first.getFirstCache（renderFirst 组装 L1）/ injectedCache（场景）/ pendingChanges（renderFirst 内 getPending）。
  function registerContext(systemPrompt) {
    if (!systemPrompt || typeof systemPrompt.context !== 'function') return false
    try {
      // 项目记忆规则·场景化：平时不注（首注不再带精简句——按用户"规则也看场景"）；memory_* 场景由 scene.js 注入 ruleFull 全量规则（含"为什么"）。
      // 硬守卫（rule.guard：write/edit 直改 .dsh-memory.json → reject+纠正）机制化防绕过，不依赖提示词；安全基线 = 硬守卫 + memory_* 工具描述。
      // project-memory-t0（L1 全量：画像/状态/催办/心跳 = renderFirst + 场景/行为行/记忆全规则 = injectedCache）——画像由 t0 单份渲染，profile 段删除（避免 step0 双份×2）
      systemPrompt.context({
        name: 'project-memory-t0',
        order: 0,
        text: (ac) => {
          try {
            const agent = ac && ac.agent
            const cwd = cwdFromAgent(agent)
            if (!cwd) return ''
            const parts = ['【项目记忆注入】']
            // L1（画像/状态/催办/心跳）只在每轮首步（step===0）渲染——工具/命令步（step≥1）不渲染画像（避免"命令查文件也注入用户画像"）。
            // ddb60d42 查实：assemble 期间 ac.agent.phase.step===0（首步），工具/后续步 ≥1。
            const st0 = agent && agent.phase && typeof agent.phase.step === 'number' ? agent.phase.step : 0
            if (st0 === 0) {
              const l1 = first && typeof first.renderFirst === 'function' ? first.renderFirst(cwd) : ''
              if (l1) parts.push(l1)
            }
            const inj = injectedCache.get(cwd)
            if (inj) {
              if (inj.behavior) parts.push(inj.behavior)
              if (inj.sceneText) parts.push(inj.sceneText)
              if (inj.ruleFull) parts.push(inj.ruleFull)
            }
            return parts.join('\n\n')
          } catch (err) { return '' }
        },
      })
      return true
    } catch (e) {
      console.log('[project-memory] systemPrompt context register failed: ' + (e && e.message ? e.message : e))
      return false
    }
  }

  // ---- onPreStep：输入命中（utt）→ scene.plan → injectedCache；镜像缺失预热（assemble 在 pre-step 前，存根兜底）----
  // 照抄 index.js L357-406 语义（input 提取/命中注入/异步不阻断），只把 detectHits+renderRedlineText
  // 换成 scene.plan（四源归一中的话语倒排 + 片段 + 行为行）。M3 pollCompaction 不属于本层（接线层保留）。
  function onPreStep(payload, next) {
    try {
      bump('preStep')
      const agent = payload && payload.agent
      if (agent && agent.session) bump('agentHasSession')
      const cwd = cwdFromAgent(agent)
      if (cwd) {
        bump('cwdResolved')
        // 首注镜像预热：缺失/未 ready 才读盘（避免每步重复读）；已 ready 的镜像由写路径持续维护
        try {
          const fc = (first && typeof first.getFirstCache === 'function') ? first.getFirstCache(cwd) : undefined
          if (fc && !fc.ready && first && typeof first.ensureWarm === 'function') first.ensureWarm(cwd).catch(() => {})
          else if (!fc && first && typeof first.ensureWarm === 'function') first.ensureWarm(cwd).catch(() => {})
        } catch (_) {}
        const msgs = (payload && payload.messages) || []
        const input = msgs.map((m) => { try { const b = m && m.content && m.content[0]; return b && b.text || '' } catch (e) { return '' } }).filter(Boolean).join('\n')
        if (input && store && typeof store.readDoc === 'function') {
          store.readDoc(cwd).then((doc) => {
            try {
              const p = scene && typeof scene.plan === 'function'
                ? scene.plan({ cwd, input, doc, invert: (store.getInvert ? store.getInvert(cwd) : undefined) })
                : null
              if (p) setInjected(cwd, p)
            } catch (e) { /* plan 失败不阻断 */ }
          }).catch(() => {})
        }
      }
    } catch (e) { /* 忽略 */ }
    return next()
  }

  // ---- onPreExecute：rule.guardCheck 硬守卫（机制化，不靠提示词）+ scene.plan(file/memory/bash)→注入缓存（含行为行）----
  // 照抄 index.js L411-456：guard 命中 deny 短路（不 next）；cat 分类；exec 快照；异步 readDoc→plan。
  function onPreExecute(exec, next) {
    try {
      bump('preExec')
      const nm = exec && exec.name
      const agent = exec && exec.agent
      const cwd = cwdFromAgent(agent)
      if (!nm || !cwd) return next()
      const args = (exec && (exec.arguments || exec.args || {})) || {}
      // 硬守卫（GLM §5 机制，deny 优先于 approval——监听器在工具体执行/确认门之前短路）：
      // rule.guardCheck 单一判定点 = 结构性基线（.dsh-memory.json 直改，硬编码）+ 记忆派生守卫
      // （block_write/update/delete）。命中 → { kind:'deny', reason }（DSH PreToolDecision 契约，
      // materialize 成 Error: <reason> 的 isError 工具结果——模型看得见为什么被拦）。
      // 注意：旧 { kind:'reject', message } 在本版本 dsh-tools 下 decision.reason 为 undefined → 不会真正拦截，
      // 故统一改为 deny+reason（见 RuleGuard 注释与 harness dsh-tools prepareExecution）。
      if (rule && typeof rule.guardCheck === 'function') {
        const gd = rule.guardCheck(exec, cwd)
        if (gd && gd.text) {
          if (gd.hit && typeof rule.bumpBlocked === 'function') { try { rule.bumpBlocked(cwd, gd.hit.sourceId) } catch (_) {} }
          return Promise.resolve({ kind: 'deny', reason: gd.text })
        }
      }
      let cat
      if (/^(write|edit|str_replace_editor)$/i.test(nm)) cat = 'file'
      else if (/^(pwsh|bash|node|subprocess|shell)$/i.test(nm)) cat = 'exec'
      else if (/^memory_(write|update|delete)$/i.test(nm)) cat = 'memory'
      else if (/^(read|grep|cat|ls|glob|read_file|read_text)$/i.test(nm)) cat = 'read'
      // 读类（cat='read'）也进 scene.plan（触发 clearBehavior 清旧行为行——GLM §5 read 清旧；话题片段不清）
      if (!cat && !/^(read|grep|cat|ls|glob|read_file|read_text)$/i.test(nm)) return next()
      if (cat === 'exec') execSnapWeak.set(exec, snapshotTopLevel(cwd))
      if (store && typeof store.readDoc === 'function') {
        store.readDoc(cwd).then((doc) => {
          try {
            const filePath = args.file_path || args.path || args.file || ''
            const p = scene && typeof scene.plan === 'function'
              ? scene.plan({ cwd, tool: nm, filePath, doc, invert: (store.getInvert ? store.getInvert(cwd) : undefined) })
              : null
            // memory_* 场景：注入完整规则（rule.injectFull；含"为什么"——照 rule.js createRule 契约）
            let ruleFullText = ''
            if (cat === 'memory' && rule && typeof rule.injectFull === 'function') {
              try { const r = rule.injectFull(cwd); ruleFullText = (r && r.text) || '' } catch (e) { /* ignore */ }
            }
            if (p) setInjected(cwd, p, ruleFullText)
          } catch (e) { /* plan 失败不阻断 */ }
        }).catch(() => {})
      }
    } catch (e) { /* 忽略 */ }
    return next()
  }

  // ---- onPostExecute：pendingChanges 累积（write/edit/memory_*/命令快照比对——照抄 index.js L505-548）----
  function onPostExecute(exec, result, next) {
    try {
      bump('postExec')
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
      // 记忆文件：memory_write/update/delete 改 .dsh-memory.json（计入待报告改动）
      if (/^memory_(write|update|delete)$/i.test(nm || '')) {
        const abs = absPath(cwd, MEMORY_FILE)
        addPending(cwd, MEMORY_FILE, abs, '记忆修改')
        const line = { type: 'text', text: `\n📎 本次改动记忆文件：${abs}（记忆修改已计入待报告改动清单）。` }
        return Promise.resolve({ kind: 'accept', content: [...prev, line] })
      }
      // 命令类工具：前后快照比对 → 顶层变化记 pendingChanges（兜底难直接拿 file_path 的场景）
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
  }

  // ---- register(ctx)：接线唯一入口——context 三段 + ctx.on 三监听器（探测→降级，全部 try 捕获）----
  function register(ctx) {
    if (!ctx) return false
    let ok = false
    if (ctx.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
      if (registerContext(ctx.systemPrompt)) ok = true
    }
    if (typeof ctx.on === 'function') {
      try {
        ctx.on('agent/pre-step', (payload, next) => { try { return onPreStep(payload, next) } catch (e) { return next ? next() : undefined } })
        ctx.on('tools/pre-execute', (exec, next) => { try { return onPreExecute(exec, next) } catch (e) { return next ? next() : undefined } })
        ctx.on('tools/post-execute', (exec, result, next) => { try { return onPostExecute(exec, result, next) } catch (e) { return next ? next() : undefined } })
        ok = true
      } catch (e) {
        console.log('[project-memory] hooks ctx.on register failed: ' + (e && e.message ? e.message : e))
      }
    }
    return ok
  }

  return { register, registerContext, onPreStep, onPreExecute, onPostExecute, getScene }
}
