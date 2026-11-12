/**
 * 规则抽取的测试：每条规则的正例 + 该被挡掉的反例。
 * 抽错一条事实比漏抽十条代价高，所以反例和正例一样重要。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidates, isDistillable } from '../src/extract.ts'

function pick(text: string) {
  return extractCandidates(text).map((item) => `${item.predicate}=${item.object}`)
}

test('自我介绍与住址', () => {
  assert.deepEqual(pick('我叫张三'), ['叫=张三'])
  assert.deepEqual(pick('我住在杭州西湖区'), ['住在=杭州西湖区'])
  assert.deepEqual(pick('我在腾讯上班'), ['在…上班=腾讯'])
})

test('喜好与厌恶', () => {
  assert.deepEqual(pick('我很喜欢手冲咖啡'), ['喜欢=手冲咖啡'])
  assert.deepEqual(pick('我不喜欢美式咖啡'), ['不喜欢=美式咖啡'])
})

test('健康与生日', () => {
  assert.deepEqual(pick('我对花生过敏'), ['过敏=花生'])
  assert.deepEqual(pick('我的生日是5月12日'), ['生日=5月12日'])
})

test('作息', () => {
  assert.deepEqual(pick('我一般23点睡觉'), ['睡觉时间=23'])
  assert.deepEqual(pick('我每天7点起床'), ['起床时间=7'])
})

test('宠物与项目', () => {
  assert.deepEqual(pick('我养了一只橘猫'), ['养=橘猫'])
  assert.deepEqual(pick('我在做青梅项目'), ['在做项目=青梅'])
})

test('一句话命中多条规则时按 predicate+object 去重', () => {
  const items = extractCandidates('我叫张三，我很喜欢手冲咖啡')
  assert.deepEqual(items.map((item) => item.rule).sort(), ['like', 'name'])
})

test('问句不抽', () => {
  assert.deepEqual(pick('我喜欢什么咖啡？'), [])
  assert.deepEqual(pick('我叫什么来着'), [])
})

test('假设/猜测不抽', () => {
  assert.deepEqual(pick('我可能喜欢咖啡'), [])
})

test('「记住/忘掉」由 qm-agent 处理，不在这里重复抽', () => {
  assert.deepEqual(pick('记住：我喜欢手冲咖啡'), [])
  assert.deepEqual(pick('忘掉我喜欢手冲咖啡'), [])
})

test('代词与超短文本不抽', () => {
  assert.deepEqual(pick('我喜欢它'), [])
  assert.equal(isDistillable('你好'), false)
  assert.equal(isDistillable('我住在'), false)
})

test('confidence 落在 0.5–0.7，规则名可追溯', () => {
  const [candidate] = extractCandidates('我对花生过敏')
  assert.equal(candidate?.rule, 'allergy')
  assert.ok((candidate?.confidence ?? 0) >= 0.5 && (candidate?.confidence ?? 1) <= 0.7)
})
