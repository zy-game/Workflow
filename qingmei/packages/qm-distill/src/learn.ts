/**
 * 教训 / 决策抽取（自我进化的写入口）。
 *
 * 和事实抽取分开：事实是「主人是什么样」，教训/决策是「以后该怎么做」。
 * 只认明确句式，宁缺毋滥；产出进同一个复核队列，人点头才写记忆。
 */
export interface LearningCandidate {
  kind: 'lesson' | 'decision'
  text: string
  confidence: number
  rule: string
}

interface Rule {
  name: string
  kind: LearningCandidate['kind']
  pattern: RegExp
  confidence: number
}

const RULES: Rule[] = [
  { name: 'lesson-do-not', kind: 'lesson', pattern: /(以后|下次|今后)(?:不要|别|不再|记得|务必|先)/, confidence: 0.7 },
  { name: 'lesson-pitfall', kind: 'lesson', pattern: /(这次|上次|昨天|刚才)?[^。！？\n]{0,10}(踩坑|教训|问题出在|原因是我|根因是)/, confidence: 0.6 },
  { name: 'decision-pick', kind: 'decision', pattern: /(决定|定了|就按|采用|选型定为|方案定)/, confidence: 0.65 },
  { name: 'decision-tradeoff', kind: 'decision', pattern: /(权衡之后|取舍是|最后选)/, confidence: 0.55 },
]

const SKIP = [/[?？]\s*$/, /(?:如果|要是|假设|可能|也许)/]

/** 按句切分，只保留命中的那句；返回去重后的候选 */
export function extractLearnings(text: string): LearningCandidate[] {
  const value = String(text ?? '').trim()
  if (value.length < 4 || value.length > 500) return []
  if (SKIP.some((pattern) => pattern.test(value))) return []
  const sentences = value
    .split(/(?<=[。！？!?；;\n])/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4)
  const out: LearningCandidate[] = []
  const seen = new Set<string>()
  for (const sentence of sentences.length > 0 ? sentences : [value]) {
    for (const rule of RULES) {
      if (!rule.pattern.test(sentence)) continue
      const key = `${rule.kind}:${sentence}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: rule.kind, text: sentence.slice(0, 200), confidence: rule.confidence, rule: rule.name })
    }
  }
  return out
}
