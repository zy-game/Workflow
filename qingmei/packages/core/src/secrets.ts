import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * 设置里的密钥只以密文落库。
 *
 * 加密密钥不单独存库：优先 QM_SETTINGS_KEY，其次用 QM_TOKEN 派生。
 * 两个都没有时退化为开发密钥（仅本地测试用，生产必须有 QM_TOKEN）。
 */
function key(): Buffer {
  const base = process.env.QM_SETTINGS_KEY || process.env.QM_TOKEN || 'qingmei-dev'
  return createHash('sha256').update(`qingmei-settings:v1:${base}`).digest()
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptSecret(payload: string): string | null {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const iv = Buffer.from(parts[1]!, 'base64')
    const tag = Buffer.from(parts[2]!, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
