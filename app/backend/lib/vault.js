'use strict';
/* AES-256-GCM sealing for GitHub credentials at rest.

   - Tokens are *never* sent to the browser: /api/status only ever returns
     booleans + login names.
   - The encryption key lives in the app's data dir (chmod 600) unless
     MAPPER_ENCRYPTION_KEY is provided. Key file and store are both created
     with restrictive permissions.
   - Sealed values are bound to an AAD string so a ciphertext cannot be
     replayed into a different slot.
*/
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_FILE = 'vault.key';

function ensureKey(dataDir) {
  const envKey = process.env.MAPPER_ENCRYPTION_KEY;
  if (envKey) {
    const buf = /^[0-9a-f]{64}$/i.test(envKey)
      ? Buffer.from(envKey, 'hex')
      : crypto.createHash('sha256').update(envKey).digest();
    if (buf.length !== 32) throw new Error('MAPPER_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
    return buf;
  }
  const keyPath = path.join(dataDir, KEY_FILE);
  if (fs.existsSync(keyPath)) {
    const buf = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    if (buf.length === 32) return buf;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort on unusual fs */ }
  return key;
}

class Vault {
  constructor(dataDir) {
    this.key = ensureKey(dataDir);
  }

  seal(value, aad) {
    if (value == null) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(String(aad)));
    const enc = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
  }

  open(sealed, aad) {
    if (!sealed) return null;
    const parts = String(sealed).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    try {
      const iv = Buffer.from(parts[1], 'base64url');
      const enc = Buffer.from(parts[2], 'base64url');
      const tag = Buffer.from(parts[3], 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(String(aad)));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

module.exports = { Vault };
