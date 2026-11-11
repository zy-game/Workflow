#!/usr/bin/env node
/**
 * 构建 Windows 安装包。
 *
 * 分工：electron-builder 只负责出 payload（dist/win-unpacked），安装器由 Inno Setup 编译。
 * 不再用 NSIS —— electron-builder 的 NSIS 目标在当前环境会被杀软/UAC 拦，
 * 且自解压结构更容易被误报；Inno 的 per-user 安装不触发 UAC。
 *
 * 用法：
 *   node scripts/build-desktop-installer.mjs                 # 重新打 payload + 编译安装器
 *   node scripts/build-desktop-installer.mjs --skip-payload  # 复用已有 win-unpacked
 *   ISCC 路径可用环境变量 INNO_ISCC 覆盖
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(REPO_ROOT, 'apps', 'desktop')
const ISS = path.join(DESKTOP, 'installer', 'inno', 'qingmei.iss')
const UNPACKED = path.join(DESKTOP, 'dist', 'win-unpacked')
const DIST = path.join(DESKTOP, 'dist')

export function findIscc(env = process.env) {
  const candidates = [
    env.INNO_ISCC,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Inno', 'ISCC.exe') : '',
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function desktopVersion() {
  return JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version
}

function buildPayload() {
  const requireFromDesktop = createRequire(path.join(DESKTOP, 'package.json'))
  const cli = requireFromDesktop.resolve('electron-builder/out/cli/cli.js')
  execFileSync(process.execPath, [cli, '--win', '--dir'], { cwd: DESKTOP, stdio: 'inherit' })
}

function compile(iscc, version) {
  if (!existsSync(UNPACKED)) throw new Error(`payload 不存在：${UNPACKED}`)
  execFileSync(iscc, [
    `/DAppVersion=${version}`,
    `/DSourceDir=${UNPACKED}`,
    `/DOutputDir=${DIST}`,
    ISS,
  ], { stdio: 'inherit' })
  const output = path.join(DIST, `Qingmei-Setup-${version}.exe`)
  if (!existsSync(output)) throw new Error(`ISCC 没有产出安装包：${output}`)
  return output
}

function main() {
  const args = process.argv.slice(2)
  const version = desktopVersion()
  const iscc = findIscc()
  if (!iscc) throw new Error('找不到 ISCC.exe：安装 Inno Setup 6 或设置 INNO_ISCC')

  if (!args.includes('--skip-payload')) {
    console.log(`[installer] 构建 payload（${version}）…`)
    buildPayload()
  }
  const output = compile(iscc, version)
  const size = Math.round(statSync(output).size / 1024 / 1024)
  console.log(`✔ ${output}（${size} MB）`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[installer] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
