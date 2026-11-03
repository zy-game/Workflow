import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BubbleQueue,
  SseParser,
  bubbleForEvent,
  eventsUrl,
  mapHistory,
  normalizeServerUrl,
  textOfBlocks,
} from '../renderer/core.mjs'

test('SSE 解析：跨 chunk、多行 data、注释', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('event: assistant\ndata: {"a"'), [])
  const events = parser.push(':1}\n\n')
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'assistant')
  assert.equal(events[0].data, '{"a":1}')

  const multi = new SseParser().push('event: x\ndata: line1\ndata: line2\n\n')
  assert.equal(multi[0].data, 'line1\nline2')

  const withComment = new SseParser().push(': ping\n\nevent: ready\ndata: {"ok":true}\n\n')
  assert.equal(withComment.length, 1)
  assert.equal(withComment[0].event, 'ready')
})

test('blocks 取文本', () => {
  assert.equal(textOfBlocks([{ type: 'text', text: 'a' }, { type: 'image', alt: '截图' }]), 'a\n[图片] 截图')
  assert.equal(textOfBlocks([{ type: 'image' }]), '')
  assert.equal(textOfBlocks(null), '')
})

test('事件转气泡：assistant / 审批 / 失败任务', () => {
  const assistant = bubbleForEvent({
    event: 'assistant',
    data: JSON.stringify({ channel: 'web', blocks: [{ type: 'text', text: '该喝水了' }] }),
  })
  assert.deepEqual(assistant, { text: '该喝水了', kind: 'message', channel: 'web' })

  assert.equal(bubbleForEvent({ event: 'assistant', data: JSON.stringify({ blocks: [] }) }), null)
  assert.deepEqual(bubbleForEvent({ event: 'approval-requested', data: JSON.stringify({ title: '部署' }) }), {
    text: '等你确认：部署',
    kind: 'approval',
  })
  assert.deepEqual(
    bubbleForEvent({ event: 'task-finished', data: JSON.stringify({ status: 'failed', title: '周报' }) }),
    { text: '任务失败：周报', kind: 'error' },
  )
  assert.equal(bubbleForEvent({ event: 'task-finished', data: JSON.stringify({ status: 'done' }) }), null)
  assert.equal(bubbleForEvent({ event: 'delta', data: '{}' }), null)
})

test('气泡队列：先进先出、过期清理', () => {
  let clock = 1000
  const queue = new BubbleQueue({ ttlMs: 100, clock: () => clock })
  queue.add('第一条')
  queue.add('第二条')
  assert.equal(queue.current().text, '第一条')
  queue.dismiss()
  assert.equal(queue.current().text, '第二条')
  clock += 200
  assert.equal(queue.current(), null)
  assert.equal(queue.size, 0)
})

test('地址与令牌：规整、拒绝非法、SSE query 编码', () => {
  assert.equal(normalizeServerUrl('http://127.0.0.1:7410/'), 'http://127.0.0.1:7410')
  assert.equal(normalizeServerUrl('https://qm.example.com/api/'), 'https://qm.example.com/api')
  assert.equal(normalizeServerUrl('ftp://x'), null)
  assert.equal(normalizeServerUrl('not a url'), null)
  const url = eventsUrl('http://127.0.0.1:7410', 'a b&c')
  assert.ok(url.includes('/api/v1/events'))
  assert.ok(url.includes('token=a+b%26c'))
})

test('历史消息映射', () => {
  assert.deepEqual(
    mapHistory([
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在的' },
      { role: 'system', text: '忽略' },
      { role: 'assistant', text: '   ' },
    ]),
    [
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在的' },
    ],
  )
})
