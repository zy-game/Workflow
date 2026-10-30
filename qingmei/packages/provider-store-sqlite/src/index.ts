/**
 * @qingmei/provider-store-sqlite —— 用 node:sqlite 实现 store 契约。
 *
 * P1 只用一张通用记录表：`(name, id)` 作主键，记录整体序列化为 JSON。
 * 没有列级索引，`where` 等值过滤与 `order` 排序都在 JS 侧完成。
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { uid, type Migration, type Row } from '@qingmei/core'
import { StoreService, type Collection, type Query } from '@qingmei/service-store'
import type { Context } from 'cordis'

export const name = 'provider-store-sqlite'

export interface Config {
  /** SQLite 数据库文件路径；父目录不存在时自动创建。 */
  path: string
}

const CREATE_RECORDS = `
CREATE TABLE IF NOT EXISTS records (
  name TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (name, id)
)
`

interface StoredRow {
  id: string
  json: string
}

interface OrderRule<T> {
  field: keyof T
  dir: 'asc' | 'desc'
}

export class SqliteStore extends StoreService {
  private readonly path: string
  private db: DatabaseSync | null = null
  private readonly collections = new Map<string, Collection<Row>>()
  /** 写操作串行化（见 runWrite） */
  private writeChain: Promise<unknown> = Promise.resolve()
  /** 当前是否在事务体内；runWrite 据此避免自我等待 */
  inTransaction = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (!config || typeof config.path !== 'string' || config.path.trim() === '') {
      throw new TypeError('[provider-store-sqlite] config.path must be a non-empty string')
    }
    this.path = config.path
    ctx.effect(() => () => this.close(), 'provider-store-sqlite: close database')
  }

  async ready(): Promise<void> {
    if (this.db) return
    if (this.path !== ':memory:') {
      mkdirSync(dirname(resolve(this.path)), { recursive: true })
    }
    const db = new DatabaseSync(this.path)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(CREATE_RECORDS)
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
  }

  close(): void {
    const db = this.db
    if (!db) return
    this.db = null
    db.close()
  }

  collection<T extends Row>(name: string): Collection<T> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('[provider-store-sqlite] collection name must be a non-empty string')
    }
    const existing = this.collections.get(name)
    if (existing) return existing as unknown as Collection<T>
    const collection = new SqliteCollection<T>(this, name)
    this.collections.set(name, collection as unknown as Collection<Row>)
    return collection
  }

  /** 供 collection 实现取连接；未 ready 或已 close 时给出明确错误。 */
  requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error(
        `[provider-store-sqlite] database "${this.path}" is not open; call ready() before using the store`,
      )
    }
    return this.db
  }

  /**
   * 写串行化：同一时刻只允许一个写事务。
   *
   * 注意：事务体内的 await 会让出事件循环，期间其它写入若调用 runWrite 会直接内联执行
   * （视为加入当前事务）。P1 是单用户单进程，写入都在毫秒级，这个近似可接受；
   * 多写入端场景要换成真正的队列实现。
   */
  runWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inTransaction) return Promise.resolve(fn())
    const run = this.writeChain.then(() => fn())
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.runWrite(async () => {
      const db = this.requireDb()
      db.exec('BEGIN IMMEDIATE')
      this.inTransaction = true
      try {
        const result = await fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 回滚失败时保留原始错误，它更有诊断价值
        }
        throw error
      } finally {
        this.inTransaction = false
      }
    })
  }

  async migrate(migrations: Migration[]): Promise<string[]> {
    const db = this.requireDb()
    db.exec('CREATE TABLE IF NOT EXISTS qm_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    const applied = new Set(
      (db.prepare('SELECT id FROM qm_migration').all() as unknown as { id: string }[]).map((row) => row.id),
    )
    const ran: string[] = []
    for (const migration of migrations) {
      if (typeof migration?.id !== 'string' || typeof migration?.sql !== 'string') {
        throw new TypeError('[provider-store-sqlite] migration 必须形如 { id, sql }')
      }
      if (applied.has(migration.id)) continue
      await this.transaction(() => {
        db.exec(migration.sql)
        db.prepare('INSERT INTO qm_migration (id, applied_at) VALUES (?, ?)').run(migration.id, Date.now())
      })
      ran.push(migration.id)
    }
    return ran
  }
}

class SqliteCollection<T extends Row> implements Collection<T> {
  private readonly store: SqliteStore
  private readonly name: string

  constructor(store: SqliteStore, name: string) {
    this.store = store
    this.name = name
  }

  async get(id: string): Promise<T | null> {
    const db = this.store.requireDb()
    const row = db
      .prepare('SELECT id, json FROM records WHERE name = ? AND id = ?')
      .get(this.name, id) as unknown as StoredRow | undefined
    if (!row) return null
    return parseJson<T>(row.json, this.name, row.id)
  }

  async find(query: Query<T> = {}): Promise<T[]> {
    assertWindow(query.limit, query.offset)
    const db = this.store.requireDb()
    const rows = db
      .prepare('SELECT id, json FROM records WHERE name = ? ORDER BY rowid ASC')
      .all(this.name) as unknown as StoredRow[]

    let values = rows.map((row) => parseJson<T>(row.json, this.name, row.id))

    if (query.where) {
      const where = query.where as unknown as Record<string, unknown>
      values = values.filter((value) => matches(value, where))
    }

    if (query.order && query.order.length > 0) {
      const order = query.order as unknown as OrderRule<T>[]
      values.sort((a, b) => compareByOrder(a, b, order))
    }

    const offset = query.offset ?? 0
    const end = query.limit === undefined ? undefined : offset + query.limit
    return values.slice(offset, end)
  }

  async insert(value: Omit<T, 'id'> & { id?: string }): Promise<T> {
    return this.store.runWrite(() => {
      if (value === null || typeof value !== 'object') {
        throw new TypeError(`[provider-store-sqlite] cannot insert a non-object into collection "${this.name}"`)
      }
      const db = this.store.requireDb()
      const id = value.id ?? uid('r')
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError(`[provider-store-sqlite] record id in collection "${this.name}" must be a non-empty string`)
      }

      const record = { ...value, id } as T
      const json = JSON.stringify(record)
      if (json === undefined) {
        throw new TypeError(`[provider-store-sqlite] record "${id}" in collection "${this.name}" is not serializable`)
      }
      try {
        db.prepare('INSERT INTO records (name, id, json, created_at) VALUES (?, ?, ?, ?)').run(
          this.name,
          id,
          json,
          Date.now(),
        )
      } catch (error) {
        throw new Error(
          `[provider-store-sqlite] failed to insert record "${id}" into collection "${this.name}"`,
          { cause: error },
        )
      }
      return record
    })
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    return this.store.runWrite(() => {
      const db = this.store.requireDb()
      const row = db
        .prepare('SELECT id, json FROM records WHERE name = ? AND id = ?')
        .get(this.name, id) as unknown as StoredRow | undefined
      if (!row) {
        throw new Error(
          `[provider-store-sqlite] cannot update record "${id}" in collection "${this.name}": not found`,
        )
      }

      const current = parseJson<T>(row.json, this.name, row.id)
      // id 是主键的一部分，不允许通过 patch 改写。
      const next = { ...current, ...patch, id } as T
      const json = JSON.stringify(next)
      if (json === undefined) {
        throw new TypeError(`[provider-store-sqlite] record "${id}" in collection "${this.name}" is not serializable`)
      }
      db.prepare('UPDATE records SET json = ? WHERE name = ? AND id = ?').run(
        json,
        this.name,
        id,
      )
    })
  }

  async delete(id: string): Promise<boolean> {
    return this.store.runWrite(() => {
      const db = this.store.requireDb()
      const result = db.prepare('DELETE FROM records WHERE name = ? AND id = ?').run(this.name, id)
      return Number(result.changes) > 0
    })
  }

  async count(query: Query<T> = {}): Promise<number> {
    // count 只应用 where；order/limit/offset 是取数窗口，不影响总数。
    const db = this.store.requireDb()
    const rows = db
      .prepare('SELECT id, json FROM records WHERE name = ?')
      .all(this.name) as unknown as StoredRow[]
    const values = rows.map((row) => parseJson<T>(row.json, this.name, row.id))
    if (!query.where) return values.length
    const where = query.where as unknown as Record<string, unknown>
    return values.filter((value) => matches(value, where)).length
  }
}

function parseJson<T>(json: string, collection: string, id: string): T {
  try {
    return JSON.parse(json) as T
  } catch (error) {
    throw new Error(
      `[provider-store-sqlite] record "${id}" in collection "${collection}" is not valid JSON`,
      { cause: error },
    )
  }
}

function matches<T>(value: T, where: Record<string, unknown>): boolean {
  const record = value as unknown as Record<string, unknown>
  for (const key of Object.keys(where)) {
    if (!sameValue(record[key], where[key])) return false
  }
  return true
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  return false
}

function compareByOrder<T>(a: T, b: T, order: OrderRule<T>[]): number {
  for (const rule of order) {
    const left = (a as unknown as Record<string, unknown>)[rule.field as string]
    const right = (b as unknown as Record<string, unknown>)[rule.field as string]
    const diff = compareValues(left, right)
    if (diff !== 0) return rule.dir === 'desc' ? -diff : diff
  }
  return 0
}

function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0
  if (left === undefined || left === null) return 1
  if (right === undefined || right === null) return -1
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0
  }
  const a = JSON.stringify(left)
  const b = JSON.stringify(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function assertWindow(limit: number | undefined, offset: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new TypeError('[provider-store-sqlite] query.limit must be a non-negative integer')
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new TypeError('[provider-store-sqlite] query.offset must be a non-negative integer')
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = new SqliteStore(ctx, config)
  await store.ready()
}
