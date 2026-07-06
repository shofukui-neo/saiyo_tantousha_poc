const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENC_DIR = path.resolve(__dirname, '..', 'secure', 'encrypted');
const OUT_DIR = path.resolve(__dirname, '..', 'secure', 'plain');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function decryptPayload(payload, passphrase) {
  const enc = payload.encrypted;
  const salt = Buffer.from(enc.salt, 'base64');
  const iv = Buffer.from(enc.iv, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const ciphertext = Buffer.from(enc.ciphertext, 'base64');
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out;
}

function main() {
  const pass = process.env.LISTS_PASSPHRASE;
  if (!pass) {
    console.error('LISTS_PASSPHRASE environment variable is required');
    process.exit(2);
  }
  if (!fs.existsSync(ENC_DIR)) {
    console.error('No encrypted directory found:', ENC_DIR);
    process.exit(3);
  }
  ensureDir(OUT_DIR);
  const files = fs.readdirSync(ENC_DIR).filter(f => f.endsWith('.enc.json'));
  if (files.length === 0) {
    console.log('No encrypted files found in', ENC_DIR);
    return;
  }
  files.forEach(f => {
    const p = path.join(ENC_DIR, f);
    const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
    const outBuf = decryptPayload(payload, pass);
    const outPath = path.join(OUT_DIR, payload.filename);
    fs.writeFileSync(outPath, outBuf);
    console.log('Decrypted', p, '->', outPath);
  });
}

main();
