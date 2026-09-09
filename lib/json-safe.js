// jsonSafe —— lossless JSON 自动防线（纯函数，供宿主工具返回用）。
// 目标：防 DSH「lossless JSON」校验拒绝 —— 工具返回值里任何 undefined 字段都会触发该报错。
// 处理（递归清洗）：
//   - 对象属性为 undefined → 直接删键（真正去除，不产生 null 噪音字段）。
//   - 数组元素为 undefined → 转 null（保索引，数组内无法删元素）。
//   - 其它值原样透传（数字安全兜底由调用层负责）。
// 独立成模块以便 round-trip 测试直接测真实实现，避免双维护漂移。

export function jsonSafe(v) {
  if (v === undefined) return undefined // 顶层/对象属性 undefined：交给外层删键（返回 undefined 以触发外层跳过）
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => { const c = jsonSafe(x); return c === undefined ? null : c })
  const o = {}
  for (const k in v) { const val = jsonSafe(v[k]); if (val !== undefined) o[k] = val }
  return o
}
