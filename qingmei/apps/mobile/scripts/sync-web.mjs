import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const repo = path.resolve(root, '..', '..')
const source = path.resolve(repo, 'apps', 'web', 'dist')
const target = path.join(root, 'www', 'app')

// dist 是 Vite 产物；没有就先构建一次，保证移动端打包不依赖手工步骤。
if (!existsSync(path.join(source, 'index.html'))) {
  execFileSync('pnpm', ['--filter', '@qingmei/web', 'build'], { cwd: repo, stdio: 'inherit', shell: true })
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })
await rm(path.join(root, 'www', 'pet'), { recursive: true, force: true })

const config = `window.__QM_SERVER_URL = 'https://139.155.78.241:8710'
window.__QM_PERSIST_TOKEN__ = false
`
await writeFile(path.join(target, 'config.js'), config)

const indexPath = path.join(target, 'index.html')
const html = await readFile(indexPath, 'utf8')
if (!html.includes('config.js')) throw new Error('构建产物没有引用 config.js')
console.log(`[mobile] web 同步完成：${target}`)
