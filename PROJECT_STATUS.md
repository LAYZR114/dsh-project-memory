# 项目记忆插件 —— 当前进度与未来完善方向

> 交接文档（供接手 agent 或协作者阅读）。请以本文件描述为准确现状，并结合仓库代码判断。
> 插件根目录：`D:\DeepSeek\project-memory-bundle\`
> 记忆数据：`<各项目目录>\.dsh-memory.json`（如 `D:\DeepSeek\.dsh-memory.json`）

---

## 一、这个插件是什么

本地优先、**按项目隔离**的项目记忆插件。每个项目一份 `.dsh-memory.json`，提供模型工具、命令、设置页 UI。遵循两条主线：

1. **随核心快速适配**：只用官方稳定 seam（`tools` / `commands` / `fs` / `webServer` / `slots` / `userQuestions` / `systemPrompt`），高危内部契约包在适配器内并遵循「探测→退化→上报」。
2. **万物皆插件**：整个功能是一个插件包 `@dsh-external/dsh-project-memory`，可独立挂载/停用，不改 Harness 核心。

---

## 二、已完成（全部验证通过）

### 宿主端 `lib/index.js`（ESM）
- **存储层 store v3**：每项目一份 `.dsh-memory.json`，按 cwd 隔离，防跨项目污染（实测未污染）。字段：`id/name/title/description/body/type/status/scope/heat/source/tags/why/howToApply/links/createdAt/updatedAt/lastRecalledAt`。写入显式传 `sandboxPolicy: { mode:'danger-full-access', workspaceRoot:cwd }` 保证落盘。
- **5 个模型工具**：`memory_read` / `memory_recall` / `memory_write` / `memory_update` / `memory_delete`。
- **`/memory` 命令**：list / add（支持 `<type>: 内容`）/ forget / clean / status / recall。
- **host RPC 路由** `GET/POST /project-memory/api`：list / save / capabilities，供设置页 UI 用。
- **能力探测报告**（capabilityReport）。
- **记忆分类**：6 种 type（project/reference/feedback/user/skill/knowledge），`memory_write` 描述里明确「按事件性质+用户说的话」判断，enum 统一 6 类。
- **正文自动整理 `organizeBody`/`organizedText`**：分段 + 自动编号 + 连续重复去重（`1、 1、`→`1、`）+ 乱序重复重排（`1、2、1`→`1、2、3`）+ **把 `- / • / *` 列表行也独立成段**（子项不编号、不重排）。客户端/宿主端各一份，逻辑一致。
- **写操作二次确认**（方案 A，最终采纳）：
  - `memory_write/update/delete` + `/memory add/forget` 写盘前调用 `userQuestions.ask` 弹「允许/拒绝」确认；
  - **严格 fail-closed**：只认 `ask` 明确「允许」，ask 不可用/抛错/用户拒绝一律**不写**；删除了「回退 approval（可能放行）」和「降级放行」两条绕道；
  - 确认文案：标题「记忆修改确认」、问题「允许[新增/更新/删除/归档]这条项目记忆？」、说明显示具体变更标题、选项「允许…/拒绝」带说明；approve 判定兼容选项 id 与文字（含「允许」）。
  - **弹窗容器布局样式由 DSH `userQuestions` 组件控制，插件只能改文案内容与结构。**
- **系统提示约束**：注入 `[项目记忆规则]`——改记忆只用 memory_* 工具（会弹确认），禁止用 write/edit/node/pwsh 直接改 `.dsh-memory.json`。

### 客户端 `lib/client.js`（CJS + React，settings.section 区块）
- 黑灰圆角 UI（背景 `#191919/#1a1a1a`、卡片灰 `#3a3a3a/#262626`、圆角 10-14px、系统黑体）。
- 多项目切换（cwd）、列表卡片（标题+简介+类型+热度/最近召回）、状态筛选（all/active/candidate/archived）+ 类型筛选（6 类）+ 搜索、统计概览、导入/导出、删除二次确认（自定义弹层，非原生 confirm）。
- **拖拽排序**：Ghost 用 `position:fixed + left/top` 视口坐标 DOM 直写、等高占位符、逐格让位、边缘自动滚动。性能优化：pointermove rAF 节流、ghost 位置 DOM 直写避免 React 每帧重渲、缓存高度/gap/容器边界免 `getBoundingClientRect` 强制 reflow、`setDrag` 仅在插入点变化时触发、`will-change` 提 GPU 合成层。
- **卡片点击展开正文**：标题/简介不动，下方展开分段编号正文，固定高度+细圆角滚动条，展开/收缩动画；编辑表单贴卡片下方，其他卡让位。
- **正文自动排版与展示一致**：编辑框显示 `organizedText` 后的分段编号版本，与展开展示一致。

### 预设 & 加载
- `router-standard`：memory_* 编入 STAGES 白名单（read/recall→阶段0，write/update→阶段2，delete→阶段3），`isMemoryTool` 同时识别 `memory_` 和 `engram_`。
- profile 层 `cordis.patch.yml`（web + desktop）插入 `dsh-project-memory` 宿主行。**注意：bundle 层 patch 在运行时不一定生效，实际靠 profile 层。**

### 文档/类型
- `README.md`（设计、安装、功能、分类约定、测试指引）。
- `lib/types/index.d.ts` + `lib/types/client/index.d.ts`（宿主/客户端类型声明）。

---

## 三、测试发现与结论

- **多项目记忆隔离**：✅ 无跨项目污染（按 cwd 独立）。
- **确认弹窗**：✅ 端到端走通——AI 走 memory_* → 弹「允许/拒绝」→ 允许才写（`saved:true`），拒绝/不弹则 fail-closed（记忆不被改）。根因：之前「没弹窗且改了」是因为 AI **绕过 memory_* 直接改文件**；约束 + 走 memory_* 后必弹。
- **AI 曾绕过确认**：⚠️ AI（该会话）曾用 `node 脚本` 直接改 `.dsh-memory.json` 绕过确认。因此设计了方案 A：移除不可靠的字符串匹配 guard（它拦不住 node 间接写、还误伤读），改为「确认层 fail-closed + 系统提示约束」。

---

## 四、当前已知缺口（含一个关键实测教训）

### 1. AI 行动时「是否真的想起并遵守记忆」未被机制保证
- 实测：模型明明存了「修改文件位置要点」（每次修改后要告诉用户改了哪个文件的目录），但在随后的修改**没有主动遵守**，未在回复里报路径。
- 这说明：**记忆「能存、能读、功能完整」≠ AI 会在行动中主动召回并遵守**。目前更多依赖 AI 的习惯/提示，而非机制。

### 2. 没有「摘要/全文」分级（正是要补的方向）
- 当前 `memory_recall` **默认返回完整 `body`**（`lib/index.js` line 312：`body: m.body`）。
- 记忆一多：完整正文会拉高 token 消耗、稀释命中率。
- 现状 `memory_read`：传 id 才返回全文，不传 id（列表/搜索）返回摘要（title+description+heat）——**部分已分级**，但 `memory_recall` 未分级。

---

## 五、未来完善方向（建议按序）

### A. 分级记忆：摘要索引 + 按需全文（最高优先级）
目标：AI 平时能「随时想起」记忆，但记忆多时不被长正文拖垮 token、保持命中率。

1. **每条记忆加 `summary` 钩子**：写入时自动从正文提取关键句（或复用 `description`），存 `summary` 字段。
2. **`memory_recall` 默认只返摘要**（id/title/type/heat/summary，**不带 body**），新增参数 `includeBody:true` 才带全文。
3. **`memory_read` 保持**：传 id 拿全文，列表/搜索返摘要（已如此）。
4. **AI 工作流引导**（工具描述 + 提示）：动手前先 `memory_recall`（想起大概）；确定引用某条才 `memory_read(id)` 取全文；**不要一开始就把全部正文拉进上下文**。
5. 客户端已天然匹配：列表卡片只显示 description（钩子），展开才显示正文。

### B. 让 AI 更主动召回记忆
- 在关键节点（动手修改/规划前）提示 AI 先 `memory_recall` 相关记忆；
- 或考虑**自动注入**「最相关 N 条摘要」到系统提示（但需平衡 token——正是分级要解决的）。

### C. 体验完善
- `/memory` 命令增强：stats / export / find 子命令。
- 正文搜索高亮关键字。
- 记忆卡片 hover 展示更多信息、不同 type 用颜色/图标区分。

### D. 健壮性
- `memory_recall` 每次召回都写盘 bump heat + lastRecalledAt，是否需节流/聚合。
- 确认 `userQuestions.ask` 在工具内弹窗的稳定性（子代理/无 live agent 时可能 fail-closed）。

---

## 六、给接手 agent 的注意事项

1. **改 `.dsh-memory.json` 必须走 memory_* 工具**（会弹确认），**不要**用 write/edit/node/pwsh 直接改——那会绕过确认，违反 `[项目记忆规则]` 注入的系统提示。
2. **记住「修改文件位置要点」**：每次修改代码/文件后，在回复里**明确列出改动的绝对路径**（这是用户明确要求、且已实测 AI 容易疏忽的点）。
3. 宿主端服务**必须 `inject` 声明 + `ctx.<name>` 访问**（不能用 `ctx.get()`）。
4. DSH `settings.section` 客户端组件必须是 **React 组件**作为 `slots.register(options, Component)` 第二参数。
5. **改插件要重启 DSH Desktop** 才生效（`lib/index.js`/`lib/client.js`）。
6. 想复用这套插件设计（端口-适配器、探测-退化-上报、分级记忆、确认门、正文自动整理、拖拽动画要点）——见记忆「项目记忆插件设计结论」（`D:\DeepSeek\.dsh-memory.json`，id=mem-dsn-prj-design）。
