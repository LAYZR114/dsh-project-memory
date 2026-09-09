// L3 规则守卫层：精简句（首注）+ memory_* 场景全量规则 + pre-execute 硬守卫（机制化）+ 底线记忆硬守卫（guard 字段）。
// 与 index.js 的分工：index.js 只负责"调"，规则文本/命中判定/注入文本全部收拢到本模块——
// 避免提示词文案散落多处漂移；纯函数（RULE_BRIEF/ruleFull/guardMemoryFile/proposeGuard/rebuildGuardTable/
// dragGuardCheck/removeGuardFromDoc）直接 export 供 selftest 覆盖。
// 接线（本模块不自行接线）：index.js 的 systemPrompt.context 首注用 brief；tools/pre-execute 硬守卫
// 改为调 guardCheck()（纯判定 dragGuardCheck + 内存守卫表）；memory_* 场景注入用 injectFull()。

// 记忆文件名（硬守卫判定的唯一目标，集中定义防止接线处写错）
export const MEMORY_FILE = '.dsh-memory.json'

// 精简句（首注）：照抄 index.js 现文（L57-61 project-memory-rules），接线后替换成 rule.brief。
export const RULE_BRIEF = '[项目记忆规则] 修改记忆仅经 memory_* 工具（走确认门）；禁止 write/edit/node 直改 .dsh-memory.json。改/删记忆时插件会注入完整规则。'

// 完整规则（含"为什么"）：memory_* 场景（改/删记忆）时全量注入，让 AI 理解机制而非背口令。
export function ruleFull() {
  return '[项目记忆规则·完整] 修改/删除项目记忆时，必须遵守：\n'
    + '1. 仅经 memory_write / memory_update / memory_delete 工具修改（每个操作走用户确认门：弹确认、用户批准才写入）。\n'
    + '2. 禁止用 write / edit / node / 脚本 直接改 ' + MEMORY_FILE + '。\n'
    + '3. 批量操作（多条增删改/合并）走 /memory export、/memory import 或 /memory merge，不绕道文件。\n'
    + '4. 改记忆同样计入待报告改动清单：收尾按表格报告文件绝对路径。\n'
    + '为什么：' + MEMORY_FILE + ' 是插件维护的结构化数据，插件在内存中缓存索引/热度/等级/待报清单；'
    + '外部直改会绕过确认门与索引同步两个机制，造成索引不一致（触发词→记忆错位）、多次叠加导致数据损坏与召回错乱。'
    + '只有 memory_* 工具能在"确认门 + 索引同步"下安全写入。'
}

// pre-execute 硬守卫（纯函数）：args={file_path?,path?,file?} 任一命中 .dsh-memory.json →
// 返回 {reject:true,message}（拒绝+纠正反馈）；未命中/参数缺失 → null（放行）。
// 判定与 index.js 旧内联版（L422-428）逐字兼容：indexOf 命中即为拦截，含 Windows 反斜杠路径。
// 用户手动改文件不受限：本守卫只挂在 AI 工具执行前（mechanism，不靠提示词）。
export function guardMemoryFile(args) {
  if (!args || typeof args !== 'object') return null
  const p = args.file_path || args.path || args.file
  if (typeof p !== 'string' || !p) return null
  if (String(p).indexOf(MEMORY_FILE) < 0) return null
  return {
    reject: true,
    message: `记忆文件 ${p} 仅限 memory_write/update/delete 工具修改（走确认门）；批量操作请用导出/导入。`,
  }
}

// =====================================================================
// 底线记忆 → 硬守卫机制（GLM 定稿 §1-§5；用户优化：代码识别，零失败模式）
// =====================================================================
// 关键语义区分（GLM §1）：只有【禁止语义】能装守卫；【义务语义】（必须/记得/每次）永远只走
// P1 提醒——义务无法机制化（拦不住"忘记跑测试"，只能拦"写 X"）。fake-guard 比没守卫更危险。
export const DENY_WORDS = ['禁止', '绝不', '严禁', '不得', '勿']
export const DUTY_WORDS = ['必须', '记得', '每次']   // 仅 obligation 检测（index.js OBLIGATION_RE），不触发守卫
// 动作由动词驱动（GLM §1 表）：删除→block_delete；修改/写/编辑→block_write；未识别→block_write
export const VERB_ACT = [
  ['删除', 'block_delete'], ['删', 'block_delete'], ['移除', 'block_delete'],
  ['修改', 'block_write'], ['改', 'block_write'], ['写', 'block_write'], ['编辑', 'block_write'],
]

// ---- 识别（纯函数，确定性，不靠 LLM 提案）：禁止语义 + 动作 + 目标解析 ----
// text：记忆正文（title+description+body 拼合）；docIds：现有记忆 id 集合（Set 或数组）。
// 返回：null（非禁止语义，不装守卫）/ {propose:false, reason}（禁止语义但无目标，诚实边界）/
//       {propose:true, guard:{action, target}}
// 目标优先级（GLM §3）：内存 id（mem-* 必须在 docIds 真实存在）> 引号路径 > 外围路径正则。
export function proposeGuard(text, docIds) {
  const src = String(text || '')
  if (!DENY_WORDS.some((w) => src.includes(w))) return null     // 非禁止语义 → 不装守卫（义务词永不提议）
  // mem id 必须真实存在于 doc（防止写一条引用不存在记忆的守卫）
  const ids = (docIds && typeof docIds.has === 'function') ? docIds : new Set((docIds || []).map((x) => (x && x.id) || x))
  const quoted = [...src.matchAll(/[“"]([^”"]{1,200})[”"]/g)].map((m) => m[1])
  const memId = [...src.matchAll(/mem-[a-z0-9-]{4,}/g)].map((m) => m[0])
    .find((id) => ids.has(id))
  const verb = VERB_ACT.find(([v]) => src.includes(v))
  let action = verb ? verb[1] : 'block_write'
  let target
  if (memId) { target = { kind: 'memory', id: memId }; if (action === 'block_write') action = 'block_update' }
  else {
    // 引号路径收紧（发现 bug 修）：引号内容必须"像路径"（后缀/盘符/斜杠）才算目标；普通引号词（如"该想起时想起"）跳过，
    // 防正文引号误当目标。外围路径正则兜底；仍无 → 诚实 propose:false（不装守卫）。
    const qPath = quoted.find((q) => /\.\w{1,6}$/.test(q) || /^[A-Za-z]:[\\\/]/.test(q) || /[\\/]/.test(q))
    if (qPath) target = { kind: 'path', value: qPath }
    else {
      const p = src.match(/[A-Za-z]:\\[^，。；"']+\.[a-z]+|\.[a-z]{2,4}(?=\s|$)/)   // 引号外的路径/后缀
      if (!p) return { propose: false, reason: '未识别出可执行的拦截目标' }           // 诚实边界：无目标不装
      target = { kind: 'path', value: p[0] }
    }
  }
  return { propose: true, guard: { action, target } }
}

// ---- 守卫表（GLM §5）：记忆 guard 字段 → 内存表 {action, target, sourceId, title, blockedCount} ----
// 拦截查询只查表不读盘；表由 writeDoc 后单点重建 + 启动时重建（用户优化：含已有守卫）。
export function rebuildGuardTable(doc) {
  if (!doc || !Array.isArray(doc.memories)) return []
  // 用户裁定（2026-09-09）：归档记忆=冗余/无用，就不该再挂着硬守卫（锁失效）。守卫载体只认 active。
  return doc.memories.filter((m) => m && m.guard && m.status !== 'archived').map((m) => ({
    action: m.guard.action,
    target: m.guard.target,
    sourceId: m.id,
    title: m.title,
    blockedCount: m.guard.blockedCount || 0,
  }))
}

// ---- 命中判定：记忆 id 精确 / 路径子串（已知限制：子串误伤，弹窗规格展示用户肉眼兜底）----
export function hitTarget(t, args) {
  if (!t) return false
  if (t.kind === 'memory') return !!(args && args['id'] === t.id)
  if (t.kind === 'path') return String((args && (args['file_path'] || args['path'])) || '').includes(t.value)
  return false
}

export const actLabel = (a) => ({ block_write: '禁止写入', block_update: '禁止更新', block_delete: '禁止删除' })[a] || a
export function targetLabel(t) {
  if (!t) return '?'
  if (t.kind === 'memory') return '记忆 ' + t.id
  return String(t.value || t.id || '?')
}
// deny 回显（GLM §5.2）：模型看得见为什么被拦（L3 转述：会转告用户）
// @fix user-delete-guard（GLM §7：守卫只约束 agent 永不约束用户）——删除类拦后指引用户走 /memory delete 命令
// （用户路径弹窗确认后解除守卫并删除）；写/更新类仍指向设置页 / /guard 移除。
export function guardDenyText(g, verb) {
  const userPath = verb === '删除'
    ? '。守卫约束 agent 不约束用户——请由用户执行 /memory delete <id|slug>，确认后即可解除守卫并删除'
    : '。如确需操作，请用户在设置页手动处理或在 /guard 移除该守卫'
  return `⛔ 已被硬守卫拦截：${verb} 目标 [${targetLabel(g.target)}] 被记忆「${g.title}」禁止${userPath}。`
}

// 用户侧删除守卫锁定记忆的弹窗确认文案（@fix user-delete-guard，GLM §7 不对称性修复）：
// AI 的 memory_delete 工具被 deny（hooks onPreExecute 硬守卫，现状保留）；用户经 /memory delete 命令
// 命中守卫时【不 deny、弹窗确认】：确认 → 解除守卫并删除；取消 → 保留。纯函数，测试可覆盖。
// g：守卫表行 {action,target,sourceId,title,blockedCount}（createRule.guardCheck 的 gd.hit 形状）。
export function userDeleteConfirmText(g) {
  const lockTitle = (g && g.title) || '禁止删除'
  return {
    question: `该记忆被「${lockTitle}」锁定，确定要删除吗？`,
    detail: `守卫：${actLabel('block_delete')} 目标 [${targetLabel((g && g.target) || { kind: 'memory', id: '?' })}]`
      + `（来源记忆「${lockTitle}」，已拦截 ${((g && g.blockedCount) || 0)} 次）。`
      + '守卫约束 agent 不约束用户——确定后解除守卫并删除该记忆。',
  }
}

// ---- 拦截判定（纯函数，可测）：dragGuardCheck(exec, table) ----
// exec：{name, arguments}（tools/pre-execute 的 exec 形状）；table：rebuildGuardTable(doc) 产物。
// ① 结构性基线（硬编码，永不依赖记忆记录——无守卫记忆时行为=现状）；
// ② 记忆派生守卫（block_write / block_delete / block_update，含记忆目标）。
// 返回：null（放行）/ {hit?:守卫行, text: deny 文案}（命中，守卫行供 blockedCount bump）。
export function dragGuardCheck(exec, table) {
  if (!exec) return null
  const nm = String(exec.name || '')
  const a = (exec && (exec.arguments || exec.args || {})) || {}
  const filePath = a['file_path'] || a['path'] || a['file']
  // ① 结构性基线：.dsh-memory.json 直改（硬编码，与 guardMemoryFile 判定逐字一致）
  if ((nm === 'write' || nm === 'edit' || nm === 'str_replace_editor') &&
      typeof filePath === 'string' && String(filePath).indexOf(MEMORY_FILE) >= 0) {
    return { text: `记忆文件 ${filePath} 仅限 memory_write/update/delete 工具修改（走确认门）；批量操作请用导出/导入。` }
  }
  // ② 记忆派生守卫
  for (const g of (table || [])) {
    if (g.action === 'block_write' && (nm === 'write' || nm === 'edit' || nm === 'str_replace_editor') && hitTarget(g.target, a)) {
      return { hit: g, text: guardDenyText(g, '写入') }
    }
    if (g.action === 'block_delete' && nm === 'memory_delete' && hitTarget(g.target, a)) {
      return { hit: g, text: guardDenyText(g, '删除') }
    }
    if (g.action === 'block_update' && nm === 'memory_update' && hitTarget(g.target, a)) {
      return { hit: g, text: guardDenyText(g, '更新') }
    }
  }
  return null
}

// ---- 可逆：从文档移除指定来源记忆的 guard 字段（/guard remove 用，纯函数）----
export function removeGuardFromDoc(doc, sourceId) {
  const mems = (doc && Array.isArray(doc.memories)) ? doc.memories : []
  const idx = mems.findIndex((m) => m && m.id === sourceId)
  if (idx < 0 || !mems[idx].guard) return { memories: mems, removed: false }
  const next = mems.slice()
  const m = { ...next[idx] }
  delete m.guard
  next[idx] = m
  return { memories: next, removed: true }
}

// 工厂：接线处注入 { store, readDocSync }（store 层，后续可在 injectFull 里读当前项目记忆上下文增强）；返回统一接口。
export function createRule({ store, readDocSync: readDocSyncOf } = {}) {
  // 守卫表状态（工厂闭包：拦截查询只查表不读盘；writeDoc 单点重建 + 启动/惰性重建）
  const guardTables = new Map()      // cwd -> Array<{action,target,sourceId,title,blockedCount}>
  const guardBaselines = new Map()   // cwd -> 历史最大守卫数（旧客户端 save 丢 guard 字段 → 下降告警）
  const lastDoc = new Map()          // cwd -> {memories}（bump 落盘免重复读盘用）
  let bumpCb = null                  // (cwd, sourceId, count) => void（blockedCount 落盘回执，index.js 注册一次）

  function rebuild(cwd, doc) {
    try {
      if (!cwd) return
      if (doc) lastDoc.set(cwd, doc)
      const t = rebuildGuardTable(doc)
      guardTables.set(cwd, t)
      // 基线只升不降：确保"旧客户端 save 丢 guard 字段 → 守卫数下降"能被 status 观测到；
      // 有意移除（/guard remove、memory_delete、新客户端 save）由 resetBaseline 显式刷新。
      const b = guardBaselines.get(cwd)
      if (b === undefined) guardBaselines.set(cwd, t.length)
      else if (t.length > b) guardBaselines.set(cwd, t.length)
    } catch (e) { /* 重建失败不阻塞 */ }
  }
  function ensureGuardTable(cwd) {
    if (!cwd || guardTables.has(cwd)) return
    let doc = null
    try { doc = typeof readDocSyncOf === 'function' ? readDocSyncOf(cwd) : null } catch (_) {}
    if (doc) rebuild(cwd, doc)
    else guardTables.set(cwd, [])
  }
  function guardsOf(cwd) {
    ensureGuardTable(cwd)
    return guardTables.get(cwd) || []
  }
  function baselineOf(cwd) {
    ensureGuardTable(cwd)
    return guardBaselines.has(cwd) ? guardBaselines.get(cwd) : (guardTables.get(cwd) || []).length
  }
  function resetBaseline(cwd) { guardBaselines.set(cwd, (guardTables.get(cwd) || []).length) }

  // 拦截入口（hooks/legacy 监听器调用）：ensure 表 → 纯 dragGuardCheck。守卫状态在工厂，拦截零读盘。
  function guardCheck(exec, cwd) {
    try {
      ensureGuardTable(cwd)
      return dragGuardCheck(exec, guardTables.get(cwd) || [])
    } catch (e) { return null }
  }

  // 审计回执：blockedCount+1（内存表即时生效；落盘经 bumpCb——index.js 注册 writeDoc 持久化）
  function bumpBlocked(cwd, sourceId) {
    try {
      const t = guardTables.get(cwd) || []
      const e = t.find((x) => x.sourceId === sourceId)
      if (!e) return
      e.blockedCount = (typeof e.blockedCount === 'number' ? e.blockedCount : 0) + 1
      if (typeof bumpCb === 'function') { try { bumpCb(cwd, sourceId, e.blockedCount) } catch (_) {} }
    } catch (e) { /* 回执失败不阻塞拦截 */ }
  }
  function onGuardBump(cb) { bumpCb = typeof cb === 'function' ? cb : null }

  function injectFull(cwd) {
    // memory_* 场景：注入完整规则（含"为什么"）。文本由 ruleFull() 确定（纯函数，测试可覆盖）；
    // store 预留：后续接线可用 store 读当前项目记忆（如检查是否已有同类规则记忆）再决定注入细节。
    return { cwd, text: ruleFull() }
  }
  return {
    brief: RULE_BRIEF, full: ruleFull, guard: guardMemoryFile, injectFull,
    // 守卫机制（GLM §1-§5）接口：
    proposeGuard,              // 识别：禁止语义 → {propose, guard}（纯函数转发）
    dragGuardCheck,            // 纯判定（供 selftest）
    userDeleteConfirmText,     // 用户侧删除守卫锁定记忆的弹窗文案（@fix user-delete-guard，纯函数）
    rebuild, guardsOf, baselineOf, resetBaseline, guardCheck, bumpBlocked, onGuardBump,
  }
}

// ---- selftest：识别/守卫生成/拦截/可逆 断言（node 直跑）----
// 运行：node -e "import('./lib/rule.js').then(m=>{const r=m.selfTest();console.log(JSON.stringify(r,null,2));process.exit(r.ok?0:1)})"
export function selfTest() {
  const results = []
  const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: String(extra || '') })
  const now = new Date().toISOString()

  // ---- 识别（proposeGuard）----
  const ids = new Set(['mem-aaa111', 'mem-bbb222'])
  let p = proposeGuard('禁止删除 mem-aaa111（核心设计结论，删了历史就断了）', ids)
  check('禁止+内存id → block_delete(记忆)', p && p.propose === true && p.guard.action === 'block_delete'
    && p.guard.target.kind === 'memory' && p.guard.target.id === 'mem-aaa111', JSON.stringify(p))
  p = proposeGuard('严禁修改 mem-bbb222', ids)
  check('严禁+修改+内存id → block_update', p && p.propose && p.guard.action === 'block_update'
    && p.guard.target.id === 'mem-bbb222', JSON.stringify(p))
  p = proposeGuard('绝不编辑 "src\\config.json"', ids)
  check('绝不+编辑+引号路径 → block_write(path)', p && p.propose && p.guard.action === 'block_write'
    && p.guard.target.kind === 'path' && p.guard.target.value === 'src\\config.json', JSON.stringify(p))
  p = proposeGuard('不得修改 D:\\Agent共享\\config.json', ids)
  check('不得+外围路径 → block_write(path)', p && p.propose && p.guard.action === 'block_write'
    && p.guard.target.kind === 'path' && p.guard.target.value.indexOf('config.json') >= 0, JSON.stringify(p))
  p = proposeGuard('必须记得修改 config.json 后跑测试', ids)
  check('义务语义(必须) → null 不装守卫', p === null, JSON.stringify(p))
  p = proposeGuard('每次写完代码都要跑测试', ids)
  check('义务语义(每次) → null', p === null, JSON.stringify(p))
  p = proposeGuard('禁止这件事做得太随意', ids)
  check('禁止但无目标 → propose:false', p && p.propose === false && /未识别/.test(p.reason), JSON.stringify(p))
  p = proposeGuard('禁止删除 mem-not-exist（不存在于 doc）', ids)
  check('mem id 不存在 → 不按记忆目标（诚实边界）', p && (p.propose === false || p.guard.target.kind !== 'memory'), JSON.stringify(p))
  p = proposeGuard('请勿打扰', ids)
  check('勿+无目标 → propose:false', p && p.propose === false, JSON.stringify(p))
  check('DUTY_WORDS 不在 DENY_WORDS', !DUTY_WORDS.some((w) => DENY_WORDS.includes(w)), '')
  check('动词表动作均为三值枚举（block_update 由记忆目标派生）', VERB_ACT.every(([v, a]) => ['block_write', 'block_update', 'block_delete'].includes(a)), '')

  // ---- 守卫表（rebuildGuardTable）----
  const g1 = { id: 'mem-aaa111', title: '禁止删除记忆A', description: 'd', body: 'b',
    type: 'project', status: 'active', heat: 0, timestamp: now, updatedAt: now, createdAt: now, name: 'g1',
    guard: { action: 'block_delete', target: { kind: 'memory', id: 'mem-bbb222' }, createdAt: now, blockedCount: 2 } }
  const g2 = { id: 'mem-bbb222', title: '禁止写 config', description: 'd', body: 'b',
    type: 'project', status: 'active', heat: 0, updatedAt: now, createdAt: now, name: 'g2',
    guard: { action: 'block_write', target: { kind: 'path', value: 'config.json' }, createdAt: now } }
  const plain = { id: 'mem-ccc333', title: '普通记忆', description: 'd', body: 'b', type: 'project', status: 'active', heat: 0, updatedAt: now, createdAt: now, name: 'g3' }
  const doc = { version: 2, memories: [g1, g2, plain] }
  const table = rebuildGuardTable(doc)
  check('守卫表只含 guard 字段记忆', table.length === 2, table.length)
  check('表含 action/target/sourceId/title/blockedCount', table[0].action === 'block_delete'
    && table[0].target.id === 'mem-bbb222' && table[0].sourceId === 'mem-aaa111'
    && table[0].blockedCount === 2 && table[0].title === '禁止删除记忆A', JSON.stringify(table[0]))
  check('被守卫的记忆本身(guard 载体)可另被拦', table[0].target.kind === 'memory' && table[0].target.id !== table[0].sourceId, '')

  // ---- 命中（dragGuardCheck）----
  let d = dragGuardCheck({ name: 'memory_delete', arguments: { id: 'mem-bbb222' } }, table)
  check('block_delete 命中记忆目标 → deny', d && d.hit && d.hit.sourceId === 'mem-aaa111' && /硬守卫拦截/.test(d.text), JSON.stringify(d && d.text))
  d = dragGuardCheck({ name: 'memory_delete', arguments: { id: 'mem-ccc333' } }, table)
  check('删其他记忆 → 放行', d === null, JSON.stringify(d))
  d = dragGuardCheck({ name: 'memory_update', arguments: { id: 'mem-bbb222' } }, table)
  check('block_delete 不拦 memory_update → 放行', d === null, JSON.stringify(d))
  d = dragGuardCheck({ name: 'write', arguments: { file_path: 'D:\\proj\\config.json' } }, table)
  check('block_write 路径子串写 config.json → deny', d && d.hit && d.hit.sourceId === 'mem-bbb222' && /写入/.test(d.text), JSON.stringify(d && d.text))
  d = dragGuardCheck({ name: 'write', arguments: { file_path: 'D:\\proj\\other.txt' } }, table)
  check('写其他文件 → 放行', d === null, JSON.stringify(d))
  d = dragGuardCheck({ name: 'memory_delete', arguments: { id: 'mem-bbb222' }, }, [])
  check('空守卫表 memory_delete 放行（派生守卫只查表）', d === null, JSON.stringify(d))
  d = dragGuardCheck({ name: 'write', arguments: { file_path: 'D:\\proj\\.dsh-memory.json' } }, table)
  check('结构性基线：直改 .dsh-memory.json → deny（不依赖守卫表）', d && !d.hit && /记忆文件/.test(d.text), JSON.stringify(d && d.text))
  d = dragGuardCheck({ name: 'write', arguments: { file_path: 'D:\\proj\\.dsh-memory.json.bak' } }, [])
  check('基线不误伤 .dsh-memory.json.bak? 子串命中即拦（同旧判定）', d && /记忆文件/.test(d.text), JSON.stringify(d && d.text))
  // ---- 用户侧删除确认文案（@fix user-delete-guard：GLM §7 用户不被守卫约束）----
  const uc = userDeleteConfirmText(table[0])
  check('userDeleteConfirmText 弹窗含锁定标题+确定+解除语义',
    uc && /锁定/.test(uc.question) && /确定要删除吗/.test(uc.question) && /解除守卫/.test(uc.detail),
    JSON.stringify(uc))
  // deny 回显对删除类指引用户命令（区分 AI 工具 deny / 用户命令确认）
  const dt = guardDenyText(table[0], '删除')
  check('guardDenyText(删除) 指引 /memory delete 命令', dt && dt.indexOf('/memory delete') >= 0, dt)

  // ---- 可逆（removeGuardFromDoc + 重派生）----
  const r = removeGuardFromDoc(doc, 'mem-bbb222')
  check('remove 删除 guard 字段', r.removed === true && !r.memories.find((m) => m.id === 'mem-bbb222').guard, '')
  check('remove 后重派生守卫消失', rebuildGuardTable({ version: 2, memories: r.memories }).length === 1, '')
  const r2 = removeGuardFromDoc(doc, 'mem-not-exist')
  check('remove 不存在 → removed:false 原样', r2.removed === false, '')

  // ---- 工厂（guardCheck/guardsOf/bumpBlocked）----
  const R = createRule()
  R.rebuild('C:\\x', doc)
  check('工厂 guardsOf', R.guardsOf('C:\\x').length === 2, R.guardsOf('C:\\x').length)
  d = R.guardCheck({ name: 'memory_delete', arguments: { id: 'mem-bbb222' } }, 'C:\\x')
  check('工厂 guardCheck 命中', d && d.hit && d.hit.sourceId === 'mem-aaa111', JSON.stringify(d))
  R.bumpBlocked('C:\\x', 'mem-aaa111')
  check('bumpBlocked blockedCount+1', R.guardsOf('C:\\x')[0].blockedCount === 3, R.guardsOf('C:\\x')[0].blockedCount)
  let bumped = null
  R.onGuardBump((cwd, sid, count) => { bumped = { cwd, sid, count } })
  R.bumpBlocked('C:\\x', 'mem-aaa111')
  check('onGuardBump 回执', bumped && bumped.sid === 'mem-aaa111' && bumped.count === 4, JSON.stringify(bumped))
  check('baseline 只升', R.baselineOf('C:\\x') === 2, R.baselineOf('C:\\x'))

  return { ok: results.every((r) => r.ok), total: results.length, failed: results.filter((r) => !r.ok), results }
}
