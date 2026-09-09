// L1 常驻元层：画像+状态+催办+心跳——每步渲染（系统提示每步重组，无 step 门控），首步恒有（同步镜像+存根）。
// createFirst({ store, getPending }) → { renderFirst(cwd), syncMirror(cwd, mems, profileText), ensureWarm(cwd), getFirstCache(cwd), isStuck(cwd) }
// store：createStore 实例（只用 readDoc 做预热读盘）；getPending：(cwd)=>pendingChanges.get(cwd)（催办=同步 Map，来自 index.js pendingChanges，注入）。
// 首注恒有三层：① ensureWarm 在 apply 预热时读盘同步构建镜像（首步尽量真身）；② syncMirror 在 writeDoc 成功后单点维护
//            （不读盘不节流，writeDoc 后 memories 已提供）；③ 镜像空/未就绪 → 存根【预热中】段（绝不出空段），第 2 防线。

// 存根超 1 turn 判定兜底阈值（按时间折算 1 turn ≈ 3 分钟；主信号是 warmFails≥2，即两轮预热周期仍无真身）。
export const WARM_TURN_MS = 3 * 60 * 1000
// 存根渲染文本（第 2 防线固定文案）
export const STUB_STATE = '📌 红线/规则×N 随场景生效·预热中'

// ---- sortUser：pinned > proofCount > 新近度（与 index.js renderT0Text 内 sortUser 逐字一致——照抄而非双维护）----
export function sortUser(arr) {
  return arr.slice().sort((a, b) => {
    const pa = a.pinned === true ? 1 : 0, pb = b.pinned === true ? 1 : 0
    if (pa !== pb) return pb - pa
    const ca = a.proofCount || 0, cb = b.proofCount || 0
    if (ca !== cb) return cb - ca
    return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)
  })
}

// ---- 纯函数（export 供 selftest）----
// 画像行：type:user 且非 archived；sortUser（pinned>proof>新近）；≤8 行截断（与 index.js 画像档同规）
export function profileRows(mems) {
  const users = (mems || []).filter((m) => m.type === 'user' && m.status !== 'archived')
  return sortUser(users).slice(0, 8).map((m) => `- ${m.title}：${m.description}`)
}
// 当前状态行：type:state 第一条的 description（缺省用 title）
export function stateRow(mems) {
  const s = (mems || []).find((m) => m.type === 'state' && m.status !== 'archived')
  return s ? (s.description || s.title || '') : ''
}
// 心跳行：redCount=obligation‖pinned；permCount=ttl permanent 且非 P1（obligation/pinned）且非 user
export function heartbeatLine(mems) {
  const list = mems || []
  const redCount = list.filter((m) => m.obligation === true || m.pinned === true).length
  const permCount = list.filter((m) => m.ttl === 'permanent' && m.obligation !== true && m.pinned !== true && m.type !== 'user').length
  return `📌 ${redCount} 条红线/规则 + ${permCount} 条常设知识随场景自动生效（改文件/改记忆/涉及话题时自动提醒）`
}
// 催办文本（延迟汇总）：【催办】段头 + 计数 + 前 2 路径示例；无则 ''（长度≥1 才出段，绝不出空段）
function pendingText(pend) {
  const list = pend || []
  if (!list.length) return ''
  return `【催办】\n📋 待报告改动：${list.length} 项（每次改文件后累积，完成对话任务时汇总表格报告）\n`
    + list.slice(0, 2).map((x) => `  - ${x.path}`).join('\n')
}
// 拼装 L1：画像+状态+催办+心跳。stub=true → 存根（预热中/未就绪），每段都有非空内容。
export function renderFirstText(p, s, pend, hb, stub) {
  const parts = []
  if (stub) {
    parts.push('【用户画像】\n📌 画像同步中·预热中（首步恒有，镜像就绪后替换）')
    parts.push('【当前状态】\n' + STUB_STATE)
  } else {
    parts.push(p ? ('【用户画像】\n' + p) : '【用户画像】\n- （暂无 type:user 画像记忆）')
    parts.push(s ? ('【当前状态】\n' + s) : '【当前状态】\n- （无）')
  }
  const pt = pendingText(pend)
  if (pt) parts.push(pt)
  parts.push(hb ? ('【心跳】' + hb) : '【心跳】📌 预热中：红线/规则与常设知识随场景自动生效')
  return parts.join('\n\n')
}

// ---- createFirst：工厂（非纯，缓存闭包内；注入 store + getPending）----
export function createFirst({ store, getPending, readDocSync } = {}) {
  const firstCache = new Map() // cwd -> { profileText, stateText, heartbeat, at, stubCount, ready, warmFails }
  const triedSync = new Set()  // syncWarm 每启动每 cwd 只试一次（防止 renderFirst 每步重试同步读）

  const readDocOf = (cwd) => (store && typeof store.readDoc === 'function')
    ? store.readDoc(cwd)
    : Promise.resolve({ version: 2, memories: [] })

  // 首步真身：同步读盘一次（DSH assemble 先于 pre-step + context text 同步-only——首步唯一路径=同步读）。
  // 失败/无文件 → 现有存根 + isStuck（零回归）；triedSync 防每步重试。
  function syncWarm(cwd) {
    if (!cwd || triedSync.has(cwd)) return
    triedSync.add(cwd)
    try {
      if (typeof readDocSync === 'function') {
        const doc = readDocSync(cwd)
        syncMirror(cwd, doc && doc.memories)
      } else {
        const cur = firstCache.get(cwd)
        firstCache.set(cwd, {
          profileText: '', stateText: '', heartbeat: '',
          at: Date.now(), stubCount: (cur && cur.stubCount || 0) + 1, ready: false,
          warmFails: (cur && cur.warmFails || 0) + 1,
        })
      }
    } catch (e) {
      const cur = firstCache.get(cwd)
      firstCache.set(cwd, {
        profileText: '', stateText: '', heartbeat: '',
        at: Date.now(), stubCount: (cur && cur.stubCount || 0) + 1, ready: false,
        warmFails: (cur && cur.warmFails || 0) + 1,
      })
    }
  }

  // apply 预热：读 doc 同步构建镜像（首步尽量真身，存根第 2 防线）。读失败 → 存根条目 + warmFails（isStuck 信号）。
  async function ensureWarm(cwd) {
    if (!cwd) return
    try {
      const doc = await readDocOf(cwd)
      syncMirror(cwd, doc.memories)
    } catch (e) {
      const cur = firstCache.get(cwd)
      firstCache.set(cwd, {
        profileText: '', stateText: '', heartbeat: '',
        at: Date.now(), stubCount: (cur && cur.stubCount || 0) + 1, ready: false,
        warmFails: (cur && cur.warmFails || 0) + 1,
      })
    }
  }

  // writeDoc 成功后同步更新镜像（单点维护：不读盘不节流——writeDoc 后 memories 已由调用方提供）。
  // profileText 可选：外部已有更完整画像文本（如 T0 档）时直接注入，否则从 memories 算；未就绪（非数组）→ 存根。
  function syncMirror(cwd, memories, profileText) {
    if (!cwd) return
    if (!Array.isArray(memories)) {
      const cur = firstCache.get(cwd)
      firstCache.set(cwd, {
        profileText: '', stateText: '', heartbeat: '',
        at: Date.now(), stubCount: (cur && cur.stubCount || 0) + 1, ready: false,
        warmFails: (cur && cur.warmFails || 0) + 1,
      })
      return
    }
    const p = typeof profileText === 'string' ? profileText : profileRows(memories).join('\n')
    const s = stateRow(memories)
    firstCache.set(cwd, {
      profileText: p, stateText: s, heartbeat: heartbeatLine(memories),
      at: Date.now(), stubCount: 0, ready: true, warmFails: 0,
    })
  }

  // 渲染 L1：画像+状态+催办+心跳。镜像空/未就绪 → 先 syncWarm（首步真身——同步读一次），仍不 ready → 存根（绝不出空段）。
  function renderFirst(cwd) {
    if (!cwd) return ''
    let e = firstCache.get(cwd)
    if (!e || !e.ready) syncWarm(cwd) // 首步：同步读构建镜像（triedSync 防每步重试）
    e = firstCache.get(cwd)
    if (!e) {
      firstCache.set(cwd, {
        profileText: '', stateText: '', heartbeat: '',
        at: Date.now(), stubCount: 1, ready: false, warmFails: 0,
      })
      e = firstCache.get(cwd)
    }
    const stub = !e.ready
    e.stubCount = stub ? (e.stubCount || 0) + 1 : 0
    const pend = typeof getPending === 'function' ? (getPending(cwd) || []) : []
    return renderFirstText(e.profileText, e.stateText, pend, e.heartbeat, stub)
  }

  function getFirstCache(cwd) { return firstCache.get(cwd) }

  // 存根超 1 turn → 'warming-too-long'（capabilityReport 上报）。主信号 warmFails≥2（≥2 轮预热失败）；
  // 兜底按时间（存根条目存在超 WARM_TURN_MS）。ready 真身在 → 不报告。
  function isStuck(cwd) {
    const e = firstCache.get(cwd)
    if (!e || e.ready) return ''
    if ((e.warmFails || 0) >= 2 || Date.now() - (e.at || 0) > WARM_TURN_MS) return 'warming-too-long'
    return ''
  }

  return { renderFirst, syncMirror, ensureWarm, syncWarm, getFirstCache, isStuck }
}
