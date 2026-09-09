# 压缩协同·候选提炼 —— 通道 B 调试报告（交 GLM 评审）

## 一、目标（M3 首交付）
在 DSH 的「项目记忆」插件里实现**压缩协同·候选提炼**：检测到一次会话压缩（compaction）检查点后，用 `ctx.llm` 从压缩摘要里提炼 ≤5 条候选记忆，确定性去重后落盘为 `status:'candidate'`（隔离舱，不进 T0 索引，待设置页评审后才转 active）。

插件是 Cordis 插件（`export function apply(ctx)` + `export const inject`），宿主半运行在 DSH Node 进程，通过 inject 声明的服务（tools/commands/fs/webServer/agents/approval/userQuestions/systemPrompt）+ `ctx.get('llm')` 可选 seam 工作。遵循「探测→退化→上报」：任何可选能力缺失/抛错都静默降级，不丢功能，`capabilityReport` 上报当前状态。

## 二、通道选择：从 A 到 B
**通道 A（被放弃，已证实架构性死路）**：监听 `session/event`。实验证据：
- 注册后 `diagListenerRegistered=false`，`session/event` 事件计数为 0，即使真实 `/compact` 触发压缩（截图确认 80 条 / ~48791 tokens 被压缩）也收不到。
- **根因**：dsh-session 的 `session.append()` 通过 **agent-scoped `emitCtx`** 发布事件（`dsh-session/lib/types/index.js` 564-569 行用 `collectSessionCallbacks(entry.emitCtx, ['session/event', ...])` + `invokeContainedSessionObservers(entry.emitCtx, 'session/event', ...)`）。这是 **scope-filtered dispatch**：宿主级全局插件监听器不在任何 agent 的 `emitCtx` 里，所以永远收不到。这是架构问题，改代码无法绕开。
- 补充：`SessionEventMap`（类型层 union，作为 `session/event` 监听器签名）**不含** compaction 类型；运行时 `session.append("compaction/summary", ...)` 确实发射（`dsh-compaction-basic/lib/index.js:592`），但宿主级监听器受 scope-filtered dispatch 阻挡，仍收不到。

**通道 B（采纳）**：从宿主级 `agent/pre-step` 触发，增量轮询 `agent.session.snapshotEvents()` 扫 `compaction/summary`。
- `agent/pre-step` 已被本插件可靠使用（`payload.agent` 可读，行为检测/系统提示注入都靠它，`inputDetection: pre-step`、`behaviorDetection: pre-execute` 都为 ok），证明宿主级可订阅、能拿到 agent。
- 监听器里拿到 `payload.agent`，读 `agent.session`，调 `session.snapshotEvents(fromSeq, toSeqExclusive)` 增量拉事件，筛 `type === 'compaction/summary' && ev.data`，取 `ev.data.summary`（ContentBlock[]）拼文本，复用 `handleCompactionSummary` 提炼。
- 进度记账：`pollLastSeq`（sessionId → 已扫 seq），首次全量，后续 `last+1` 起。

## 三、本次调试的核心发现：诊断仪表被静态快照冻结（已修复）

### 现象
重启 DSH 后 `/memory status` 与 `/compact` 之后，**`diagPollScans: 0`**（base 和 post-compact 都是 0）。这暗示 `pollCompaction` 从未执行过，与预期不符（pre-step 每步都应触发它）。

### 真正根因——不是 poll 没跑，而是**诊断字段从不更新**
`capabilityReport` 是 `apply` 作用域里的 **`const` 对象，在插件装载时一次性创建**：
```js
const capabilityReport = {
  ...
  diagPollScans: diagPollScans,       // 对象创建那一刻把 let 变量的"当前值"（=0）拷贝进属性
  diagPollCompaction: diagPollCompaction,
  diagPollCompactionText: diagPollCompactionText,
}
```
`diagPollScans` 是 `let` 变量，`pollCompaction` 用 `diagPollScans++` 改它。但 `capabilityReport.diagPollScans` 这个**对象属性在创建时已经把 0 拷走了**，poll 之后改的是那个 `let` 变量，属性里的值**永远不会变**，永远停在 0。

`/memory status` 用 `Object.entries(capabilityReport)` 输出诊断（index.js:1072），HTTP 路由也返回同一个对象（list/status）。所以无论 poll 是否真的跑了，`diagPollScans` 都显示 0 —— **一个假 0，误导了判断**。

> 之前误以为「capabilityReport 是 const 对象 + 闭包引用 let 变量会实时反映」，这个假设是**错的**：对象属性是值拷贝，不是 getter/引用。

### 修复
把静态快照改为**每次读取实时构建**：
- 引入 `let compactionCaptureVal`（词法持久结果，handle/persist 路径写 `no-llm`/`degraded`/`ok`；`''` 表示尚未进入提炼路径）。
- 新增 `buildCapabilityReport()` 函数，每次调用现场读 `let diagPollScans / diagPollCompaction / diagPollCompactionText / hasCompactionDetect / compactionCaptureVal`，返回新对象。
- 三个读点改用 `buildCapabilityReport()`：`/memory status`（Object.entries）、HTTP `list`、HTTP `status`。
- 删除旧 `const capabilityReport` 死对象，避免误导。
- 三处旧写入 `capabilityReport.compactionCapture = '...'` 改为写 `compactionCaptureVal = '...'`。

`compactionCapture` 的取值逻辑（build 时推导）：
```
if llm 不可用(无 stream)          -> 'no-llm'
else if compactionCaptureVal 非空 -> compactionCaptureVal（ok/degraded/no-llm，已被提炼路径写入）
else if hasCompactionDetect       -> 'ok'
else if diagPollScans > 0         -> 'polling'
else                              -> 'no-poll'
```

### 判读表（修复后）
| diagPollScans | diagPollCompaction | compactionCapture | 含义 |
|---|---|---|---|
| 0 | 0 | no-poll | poll 从未执行（pre-step 没触发 / agent.session 不可读 / cwd 为假） |
| >0 | 0 | polling | poll 已跑，但还没扫到 compaction/summary |
| >0 | ≥1 | ok 或 polling | 已扫到压缩事件；若文本也进提炼并落盘则 upper 路径置 ok |

## 四、`pollCompaction` 实现要点
```js
// pollLastSeq: Map<sessionId(string), lastScanSeq>
async function pollCompaction(agent, cwd) {
  try {
    diagPollScans++
    const sess = agent && agent.session
    if (!sess || typeof sess.snapshotEvents !== 'function') return
    const sid = String(sess.id || '')
    const last = pollLastSeq.get(sid) || 0
    const events = sess.snapshotEvents(last === 0 ? 0 : last + 1)   // fromSeq 含
    let newLast = last
    for (const ev of events) {
      const seq = ev && typeof ev.seq === 'number' ? ev.seq : -1
      if (seq > newLast) newLast = seq
      if (ev && ev.type === 'compaction/summary' && ev.data) {
        diagPollCompaction++
        hasCompactionDetect = true
        const blocks = (ev.data.summary) || []
        const text = blocks.map((b) => (b && b.text) || '').filter(Boolean).join('\n')
        if (!text) continue
        diagPollCompactionText++
        handleCompactionSummary(cwd, text, ev).catch(() => {})   // 异步提炼，不阻断
      }
    }
    if (newLast > last) pollLastSeq.set(sid, newLast)
  } catch (e) { console.log('[project-memory] pollCompaction failed (no-op): ' + (e && e.message ? e.message : e)) }
}
```
- 挂在原 `agent/pre-step` 监听器里 `if (cwd) pollCompaction(agent, cwd).catch(() => {})`。
- 不阻断 step（异步 + 内部全 try/catch），失败无损。

## 五、待确认 / 下一步
1. **重启 DSH** 加载修复后的插件。
2. `/memory status` 看基准：若 `diagPollScans > 0` → 证实 poll 一直在跑、之前只是被静态快照骗了；若仍 0 → agent.session 不可读或 pre-step 没触发（需深挖）。
3. 触发 `/compact` 再 `/memory status`：`diagPollCompaction ≥ 1` → 扫到压缩事件；`compactionCapture: ok` → 全链路通（提炼+落盘 candidate）。

## 六、审阅焦点（请 GLM 验证）
- **根因判断是否成立**：`const capabilityReport` 对象属性在创建时冻结 `let` 值、后续自增反映不到属性——这个机制是否有例外（例如属性是 getter 或对象被 replace）？我们的代码里不是 getter，故应成立。
- **通道 B 在宿主级是否可靠**：`agent/pre-step` 是否在所有自定义 agent 上都派发（已有 `inputDetection` 依赖它并成功，倾向安全）。`agent.session.snapshotEvents` 是否所有 Session 实例都暴露（`cwdFromAgent` 用 `a.session.header.cwd` 已证明 `.session` 存在）。
- **时序**：`/compact` 触发压缩后，`compaction/summary` 事件是否真的 `append` 到同一个 agent 的 `log`（`snapshotEvents` 读 `this.log`），从而能被本轮/下轮 poll 扫到？还是压缩事件只存在于另一个 session/内存态？
