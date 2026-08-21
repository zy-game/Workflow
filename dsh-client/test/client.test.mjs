import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { CacheRepository, cacheRoot } from '../vendor/dsh-neotui/src/cache.js'
import { createLoginForm } from '../vendor/dsh-neotui/src/login.js'

const roots = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-client-'))
  roots.push(root)
  return root
}

test('password input is masked and both credential fields clear before login settles', async () => {
  let release
  let received
  const pending = new Promise(resolve => { release = resolve })
  const form = createLoginForm({
    async login(email, password) {
      received = { email, password }
      await pending
    },
  })
  form.email.setValue('user@example.com')
  form.password.setValue('not-persisted')

  const submit = form.submit()
  assert.equal(form.password.masked, true)
  assert.equal(form.email.value, '')
  assert.equal(form.password.value, '')
  assert.deepEqual(received, { email: 'user@example.com', password: 'not-persisted' })
  release()
  await submit
})

test('cache accepts rebuildable projections and cursor but refuses credentials', async () => {
  const path = join(await tempRoot(), 'cache.db')
  let cache = new CacheRepository(path)
  cache.put('projections', 's1', { title: 'Session' })
  cache.put('cursor', 's1', { lastSeq: 9 })
  assert.deepEqual(cache.get('projections', 's1'), { title: 'Session' })
  assert.deepEqual(cache.get('cursor', 's1'), { lastSeq: 9 })
  assert.throws(() => cache.put('projections', 'access_token', 'secret'), /credentials are forbidden/)
  assert.throws(() => cache.put('projections', 's2', { authorization: 'Bearer secret' }), /credentials are forbidden/)
  cache.delete('cursor', 's1')
  assert.equal(cache.get('cursor', 's1'), null)
  cache.close()

  cache = CacheRepository.rebuild(path)
  assert.equal(cache.get('projections', 's1'), null)
  cache.close()
})

test('cache resolves to client-specific roots and remains explicitly overridable', () => {
  assert.equal(cacheRoot({ DSH_TUI_CACHE_HOME: 'D:/managed/cache' }, 'win32'), 'D:/managed/cache')
  assert.equal(cacheRoot({ LOCALAPPDATA: 'C:/Users/test/AppData/Local' }, 'win32'), join('C:/Users/test/AppData/Local', 'DshTui'))
  assert.equal(cacheRoot({ XDG_CACHE_HOME: '/var/cache/user' }, 'linux'), join('/var/cache/user', 'dsh-tui'))
  assert.throws(() => cacheRoot({}, 'win32'), /LOCALAPPDATA/)
})

test('client resolves the controlled fork and public gateway defaults', async () => {
  const root = new URL('..', import.meta.url)
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const fork = JSON.parse(await readFile(new URL('vendor/dsh-neotui/package.json', root), 'utf8'))
  const apiSource = await readFile(new URL('vendor/dsh-neotui/src/api.js', root), 'utf8')
  const cliSource = await readFile(new URL('vendor/dsh-neotui/src/cli.js', root), 'utf8')
  const binSource = await readFile(new URL('vendor/dsh-neotui/bin/dsh-tui.js', root), 'utf8')
  const launcher = await readFile(new URL('Start-DshTui.ps1', root), 'utf8')
  const releaseBuilder = await readFile(new URL('scripts/build-windows-sea.mjs', root), 'utf8')

  assert.equal(packageJson.dependencies['dsh-neotui'], 'file:vendor/dsh-neotui')
  assert.equal(fork.version, '0.3.0-dsh.1')
  assert.match(apiSource, /https:\/\/139\.155\.78\.241:8710\/dsh/)
  assert.match(cliSource, /DEFAULT_BASE = "https:\/\/139\.155\.78\.241:8710\/dsh"/)
  assert.match(binSource, /parseCli\(process\.argv\.slice\(2\)\)/)
  assert.match(launcher, /https:\/\/139\.155\.78\.241:8710\/dsh/)
  assert.doesNotMatch(launcher, /ssh|tunnel|LocalPort|KeyPath/i)
  assert.match(launcher, /HttpMethod\]::Head/)
  assert.match(launcher, /HttpClientHandler\]::new\(\)/)
  assert.doesNotMatch(launcher, /DangerousAcceptAnyServerCertificateValidator|ServerCertificateCustomValidationCallback/)
  assert.match(launcher, /AuthenticationAttempted = \$false/)
  assert.match(launcher, /LOCALAPPDATA/)
  assert.match(launcher, /DSH_TUI_CACHE_HOME/)
  assert.doesNotMatch(launcher, /client-login|session\.(create|cancel)|api\/respond/)
  assert.doesNotMatch(releaseBuilder, /banner:\s*\{\s*js:\s*["']#!\/usr\/bin\/env node/)
  assert.match(releaseBuilder, /execFileAsync\(exePath, \["--version"\]/)
  assert.match(releaseBuilder, /execFileAsync\(exePath, \["--help"\]/)
  assert.ok(releaseBuilder.indexOf('await rcedit(exePath') < releaseBuilder.indexOf('await inject(exePath'))
  assert.ok(releaseBuilder.indexOf('execFileAsync(exePath, ["--version"]') < releaseBuilder.indexOf('makeZip(zipPath'))
})
