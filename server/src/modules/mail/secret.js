import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Secrets kept in app_setting (the SMTP password) are encrypted with AES-256-GCM. The key is
// derived from LOG_HMAC_KEY, which lives only on the app server, so a database dump alone does
// not reveal them. Format: "enc:v1:" + base64(iv 12 | tag 16 | ciphertext).

const PREFIX = 'enc:v1:';

export function secretKey(hmacKey) {
  return Buffer.from(hkdfSync('sha256', hmacKey, Buffer.alloc(0), 'blk/app-setting-secret/v1', 32));
}

export function encryptSecret(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Returns null for an empty value; throws if the value was encrypted with another key. */
export function decryptSecret(key, value) {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) throw new Error('not an encrypted setting');
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
