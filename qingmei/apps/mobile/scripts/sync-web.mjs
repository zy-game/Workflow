import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const source = path.resolve(root, '..', 'web', 'public')
const target = path.join(root, 'www', 'app')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })

const config = `window.__QM_SERVER_URL = (localStorage.getItem('qm.server') || '').replace(/\\/+$/, '')
window.__QM_PERSIST_TOKEN__ = false
`
await writeFile(path.join(target, 'config.js'), config)

const indexPath = path.join(target, 'index.html')
const html = await readFile(indexPath, 'utf8')
const injected = html.replace(
  '<script type="module" src="./app.js"></script>',
  '<script src="./config.js"></script>\n    <script type="module" src="./app.js"></script>',
)
if (!injected.includes('config.js')) throw new Error('无法向 index.html 注入 config.js')
await writeFile(indexPath, injected)
console.log(`[mobile] web 同步完成：${target}`)
