import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeReply } from '../src/index.ts'

test('sanitizeReply：隐藏 MCP 前缀与工具名', () => {
  const out = sanitizeReply('我调用了 mcp__qingmei__memory_recall 和 `bash` 来查')
  assert.ok(!out.includes('mcp__'))
  assert.ok(!out.includes('`bash`'))
  assert.match(out, /内部信息已隐藏/)
})

test('sanitizeReply：隐藏绝对路径与权限策略', () => {
  const out = sanitizeReply('当前文件策略为 workspace-write，可修改 /opt/qingmei/workspace 下的文件')
  assert.ok(!out.includes('/opt/qingmei/workspace'))
  assert.ok(!out.includes('workspace-write'))
})

test('sanitizeReply：普通回答不受影响', () => {
  const text = '下周三您要去杭州出差。'
  assert.equal(sanitizeReply(text), text)
})
