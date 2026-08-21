import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionPersistence } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { migrateDomains, migrateSessions, runMigrationPair } from '../src/migrate-lib.mjs'
import {
  SESSION_APPLICATION_ID,
  SESSION_SCHEMA_VERSION,
  STORAGE_SCHEMA_VERSION,
  assertSnapshotsStable,
} from '../src/validation.mjs'

const roots = []
const tempBase = process.env.DSH_TEST_TMPDIR || tmpdir()
const descriptors = [
  { name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true },
  { name: 'session_projcache', version: 3, tables: ['sessions'], hasGlobal: false },
  { name: 'message_feedback', version: 0, tables: ['sessions'], hasGlobal: false },
]

afterEach(async () => {
  for (const path of roots.splice(0)) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function tempRoot(prefix) {
  await mkdir(tempBase, { recursive: true })
  const root = await mkdtemp(join(tempBase, prefix))
  roots.push(root)
  return root
}

async function createSessionSource(root, header, events) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  try {
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, events)
  } finally {
    await fiber.dispose()
  }
}

async function exists(path) {
  try { await access(path); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function createDomainSource(root) {
  await mkdir(root, { recursive: true })
  const source = new JsonStorageBackend(root)
  try {
    const workspace = await source.kv.open(descriptors[0])
    await workspace.putRecord('workspaces', 'ws-1', {
      path: '/srv/project', title: 'Project', sessionIds: ['session-1'],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await workspace.setGlobal({ initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] })
    await workspace.close()
  } finally {
    await source.close()
  }
}

function oneTurnLog(attachment) {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: 2,
      data: {
        id: 'one-turn-user', role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image', attachment },
        ],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 3, time: 4,
      data: {
        turn: 1, step: 1,
        message: {
          id: 'one-turn-assistant', role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('migrates a session log and verifies its attachment and SQLite invariants', async () => {
  const root = await tempRoot('dsh-migrate-session-')
  const sourceRoot = join(root, 'sessions')
  const destination = join(root, 'out', 'sessions.db')
  const attachmentRoot = join(root, 'attachments', 'v1')
  const bytes = Buffer.from('fixture attachment bytes')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const objectPath = join(attachmentRoot, 'objects', digest.slice(0, 2), digest)
  await mkdir(dirname(objectPath), { recursive: true })
  await writeFile(objectPath, bytes)
  const attachment = {
    attachmentId: `sha256:${digest}`,
    mediaType: 'image/png', bytes: bytes.byteLength, width: 1, height: 1,
  }
  const header = { version: 0, id: randomUUID(), createdAt: 1000, cwd: root }
  await createSessionSource(sourceRoot, header, oneTurnLog(attachment))

  const result = await migrateSessions({
    sourceRoot,
    destination,
    compression: 'none',
    attachmentRoot,
  })

  assert.equal(result.sessions, 1)
  assert.equal(result.events, 6)
  assert.equal(result.physicalEventRows, 6)
  assert.deepEqual(result.attachments, [{
    attachmentId: attachment.attachmentId,
    bytes: bytes.byteLength,
    sha256: digest,
  }])
  assert.equal(result.sqlite.applicationId, SESSION_APPLICATION_ID)
  assert.equal(result.sqlite.userVersion, SESSION_SCHEMA_VERSION)
  assert.deepEqual(result.sqlite.counts, { persistence_state: 1, sessions: 1, events: 6 })
})

test('RC.8 rejects an RC.7 session database without mutating its schema stamp', async () => {
  const root = await tempRoot('dsh-reject-rc7-')
  const destination = join(root, 'sessions.db')
  const db = new (await import('node:sqlite')).DatabaseSync(destination)
  db.exec(`PRAGMA application_id = ${SESSION_APPLICATION_ID}; PRAGMA user_version = 15; CREATE TABLE legacy (id INTEGER);`)
  db.close()

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SqliteSessionPersistence, { path: destination, journalMode: 'delete' })
  try {
    await assert.rejects(ctx.sessionPersistence.listSnapshots(), /schema version 15, incompatible with this build \(17\)/)
  } finally {
    await fiber.dispose()
  }

  const check = new (await import('node:sqlite')).DatabaseSync(destination, { readOnly: true })
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 15)
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name), ['legacy'])
  check.close()
})

test('migration descriptors match the RC.8 domain packages locked through DSH', async () => {
  const requireFromDsh = createRequire(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url))
  const specs = await Promise.all([
    ['@deepseek-ai/dsh-workspace', 'workspaceDomainSpec'],
    ['@deepseek-ai/dsh-session-projection-cache', 'projectionCacheDomainSpec'],
    ['@deepseek-ai/dsh-message-feedback', 'messageFeedbackDomainSpec'],
  ].map(async ([packageName, exportName]) => {
    const module = await import(requireFromDsh.resolve(packageName))
    const spec = module[exportName]
    return {
      name: spec.name,
      version: spec.version,
      tables: Object.keys(spec.tables),
      hasGlobal: spec.global !== undefined,
    }
  }))

  assert.deepEqual(descriptors, specs)
})

test('refuses a pre-existing session destination', async () => {
  const root = await tempRoot('dsh-migrate-existing-')
  const sourceRoot = join(root, 'sessions')
  const destination = join(root, 'sessions.db')
  await mkdir(sourceRoot, { recursive: true })
  await writeFile(destination, 'do not overwrite')

  await assert.rejects(
    migrateSessions({ sourceRoot, destination, compression: 'none' }),
    /destination must not exist/,
  )
  assert.equal(await (await import('node:fs/promises')).readFile(destination, 'utf8'), 'do not overwrite')
})

test('migrates all explicit JSON storage domains and global state', async () => {
  const root = await tempRoot('dsh-migrate-domains-')
  const sourceRoot = join(root, 'storage')
  const destination = join(root, 'dsh-state.db')
  await mkdir(sourceRoot, { recursive: true })
  const source = new JsonStorageBackend(sourceRoot)
  try {
    const workspace = await source.kv.open(descriptors[0])
    await workspace.putRecord('workspaces', 'ws-1', {
      path: '/srv/project', title: 'Project', sessionIds: ['session-1'],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await workspace.setGlobal({ initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] })
    await workspace.close()

    const projection = await source.kv.open(descriptors[1])
    await projection.putRecord('sessions', 'session-1', {
      identity: { createdAt: 1000, cwd: '/srv/project' },
      rows: { summary: { ver: 1, seq: 5, val: { text: 'done' } } },
    })
    await projection.close()

    const feedback = await source.kv.open(descriptors[2])
    await feedback.putRecord('sessions', 'session-1', {
      session: { createdAt: 1000, cwd: '/srv/project' },
      items: [{
        messageId: 'one-turn-assistant', rating: 'positive', version: randomUUID(),
        createdAt: 1001, updatedAt: 1001,
      }],
    })
    await feedback.close()
  } finally {
    await source.close()
  }

  const result = await migrateDomains({ sourceRoot, destination, descriptors })

  assert.deepEqual(result.domains, { workspace: 1, session_projcache: 1, message_feedback: 1 })
  assert.equal(result.sqlite.applicationId, 0)
  assert.equal(result.sqlite.userVersion, STORAGE_SCHEMA_VERSION)
  assert.deepEqual(result.sqlite.counts, {
    units: 3,
    unit_globals: 1,
    u_workspace_workspaces: 1,
    u_session_projcache_sessions: 1,
    u_message_feedback_sessions: 1,
  })
})

test('pair failure after session copy removes both fresh databases and sidecars', async () => {
  const root = await tempRoot('dsh-migrate-pair-failure-')
  const sourceRoot = join(root, 'sessions')
  const storageRoot = join(root, 'storage')
  const sessionDb = join(root, 'out', 'sessions.db')
  const stateDb = join(root, 'out', 'dsh-state.db')
  const header = { version: 0, id: randomUUID(), createdAt: 1000, cwd: root }
  await createSessionSource(sourceRoot, header, oneTurnLog(null))
  await createDomainSource(storageRoot)

  await assert.rejects(runMigrationPair({
    sessions: { sourceRoot, destination: sessionDb, compression: 'none' },
    domains: {
      sourceRoot: storageRoot,
      destination: stateDb,
      descriptors: [{ name: 'workspace', version: 2, tables: ['missing-table'], hasGlobal: true }],
    },
  }))

  for (const path of [sessionDb, `${sessionDb}-wal`, `${sessionDb}-shm`, stateDb, `${stateDb}-wal`, `${stateDb}-shm`]) {
    assert.equal(await exists(path), false, `${path} should be removed`)
  }
})

test('attachment mutation before final manifest rejects and cleans the pair', async () => {
  const root = await tempRoot('dsh-migrate-attachment-mutation-')
  const sourceRoot = join(root, 'sessions')
  const storageRoot = join(root, 'storage')
  const attachmentRoot = join(root, 'attachments', 'v1')
  const sessionDb = join(root, 'out', 'sessions.db')
  const stateDb = join(root, 'out', 'dsh-state.db')
  const bytes = Buffer.from('stable attachment')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const objectPath = join(attachmentRoot, 'objects', digest.slice(0, 2), digest)
  await mkdir(dirname(objectPath), { recursive: true })
  await writeFile(objectPath, bytes)
  const attachment = { attachmentId: `sha256:${digest}`, bytes: bytes.length, mediaType: 'text/plain' }
  await createSessionSource(sourceRoot, { version: 0, id: randomUUID(), createdAt: 1000, cwd: root }, oneTurnLog(attachment))
  await createDomainSource(storageRoot)

  await assert.rejects(runMigrationPair({
    sessions: { sourceRoot, destination: sessionDb, compression: 'none', attachmentRoot },
    domains: { sourceRoot: storageRoot, destination: stateDb, descriptors },
    beforeFinalManifest: () => writeFile(objectPath, Buffer.from('mutated attachment')),
  }), /attachments pair source manifest differs logically/)

  assert.equal(await exists(sessionDb), false)
  assert.equal(await exists(stateDb), false)
})

test('dry-run creates no destination or parent directory and verify does not rewrite', async () => {
  const root = await tempRoot('dsh-migrate-modes-')
  const sourceRoot = join(root, 'sessions')
  const storageRoot = join(root, 'storage')
  const sessionDb = join(root, 'dry', 'sessions.db')
  const stateDb = join(root, 'dry', 'state.db')
  await createSessionSource(sourceRoot, { version: 0, id: randomUUID(), createdAt: 1000, cwd: root }, oneTurnLog(null))
  await createDomainSource(storageRoot)

  const dry = await runMigrationPair({
    mode: 'dry-run',
    sessions: { sourceRoot, destination: sessionDb, compression: 'none' },
    domains: { sourceRoot: storageRoot, destination: stateDb, descriptors },
  })
  assert.equal(dry.mode, 'dry-run')
  assert.equal(await exists(join(root, 'dry')), false)

  await runMigrationPair({
    sessions: { sourceRoot, destination: sessionDb, compression: 'none' },
    domains: { sourceRoot: storageRoot, destination: stateDb, descriptors },
  })
  const before = await Promise.all([stat(sessionDb), stat(stateDb)])
  const verified = await runMigrationPair({
    mode: 'verify',
    sessions: { sourceRoot, destination: sessionDb, compression: 'none' },
    domains: { sourceRoot: storageRoot, destination: stateDb, descriptors },
  })
  const after = await Promise.all([stat(sessionDb), stat(stateDb)])
  assert.equal(verified.mode, 'verify')
  assert.deepEqual(after.map(value => value.mtimeMs), before.map(value => value.mtimeMs))
})

test('detects a source revision change between snapshots', () => {
  const header = { version: 0, id: 'session-1', createdAt: 1000 }
  assert.throws(
    () => assertSnapshotsStable(
      [{ header, revision: 'source:1' }],
      [{ header, revision: 'source:2' }],
    ),
    /source snapshot differs logically/,
  )
})
