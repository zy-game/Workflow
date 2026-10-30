// Node 24 把 `node --test <dir>` 的位置参数当作 glob，不再展开目录；
// test/package.json 的 main 指向本文件，让这条验收命令可以只跑一个入口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import { StoreService, type Row } from '@qingmei/service-store'
import * as storePlugin from '../src/index.ts'
import { SqliteStore } from '../src/index.ts'

interface Person extends Row {
  name: string
  age: number
  active: boolean
}

const PEOPLE: Person[] = [
  { id: 'p1', name: 'Ada', age: 36, active: true },
  { id: 'p2', name: 'Bob', age: 20, active: false },
  { id: 'p3', name: 'Cid', age: 30, active: true },
  { id: 'p4', name: 'Dee', age: 30, active: true },
]

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'qm-store-'))
}

async function openStore(path: string): Promise<{ ctx: Context; store: SqliteStore }> {
  const ctx = new Context()
  const store = new SqliteStore(ctx, { path })
  await store.ready()
  return { ctx, store }
}

async function withTempStore<T>(fn: (store: SqliteStore, dir: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir()
  const { store } = await openStore(join(dir, 'store.db'))
  try {
    return await fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function seed(store: SqliteStore): Promise<void> {
  const people = store.collection<Person>('people')
  for (const id of ['p3', 'p1', 'p4', 'p2']) {
    const person = PEOPLE.find((item) => item.id === id)
    assert.ok(person)
    await people.insert(person)
  }
}

test('insert assigns an id and get returns the stored record', async () => {
  await withTempStore(async (store) => {
    const people = store.collection<Person>('people')

    const inserted = await people.insert({ name: 'Ada', age: 36, active: true })
    assert.equal(typeof inserted.id, 'string')
    assert.ok(inserted.id.length > 0)
    assert.deepEqual(await people.get(inserted.id), inserted)
    assert.equal(await people.get('missing'), null)

    const explicit = await people.insert(PEOPLE[1]!)
    assert.equal(explicit.id, 'p2')
    assert.deepEqual(await people.get('p2'), PEOPLE[1])
  })
})

test('find filters by where, sorts by order, and applies offset/limit', async () => {
  await withTempStore(async (store) => {
    await seed(store)
    const people = store.collection<Person>('people')

    const active = await people.find({ where: { active: true }, order: [{ field: 'age', dir: 'desc' }] })
    assert.deepEqual(
      active.map((person) => person.id),
      ['p1', 'p3', 'p4'],
    )

    const topTwo = await people.find({
      where: { active: true },
      order: [{ field: 'age', dir: 'desc' }],
      limit: 2,
    })
    assert.deepEqual(
      topTwo.map((person) => person.id),
      ['p1', 'p3'],
    )

    const page = await people.find({ order: [{ field: 'age', dir: 'asc' }], offset: 1, limit: 2 })
    assert.deepEqual(
      page.map((person) => person.id),
      ['p3', 'p4'],
    )

    const stacked = await people.find({
      where: { active: true },
      order: [
        { field: 'age', dir: 'asc' },
        { field: 'name', dir: 'desc' },
      ],
    })
    assert.deepEqual(
      stacked.map((person) => person.id),
      ['p4', 'p3', 'p1'],
    )

    const both = await people.find({ where: { active: true, age: 30 } })
    assert.deepEqual(
      both.map((person) => person.id).sort(),
      ['p3', 'p4'],
    )
  })
})

test('update merges a patch, keeps the id, and rejects a missing record', async () => {
  await withTempStore(async (store) => {
    await seed(store)
    const people = store.collection<Person>('people')

    await people.update('p3', { age: 31 })
    assert.deepEqual(await people.get('p3'), { id: 'p3', name: 'Cid', age: 31, active: true })

    await people.update('p3', { id: 'renamed' } as Partial<Person>)
    assert.equal((await people.get('p3'))?.id, 'p3')
    assert.equal(await people.get('renamed'), null)

    await assert.rejects(people.update('nobody', { age: 1 }), /not found/)
  })
})

test('delete reports whether a record existed and count follows where', async () => {
  await withTempStore(async (store) => {
    await seed(store)
    const people = store.collection<Person>('people')

    assert.equal(await people.count(), 4)
    assert.equal(await people.count({ where: { active: true } }), 3)

    assert.equal(await people.delete('p4'), true)
    assert.equal(await people.delete('p4'), false)
    assert.equal(await people.get('p4'), null)
    assert.equal(await people.count(), 3)

    await people.delete('p1')
    assert.deepEqual(
      (await people.find()).map((person) => person.id),
      ['p3', 'p2'],
    )
  })
})

test('closing and reopening the same file keeps the data', async () => {
  const dir = makeTempDir()
  const path = join(dir, 'store.db')
  try {
    const first = await openStore(path)
    await seed(first.store)
    assert.equal(await first.store.collection<Person>('people').count(), 4)
    first.store.close()

    const second = await openStore(path)
    try {
      const people = second.store.collection<Person>('people')
      assert.equal(await people.count(), 4)
      assert.deepEqual(await people.get('p1'), PEOPLE[0])
      assert.deepEqual(
        (await people.find({ where: { active: false } })).map((person) => person.id),
        ['p2'],
      )
    } finally {
      second.store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ready creates missing parent directories for the database file', async () => {
  const dir = makeTempDir()
  const path = join(dir, 'nested', 'deeper', 'store.db')
  const { store } = await openStore(path)
  try {
    assert.equal(existsSync(path), true)
    await store.collection<Person>('people').insert(PEOPLE[0]!)
    assert.equal(await store.collection<Person>('people').count(), 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ready enables WAL and creates the records table', async () => {
  const dir = makeTempDir()
  const path = join(dir, 'store.db')
  const { store } = await openStore(path)
  let probe: DatabaseSync | null = null
  try {
    probe = new DatabaseSync(path)
    const mode = probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    assert.equal(mode.journal_mode, 'wal')
    const table = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'")
      .get() as { name: string } | undefined
    assert.equal(table?.name, 'records')
  } finally {
    probe?.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin exposes the store service and closes the database on dispose', async () => {
  const dir = makeTempDir()
  const path = join(dir, 'store.db')
  try {
    const ctx = new Context()
    const fiber = ctx.plugin(storePlugin, { path })
    await fiber
    const store = ctx.store
    assert.ok(store instanceof StoreService)
    await store.collection<Person>('people').insert(PEOPLE[0]!)
    await fiber.dispose()
    await assert.rejects(store.collection<Person>('people').count(), /not open/)

    const reopened = new Context()
    const reopenedFiber = reopened.plugin(storePlugin, { path })
    await reopenedFiber
    try {
      assert.deepEqual(await reopened.store.collection<Person>('people').find(), [PEOPLE[0]])
    } finally {
      await reopenedFiber.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transaction：中途抛错时整批回滚', async () => {
  await withTempStore(async (store) => {
    const people = store.collection<Person>('people')
    await assert.rejects(
      store.transaction(async () => {
        await people.insert({ id: 'rb1', name: 'Rollback', age: 1, active: true })
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.equal(await people.get('rb1'), null)
    assert.equal(await people.count(), 0)
  })
})

test('transaction：成功后多条一次提交', async () => {
  await withTempStore(async (store) => {
    const people = store.collection<Person>('people')
    await store.transaction(async () => {
      await people.insert({ id: 't1', name: 'A', age: 1, active: true })
      await people.insert({ id: 't2', name: 'B', age: 2, active: false })
    })
    assert.equal(await people.count(), 2)
  })
})

test('migrate：只执行未应用过的迁移', async () => {
  await withTempStore(async (store) => {
    const migration = { id: '001-init', sql: 'CREATE TABLE IF NOT EXISTS demo (id TEXT PRIMARY KEY)' }
    assert.deepEqual(await store.migrate([migration]), ['001-init'])
    assert.deepEqual(await store.migrate([migration]), [])
  })
})
