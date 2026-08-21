import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

async function patch(name) {
  return readFile(join(root, name), 'utf8')
}

for (const name of ['server-patch.yml', 'patch-test.yml']) {
  test(`${name} disables JSONL persistence and separates all SQLite roles`, async () => {
    const text = await patch(name)
    assert.match(text, /- id: session-persistence-jsonl\s+name: '@deepseek-ai\/dsh-session-persistence-jsonl'\s+disabled: true/)
    assert.match(text, /- insert:\s+- id: session-persistence-sqlite\s+name: '@deepseek-ai\/dsh-session-persistence-sqlite'\s+config:/)
    assert.match(text, /id: session-query-sqlite\s+config:\s+path:/)
    assert.match(text, /id: storage-sqlite\s+name: '@deepseek-ai\/dsh-storage-sqlite'/)
    assert.match(text, /workspace: sqlite/)
    assert.match(text, /session_projcache: sqlite/)
    assert.match(text, /message_feedback: sqlite/)

    const sessionPath = text.match(/DSH_SESSION_DB[^\n]*'([^']+)'/)?.[1] ?? text.match(/session-persistence-sqlite[\s\S]*?path:\s*([^\n]+)/)?.[1]
    const statePath = text.match(/DSH_STATE_DB[^\n]*'([^']+)'/)?.[1] ?? text.match(/storage-sqlite[\s\S]*?path:\s*([^\n]+)/)?.[1]
    const queryPath = text.match(/DSH_SESSION_QUERY_DB[^\n]*'([^']+)'/)?.[1] ?? text.match(/session-query-sqlite[\s\S]*?path:\s*([^\n]+)/)?.[1]
    assert.ok(sessionPath && statePath && queryPath)
    assert.equal(new Set([sessionPath, statePath, queryPath]).size, 3)
  })
}

test('production patch configures the existing internal workflow context provider only', async () => {
  const text = await patch('server-patch.yml')
  assert.match(text, /- id: workflow-context\s+name: file:\/\/\/home\/ubuntu\/\.dsh\/plugins\/workflow-context\.mjs\s+config:/)
  assert.match(text, /providerUrl:\s*http:\/\/127\.0\.0\.1:18711\/api\/internal\/v1\/workflow\/context/)
  assert.doesNotMatch(text, /\n    - id: workflow-context(?:\n|$)/)
  assert.doesNotMatch(text, /workflowDb:/)
  assert.doesNotMatch(text, /workflowHome:/)
  assert.doesNotMatch(text, /\/var\/lib\/dsh/)
})

test('all production SQLite defaults live under the DSH user home', async () => {
  const text = await patch('server-patch.yml')
  assert.match(text, /DSH_SESSION_DB[^\n]*'\/home\/ubuntu\/\.dsh\/sessions\.db'/)
  assert.match(text, /DSH_STATE_DB[^\n]*'\/home\/ubuntu\/\.dsh\/dsh-state\.db'/)
  assert.match(text, /DSH_SESSION_QUERY_DB[^\n]*'\/home\/ubuntu\/\.dsh\/session-query\.db'/)
})
