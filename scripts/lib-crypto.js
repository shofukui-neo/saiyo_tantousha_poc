'use strict';
/**
 * ボールト用の認証付き暗号(AES-256-GCM) + メモリハード鍵導出(scrypt)。
 * encrypt-lists.js / decrypt-lists.js が共有し、暗号仕様の齟齬を防ぐ。
 *
 * payload 形式 (v2):
 *   { v:2, alg:'aes-256-gcm', kdf:'scrypt', kdfParams:{N,r,p,keylen},
 *     relpath, salt, iv, tag, ciphertext }   ※各バイナリは base64
 * 旧 v1 (pbkdf2/{encrypted:{...}}) も復号可能(後方互換)。
 */
const crypto = require('crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

function deriveScrypt(passphrase, salt, params) {
  const p = { ...SCRYPT, ...(params || {}) };
  return crypto.scryptSync(passphrase, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: p.maxmem });
}

function encryptBuffer(buf, passphrase, relpath) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveScrypt(passphrase, salt, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const aad = Buffer.from(relpath || '', 'utf8');
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 2,
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen },
    relpath: relpath || '',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptPayload(payload, passphrase) {
  // 旧 v1 形式(pbkdf2, 100k, sha256)の後方互換
  if (payload && payload.encrypted && !payload.v) {
    const e = payload.encrypted;
    const salt = Buffer.from(e.salt, 'base64');
    const iv = Buffer.from(e.iv, 'base64');
    const tag = Buffer.from(e.tag, 'base64');
    const ct = Buffer.from(e.ciphertext, 'base64');
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
  // v2 (scrypt)
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ct = Buffer.from(payload.ciphertext, 'base64');
  const key = deriveScrypt(passphrase, salt, payload.kdfParams);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(payload.relpath || '', 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

module.exports = { encryptBuffer, decryptPayload, SCRYPT };
