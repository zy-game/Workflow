// config-llm.test.mjs - the server LLM backend is selected from environment
// configuration, not from a product-specific hardcoded path. 'auto' prefers a
// configured CLI and falls back to the direct API; 'cli' requires a command;
// 'direct' ignores any CLI. Malformed CLI configuration fails closed.
import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { WFC_DATA_DIR: os.tmpdir(), WFC_ALLOW_PLAIN_HTTP: '1' };

test('server LLM defaults to the direct API with no CLI configured', () => {
  const { llm } = loadConfig({ ...base });
  assert.equal(llm.backend, 'auto');
  assert.equal(llm.cli, null);
});

test('a configured CLI is carried through with parsed args and timeout', () => {
  const { llm } = loadConfig({
    ...base,
    WFC_LLM_CLI_COMMAND: '/opt/node24/bin/node',
    WFC_LLM_CLI_ARGS: JSON.stringify(['/opt/agent/lib/bin.js', '--headless']),
    WFC_LLM_CLI_TIMEOUT_MS: '90000',
  });
  assert.deepEqual(llm.cli, {
    command: '/opt/node24/bin/node',
    args: ['/opt/agent/lib/bin.js', '--headless'],
    timeoutMs: 90000,
  });
  // auto keeps the CLI available without forcing it on.
  assert.equal(llm.backend, 'auto');
});

test('cli backend requires an explicit command', () => {
  assert.throws(
    () => loadConfig({ ...base, WFC_LLM_BACKEND: 'cli' }),
    /WFC_LLM_BACKEND=cli requires WFC_LLM_CLI_COMMAND/,
  );
});

test('unknown backends, malformed args, and non-integer timeouts are rejected', () => {
  assert.throws(
    () => loadConfig({ ...base, WFC_LLM_BACKEND: 'dsh-cli' }),
    /WFC_LLM_BACKEND must be one of auto, cli, direct/,
  );
  assert.throws(
    () => loadConfig({ ...base, WFC_LLM_CLI_COMMAND: 'node', WFC_LLM_CLI_ARGS: '{"a":1}' }),
    /WFC_LLM_CLI_ARGS must be a JSON array of strings/,
  );
  assert.throws(
    () => loadConfig({ ...base, WFC_LLM_CLI_COMMAND: 'node', WFC_LLM_CLI_ARGS: '["ok",7]' }),
    /WFC_LLM_CLI_ARGS must be a JSON array of strings/,
  );
  assert.throws(
    () => loadConfig({ ...base, WFC_LLM_CLI_COMMAND: 'node', WFC_LLM_CLI_TIMEOUT_MS: 'soon' }),
    /WFC_LLM_CLI_TIMEOUT_MS must be an integer/,
  );
});
