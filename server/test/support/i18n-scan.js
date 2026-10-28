// Finds the translation keys used in the source: the first string literal of t(), th(), tk(), req.t(), req.th().
import fs from 'node:fs';
import path from 'node:path';

const BS = String.fromCharCode(92);
const CALL = /(?<![\w$])(?:req\.)?(?:th|tk|t)\(\s*(['"`])/g;

export const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

function decode(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === BS && i + 1 < raw.length) {
      const n = raw[i + 1];
      out += n === 'n' ? '\n' : n;
      i++;
    } else out += raw[i];
  }
  return out;
}

/** [{ key, line }] for one source text. */
export function scanKeys(source) {
  const found = [];
  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(source))) {
    const quote = m[1];
    const start = m.index + m[0].length;
    let j = start;
    while (j < source.length && source[j] !== quote) j += source[j] === BS ? 2 : 1;
    found.push({ key: decode(source.slice(start, j)), line: source.slice(0, m.index).split('\n').length });
    CALL.lastIndex = j + 1;
  }
  return found;
}

function walk(dir, exts, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, files);
    else if (exts.some((x) => e.name.endsWith(x))) files.push(p);
  }
  return files;
}

/** Map key -> [files] for every .js and .ejs under `dir`. */
export function scanDir(dir) {
  const keys = new Map();
  for (const file of walk(dir, ['.js', '.ejs'])) {
    if (file.includes(`${path.sep}i18n${path.sep}`)) continue; // the dictionary itself
    for (const { key } of scanKeys(fs.readFileSync(file, 'utf8'))) {
      if (!keys.has(key)) keys.set(key, new Set());
      keys.get(key).add(path.relative(dir, file).replace(/\\/g, '/'));
    }
  }
  return keys;
}
