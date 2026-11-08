#!/usr/bin/env node
/**
 * 发布产物一致性检查（离线）：
 * - 最新 android-latest-*.json 里的 APK 必须存在，size/sha256 必须一致
 * - Desktop 一键安装器必须存在
 *
 * 用法：node scripts/check-artifacts.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.dirname(REPO)

function latestManifest() {
  const files = readdirSync(ROOT)
    .filter((name) => /^android-latest-.*\.json$/.test(name))
    .map((name) => ({ name, at: statSync(path.join(ROOT, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  if (files.length === 0) throw new Error('找不到 android-latest-*.json')
  return path.join(ROOT, files[0].name)
}

const manifestPath = latestManifest()
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const apkPath = path.join(ROOT, manifest.name)
if (!existsSync(apkPath)) throw new Error(`APK 不存在：${apkPath}`)
const size = statSync(apkPath).size
if (size !== manifest.size) throw new Error(`APK size 不一致：${size} !== ${manifest.size}`)
const sha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex')
if (sha256 !== manifest.sha256) throw new Error(`APK sha256 不一致：${sha256}`)

const installer = path.join(REPO, 'apps/desktop/dist/Qingmei-Setup-oneclick-signed-current.exe')
if (!existsSync(installer)) throw new Error(`Desktop 安装器不存在：${installer}`)

console.log(`✔ Android ${manifest.version} (${manifest.versionCode}) ${manifest.name}`)
console.log(`  size=${size} sha256=${sha256.slice(0, 12)}…`)
console.log(`✔ Desktop 安装器 ${path.basename(installer)} size=${statSync(installer).size}`)
