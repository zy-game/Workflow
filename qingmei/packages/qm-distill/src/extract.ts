/**
 * 规则抽取：把一句话变成候选事实。
 *
 * 设计约束（docs/24 的结论仍然成立）：
 *   - 不做「每轮调用模型抽事实」，成本与污染都不可控；
 *   - 只认少数高置信句式，抽不准就放过，宁缺毋滥；
 *   - 输出带 rule 名，方便回看是哪条规则产生的。
 */

export interface FactCandidate {
  subject: string
  predicate: string
  object: string
  confidence: number
  rule: string
}

interface Rule {
  name: string
  pattern: RegExp
  predicate: string
  confidence: number
  /** 从捕获组里取 object；默认第 1 组 */
  object?: (match: RegExpExecArray) => string
}

const RULES: Rule[] = [
  { name: 'name', pattern: /(?:我(?:的名字)?叫|我的名字是)\s*([^\s，。,.!！?？]{1,12})/, predicate: '叫', confidence: 0.6 },
  { name: 'home', pattern: /我(?:住在|家在|老家在)\s*([^\s，。,.!！?？]{2,20})/, predicate: '住在', confidence: 0.6 },
  { name: 'workplace', pattern: /我在\s*([^\s，。,.!！?？]{2,20})\s*(?:上班|工作)/, predicate: '在…上班', confidence: 0.55 },
  { name: 'like', pattern: /我(?:很|特别|超)?(?:喜欢|爱)\s*([^\s，。,.!！?？]{1,20})/, predicate: '喜欢', confidence: 0.6 },
  { name: 'dislike', pattern: /我(?:不喜欢|讨厌|受不了)\s*([^\s，。,.!！?？]{1,20})/, predicate: '不喜欢', confidence: 0.6 },
  { name: 'allergy', pattern: /我对\s*([^\s，。,.!！?？]{1,12})\s*过敏/, predicate: '过敏', confidence: 0.7 },
  { name: 'birthday', pattern: /我(?:的)?生日(?:是|在)?\s*([0-9]{1,2}\s*月\s*[0-9]{1,2}\s*[日号]?)/, predicate: '生日', confidence: 0.7 },
  { name: 'wake', pattern: /我(?:一般|通常|每天)?\s*([0-9]{1,2}(?::[0-9]{2})?)\s*点?\s*起床/, predicate: '起床时间', confidence: 0.6 },
  { name: 'sleep', pattern: /我(?:一般|通常|每天)?\s*([0-9]{1,2}(?::[0-9]{2})?)\s*点?\s*(?:睡|睡觉)/, predicate: '睡觉时间', confidence: 0.6 },
  { name: 'pet', pattern: /我(?:养了|养)\s*(?:一只|一条)?\s*([^\s，。,.!！?？]{1,12}?(?:猫|狗|鹦鹉|兔子|乌龟|鱼))/, predicate: '养', confidence: 0.6 },
  { name: 'project', pattern: /我(?:在做|在搞|负责)\s*([^\s，。,.!！?？]{2,20})\s*项目/, predicate: '在做项目', confidence: 0.5 },
]

/** 问句、假设、超长与命令句不抽；这些要么不是陈述，要么已经由 qm-agent 的「记住」处理。 */
const SKIP_PATTERNS = [
  /[?？]\s*$/,
  /(?:吗|呢|么)\s*[?？]?$/,
  /(?:什么|怎么|为什么|哪|谁|多少|几点)/,
  /^(?:记住|忘掉|帮我|请|能不能|可以)/,
  /(?:可能|也许|大概|如果|要是|假设)/,
]

const PRONOUNS = new Set(['这个', '那个', '它', '他', '她', '这', '那', '什么'])

export function isDistillable(text: string): boolean {
  const value = String(text ?? '').trim()
  if (value.length < 4 || value.length > 200) return false
  if (SKIP_PATTERNS.some((pattern) => pattern.test(value))) return false
  return !/^\s*(?:记住|忘掉)/.test(value)
}

/** 一条消息可能命中多条规则；按 predicate+object 去重。 */
export function extractCandidates(text: string): FactCandidate[] {
  if (!isDistillable(text)) return []
  const value = String(text).trim()
  const out: FactCandidate[] = []
  const seen = new Set<string>()

  for (const rule of RULES) {
    const match = rule.pattern.exec(value)
    if (!match) continue
    const object = cleanObject((rule.object ?? ((item: RegExpExecArray) => item[1] ?? ''))(match))
    if (!object || PRONOUNS.has(object) || object.length > 30) continue
    const key = `${rule.predicate}|${object}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ subject: '主人', predicate: rule.predicate, object, confidence: rule.confidence, rule: rule.name })
  }
  return out
}

function cleanObject(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[的了]\s*/, '')
    .replace(/[的了啊呀哈呢吧，。,.!！?？]+$/g, '')
    .trim()
}
