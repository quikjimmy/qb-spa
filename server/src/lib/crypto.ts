import crypto from 'crypto'

// AES-256-GCM envelope for server-stored secrets (Ollama API keys etc).
// Key comes from ENCRYPTION_KEY env var. On Railway, set a persistent random
// 32-byte value (base64 or hex). Rotating this key invalidates every stored secret.

const ALG = 'aes-256-gcm'
const IV_LEN = 12        // GCM-recommended
const TAG_LEN = 16

let warnedMissingKey = false
function getKey(): Buffer {
  const raw = process.env['ENCRYPTION_KEY'] || ''
  if (!raw) {
    // Warn once per process so prod without ENCRYPTION_KEY is visible in logs,
    // but don't throw — matches the JWT_SECRET dev-fallback pattern elsewhere
    // in the codebase. Set ENCRYPTION_KEY on Railway to make this go away.
    if (!warnedMissingKey) {
      console.warn('[crypto] ENCRYPTION_KEY not set — using fallback (OK for dev, weaker in prod; secrets will be invalidated if/when you set the env var)')
      warnedMissingKey = true
    }
    return crypto.createHash('sha256').update('dev-fallback-encryption-key').digest()
  }
  // Accept hex, base64, or raw string — normalize to 32 bytes via sha256.
  return crypto.createHash('sha256').update(raw).digest()
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALG, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Pack: iv || tag || ciphertext, base64-encoded
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(packed: string): string {
  const buf = Buffer.from(packed, 'base64')
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('invalid ciphertext')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const data = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = crypto.createDecipheriv(ALG, getKey(), iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(data), decipher.final()])
  return dec.toString('utf8')
}

// Redacted preview for UI: "sk-…xyz" — never returns the full key.
export function previewSecret(plaintext: string): string {
  if (plaintext.length <= 8) return '•'.repeat(plaintext.length)
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`
}
