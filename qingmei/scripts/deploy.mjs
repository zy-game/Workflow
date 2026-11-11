#!/usr/bin/env node
/**
 * 一键发布：本地门禁 → 构建前端 → 打包 → 上传 → supervisor 部署 → 健康校验 → 更新源上传。
 *
 * 走的是既有 supervisor 链路（解包 → 备份 → 重启 → 轮询 healthz → 失败自动回滚），
 * 不引入第二套部署路径。
 *
 * 用法：
 *   node scripts/deploy.mjs                       # 全量：测试 + 构建 + 部署 + 传更新源
 *   node scripts/deploy.mjs --skip-tests          # 跳过 gate（改的只是文档时）
 *   node scripts/deploy.mjs --no-updates          # 只发服务器
 *   node scripts/deploy.mjs --updates-only        # 只传 updates/（桌面 + Android）
 *   node scripts/deploy.mjs --android <apk> --android-version 0.1.12 --android-code 13
 *
 * 环境：需要 ~/.ssh/company.pem 与服务器免密；服务器服务名 qingmei。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SSH_KEY = path.join(homedir(), '.ssh', 'company.pem')
const HOST = 'ubuntu@139.155.78.241'
const APP_DIR = '/opt/qingmei'
const HEALTH = 'https://139.155.78.241:8710/healthz'
const INSTALL_CMD = 'PATH=/opt/node24/bin:/opt/dsh/bin:$PATH corepack pnpm install --prod --frozen-lockfile'

/** 不进部署包的路径（相对仓库根，按前缀匹配） */
const EXCLUDES = [
  'node_modules',
  'data',
  '.git',
  'config-snapshots',
  'updates',
  'tmp',
  'chrome-cdp-profile',
  'apps/desktop/dist',
  'apps/mobile/www',
  'apps/mobile/android/build',
]

export function shouldExclude(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  return EXCLUDES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options })
}

function ssh(script, { quiet = false } = {}) {
  const args = ['-i', SSH_KEY, '-o', 'BatchMode=yes', HOST, script]
  if (quiet) return execFileSync('ssh', args, { encoding: 'utf8' }).trim()
  run('ssh', args)
  return ''
}

function scp(file, remote) {
  run('scp', ['-i', SSH_KEY, '-o', 'BatchMode=yes', file, `${HOST}:${remote}`])
}

export function buildTarball({ outFile }) {
  const args = ['-czf', outFile, '-C', REPO_ROOT]
  for (const prefix of EXCLUDES) args.push(`--exclude=./${prefix}`)
  args.push('.')
  run('tar', args)
  return outFile
}

function buildWeb() {
  // 直接跑 vite：Windows 上 Node 不能 spawn pnpm.cmd（EINVAL），绕开包管理器更稳
  const webDir = path.join(REPO_ROOT, 'apps', 'web')
  const requireFromWeb = createRequire(path.join(webDir, 'package.json'))
  const viteDir = path.dirname(requireFromWeb.resolve('vite/package.json'))
  const vite = path.join(viteDir, 'bin', 'vite.js')
  execFileSync(process.execPath, [vite, 'build'], { cwd: webDir, stdio: 'inherit' })
}

function gate() {
  run(process.execPath, [path.join(REPO_ROOT, 'scripts', 'gate.mjs')])
}

async function verifyHealth() {
  const response = await fetch(HEALTH, { signal: AbortSignal.timeout(8000) })
  const body = await response.json()
  if (!response.ok || body.ok === false) throw new Error(`healthz 异常：${response.status} ${JSON.stringify(body)}`)
  return body
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function deployServer({ install = false } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tarball = path.join(REPO_ROOT, 'tmp', `qingmei-${stamp}.tgz`)
  mkdirSync(path.dirname(tarball), { recursive: true })
  console.log('[deploy] 打包…')
  buildTarball({ outFile: tarball })
  const size = Math.round(statSync(tarball).size / 1024 / 1024)
  console.log(`[deploy] 包大小 ${size} MB，上传…`)

  const remote = `/tmp/qingmei-${stamp}.tgz`
  scp(tarball, remote)

  console.log(`[deploy] supervisor：解包 → ${install ? '安装依赖 → ' : ''}重启 → 健康检查`)
  const installArg = install ? ` --install '${INSTALL_CMD}'` : ''
  ssh(
    `sudo -n /opt/node24/bin/node ${APP_DIR}/scripts/supervisor.mjs ` +
      `--tarball ${remote} --app ${APP_DIR} --health http://127.0.0.1:7410/healthz${installArg}`,
  )

  console.log('[deploy] 校验线上健康与清单')
  const body = await verifyHealth()
  console.log(`[deploy] healthz ok，channels: ${JSON.stringify(body.channels)}`)
  const current = ssh(`readlink -f ${APP_DIR}/current`, { quiet: true })
  console.log(`[deploy] current → ${current}`)
  const check = ssh(
    `sudo -n bash -c 'set -a; . /etc/qingmei/env; set +a; cd ${APP_DIR} && /opt/node24/bin/node scripts/check-config.mjs --env' 2>&1 | tail -3`,
    { quiet: true },
  )
  console.log(check)

  rmSync(tarball, { force: true })
}

/** updates/ 是 root 建的目录；一次性交给 ubuntu，后续 scp 才写得进去 */
function ensureUpdatesDirs() {
  ssh(`sudo -n mkdir -p ${APP_DIR}/updates/desktop ${APP_DIR}/updates/android && sudo -n chown -R ubuntu:ubuntu ${APP_DIR}/updates`)
}

async function uploadDesktop() {
  const dir = path.join(REPO_ROOT, 'updates', 'desktop')
  if (!existsSync(path.join(dir, 'latest.json'))) throw new Error('updates/desktop/latest.json 不存在：先跑 release-desktop.mjs')
  ensureUpdatesDirs()
  run('scp', ['-i', SSH_KEY, '-o', 'BatchMode=yes', path.join(dir, '*'), `${HOST}:${APP_DIR}/updates/desktop/`])
  const manifest = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8'))
  console.log(`[deploy] 桌面 ${manifest.version} 已上传；sha256=${manifest.sha256.slice(0, 12)}…`)
}

function uploadAndroid({ apk, version, code }) {
  if (!apk) return
  if (!existsSync(apk)) throw new Error(`APK 不存在：${apk}`)
  const name = path.basename(apk)
  ensureUpdatesDirs()
  run('scp', ['-i', SSH_KEY, '-o', 'BatchMode=yes', apk, `${HOST}:${APP_DIR}/updates/android/${name}`])
  const remoteSize = Number(ssh(`stat -c %s ${APP_DIR}/updates/android/${name}`, { quiet: true }))
  const localSize = statSync(apk).size
  if (remoteSize !== localSize) throw new Error(`APK 上传不完整：本地 ${localSize} 远端 ${remoteSize}`)
  const manifest = {
    version,
    versionCode: Number(code),
    name,
    url: `https://139.155.78.241:8710/updates/android/${name}`,
    size: localSize,
    sha256: sha256(apk),
    at: new Date().toISOString(),
  }
  const tmp = path.join(REPO_ROOT, 'tmp', 'android-latest.json')
  mkdirSync(path.dirname(tmp), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  scp(tmp, `${APP_DIR}/updates/android/latest.json`)
  rmSync(tmp, { force: true })
  console.log(`[deploy] Android ${version}（versionCode ${code}）已上传`)
}

async function main() {
  const args = process.argv.slice(2)
  const has = (flag) => args.includes(flag)
  const value = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  if (!existsSync(SSH_KEY)) throw new Error(`缺少 SSH 私钥：${SSH_KEY}`)

  const onlyUpdates = has('--updates-only')
  const serverOnly = has('--no-updates')

  if (!onlyUpdates) {
    if (!has('--skip-tests')) gate()
    if (!has('--skip-build')) buildWeb()
    await deployServer({ install: has('--install') })
  }
  if (!serverOnly) {
    await uploadDesktop()
    uploadAndroid({ apk: value('--android'), version: value('--android-version'), code: value('--android-code') })
  }
  console.log('[deploy] 完成')
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[deploy] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
