// 轻量化·批次D：模型工具面（memory_read/recall/write/update/delete/pending_changes）。
// 只搬移不重写——本文件 toolsDef 数组逐字等价于原 index.js L1334-1674；闭包依赖经 deps 注入
// （createTools(deps) 返回 toolsDef 数组，index.js apply 负责 tools.register 及共享层）。
// 依赖传参约定（GLM §7）：只读共享用 `const { ... } = deps` 解构；跨模块可变计数（diagRerankRun/
// diagRerankFallback）必须经 `deps.diagRerankRun++` 直接读写 deps 实属性（解构会断链）。
export function createTools(deps) {
  const {
    ensureCwd, readDoc, searchProjectMemory, activeOnly, jsonSafe,
    outSchema, text, recallMemory, llm, probeLlmRoute, extractJson,
    writeThrough, sanitizeSecret, isObligation, extractTriggers,
    SCENE_DOMAINS, cfg, rl, actLabel, targetLabel, askConfirm,
    newId, organizedText, titleSimilarity, makeMemorySlug,
    requireApproval, pendingChanges, tools, MEMORY_TYPES,
  } = deps

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
                  deps.diagRerankRun++   // 跨模块共享计数：必须写 deps 实属性（解构会断链）
                }
              }
            }
          } catch (e) {
            deps.diagRerankFallback++ // LLM 精排失败 → 保留词法排序（已在上面的 recalled）
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
            const okRec = await writeThrough(cwd, bumped) // 唯一写入口（含 sanity + 派生物链：镜像同步上收 afterWrite）
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
        let guardSelf = false   // 用户主动选"保护这条记忆本身"（目标=新记忆 id，禁止删/改）
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
          // GLM §4：守卫命中 → guardSpec 全文（动作+目标+来源）原样展示；askConfirm 据此建"允许并装硬守卫"选项（approve+guard）。
          const gOk = await askConfirm(exec.agent, {
            header: '记忆修改确认',
            question: '允许新增这条项目记忆？',
            detail: confirmDetail + `\n检测到禁止语义，可安装硬守卫：${spec}${importAdvice}`,
            guardSpec: spec,
          })
          if (gOk === 'reject') return { saved: false, cancelled: true, message: '已取消：用户未批准新增这条项目记忆。' }
          if (gOk === 'approve+guard') {
            guardToInstall = { action: proposal.guard.action, target: proposal.guard.target, createdAt: new Date().toISOString(), blockedCount: 0 }
          }
        } else if (proposal && proposal.propose === false) {
          // 识别失败也要说话（GLM §3）：注明将作为 P1 提醒注入（不安装守卫）——设定期望，符合诚实边界。
          // 用户中心（2026-09-09）：即使未识别出禁止语义目标，也加"允许并装硬守卫（保护这条记忆本身）"选项——用户主动想保护即可装（目标=这条新记忆，禁止删/改）。
          const gOk = await askConfirm(exec.agent, {
            header: '记忆修改确认',
            question: '允许新增这条项目记忆？',
            detail: confirmDetail + `\n${proposal.reason}——本记忆将作为 P1 提醒注入；如需防止误删/误改，可选"保护这条记忆"。`,
            options: [
              { label: '允许', id: 'approve', description: '作为 P1 提醒注入，不安装守卫' },
              { label: '允许并装硬守卫（保护这条记忆）', id: 'approve+guard-self', description: '安装守卫：禁止删除/更新【这条记忆本身】（防误删/误改；可在 /guard 移除）' },
              { label: '拒绝', id: 'reject', description: '不写入' },
            ],
          })
          if (gOk === 'reject') return { saved: false, cancelled: true, message: '已取消：用户未批准新增这条项目记忆。' }
          if (gOk === 'approve+guard-self') guardSelf = true
        } else {
          // 普通写入（无禁止语义目标）：同样加"允许并装硬守卫（保护这条记忆）"——用户主动想保护即可装（target=这条新记忆本身）。
          // GLM §4：普通写入 → protectSelf 让 askConfirm 建"允许并装硬守卫（保护这条记忆）"选项（approve+guard-self，目标=新记忆本身）。
          const gOk = await askConfirm(exec.agent, {
            header: '记忆修改确认',
            question: '允许新增这条项目记忆？',
            detail: confirmDetail + (obligation ? '（已识别为义务类常驻）' : '') + '；如需防止误删/误改，可选"保护这条记忆"。',
            protectSelf: true,
          })
          if (gOk === 'reject') return { saved: false, cancelled: true, message: '已取消：用户未批准新增这条项目记忆。' }
          if (gOk === 'approve+guard-self') guardSelf = true
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
        if (guardSelf) { mem.guard = { action: 'block_delete', target: { kind: 'memory', id: mem.id }, createdAt: new Date().toISOString(), blockedCount: 0 } }  // 保护这条记忆本身（TDZ 规避：mem 构建后赋值）
        const sk = `${cleanTitle} ${cleanDesc}`
        const dup = doc.memories.find(m => titleSimilarity(`${m.title} ${m.description}`, sk) >= 0.6)
        if (dup) {
          // 闸门④ 去重棘轮：高度相似的坑类记忆，确定性合并正文 + proofCount+1 升权
          const isProofable = dup.type === 'feedback' || dup.ttl === 'event'
          if (isProofable) {
            const mergedBody = organizedText(dup.body + '\n\n' + cleanBody)
            const bumped = { ...dup, body: mergedBody, proofCount: (dup.proofCount || 0) + 1, updatedAt: new Date().toISOString() }
            const memsAfterMerge = doc.memories.map(m => m.id === dup.id ? bumped : m)
            if (await writeThrough(cwd, memsAfterMerge))
            return jsonSafe({ saved: true, merged: true, memory: bumped, message: '发现相似记忆并合并（proofCount 已 +1）：' + dup.title })
          }
          return { saved: false, duplicate: true, similarMemory: dup, message: '发现高度相似的现有记忆，未写入。若为同一事实请用 memory_update 更新；若为新事实请使用更区分性的标题。' }
        }
        const taken = new Set(doc.memories.map(m => m.name).filter(Boolean))
        mem.name = makeMemorySlug(cleanTitle, taken, mem.id)
        const memsAfterWrite = [...doc.memories, mem]
        if (await writeThrough(cwd, memsAfterWrite))
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
        // 守卫可逆（GLM §4）：编辑记忆去掉禁止措辞 → 重派生后守卫消失（guard 字段删除，随 writeThrough 单点重建生效）
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
        if (await writeThrough(cwd, doc.memories))
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
        if (await writeThrough(cwd, doc.memories)) {
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
}
