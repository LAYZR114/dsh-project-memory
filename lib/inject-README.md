# 注入重做 · README（北极星记忆·项目记忆注入模块）

> 日期：2026-09-09
> 定位：注入从"T0 每轮全量 + T1 命中即注入"重做为"L1 常驻元层 + L2 场景触发 + L3 规则守卫"。从起点重写（非补丁），GLM 定稿《注入模块重写》。

## 分层

| 层 | 文件 | 职责 |
|---|---|---|
| L1 常驻元层 | `lib/first.js` | 【用户画像】+【当前状态】+【催办】+【心跳】——每步渲染（系统提示每步重组）；首步恒有（同步镜像 firstCache + 存根"预热中"绝不出空段）；writeDoc 后 syncMirror 单点维护 |
| L2 场景触发 | `lib/scene.js` | detectScene 四源归一（file 域 > memory_* > bash/pwsh 行为 > 话语倒排）→ deriveLevel（P1=obligation‖pinned / P2=ttl permanent,phase / P3=其余）→ extractFragment（title+命中行+[来源:slug]，不注 body）→ cap3 去重 → renderScene（P1 红线恒置顶）；读类只清旧行为行（不清话题片段） |
| L3 规则守卫 | `lib/rule.js` | RULE_BRIEF（首注精简句）/ ruleFull（memory_* 场景全量，含"为什么"）/ guardMemoryFile（pre-execute 拦直改 .dsh-memory.json → 结构性基线）/ **硬守卫机制**（GLM 定稿 §1-§5）：proposeGuard 纯代码识别（只认禁止语义；义务语义永不提议）→ 三选项弹窗授权（allow/allow+guard/reject）→ guard 字段进记忆（零 schema）→ rebuildGuardTable 内存派生表（writeDoc 单点重建 + 启动重建）→ guardCheck 拦截（deny 优先于 approval，`{kind:'deny', reason}` 契约定型）→ bumpBlocked 审计回执 + /memory guard list|remove（二次确认，可逆） |
| L4 编排 | `lib/hooks.js` | 唯一接触 ctx：registerContext（t0 L1+场景 / rules 精简句；profile 并入 t0 防×2）+ 三监听器（pre-step/pre-execute/post-execute）编排 |
| 复用 | `lib/store.js` | readDoc（含损坏备份）/ writeDoc / enrichMemory / buildInvert / SCENE_DOMAINS / activeOnly / scoreMemory 等纯函数核（逐字复用，签名不变） |

## 数据流

```
pre-step（话语）──┐
pre-execute（file/memory/bash）─┼→ scene.plan({cwd,tool,filePath,input,doc,invert}) 单一写入点
                   │              → {source,domain,ids,scenes,behavior}
写路径（memory_*/命令/RPC save）→ writeDoc → fr.syncMirror（首注镜像）
post-execute（write/edit/memory_/命令快照）→ pendingChanges（待报告改动）
t0 context（每步 assemble）→ first.renderFirst + injectedCache（场景/行为/规则全量）
```

## injectMode 语义

- `scenario`（默认）：L1 常驻元层 + L2 场景触发 + L3 守卫——每轮 O(1)。
- `legacy-full`：**实现=旧路径金丝雀**（旧 t0【必须遵守】【常设】全量 + 旧 detectHits/sceneInject 漏斗），**保留至切换验证后删除**。**注意**：非"新渲染器全量模式"（GLM §7 语义澄清——真 full 策略应由 hooks.js 实现，勿借旧分支）。

## 知识页定位（GLM §6）

- buildPages / pagesCache（「本项目已验证的坑」「用户红线与偏好」「关键决策与结论」）：**设置页浏览/导出工件 + recall 辅助**；**L1 不渲染页面**（与画像唯一常驻一致）；场景注入按记忆条目走（页是浓缩缓存，不作为注入源）。
- client.js 目前只调 `/list /save`，未接 pages。

## 重做笔记（接线状态 / 已知项）

- **接线**：index.js 顶部 import 5 个 create*；apply 内装配（createStore/createFirst/createScene/createRule/createHooks）+ injectMode 分流 + 11 处 syncMirror；旧路径金丝雀保留（legacy-full 守卫）。
- **enqueueRefresh**：占位空回调（store 的 refresh 路径当前无人调用；镜像刷新靠 syncMirror 单点）——留作将来级联刷新入口。
- **已知修复**：read-clear（hooks onPreExecute 加 read cat）；js/ts 词边界（scene.js 域匹配，'js'⊄'json'）；injectionMode 生效值（index.js 旧 renderT0Text 208 用 injectionMode 非配置常量）。
- **验收**（GLM §9）：首注恒有（冷启动存根→真身≤1turn）/ 场景注入（读零注入、edit 域≤3 带 [P·级] 溯源、memory_* 全量规则）/ 硬守卫 reject / injectMode 两模式 / 工具 RPC 回归 / 数据完好。

## 回退

- Config `injectMode: 'legacy-full'` + 重启宿主 → 旧路径金丝雀。

## 自测

- `node lib/scene.js`（selfTest 31 断言）/ store/first/rule 冒烟；`node --test`（roundtrip/m4-recall/guard）。
- 硬守卫：`node -e "import('./lib/rule.js').then(m=>{const r=m.selfTest();console.log(JSON.stringify(r,null,2));process.exit(r.ok?0:1)})"`（识别/守卫表/拦截/可逆 30 断言）。
