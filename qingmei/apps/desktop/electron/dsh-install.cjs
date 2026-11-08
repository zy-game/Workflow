/**
 * Install Qingmei DSH plugins into the local DSH desktop profile.
 *
 * DSH's own CLI refuses `--profile desktop` ("managed exclusively by the
 * Electron application"), so this helper writes the same profile surface the
 * desktop runtime consumes: node_modules package, profile bundle list, and an
 * id-targeted cordis patch. It is intentionally idempotent.
 */
const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function dshInstalled() {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['dsh'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (result.status === 0) return true
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'dsh', 'dsh.exe'),
  ]
  return candidates.some((candidate) => candidate && existsSync(candidate))
}

function copyPackage(source, target) {
  mkdirSync(target, { recursive: true })
  cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (file) => !/[\\/](test|node_modules)([\\/]|$)/.test(file) && !file.endsWith('.tgz'),
  })
}

function addBundle(profilePackage, name) {
  profilePackage.dsh ??= {}
  profilePackage.dsh.profile ??= {}
  profilePackage.dsh.profile.bundles ??= []
  if (!profilePackage.dsh.profile.bundles.includes(name)) {
    profilePackage.dsh.profile.bundles.push(name)
  }
}

function appendPatch(file, block) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (current.includes(`id: ${block.id}\n`)) return
  writeFileSync(file, `${current.trimEnd()}\n${block.text.trimEnd()}\n`, 'utf8')
}

function installOne({ profile, source, name, patch }) {
  const target = path.join(profile, 'node_modules', ...name.split('/'))
  if (!existsSync(source)) return false
  copyPackage(source, target)
  const profilePackageFile = path.join(profile, 'package.json')
  const profilePackage = JSON.parse(readFileSync(profilePackageFile, 'utf8'))
  profilePackage.dependencies ??= {}
  profilePackage.dependencies[name] = `file:${target}`
  addBundle(profilePackage, name)
  writeFileSync(profilePackageFile, `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8')
  appendPatch(path.join(profile, 'cordis.patch.yml'), patch)
  return true
}

function defaultWorkspace(dshHome, home) {
  try {
    const file = path.join(dshHome, 'storages', 'workspace.json')
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const workspaces = Object.values(data?.tables?.workspaces ?? {})
        .filter((item) => typeof item?.path === 'string')
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      if (workspaces[0]?.path) return workspaces[0].path
    }
  } catch {}
  return path.join(home, 'Workflow')
}
function installDshPlugins({ home = os.homedir(), token, api, workspacePath, pluginRoot } = {}) {
  if (!dshInstalled()) return { ok: true, skipped: 'dsh-not-installed' }
  if (!token || !api) return { ok: false, error: '缺少服务器地址或令牌' }

  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'desktop')
  if (!existsSync(path.join(profile, 'package.json'))) {
    return { ok: true, skipped: 'dsh-desktop-profile-not-found' }
  }

  const devRoot = path.resolve(__dirname, '..', '..')
  const packagedRoot = path.join(process.resourcesPath || '', 'dsh-plugins')
  const root = pluginRoot || (existsSync(path.join(devRoot, 'dsh-companion')) ? devRoot : packagedRoot)
  const workspace = workspacePath || process.env.QINGMEI_WORKSPACE || defaultWorkspace(dshHome, home)
  const companion = installOne({
    profile,
    source: path.join(root, 'dsh-companion'),
    name: '@qingmei/dsh-companion',
    patch: {
      id: 'qingmei-dsh-companion',
      text: `- id: qingmei-dsh-companion
  name: "@qingmei/dsh-companion"
  config:
    enabled: true
    api: "${String(api).replace(/"/g, '')}"
    token: "${String(token).replace(/"/g, '')}"
    deviceId: "dev-dsh-${os.hostname().replace(/[^a-zA-Z0-9]+/g, '-')}"
    workspacePath: "${String(workspace).replace(/\\/g, '/').replace(/"/g, '')}"`,
    },
  })
  const hook = installOne({
    profile,
    source: path.join(root, 'dsh-hook'),
    name: '@qingmei/dsh-hook',
    patch: {
      id: 'qingmei-hook',
      text: `- id: qingmei-hook
  name: "@qingmei/dsh-hook"
  config:
    endpoint: http://127.0.0.1:7431/session/ingest`,
    },
  })

  return {
    ok: true,
    installed: { companion, hook },
    profile,
    message: companion || hook ? 'DSH 插件已安装；重启 DSH 后生效' : '未找到可安装的 DSH 插件源',
  }
}

module.exports = { installDshPlugins, dshInstalled }
