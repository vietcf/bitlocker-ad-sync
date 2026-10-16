import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

// Password-protected ZIP with WinZip AES-256 encryption (format "AE-2"), which 7-Zip, WinRAR and
// most archive tools open. Each entry: PBKDF2-HMAC-SHA1 (1000 rounds, the format's fixed count) on
// a random 16-byte salt gives the AES-256 key, an HMAC-SHA1 key and a 2-byte password check; the
// (deflated) data is encrypted with AES-256 in CTR mode (little-endian counter from 1) and
// authenticated with HMAC-SHA1 (10 bytes). AE-2 stores no CRC, so nothing leaks about the content.
// The weak point of the format is the fixed key-derivation cost: use a long password.

const AES_STRENGTH = 3; // 256-bit
const SALT_LEN = 16;
const KEY_LEN = 32;
const ITERATIONS = 1000;

function deriveKeys(password, salt) {
  const dk = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, ITERATIONS, KEY_LEN * 2 + 2, 'sha1');
  return { aesKey: dk.subarray(0, KEY_LEN), hmacKey: dk.subarray(KEY_LEN, KEY_LEN * 2), verifier: dk.subarray(KEY_LEN * 2) };
}

/** AES-256-CTR as WinZip does it: 16-byte little-endian counter starting at 1 (same op both ways). */
function ctr(aesKey, data) {
  const out = Buffer.alloc(data.length);
  const ecb = createCipheriv('aes-256-ecb', aesKey, null).setAutoPadding(false);
  const CHUNK = 4096; // blocks per round
  let block = 1n;
  for (let off = 0; off < data.length; off += CHUNK * 16) {
    const n = Math.min(CHUNK, Math.ceil((data.length - off) / 16));
    const counters = Buffer.alloc(n * 16);
    for (let i = 0; i < n; i += 1) {
      counters.writeBigUInt64LE(block & 0xffffffffffffffffn, i * 16);
      counters.writeBigUInt64LE(block >> 64n, i * 16 + 8);
      block += 1n;
    }
    const stream = ecb.update(counters);
    const end = Math.min(data.length, off + n * 16);
    for (let i = off; i < end; i += 1) out[i] = data[i] ^ stream[i - off];
  }
  return out;
}

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

/** The 0x9901 extra field: AE-2, vendor "AE", AES-256, real compression method. */
function aesExtra(method) {
  const b = Buffer.alloc(11);
  b.writeUInt16LE(0x9901, 0);
  b.writeUInt16LE(7, 2);
  b.writeUInt16LE(2, 4); // AE-2
  b.write('AE', 6, 'ascii');
  b.writeUInt8(AES_STRENGTH, 8);
  b.writeUInt16LE(method, 9);
  return b;
}

/**
 * files: [{ name, data: Buffer | string, compress = true }] -> Buffer of a ZIP where every entry is
 * AES-256 encrypted with `password`. password null: a plain (not encrypted) ZIP, which any tool,
 * File Explorer included, opens.
 */
export function zipAes(files, password, { date = new Date() } = {}) {
  const encrypt = !!password;
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const method = f.compress === false ? 0 : 8;
    const packed = method === 8 ? deflateRawSync(raw, { level: 6 }) : raw;
    let body = packed;
    let extra = Buffer.alloc(0);
    if (encrypt) {
      const salt = randomBytes(SALT_LEN);
      const { aesKey, hmacKey, verifier } = deriveKeys(password, salt);
      const encrypted = ctr(aesKey, packed);
      const auth = createHmac('sha1', hmacKey).update(encrypted).digest().subarray(0, 10);
      body = Buffer.concat([salt, verifier, encrypted, auth]);
      extra = aesExtra(method);
    }
    const version = encrypt ? 51 : 20; // 5.1 for AES, 2.0 for Deflate
    const flags = (encrypt ? 0x0001 : 0) | 0x0800; // encrypted, UTF-8 name
    const zipMethod = encrypt ? 99 : method; // 99 = AES
    const crc = encrypt ? 0 : crc32(raw); // AE-2: no CRC

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(version, 4);
    head.writeUInt16LE(flags, 6);
    head.writeUInt16LE(zipMethod, 8);
    head.writeUInt16LE(dosTime(date), 10);
    head.writeUInt16LE(dosDate(date), 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(extra.length, 28);
    locals.push(head, name, extra, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(63, 4); // made by 6.3
    dir.writeUInt16LE(version, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(zipMethod, 10);
    dir.writeUInt16LE(dosTime(date), 12);
    dir.writeUInt16LE(dosDate(date), 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(extra.length, 30);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name, extra);
    offset += head.length + name.length + extra.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset > 0xffffffff) throw new Error('zipAes: archive larger than 4 GB');
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Whether a ZIP written by zipAes is encrypted (looks at the first entry). */
export const isEncryptedZip = (buf) => buf.length > 10 && buf.readUInt32LE(0) === 0x04034b50 && buf.readUInt16LE(8) === 99;

/**
 * Reads back an archive written by zipAes (tests, and checking a backup on the server):
 * { [name]: Buffer }. Throws on a wrong password or a damaged entry. Plain entries need no password.
 */
export function unzipAes(buf, password = null) {
  const out = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const name = buf.toString('utf8', o + 30, o + 30 + nameLen);
    const extra = buf.subarray(o + 30 + nameLen, o + 30 + nameLen + extraLen);
    const start = o + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + size);
    if (buf.readUInt16LE(o + 8) !== 99) {
      const data = buf.readUInt16LE(o + 8) === 8 ? inflateRawSync(body) : Buffer.from(body);
      if (crc32(data) !== buf.readUInt32LE(o + 14)) throw new Error(`damaged entry ${name}`);
      out[name] = data;
      o = start + size;
      continue;
    }
    if (!password) throw new Error('wrong password');
    const method = extra.readUInt16LE(9);
    const salt = body.subarray(0, SALT_LEN);
    const { aesKey, hmacKey, verifier } = deriveKeys(password, salt);
    if (!verifier.equals(body.subarray(SALT_LEN, SALT_LEN + 2))) throw new Error('wrong password');
    const encrypted = body.subarray(SALT_LEN + 2, body.length - 10);
    const auth = createHmac('sha1', hmacKey).update(encrypted).digest().subarray(0, 10);
    if (!auth.equals(body.subarray(body.length - 10))) throw new Error(`damaged entry ${name}`);
    const packed = ctr(aesKey, encrypted);
    out[name] = method === 8 ? inflateRawSync(packed) : packed;
    o = start + size;
  }
  return out;
}

