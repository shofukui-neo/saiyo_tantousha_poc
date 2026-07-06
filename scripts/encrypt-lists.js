const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUT_DIR = path.resolve(__dirname, '..', 'secure', 'encrypted');

const PATTERNS = [
  'アプローチ禁止企業一覧.txt',
  '既存顧客',
  'existing-bango.json',
  'セールスフォース',
  'SF',
];

function listDataFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).map(f => path.join(DATA_DIR, f));
}

function matchesPatterns(filename) {
  const name = path.basename(filename);
  return PATTERNS.some(p => name.includes(p));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function encryptBuffer(buf, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function main() {
  const pass = process.env.LISTS_PASSPHRASE;
  if (!pass) {
    console.error('LISTS_PASSPHRASE environment variable is required');
    process.exit(2);
  }
  ensureDir(OUT_DIR);
  const files = listDataFiles().filter(matchesPatterns);
  if (files.length === 0) {
    console.log('No matching files found in data/. Patterns:', PATTERNS);
    return;
  }
  files.forEach(f => {
    const buf = fs.readFileSync(f);
    const enc = encryptBuffer(buf, pass);
    const outName = path.basename(f) + '.enc.json';
    const outPath = path.join(OUT_DIR, outName);
    const payload = { filename: path.basename(f), encrypted: enc };
    fs.writeFileSync(outPath, JSON.stringify(payload));
    console.log('Encrypted', f, '->', outPath);
  });
}

main();
