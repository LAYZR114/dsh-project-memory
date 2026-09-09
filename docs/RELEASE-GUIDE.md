# 北极星记忆（dsh-project-memory）· 发布指引 v0.1.0（测试版）

> 目的：把插件发布到 DeepSeek Harness 插件生态（官方入口 topics/dsh-plugin + 社区可装市场 dsh-market）+ 开源。
> 说明：DeepSeek Harness **没有官方"插件店"收录第三方**（官方 repo 拒绝外部 PR）；**官方唯一背书的插件入口 = GitHub topics/dsh-plugin**（打 tag 即上榜，零审批）；**可一键安装 = awesome-dsh-plugin 目录 PR**（进 dsh-market）。下方步骤按此。

## 已由 AI 完成的（发布准备）
- 代码就绪（注入重做 L1/L2/L3 + 硬守卫，selftest/测试全绿）。
- `package.json`：`private:false` + `publishConfig.access:public` + `repository` + `keywords` + `files`（lib+cordis.patch.yml+README+LICENSE 需补）。
- `README.md`：**双语**（专业术语版 + 大白话版）+ 表格 + mermaid 架构/流程图 + 0.1.0 声明。
- `LICENSE`（BSD-3-Clause）+ `.gitignore`（排除备份/junction/记忆数据）。
- 源码敏感检查：**无真实凭据/token**（仅代码变量名）；无本机路径硬编码（路径动态 cwd）——**可开源**。

## 你需要做的（发布执行，按顺序）

### 1. GitHub 公开仓库 + 官方入口（必做，零审批）
1. 在 [GitHub](https://github.com) 建**公开仓库** `dsh-project-memory`（不要 fork）。
2. 本地初始化+推送：
   ```bash
   cd D:\DeepSeek\project-memory-bundle
   git init
   git add -A
   git commit -m "dsh-project-memory v0.1.0 (beta): 项目记忆插件（注入重做 L1/L2/L3 + 硬守卫）"
   git remote add origin https://github.com/<你的用户名>/dsh-project-memory.git
   git push -u origin main
   ```
3. **给仓库打 `dsh-plugin` topic**（Settings → Topics → 加 `dsh-plugin`）→ **立即出现在官方入口页**（`https://github.com/topics/dsh-plugin`）。
4. 确认仓库**根 package.json** 有有效 `dsh.bundle.patch`（已有）+ patch 文件存在（`cordis.patch.yml`）——majiayu000 registry 自动收录条件。

### 2. npm publish（可选，一键安装体验）
1. npm 账号：`npm login`。
2. **注意 scope**：`@dsh-external` 在 npm 上 **404**（未注册/未发布）——两选一：
   - a) 在 npm **创建 `@dsh-external` 组织**（npm 官网新建 org），或
   - b) **改包名**为无 scope（如 `dsh-project-memory`，package.json name 改后 `files` 补 `README.md/LICENSE`）。
3. 发布：
   ```bash
   npm publish --access public   # 0.1.0 测试版；"测试版"在 README/描述注明（无官方 beta 通道）
   ```
4. 验证：`dsh plugin --profile web add dsh-project-memory`。

### 3. awesome-dsh-plugin 目录 PR（进可装市场 dsh-market，可选但推荐）
1. 到 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 开 PR，加一条 entry（参考现有条目格式）：
   - `name`：北极星记忆（dsh-project-memory）
   - `owner`：<你的用户名>
   - `url`：`https://github.com/<你的用户名>/dsh-project-memory`
   - `category`：`memory`
   - `description`：**en + zh 双语**（目录 plugins.json 要求 `{en,zh}`）
   - `install`：`npm install -g dsh-project-memory`（或 `dsh plugin add`）
2. 合并后 dsh-market 自动出现，可一键安装。（注意：目录 PR **不保证过审**——内容/版权/风险由维护者判断。）

### 4. 官方讨论区展示（可选）
在 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 **Show Your Plugins** 讨论区发帖展示（社区展示，非官方收录）。

## 分类提示
- 市场类别：`memory`（记忆/知识管理）——README/目录描述注明。
- 版本：0.1.0 测试版（README 顶部已注 `0.1.0（测试版 / beta）`；市场无官方 beta 通道，描述里注明即可）。

## 风险/边界（诚实）
- **无官方插件店/无官方审批**：官方只维护 @deepseek-ai/* 自研；社区目录是主流入口。
- **topic 页 0 门槛但无校验**：打了 tag 即上榜（含大量蹭标签非 DSH 项目）；**能装**=目录 PR 通过 + npm/GitHub 源。
- **`@dsh-external` scope 未注册** / **`private:true` 会导致 publish 失败**（已修 private；scope 需注册或改名）。
- GitHub 源直装**不自动构建**（需用户放行 prepare——推荐 npm 分发）。

## 检查清单（发布前）
- [x] 代码测试全绿（node --test + rule/scene selfTest）
- [x] README 双语+图表
- [x] LICENSE（BSD-3）
- [x] .gitignore（排除备份/记忆数据）
- [x] 敏感检查（无凭据/无本机硬编码）
- [ ] package.json `files` 补 `README.md`、`LICENSE`（若 npm publish）
- [ ] GitHub repo + `dsh-plugin` topic
- [ ] npm publish（scope 注册/改名）
- [ ] awesome-dsh-plugin PR
