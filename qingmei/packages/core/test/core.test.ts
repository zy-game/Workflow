import test from 'node:test'
import assert from 'node:assert/strict'
import { uid, textOf, clampToCapabilities, type ChannelCapabilities, type Block } from '../src/index.ts'

test('uid: 前缀 + 单调时间前缀 + 唯一性', () => {
  const a = uid('msg')
  const b = uid('msg')
  assert.match(a, /^msg_[0-9a-z]{9}[0-9a-z]{6}$/)
  assert.notEqual(a, b)
})

test('textOf: 把各类 block 拍平', () => {
  const blocks: Block[] = [
    { type: 'text', text: '你好' },
    { type: 'markdown', text: '**粗体**' },
    { type: 'image', url: 'x', alt: '猫' },
    { type: 'card', title: '卡片', fields: [{ label: '进度', value: '70%' }] },
    { type: 'actions', buttons: [{ id: 'a', label: '确认' }, { id: 'b', label: '取消' }] },
    { type: 'quote', messageId: 'm1', text: '原话' },
  ]
  const out = textOf(blocks)
  assert.match(out, /你好/)
  assert.match(out, /\*\*粗体\*\*/)
  assert.match(out, /\[图片\] 猫/)
  assert.match(out, /进度: 70%/)
  assert.match(out, /1\. 确认/)
  assert.match(out, /> 原话/)
})

test('clampToCapabilities: 不支持富文本时降级为 text', () => {
  const caps: ChannelCapabilities = {
    markdown: false,
    card: false,
    button: false,
    image: true,
    voice: true,
    file: true,
    edit: false,
    thread: false,
    maxTextLength: 20,
  }
  const input: Block[] = [
    { type: 'markdown', text: '# 标题' },
    { type: 'card', title: 'T', fields: [{ label: 'k', value: 'v' }] },
    { type: 'actions', buttons: [{ id: 'a', label: '好' }] },
  ]
  const out = clampToCapabilities(input, caps)
  assert.ok(out.every((b) => b.type === 'text'))
  assert.equal(textOf(out), '# 标题\nT\nk: v\n1. 好')
})

test('clampToCapabilities: 超长文本按 maxTextLength 切分', () => {
  const caps: ChannelCapabilities = {
    markdown: true,
    card: true,
    button: true,
    image: true,
    voice: true,
    file: true,
    edit: true,
    thread: true,
    maxTextLength: 5,
  }
  const out = clampToCapabilities([{ type: 'text', text: 'abcdefghij' }], caps)
  assert.equal(out.length, 2)
  assert.equal(textOf(out), 'abcde\nfghij')
})
