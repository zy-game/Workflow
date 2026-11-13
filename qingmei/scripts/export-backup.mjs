#!/usr/bin/env node
/**
 * 个人备份导出：把数据库快照、配置、人格文件和更新清单打成一个 tar.gz。
 *
 * 不包含 /etc/qingmei/env；恢复时需要同样的 QM_TOKEN（设置里的密钥用它派生加密）。
 * 产物默认在 backups/，由用户自己上传 COS。
 *
 * 用法：
 *   node scripts/export-backup.mjs
 *   node scripts/export-backup.mjs --db ./data/qm.db --out ./backups
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const value = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

const dbPath = path.resolve(value('--db') || process.env.QM_DB || path.join(REPO_ROOT, 'data', 'qm.db'))
const outDir = path.resolve(value('--out') || path.join(REPO_ROOT, 'backups'))

if (!existsSync(dbPath)) {
  console.error(`[backup] 数据库不存在：${dbPath}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const staging = mkdtempSync(path.join(tmpdir(), 'qm-backup-'))
const snapshot = path.join(staging, 'qm.db')

try {
  const source = new DatabaseSync(dbPath, { readOnly: true })
  source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`)
  source.close()

  const files = [
    ['qingmei.prod.yml', path.join(REPO_ROOT, 'qingmei.prod.yml')],
    ['persona.md', path.join(REPO_ROOT, 'apps', 'server', 'persona.md')],
    ['updates/android/latest.json', path.join(REPO_ROOT, 'updates', 'android', 'latest.json')],
    ['updates/desktop/latest.json', path.join(REPO_ROOT, 'updates', 'desktop', 'latest.json')],
  ]
  for (const [name, from] of files) {
    if (!existsSync(from) || !statSync(from).isFile()) continue
    const to = path.join(staging, name)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
  }

  writeFileSync(
    path.join(staging, 'RESTORE.md'),
    [
      '# 青梅备份恢复',
      '',
      '1. 停服务：`sudo systemctl stop qingmei`',
      '2. 备份当前库：`cp /opt/qingmei/data/qm.db /opt/qingmei/data/qm.db.bak`',
      '3. 用压缩包里的 `qm.db` 覆盖 `/opt/qingmei/data/qm.db`',
      '4. 恢复 `/etc/qingmei/env`（备份不包含它）；设置页保存的密钥依赖同样的 `QM_TOKEN` 或 `QM_SETTINGS_KEY` 才能解密',
      '5. 启动：`sudo systemctl start qingmei`，检查 `/healthz`',
      '',
      `备份时间：${new Date().toISOString()}`,
      '',
    ].join('\n'),
    'utf8',
  )

  const target = path.join(outDir, `qingmei-backup-${stamp}.tar.gz`)
  const tar = spawnSync('tar', ['-czf', target, '-C', staging, '.'], { stdio: 'pipe' })
  if (tar.status !== 0) throw new Error(tar.stderr?.toString() || 'tar 失败')
  console.log(`[backup] ${target}（${(statSync(target).size / 1024 / 1024).toFixed(1)} MB）`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
