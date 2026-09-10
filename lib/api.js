// 轻量化·批次D：host RPC 面（设置面板 /project-memory/api，官方稳定 seam webServer）。
// 只搬移不重写——本文件逐字取自原 index.js L2031-2101；闭包依赖经 deps 注入
// （registerApiRoute(deps) 由 index.js apply 调用；写路径铁律 writeThrough 留在 index 共享层）。
// 装卸干净（审计 6fc8f006）：包 ctx.effect 卸除路由（与 fiber 绑定的官方做法）。
export function registerApiRoute(ctx, deps) {
  const { webServer, readDoc, writeThrough, buildCapabilityReport, rl, collectProjects, pickDirectory } = deps

  // ---- host RPC route for the settings panel (official stable seam: webServer) ----
  if (webServer !== undefined) {
    try {
      const body = (req) => new Promise((resolve, reject) => {
        let data = ''
        req.on('data', (chunk) => { data += chunk })
        req.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}) } catch (e) { resolve({}) }
        })
        req.on('error', reject)
      })
      const json = (res, obj) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(obj))
      }
      const handler = async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        let payload = {}
        try { payload = await body(req) } catch (e) { payload = {} }
        const action = payload.action
        const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined
        try {
          if (action === 'list') {
            if (!cwd) return json(res, { ok: false, error: 'missing cwd' })
            // keepOrder：设置页看到的就是**文件里的真实顺序**（= 手动/保存排序的结果）。
            // 否则读取按"最新"重排，用户的手动顺序永远显示不出来（老 bug）。
            const doc = await readDoc(cwd, { keepOrder: true })
            return json(res, { ok: true, memories: doc.memories, capabilities: buildCapabilityReport() })
          }
          if (action === 'save') {
            if (!cwd) return json(res, { ok: false, error: 'missing cwd' })
            if (!Array.isArray(payload.memories)) return json(res, { ok: false, error: 'missing memories' })
            // 数据安全防线（GLM §6）：任何一条记录不满足记忆形状 → 整包拒绝、原文件不动，杜绝客户端写坏库。
            const bad = payload.memories.filter((m) => !m || typeof m !== 'object'
              || typeof m.id !== 'string' || typeof m.title !== 'string'
              || typeof m.description !== 'string' || typeof m.body !== 'string'
              || typeof m.updatedAt !== 'string')
            if (bad.length > 0) {
              return json(res, { ok: false, error: 'rejected: ' + bad.length + ' invalid record(s) (not a well-formed memory)' })
            }
            const hasGuard = payload.memories.some((m) => m && m.guard)
            // explicitOrder：设置页保存 = **显式改序**，以客户端给的顺序为准（writeThrough 默认会保序、
            // 把集合套回磁盘顺序，那是给"顺带写入"用的；这里必须放行改序）。
            const wrote = await writeThrough(cwd, payload.memories, { explicitOrder: true })
            if (!wrote) {
              // writeThrough 防线1 sanity 拦截（坏数据不落盘）→ 如实上报，杜绝"假保存"
              return json(res, { ok: false, error: 'rejected: writeThrough sanity aborted (invalid record(s))' })
            }
            // ★ 保存后**回读校验**（用户要求的新机制）：写盘成功 ≠ 一定能读回同一顺序，
            //   所以这里按 keepOrder 把文件真读一遍，用 id 序列逐位比对；不一致就如实上报 verified:false，
            //   客户端据此提示"保存未生效"，绝不谎报成功。
            const want = payload.memories.map((m) => m.id).join('|')
            let verified = false
            let count = 0
            let mismatchAt = -1
            try {
              const back = await readDoc(cwd, { keepOrder: true })
              const got = (back.memories || [])
              count = got.length
              verified = got.map((m) => m.id).join('|') === want
              if (!verified) {
                for (let i = 0; i < Math.max(got.length, payload.memories.length); i++) {
                  const a = got[i] && got[i].id
                  const b = payload.memories[i] && payload.memories[i].id
                  if (a !== b) { mismatchAt = i; break }
                }
              }
            } catch (e) { verified = false }
            // 新客户端（payload 带 guard 字段）保存 = 可信路径 → 基线刷新；旧客户端（丢 guard 字段）
            // 不刷新 → /memory status 按基线下降告警（GLM §2 缓解：可观测而非阻断）
            if (hasGuard) rl.resetBaseline(cwd)
            return json(res, { ok: true, saved: true, verified, count, mismatchAt })
          }
          if (action === 'pickdir') {
            // 设置页「选择目录」按钮：调官方 directoryPicker 弹系统文件夹对话框（桌面端为原生对话框）。
            // 取消 → { ok:false, error:'cancelled' }；本环境无原生能力 → { ok:false, error:'browse-only', browse:true }。
            const picked = (typeof pickDirectory === 'function') ? await pickDirectory() : { ok: false, error: 'picker unavailable' }
            return json(res, picked)
          }
          if (action === 'projects') {
            // 设置页「项目目录」Typeahead 数据源：现有项目 = 本进程见过的 cwd（工具/读盘时记录）
            // + 活跃会话的工作目录（agents.list）。每条带 count（记忆条数）与 updatedAt（记忆文件时间）。
            const projects = (typeof collectProjects === 'function') ? await collectProjects() : []
            return json(res, { ok: true, projects })
          }
          if (action === 'capabilities') {
            return json(res, { ok: true, capabilities: buildCapabilityReport() })
          }
          return json(res, { ok: false, error: 'unknown action: ' + String(action) })
        } catch (e) {
          return json(res, { ok: false, error: String(e && e.message ? e.message : e) })
        }
      }
      // 装卸干净（审计 6fc8f006）：webServer.register 与 fiber 无绑定——必须包 ctx.effect（照抄 client-connection 官方做法），
      // 否则进程内卸载后 /project-memory/api 路由残留 + 重复装卸路由堆积（register duplicate prefix 被吞→新实例装不上）。
      ctx.effect(() => {
        webServer.register({ kind: 'prefix', path: '/project-memory/api', handler })
      }, 'project-memory: api route')
      console.log('[project-memory] host RPC route mounted at /project-memory/api')
    } catch (e) {
      console.log('[project-memory] webServer route register failed: ' + (e && e.message ? e.message : e))
    }
  }
}
