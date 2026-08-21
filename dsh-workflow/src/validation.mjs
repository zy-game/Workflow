import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { SCHEMA_VERSION as SESSION_SCHEMA_VERSION } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { STORAGE_SQLITE_SCHEMA_VERSION as STORAGE_SCHEMA_VERSION } from '@deepseek-ai/dsh-storage-sqlite'

export const SESSION_APPLICATION_ID = 0x44534850
export { SESSION_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION }

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function assertDeepEqual(actual, expected, label) {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`${label} differs logically`)
}

export function normalizeSnapshots(snapshots) {
  return snapshots.map(({ header, revision }) => ({ header, revision: String(revision) }))
    .sort((a, b) => a.header.id.localeCompare(b.header.id))
}

export function assertSnapshotsStable(before, after) {
  assertDeepEqual(normalizeSnapshots(after), normalizeSnapshots(before), 'source snapshot')
}

export async function sourceManifest(root) {
  const files = []
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        const info = await stat(path)
        files.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: info.size,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await walk(root)
  return files
}

export function assertManifestStable(before, after, label) {
  assertDeepEqual(after, before, `${label} source manifest`)
}

export function assertContiguousEvents(header, events) {
  if (!header || typeof header.id !== 'string' || header.id.length === 0) throw new Error('session header has no id')
  events.forEach((event, index) => {
    if (event.seq !== index) throw new Error(`session ${header.id} has non-contiguous seq at ${index}: ${event.seq}`)
  })
}

export function collectAttachmentRefs(value, out = new Map()) {
  if (Array.isArray(value)) {
    for (const child of value) collectAttachmentRefs(child, out)
  } else if (value !== null && typeof value === 'object') {
    const id = value.attachmentId
    if (typeof id === 'string' && /^sha256:[a-f0-9]{64}$/.test(id)) out.set(id, value)
    for (const child of Object.values(value)) collectAttachmentRefs(child, out)
  }
  return out
}

export async function verifyAttachmentRefs(eventsBySession, attachmentRoot) {
  const refs = collectAttachmentRefs([...eventsBySession.values()])
  const verified = []
  for (const [attachmentId, ref] of refs) {
    const digest = attachmentId.slice('sha256:'.length)
    const bytes = await readFile(join(attachmentRoot, 'objects', digest.slice(0, 2), digest))
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) throw new Error(`attachment ${attachmentId} SHA-256 mismatch`)
    if (Number.isSafeInteger(ref.bytes) && ref.bytes !== bytes.byteLength) {
      throw new Error(`attachment ${attachmentId} byte count mismatch`)
    }
    verified.push({ attachmentId, bytes: bytes.byteLength, sha256: actual })
  }
  return verified
}

export function pragmaScalar(db, name) {
  return db.prepare(`PRAGMA ${name}`).get()[name]
}

export function verifyDatabase(db, { applicationId, userVersion, tables }) {
  const actualApplicationId = pragmaScalar(db, 'application_id')
  if (actualApplicationId !== applicationId) throw new Error(`application_id ${actualApplicationId}, expected ${applicationId}`)
  const actualVersion = pragmaScalar(db, 'user_version')
  if (actualVersion !== userVersion) throw new Error(`user_version ${actualVersion}, expected ${userVersion}`)
  const integrity = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0])
  if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`integrity_check failed: ${integrity.join(', ')}`)
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeys.length !== 0) throw new Error(`foreign_key_check failed with ${foreignKeys.length} row(s)`)
  const counts = {}
  for (const table of tables) counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)
  return { applicationId: actualApplicationId, userVersion: actualVersion, counts }
}
