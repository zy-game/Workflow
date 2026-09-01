import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const mainUrl = new URL('../main.js', import.meta.url)

test('desktop shell records renderer failures and responsiveness', async () => {
  const source = await readFile(mainUrl, 'utf8')
  for (const event of ['console-message', 'did-fail-load', 'render-process-gone', 'unresponsive', 'responsive']) {
    assert.match(source, new RegExp(`['"]${event}['"]`))
  }
})
