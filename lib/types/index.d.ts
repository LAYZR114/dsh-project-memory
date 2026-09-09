/**
 * dsh-project-memory 宿主半类型声明。
 * 描述 .dsh-memory.json 的存储模型与 5 个模型工具的参数/返回接口。
 * 与 lib/index.js 的实际实现保持一致（store v3）。
 */

/** 记忆分类 type（6 种） */
export type MemoryType =
  | 'project'      // 项目事实/设计决策/进展/结构
  | 'reference'    // 参考资料/外部知识/学习文档
  | 'feedback'     // 反馈/经验教训/复盘结论
  | 'user'         // 用户偏好/习惯/明确要求
  | 'skill'        // 技能/操作方法/流程步骤
  | 'knowledge'    // 通用知识/领域概念

/** 记忆状态 */
export type MemoryStatus = 'active' | 'candidate' | 'archived'

/** 记忆来源 */
export type MemorySource = 'manual' | 'auto' | 'tool' | 'feedback'

/** 硬守卫（底线记忆，GLM 定稿 §2）：guard 字段进记忆（零 schema），随记忆生命周期 */
export interface MemoryGuard {
  action: 'block_write' | 'block_update' | 'block_delete'
  /** 目标两类：记忆 id（精确）/ 路径（子串匹配——已知限制：子串误伤，安装弹窗规格全文展示由用户肉眼兜底） */
  target: { kind: 'memory'; id: string } | { kind: 'path'; value: string }
  createdAt: string
  blockedCount: number
}

/** 一条项目记忆（.dsh-memory.json 中的一项） */
export interface ProjectMemory {
  id: string
  name?: string
  title: string
  description: string
  body: string
  type: MemoryType
  scope?: 'project'
  status: MemoryStatus
  heat: number
  source: MemorySource
  tags: string[]
  why?: string
  howToApply?: string
  links?: string[]
  guard?: MemoryGuard
  createdAt: string
  updatedAt: string
  lastRecalledAt?: string
}

/** .dsh-memory.json 文档 */
export interface MemoryDocument {
  version: number
  memories: ProjectMemory[]
}

/** memory_recall 返回的一条召回结果 */
export interface RecalledMemory {
  id: string
  title: string
  type: MemoryType
  heat: number
  lastRecalledAt?: string
  description: string
  body: string
}

/** memory_read 工具结果 */
export interface MemoryReadResult { memories: ProjectMemory[] }

/** memory_recall 工具结果 */
export interface MemoryRecallResult {
  total: number
  recalled: RecalledMemory[]
}

/** memory_write 工具结果 */
export interface MemoryWriteResult {
  saved: boolean
  duplicate?: boolean
  similarMemory?: ProjectMemory
  cancelled?: boolean
  memory?: ProjectMemory
  message?: string
}

/** memory_update 工具结果 */
export interface MemoryUpdateResult {
  saved: boolean
  cancelled?: boolean
  memory?: ProjectMemory
  message?: string
}

/** memory_delete 工具结果 */
export interface MemoryDeleteResult {
  saved: boolean
  cancelled?: boolean
  id?: string
  message?: string
}
