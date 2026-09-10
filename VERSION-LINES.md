# 北极星记忆 · 版本线策略（VERSION LINES）

> **2026-09-11 定案（用户）：取消双线，只保留一条线，版本号定为 `0.1.3`，暂不发布。**
> 插件**不再为旧版本核心做适配**，只跟最新的 DSH 核心走（0.1.5-rc.1 及更新）。
> 双线时期的版本号 `0.1.4` / `0.1.5` **作废**（从未对外发布过，本地标签已删除）。
> 旧的自用稳定线（legacy 0.1.4 代码）已**归档**：`D:\Agent共享\DSH插件\归档-legacy线-20260911\`
> （含完整 git bundle `北极星legacy-v0.1.4-all-refs.bundle`，已 `git bundle verify` 校验）。

---

## 1. 单线是什么

| 项 | 值 |
|---|---|
| 包名 | `@dsh-external/dsh-project-memory`（加载身份 = package.json name；补丁行 name、node_modules 目录名三处必须一致） |
| 版本 | **0.1.3**（暂不发布） |
| 源码目录 | `D:\DeepSeek\project-memory-bundle`（原 `polaris-next`，2026-09-11 归并改名） |
| git | 分支 **`main`** + 标签 **`v0.1.3`**（指向当前 HEAD）；远程 `origin` = `github.com/LAYZR114/dsh-project-memory`（**尚未推送**） |
| 目标核心 | **DSH 0.1.5-rc.1 及更新**（桌面端 2.0.7 / 2.0.9）；旧核（0.1.2-rc.1 等）**不再适配** |
| 安装包 | `D:\Agent共享\DSH插件\dsh-external-dsh-project-memory-0.1.3.tgz` |
| 记忆数据 | 各项目目录下的 `.dsh-memory.json`（store v2/v3），换版本不丢记忆、无需迁移 |

## 2. 版本号策略（沿用 2026-09-10 用户定调）

- 同属 **0.1.x** 系列：纯核心适配、bugfix、兼容补丁、小功能 → 只加补丁位。
- **只有出现较大优化或新功能才升 `0.2.0`**。
- 版本号全局唯一（只一条线，天然满足）。
- ⚠️ 双线时期用过的 0.1.4 / 0.1.5 已作废且从未发布，**下一个补丁位从 0.1.4 继续**。

## 3. 铁律

1. **一个 profile 只装一份**（同包名挂两份 → `memory_*` 工具重名注册冲突）。
2. 补丁行不用改；换装只改 junction 指向的目录（现在只有唯一目录）。
3. 记忆文件只允许 `memory_*` 工具或设置页修改（用户红线）。
4. 改 `index.js` / `api.js` → **重启桌面端**；只改 `client.js` → 刷新页面（F5）；**补丁里新增插件行也必须重启**。

## 4. 安装 / 卸载（单线）

- 安装（二选一）：
  - junction（推荐，改代码即生效）：
    `mklink /J "C:\Users\35211\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-project-memory" "D:\DeepSeek\project-memory-bundle"`
  - tarball：`dsh plugin --profile desktop add "D:\Agent共享\DSH插件\dsh-external-dsh-project-memory-0.1.3.tgz"`
- 卸载：删 junction（`cmd /c rmdir <链接>`，**只删链接**）+ 删除 profile 补丁里的 insert 行。
- ⚠️ **建 junction 一律用 `New-Item -ItemType Junction -Path <链接> -Target <目标>`**；不要用 `cmd /c mklink` 并在双引号里写 `"$obj.Prop"`（Windows PowerShell 会把它展开成 `System.Collections.Hashtable.Prop`，链接指向坏路径——2026-09-11 实测踩到）。

## 5. 发布前三件套（每次发布都要跑齐）

```sh
node --test                      # 51 项（含 client 真行为测试）
node tools/verify-api-0.1.5.mjs  # 29 项静态 API 核对（需要 DSH 0.1.5 源码树，见下）
node tools/smoke-apply.mjs       # 25 项 apply() 冒烟（含"全新安装 = 0 条记忆"）
```
- `verify-api-0.1.5.mjs` 依赖解压出来的核心源码树，默认路径
  `D:\DeepSeek\_src_inspect\dsh-v0.1.5-rc.1\deepseek-harness-dsh-v0.1.5-rc.1`。
  需要时用 zip 重新解压即可（`D:\DeepSeek\deepseek-harness-dsh-v0.1.5-rc.1.zip`，约 25MB）。
  **源码树不在时该脚本打印提示并跳过（不判失败）**——2026-09-11 已把源码树从磁盘清掉
  （它含 `AGENTS.md`/`CLAUDE.md`，一读就触发 DSH 仓库规范注入，实测 23,431 字符，白烧上下文）。
- 发布包内不得含任何记忆数据（`.gitignore`/`.npmignore` 已挡）。

## 6. 变更记录

- 2026-09-11：**单线定型 0.1.3（暂不发布）**：取消双线后沿用"单线 + 最新核心"策略，双线版本号 0.1.4/0.1.5 作废；本地标签 `v0.1.4`/`v0.1.5` 删除、`v0.1.3` 重新指向当前 HEAD；`polaris-next` 归并回规范目录 `project-memory-bundle`，分支统一 `main`；`origin` 从"本地 legacy 目录"改指 GitHub（尚未推送）。
- 2026-09-11：桌面端升到 **2.0.9**（核心 0.1.5-rc.1）后插件实测通过：上下文注入正常、模型工具注册可用、HTTP `capabilities` 中 `tools/commands/fs/webServer/systemPromptContext/invertedIndex` 全 ok、**LLM 精排真生效**（`diagRerankRun=1 / diagRerankFallback=0`）。2.0.9 已修 2.0.7 那个"Windows Job runner 立刻 exit 0 → 所有子进程能力全挂"的回归。
- 2026-09-11：修复 `切换北极星版本线.ps1`（已随双线一起归档）的真 bug：`cmd /c mklink /J "$link" "$target.Dir"` 中 `"$target.Dir"` 被 Windows PowerShell 展开成 `System.Collections.Hashtable.Dir` → 链接指向坏路径；且后续读版本抛错会中断整个脚本。
- 2026-09-10：分版落地（legacy 冻结 0.1.2）；新增设置页「保存排序」；修「手动顺序存不住」真因（`readDoc` 每次读盘重排 → `keepOrder` + `/save` 回读校验 verified）；修 `checkSanity` 作用域错误（「确认保存」无反应）；成功弹窗 3 秒。
