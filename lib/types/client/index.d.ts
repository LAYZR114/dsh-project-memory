/**
 * dsh-project-memory 客户端（browser / settings.section）半类型声明。
 * 客户端是手写 CJS + React，通过 slots.register("settings.section", Component) 挂载设置页。
 */

/** client 半注入的服务（插件通过 dsh.client 声明） */
export interface ProjectMemoryClientInject {
  inject: ['slots']
}

/** 记忆分类 type（与宿主端一致，客户端用于 UI 标签） */
export type MemoryType =
  | 'project'
  | 'reference'
  | 'feedback'
  | 'user'
  | 'skill'
  | 'knowledge'

/** 客户端设置页区块注册（settings.section slot） */
export interface ProjectMemorySectionRegistration {
  name: 'settings.section'
  id: 'project-memory'
  order: number
  label: () => string
}

/** 客户端 MemorySection 组件的 props（实际不需要业务注入） */
export interface MemorySectionProps {
  [key: string]: unknown
}
