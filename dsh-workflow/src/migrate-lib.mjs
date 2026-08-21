import { access, constants, mkdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionPersistence } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  SESSION_APPLICATION_ID,
  SESSION_SCHEMA_VERSION,
  STORAGE_SCHEMA_VERSION,
  assertContiguousEvents,
  assertDeepEqual,
  assertManifestStable,
  assertSnapshotsStable,
  sourceManifest,
  verifyAttachmentRefs,
  verifyDatabase,
} from './validation.mjs'

const MODES = new Set(['migrate', 'dry-run', 'verify'])

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function mustNotExist(path) {
  if (await pathExists(path)) throw new Error(`destination must not exist: ${path}`)
}

async function mustExist(path) {
  if (!(await pathExists(path))) throw new Error(`destination does not exist: ${path}`)
}

async function mustBeDirectory(path) {
  if (!(await stat(path)).isDirectory()) throw new Error(`source is not a directory: ${path}`)
}

async function mountPersistence(Plugin, config) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(Plugin, config)
  return { persistence: ctx.sessionPersistence, dispose: () => fiber.dispose() }
}

function assertMode(mode) {
  if (!MODES.has(mode)) throw new Error(`unsupported migration mode: ${mode}`)
}

async function removeDatabase(path) {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map(file => rm(file, { force: true })))
}

async function inspectSessionSource({ sourceRoot, compression, attachmentRoot }) {
  const manifestBefore = await sourceManifest(sourceRoot)
  const sourceMount = await mountPersistence(JsonlSessionPersistence, { root: sourceRoot, compression })
  const logicalBySession = new Map()
  const eventsBySession = new Map()
  let snapshots
  try {
    snapshots = await sourceMount.persistence.listSnapshots()
    for (const { header } of [...snapshots].sort((a, b) => a.header.id.localeCompare(b.header.id))) {
      const logical = await sourceMount.persistence.readFrom(header.id, 0)
      assertDeepEqual(logical.meta, header, `session ${header.id} header`)
      assertContiguousEvents(logical.meta, logical.events)
      logicalBySession.set(header.id, structuredClone(logical))
      eventsBySession.set(header.id, logical.events)
    }
    assertSnapshotsStable(snapshots, await sourceMount.persistence.listSnapshots())
  } finally {
    await sourceMount.dispose()
  }
  const attachments = attachmentRoot ? await verifyAttachmentRefs(eventsBySession, attachmentRoot) : []
  const manifestAfter = await sourceManifest(sourceRoot)
  assertManifestStable(manifestBefore, manifestAfter, 'sessions')
  return { snapshots, logicalBySession, attachments, manifest: manifestBefore }
}

async function verifySessionTarget(destination, sourceData) {
  const targetMount = await mountPersistence(SqliteSessionPersistence, { path: destination, journalMode: 'wal' })
  try {
    const targetSnapshots = await targetMount.persistence.listSnapshots()
    if (targetSnapshots.length !== sourceData.snapshots.length) throw new Error('destination session count differs')
    for (const { header } of sourceData.snapshots) {
      assertDeepEqual(
        await targetMount.persistence.readFrom(header.id, 0),
        sourceData.logicalBySession.get(header.id),
        `session ${header.id}`,
      )
    }
  } finally {
    await targetMount.dispose()
  }

  const db = new DatabaseSync(destination, { readOnly: true })
  try {
    const sqlite = verifyDatabase(db, {
      applicationId: SESSION_APPLICATION_ID,
      userVersion: SESSION_SCHEMA_VERSION,
      tables: ['persistence_state', 'sessions', 'events'],
    })
    const seqErrors = db.prepare(`
      SELECT session_id, MIN(seq) AS min_seq, MAX(seq) AS max_seq, COUNT(*) AS count
      FROM events GROUP BY session_id
      HAVING min_seq <> 0 OR max_seq <> count - 1
    `).all()
    if (seqErrors.length) throw new Error(`destination has non-contiguous event seqs for ${seqErrors.length} session(s)`)
    return sqlite
  } finally {
    db.close()
  }
}

export async function migrateSessions({ sourceRoot, destination, compression = 'zstd', attachmentRoot, mode = 'migrate' }) {
  assertMode(mode)
  await mustBeDirectory(sourceRoot)
  if (mode === 'verify') await mustExist(destination)
  else await mustNotExist(destination)
  const sourceData = await inspectSessionSource({ sourceRoot, compression, attachmentRoot })
  if (mode === 'dry-run') {
    return { mode, sessions: sourceData.snapshots.length, attachments: sourceData.attachments, manifest: sourceData.manifest }
  }

  let created = false
  try {
    if (mode === 'migrate') {
      await mkdir(dirname(destination), { recursive: true })
      const targetMount = await mountPersistence(SqliteSessionPersistence, { path: destination, journalMode: 'wal' })
      created = true
      try {
        for (const { header } of sourceData.snapshots) {
          const logical = sourceData.logicalBySession.get(header.id)
          await targetMount.persistence.create(structuredClone(logical.meta))
          if (logical.events.length > 0) await targetMount.persistence.append(header.id, structuredClone(logical.events))
        }
      } finally {
        await targetMount.dispose()
      }
    }
    const sqlite = await verifySessionTarget(destination, sourceData)
    assertManifestStable(sourceData.manifest, await sourceManifest(sourceRoot), 'sessions')
    return {
      mode,
      sessions: sourceData.snapshots.length,
      events: [...sourceData.logicalBySession.values()].reduce((sum, session) => sum + session.events.length, 0),
      physicalEventRows: sqlite.counts.events,
      attachments: sourceData.attachments,
      manifest: sourceData.manifest,
      sqlite,
    }
  } catch (error) {
    if (created) await removeDatabase(destination)
    throw error
  }
}

async function inspectDomainSource(sourceRoot, descriptors) {
  const manifestBefore = await sourceManifest(sourceRoot)
  const source = new JsonStorageBackend(sourceRoot)
  const snapshots = new Map()
  try {
    for (const descriptor of descriptors) {
      const unit = await source.kv.open(descriptor)
      try { snapshots.set(descriptor.name, structuredClone(await unit.loadAll())) }
      finally { await unit.close() }
    }
    for (const descriptor of descriptors) {
      const unit = await source.kv.open(descriptor)
      try { assertDeepEqual(await unit.loadAll(), snapshots.get(descriptor.name), `source domain ${descriptor.name} second snapshot`) }
      finally { await unit.close() }
    }
  } finally {
    await source.close()
  }
  const manifestAfter = await sourceManifest(sourceRoot)
  assertManifestStable(manifestBefore, manifestAfter, 'domains')
  return { snapshots, manifest: manifestBefore }
}

async function verifyDomainTarget(destination, descriptors, sourceData) {
  const target = new SqliteStorageBackend({ path: destination, journalMode: 'wal' })
  try {
    for (const descriptor of descriptors) {
      const unit = await target.kv.open(descriptor)
      try { assertDeepEqual(await unit.loadAll(), sourceData.snapshots.get(descriptor.name), `domain ${descriptor.name}`) }
      finally { await unit.close() }
    }
  } finally {
    await target.close()
  }
  const db = new DatabaseSync(destination, { readOnly: true })
  try {
    const tables = ['units', 'unit_globals', ...descriptors.flatMap(d => d.tables.map(t => `u_${d.name}_${t}`))]
    return verifyDatabase(db, { applicationId: 0, userVersion: STORAGE_SCHEMA_VERSION, tables })
  } finally {
    db.close()
  }
}

export async function migrateDomains({ sourceRoot, destination, descriptors, mode = 'migrate' }) {
  assertMode(mode)
  await mustBeDirectory(sourceRoot)
  if (!Array.isArray(descriptors) || descriptors.length === 0) throw new Error('at least one explicit domain descriptor is required')
  if (mode === 'verify') await mustExist(destination)
  else await mustNotExist(destination)
  const sourceData = await inspectDomainSource(sourceRoot, descriptors)
  const copied = Object.fromEntries(descriptors.map(descriptor => {
    const snapshot = sourceData.snapshots.get(descriptor.name)
    return [descriptor.name, Object.values(snapshot.tables).reduce((sum, records) => sum + Object.keys(records).length, 0)]
  }))
  if (mode === 'dry-run') return { mode, domains: copied, manifest: sourceData.manifest }

  let created = false
  try {
    if (mode === 'migrate') {
      await mkdir(dirname(destination), { recursive: true })
      const target = new SqliteStorageBackend({ path: destination, journalMode: 'wal' })
      created = true
      try {
        for (const descriptor of descriptors) {
          const targetUnit = await target.kv.open(descriptor)
          const snapshot = sourceData.snapshots.get(descriptor.name)
          try {
            for (const table of descriptor.tables) {
              for (const [key, value] of Object.entries(snapshot.tables[table] ?? {})) {
                await targetUnit.putRecord(table, key, structuredClone(value))
              }
            }
            if (descriptor.hasGlobal && snapshot.global !== null) await targetUnit.setGlobal(structuredClone(snapshot.global))
          } finally {
            await targetUnit.close()
          }
        }
      } finally {
        await target.close()
      }
    }
    const sqlite = await verifyDomainTarget(destination, descriptors, sourceData)
    assertManifestStable(sourceData.manifest, await sourceManifest(sourceRoot), 'domains')
    return { mode, domains: copied, manifest: sourceData.manifest, sqlite }
  } catch (error) {
    if (created) await removeDatabase(destination)
    throw error
  }
}

export async function runMigrationPair({ sessions, domains, mode = 'migrate', beforeFinalManifest }) {
  assertMode(mode)
  if (mode !== 'verify') {
    await mustNotExist(sessions.destination)
    await mustNotExist(domains.destination)
  }
  const sourceManifests = {
    sessions: await sourceManifest(sessions.sourceRoot),
    domains: await sourceManifest(domains.sourceRoot),
    attachments: sessions.attachmentRoot
      ? await sourceManifest(`${sessions.attachmentRoot}/objects`)
      : null,
  }
  const fresh = mode === 'migrate'
  const created = { sessions: false, domains: false }
  try {
    const sessionResult = await migrateSessions({ ...sessions, mode })
    created.sessions = fresh
    const domainResult = await migrateDomains({ ...domains, mode })
    created.domains = fresh
    await beforeFinalManifest?.()
    assertManifestStable(sourceManifests.sessions, await sourceManifest(sessions.sourceRoot), 'sessions pair')
    assertManifestStable(sourceManifests.domains, await sourceManifest(domains.sourceRoot), 'domains pair')
    if (sourceManifests.attachments) {
      assertManifestStable(
        sourceManifests.attachments,
        await sourceManifest(`${sessions.attachmentRoot}/objects`),
        'attachments pair',
      )
    }
    return { mode, sourceManifests, sessionResult, domainResult }
  } catch (error) {
    await Promise.allSettled([
      created.sessions ? removeDatabase(sessions.destination) : Promise.resolve(),
      created.domains ? removeDatabase(domains.destination) : Promise.resolve(),
    ])
    throw error
  }
}
