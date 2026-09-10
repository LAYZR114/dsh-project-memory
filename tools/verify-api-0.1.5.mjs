// 静态核对：北极星记忆插件用到的每个 DSH API，在 0.1.5-rc.1 源码里是否仍以预期形状存在。
// 只读；不改任何文件。用法：node tools/verify-api-0.1.5.mjs
import fs from 'node:fs'
import path from 'node:path'

// 需要解压出来的核心源码树；可用环境变量 DSH_SRC_TREE 覆盖。
// 树不在时**跳过（exit 0）**——2026-09-11 起磁盘上默认不再保留该树（它含 AGENTS.md，
// 一读就触发 DSH 仓库规范注入，白烧上下文）。重新准备方式见 VERSION-LINES.md §5。
const NEW = process.env.DSH_SRC_TREE
  ?? 'D:/DeepSeek/_src_inspect/dsh-v0.1.5-rc.1/deepseek-harness-dsh-v0.1.5-rc.1'
if (!fs.existsSync(NEW)) {
  console.log('=== 静态 API 核对：跳过 ===')
  console.log('  未找到核心源码树: ' + NEW)
  console.log('  准备方式：把 D:\\DeepSeek\\deepseek-harness-dsh-v0.1.5-rc.1.zip 解压到')
  console.log('           D:\\DeepSeek\\_src_inspect\\ ，或设 DSH_SRC_TREE 指向已有源码树。')
  process.exit(0)
}
const read = (rel) => fs.readFileSync(path.join(NEW, rel), 'utf8')

const checks = [
  ['tools.register 返回 disposer', 'packages/core/tools/src/index.ts', /register\(definition: ToolDefinition\): \(\) => void/],
  ['ToolDefinition 形状(name/description/parameters/output)', 'packages/core/tools/src/index.ts', /interface ToolDefinition[\s\S]{0,600}?output: ToolOutputDefinition/],
  ['PreToolDecision 三种 kind（无 reject）', 'packages/core/tools/src/index.ts', /export type PreToolDecision =[\s\S]{0,200}?kind: 'deny';[\s\S]{0,120}?reason: string[\s\S]{0,200}?kind: 'ask'/],
  ['PostToolDecision accept{content}/block{feedback}', 'packages/core/tools/src/index.ts', /export type PostToolDecision =[\s\S]{0,400}?kind: 'block';[\s\S]{0,80}?feedback/],
  ['tools/pre-execute 事件声明', 'packages/core/tools/src/index.ts', /'tools\/pre-execute'\(this: Scoped<ToolRuntime>, exec: ToolExecution, next: \(\) => Promise<PreToolDecision>\)/],
  ['tools/post-execute 事件声明', 'packages/core/tools/src/index.ts', /'tools\/post-execute'/],
  ['agent/pre-step 事件（waterfall，payload 含 agent/turn/step）', 'packages/core/agent/src/runtime-types.ts', /'agent\/pre-step'[\s\S]{0,400}?agent: Agent[\s\S]{0,200}?step: number/],
  ['agent/created 事件', 'packages/core/agent/src/runtime-types.ts', /'agent\/created'[\s\S]{0,200}?agent: Agent/],
  ['AssembleContext.agent 由 dsh-agent 合并补回', 'packages/core/agent/src/runtime-types.ts', /interface AssembleContext \{[\s\S]{0,200}?agent\?: Agent/],
  ['assembleContextFor 提供 agent+scope', 'packages/core/agent/src/dispatch.ts', /return \{ agent, scope: agent/],
  ['systemPrompt.context(PromptContext) 返回 disposer', 'packages/core/system-prompt/src/index.ts', /context\(context: PromptContext\): \(\) => void/],
  ['PromptContext = {name, order, text 同步字符串}（无 Promise 变体）', 'packages/core/system-prompt/src/index.ts', /interface PromptContext \{[\s\S]{0,400}?readonly text: string \| \(\(context: AssembleContext\) => string\)/],
  ['AssembleContext 基础字段 scope/signal', 'packages/core/system-prompt/src/index.ts', /interface AssembleContext \{[\s\S]{0,300}?scope\?: ScopeKey[\s\S]{0,200}?signal\?: AbortSignal/],
  ['commands.register 存在', 'packages/interaction/commands/src/index.ts', /register\(/],
  ['CommandInvocation 含 rawInput/agent/attachments', 'packages/interaction/commands/src/index.ts', /interface CommandInvocation \{[\s\S]{0,700}?readonly rawInput: string[\s\S]{0,600}?readonly attachments/],
  ['CommandResult kind:success + text', 'packages/interaction/commands/src/types.ts', /kind: 'success'[\s\S]{0,120}?text/],
  ['webServer.register({kind,path,handler})', 'packages/host/webserver/src/index.ts', /register\(/],
  ['approval: ApprovalService.request', 'packages/interaction/user-approval/src/index.ts', /request\(/],
  ['userQuestions.ask', 'packages/interaction/user-questions/src/index.ts', /ask\(/],
  ['agents 服务（registry.list/get）', 'packages/core/agent/src/index.ts', /list\(\): Agent\[\]/],
  ['agent.session / agent.ctx', 'packages/core/agent/src/runtime-types.ts', /readonly session: Session[\s\S]{0,800}?readonly ctx: Context/],
  ['agent-loop 仍有 phase.step（首步门控依据）', 'packages/core/agent-loop/src/agent.ts', /private phase: Phase|phase\.step/],
  ['llm.stream(GenerateOptions)', 'packages/llm/llm/src/index.ts', /stream\(/],
  ['StreamChunk 含 text-delta（LLM 精排修复依据）', 'packages/llm/llm/src/types.ts', /type: 'text-delta'/],
  ['StreamChunk 不含 content/text（旧写法必不命中）', 'packages/llm/llm/src/types.ts', /type: 'text-delta'[\s\S]{0,900}?type: 'finish'/],
  ['客户端 slots registry（settings.section 契约）', 'packages/client/ui-renderer/src/client/registry.ts', /register\(/],
  ['settings.section slot 声明', 'packages/client/ui-settings/src/client/contract/slots.ts', /'settings\.section'/],
  ['client 模块注册（window.__ModuleLoader__.load 契约）', 'packages/client/modules/src/index.ts', /load\(registration/],
  ['dsh.bundle.patch 装配要求', 'packages/util/package-manifest/src/types.ts', /bundle/],
]

let pass = 0, fail = 0
console.log('=== 0.1.5-rc.1 静态 API 核对（北极星记忆用到的每个 seam）===')
for (const [label, rel, re] of checks) {
  let ok = false, err = ''
  try { ok = re.test(read(rel)) } catch (e) { err = ' (' + e.message + ')' }
  if (ok) { pass++; console.log('  ✔ ' + label) }
  else { fail++; console.log('  ✘ ' + label + '  ← ' + rel + err) }
}
console.log('\n通过 ' + pass + ' / 失败 ' + fail + '（共 ' + checks.length + '）')
