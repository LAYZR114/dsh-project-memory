# 北极星记忆 · 两条版本线（VERSION LINES）

> 2026-09-10 定案：**同一个包名**（`@dsh-external/dsh-project-memory`），**两条版本线**，两个工作目录、两条 git 分支。
> 为什么同包名：DSH 的加载身份 = `package.json name`（须与补丁行 `name`、node_modules 目录名三处一致），
> 同包名可以让补丁行、设置页、工具名（memory_*）在两条线之间**完全不用改**；代价是**同一个 profile 只能装一条**。

---

## 1. 两条线是什么

| | **自用稳定线（legacy）** | **新核线（next）** |
|---|---|---|
| 包名 | `@dsh-external/dsh-project-memory` | 同左（同一包名） |
| 版本 | **0.1.3** | **0.1.4** |
| 目标核心 | DSH **0.1.2-rc.1** 起旧核（桌面端 2.0.5 等） | DSH **0.1.5-rc.1+**（桌面端 2.0.7 等） |
| 定位 | 日常自用：以 bugfix 与兼容补丁为主 | 追新核：功能与 legacy 对等，另含核心适配 |
| 工作目录 | `D:\DeepSeek\project-memory-bundle` | `D:\DeepSeek\polaris-next` |
| git 分支 | `main`（tag `v0.1.3`） | `next/0.1.x`（tag `v0.1.4`） |
| 交付包 | `dsh-external-dsh-project-memory-0.1.3.tgz` | `dsh-external-dsh-project-memory-0.1.4.tgz` |

两线**共享同一套数据格式**：记忆文件仍是各项目目录下的 `.dsh-memory.json`（store v2/v3）。
所以来回切换版本线**不会丢记忆、不需要迁移**。两线代码当前**功能对等**，差异只在"目标核心"与版本号。

## 2. 版本号策略（用户 2026-09-10 定调）

- **两条线同属 0.1.x 系列**，靠"线 + 目标核心"区分，不靠大版本号区分。
- **只有出现较大优化或新功能时，才升 `0.2.0`**（升版时旧线冻结，新线从 0.2.0 起）。
- 纯核心适配、bugfix、兼容补丁、小功能 → 只加补丁位（0.1.3、0.1.4…）。
- 版本号必须**全局唯一**（两线同包名，不能两条线同时叫 0.1.3）：谁后发谁用更大的号。
- 例子：新核线最初只是"配了核心版本"→ 定 0.1.3；随后两条线都加了「保存排序」小功能 → legacy 0.1.3、next 0.1.4。

## 3. 铁律

1. **一个 profile 只装一条线**。同一个 profile 里同时挂两条（同包名、两个目录）会造成 `memory_*` 工具重名注册冲突。
2. 补丁行**不用改**（两条线同包名），只切换 junction 指向的目录即可。
3. 两线的**记忆格式与工具名/语义保持一致**（可随时换线）；一侧改协议必须两侧同步。
4. 记忆文件仍然只允许 `memory_*` 工具或设置页修改（红线）。

## 4. 怎么切换（profile ↔ 版本线）

方式一（脚本，推荐）：双击 `D:\Agent共享\DSH插件\切换北极星版本线.cmd` 选 1/2/3（切完重启桌面端）
方式二（命令行）：`powershell -ExecutionPolicy Bypass -File "切换北极星版本线.ps1" -Line next [-Profile desktop|web] [-DryRun]`
方式三（手动）：
```powershell
cmd /c rmdir "C:\Users\35211\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-project-memory"   # 只删链接
cmd /c mklink /J "C:\Users\35211\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-project-memory" "D:\DeepSeek\polaris-next"
```
方式四（tarball 安装）：`dsh plugin --profile desktop add <对应线的 tgz>`

## 5. 发布策略

- npm / GitHub：同包名，靠**版本号 + 目标核心说明**区分两条线。
- 发布前三件套：`node --test`（含 client 侧回归）、`node tools/verify-api-0.1.5.mjs`、`node tools/smoke-apply.mjs`。
- 发布包内不得含任何记忆数据（.gitignore/.npmignore 已挡；冒烟"场景 0"每次回归验证"全新安装 = 0 条记忆"）。

## 6. 变更记录

- 2026-09-10：分版落地。legacy 冻结于 0.1.2（含 LLM 精排 text-delta 修复、软依赖挂载时机 hotfix）；next 由 legacy 克隆起步，目标核心 DSH 0.1.5-rc.1+。
- 2026-09-10：next 版本号 0.2.0 → 0.1.3（纯核心适配，不升大版本）。
- 2026-09-10：**新增设置页「保存排序」**（选任一自动排序 → 一键固化为「默认（手动）顺序」；默认模式不显示按钮；保存后 10 秒内可撤销；与拖动排序同一条写盘路径 + sanity 体检）。两线同步落地：**legacy 0.1.3 / next 0.1.4**；新增 `test/client-save-sort.test.mjs` 回归（8 项）。
