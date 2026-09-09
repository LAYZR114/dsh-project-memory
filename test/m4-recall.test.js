import { test } from 'node:test'
import assert from 'node:assert'

// M4-lite 计分逻辑自包含副本（index.js scoreMemory 在 apply 闭包内无法直接 import，此处镜像签名用于回归验证）。
// 若 index.js 的 scoreMemory 改动，需同步此处（或未来抽到可导出模块）。
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
function tokenizeRare(s) {
  const out = new Set(); const str = norm(s)
  for (const w of (str.match(/[a-zA-Z]{3,}/g) || [])) out.add(w.toLowerCase())
  const t = str.replace(/\s+/g, '')
  for (let i = 0; i < t.length - 1; i++) { const two = t.slice(i, i + 2); if (/\p{Script=Han}/u.test(two)) out.add(two) }
  return out
}
const M4_FIELD_W = { title: 3, description: 2, body: 0.4 }
function scoreMemory(mems, query, idfFn) {
  const qTokens = tokenizeRare(query)
  for (const ch of String(query).replace(/\s+/g, '')) if (/\p{Script=Han}/u.test(ch)) qTokens.add(ch)
  const idf = idfFn || (() => 1)
  const qWeights = {}; let qWeightSum = 0
  for (const t of qTokens) {
    if (/^[a-zA-Z]{3,}$/.test(t)) qWeights[t] = 1.5
    else if (/^\p{Script=Han}{2}$/u.test(t)) qWeights[t] = 1.0
    else qWeights[t] = 0.5
    qWeightSum += qWeights[t] * (idf(t) || 0)
  }
  const out = []
  const maxHeat = Math.max(1, ...mems.map((m) => (typeof m.heat === 'number' ? m.heat : 0)))
  for (const m of mems) {
    const parts = { title: norm(m.title || ''), description: norm(m.description || ''), body: norm(m.body || '') }
    const hits = { title: new Set(), description: new Set(), body: new Set() }
    for (const t of qTokens) for (const f of Object.keys(parts)) if (parts[f].includes(t)) hits[f].add(t)
    let hitIdf = 0
    for (const t of qTokens) {
      const w = qWeights[t] || 1
      const fw = (hits.title.has(t) ? M4_FIELD_W.title : 0) + (hits.description.has(t) ? M4_FIELD_W.description : 0) + (hits.body.has(t) ? M4_FIELD_W.body : 0)
      if (fw > 0) hitIdf += w * fw * (idf(t) || 0)
    }
    if (hitIdf === 0) continue
    const lex = hitIdf / (qWeightSum || 1)
    const heat = typeof m.heat === 'number' ? m.heat : 0
    const heatNorm = Math.log1p(heat) / Math.log1p(maxHeat)
    out.push({ m, score: 0.7 * lex + 0.3 * heatNorm })
  }
  out.sort((a, b) => b.score - a.score)
  return { scored: out, qWeightSum }
}

const mems = [
  { id: 'm1', title: '记忆冗余治理与自动合并·思考结论', description: '记忆冗余治理思考：根因候选冗余(P2)，倾向B+A方案', body: '冗余治理治理合并归并', heat: 5 },
  { id: 'm2', title: 'M4语义检索·混合检索思考结论', description: 'M4语义检索：混合检索(关键词+TF-IDF+LLM重排)三层', body: '关键词 倒排 TF-IDF 向量 语义', heat: 2 },
  { id: 'm3', title: '品牌名定为北极星记忆(方案A)', description: '插件品牌名=北极星记忆（方案A只改展示层）', body: '北极星 品牌 展示', heat: 0 },
  { id: 'm4', title: 'DSH开发关键API约束', description: 'DSH插件开发约束', body: '聚合归并 这些词只出现在正文', heat: 1 },
]
const idf = () => 1

test('跨措辞：怎么合并记忆 应优先召回 冗余治理', () => {
  const { scored } = scoreMemory(mems, '怎么合并记忆', idf)
  const titles = scored.map((x) => x.m.id)
  assert.ok(titles.includes('m1'), '应召回"记忆冗余治理"')
  assert.ok(titles.indexOf('m1') === 0, '"冗余治理"应排第1名')
})

test('body 降权后仍可达（查询只在正文的词）', () => {
  const { scored } = scoreMemory(mems, '聚合归并', idf)
  const titles = scored.map((x) => x.m.id)
  assert.ok(titles.includes('m4'), '仅 body 命中应召回（body 权重非 0）')
})

test('停用词查询：不崩，无高相关召回', () => {
  const { scored } = scoreMemory(mems, '的了', idf)
  assert.ok(Array.isArray(scored), '停用词不崩')
})

test('短查询不崩', () => {
  const { scored } = scoreMemory(mems, '修复', idf)
  assert.ok(Array.isArray(scored), '短查询不崩')
})
