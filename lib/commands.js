// 轻量化·批次D：/memory 与 /guard 命令面。
// 只搬移不重写——本文件逐字取自原 index.js L1676-2029；闭包依赖经 deps 注入
// （registerCommands(deps) 由 index.js apply 调用；共享层 + 写路径铁律留在 index.js）。
// 返回 { success/error, text } 的 handler 形状与原实现完全一致。
export function registerCommands(deps) {
  const {
    commands, ensureCwd, readDoc, activeOnly, pollCompaction, pendingChanges,
    rl, buildCapabilityReport, recallMemory, requireApproval, askConfirm,
    writeThrough, addPending, absPath, MEMORY_FILE, titleSimilarity, newId,
    organizedText, makeMemorySlug, userDeleteConfirmText, removeGuardFromDoc,
    actLabel, targetLabel, scoreRareTopic,
  } = deps

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
        if (await writeThrough(cwd, mems))
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
      const okRemove = await askConfirm(agent, {
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
      if (await writeThrough(cwd, r.memories))
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
              const rerankNote = deps.diagLastRoute ? '' : `\n# 检索精排\n- 精排未启用：未配置模型路由（设置中可填 provider/model）；当前为词法粗糙筛（IDF 召回）。`
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
              if (await writeThrough(cwd, doc.memories))
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
                const uOk = await askConfirm(inv.agent, {
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
                if (await writeThrough(cwd, mems)) {
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
              if (await writeThrough(cwd, doc.memories))
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
              if (await writeThrough(cwd, memsAfterAdd))
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
                if (await writeThrough(cwd, memsAfterState))
                addPending(cwd, MEMORY_FILE, absPath(cwd, MEMORY_FILE), '记忆修改(命令:状态快照)')
                return { kind: 'success', text: `已更新状态快照: ${desc}` }
              }
              const mem = { id: newId(), name: 'state-current', title: '当前项目状态', description: desc, type: 'state', body: organizedText(text), scope: 'project', status: 'active', heat: 0, ttl: 'permanent', triggers: [], obligation: false, pinned: false, proofCount: 0, phase: null, createdAt: now, updatedAt: now }
              const memsAfterState = [...doc.memories, mem]
              if (await writeThrough(cwd, memsAfterState))
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
}
