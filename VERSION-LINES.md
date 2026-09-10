# 北极星记忆 · 两条版本线（VERSION LINES）

> 2026-09-10 定案：**同一个包名**（`@dsh-external/dsh-project-memory`），**两条版本线**，两个工作目录、两条 git 分支。
> 为什么同包名：DSH 的加载身份 = `package.json name`（须与补丁行 `name`、node_modules 目录名三处一致），
> 同包名可以让补丁行、设置页、工具名（memory_*）在两条线之间**完全不用改**；代价是**同一个 profile 只能装一条**。

---

## 1. 两条线是什么

| | **自用稳定线（legacy）** | **新核线（next）** |
|---|---|---|
| 包名 | `@dsh-external/dsh-project-memory` | 同左（同一包名） |
| 版本区间 | **0.1.x**（当前 0.1.2，已冻结） | **0.2.x**（当前 0.2.0） |
| 目标核心 | DSH **0.1.2-rc.1** 起的旧核（桌面端 2.0.5 等），兼容到 0.1.5-rc.1 | DSH **0.1.5-rc.1+** 新核（桌面端 2.0.7 等），可用新核 API |
| 定位 | 日常自用：**只做 bugfix 与兼容补丁，不加新功能** | 追新：功能与 legacy **对等起步**，之后才上 0.1.5 新能力 |
| 工作目录 | `D:\DeepSeek\project-memory-bundle` | `D:\DeepSeek\polaris-next` |
| git 分支 | `main`（tag `v0.1.2`） | `next/0.2.x` |
| 交付包 | `dsh-external-dsh-project-memory-0.1.2.tgz` | `dsh-external-dsh-project-memory-0.2.0.tgz` |

两线**共享同一套数据格式**：记忆文件仍是各项目目录下的 `.dsh-memory.json`（store v2/v3）。
所以来回切换版本线**不会丢记忆、不需要迁移**。

## 2. 铁律

1. **一个 profile 只装一条线**。同一个 profile 里同时挂两条（同包名、两个目录）会造成 `memory_*` 工具重名注册冲突。
2. 补丁行**不用改**（两条线同包名），只切换 junction 指向的目录即可。
3. legacy **不回移** next 的新特性；next **不对 legacy 做破坏性改动**（next 可以改自己的实现，但记忆格式与工具名/语义保持一致）。
4. 记忆文件仍然只允许 `memory_*` 工具修改（红线）。

## 3. 怎么切换（profile ↔ 版本线）

方式一（脚本，推荐）：`D:\Agent共享\DSH插件\切换北极星版本线.ps1 -线 next -Profile desktop`（改完重启桌面端）
方式二（手动）：
```powershell
# 先删旧链接（只删链接，不删源码）
cmd /c rmdir "C:\Users\35211\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-project-memory"
# 再指向目标线目录
cmd /c mklink /J "C:\Users\35211\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-project-memory" "D:\DeepSeek\polaris-next"
```
方式三（tarball 安装）：`dsh plugin --profile desktop add <对应线的 tgz>`

## 4. 发布策略

- npm / GitHub：同包名、两条线靠 **版本号**区分（`0.1.x` = legacy，`0.2.x` = next）。
- 发布前跑齐三件套：`node --test`、`node tools/verify-api-0.1.5.mjs`、`node tools/smoke-apply.mjs`。
- legacy 只发补丁版本（0.1.3、0.1.4…）；next 走 0.2.x（预发布可用 0.2.0-beta.N）。

## 5. 变更记录

- 2026-09-10：分版落地。legacy 冻结 0.1.2（含 LLM 精排修复、软依赖挂载时机 hotfix）；next 由 legacy 克隆起步为 0.2.0（功能对等，核心目标 0.1.5-rc.1+）。
