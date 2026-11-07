// 极简事件总线：SSE 与跨视图刷新都走它，避免视图之间互相 import。
const listeners = new Map()

export function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(handler)
  return () => {
    listeners.get(type)?.delete(handler)
  }
}

export function emit(type, payload) {
  for (const handler of [...(listeners.get(type) ?? [])]) {
    try {
      handler(payload)
    } catch (error) {
      console.warn(`[bus] ${type} 处理失败`, error)
    }
  }
}
