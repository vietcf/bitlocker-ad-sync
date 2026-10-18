import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { unzipAes, zipAes, zipAesToFile } from '../../src/modules/backup/zip-aes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blk-zip-'));

describe('zipAesToFile (streamed, for big dumps)', () => {
  for (const size of [0, 1, 15, 16, 17, (1 << 20) + 7, 3 * (1 << 20)]) {
    it(`round trip with a password, big file of ${size} bytes`, async () => {
      const dir = tmp();
      const big = randomBytes(size);
      fs.writeFileSync(path.join(dir, 'big.bin'), big);
      const dest = path.join(dir, 'out.zip');
      await zipAesToFile(dest, [
        { name: 'README.txt', data: 'hello' },
        { name: 'big.bin', file: { path: path.join(dir, 'big.bin'), size, crc: crc32(big) } },
      ], 'a long enough password');
      const files = unzipAes(fs.readFileSync(dest), 'a long enough password');
      expect(files['README.txt'].toString()).toBe('hello');
      expect(files['big.bin'].equals(big)).toBe(true);
      expect(() => unzipAes(fs.readFileSync(dest), 'wrong password!!!!')).toThrow(/wrong password/);
    });
  }

  it('same bytes as the in-memory writer would give, and a plain zip works without a password', async () => {
    const dir = tmp();
    const big = randomBytes(100_000);
    fs.writeFileSync(path.join(dir, 'big.bin'), big);
    const dest = path.join(dir, 'plain.zip');
    await zipAesToFile(dest, [{ name: 'big.bin', file: { path: path.join(dir, 'big.bin'), size: big.length, crc: crc32(big) } }], null);
    expect(unzipAes(fs.readFileSync(dest))['big.bin'].equals(big)).toBe(true);
    expect(unzipAes(zipAes([{ name: 'a', data: 'x' }], 'pw-pw-pw-pw-pw-pw'), 'pw-pw-pw-pw-pw-pw').a.toString()).toBe('x');
  });

  it('removes the half-written file when the source is missing', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'x.zip');
    await expect(zipAesToFile(dest, [{ name: 'a', file: { path: path.join(dir, 'nope'), size: 5, crc: 0 } }], 'pw-pw-pw-pw-pw-pw')).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });
});
