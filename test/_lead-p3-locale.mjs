/**
 * Lead probe: every locale key the client asks for must exist in BOTH dictionaries.
 *
 * A missing key renders as the raw key string in the panel ('migrate.button' instead of
 * '迁移到 E 盘'), and only one of the two dictionaries being updated is the classic way that
 * ships. This is a static check — no browser needed.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(import.meta.dirname, '../client.js');
const source = fs.readFileSync(file, 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, what, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${what}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL ${what}${extra ? ' :: ' + extra : ''}`);
  }
};

// Keys requested through t('literal') — the only form that can be checked statically.
const used = new Set();
for (const m of source.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);

// Slice the two dictionary literals out of the DICTS object.
function dictSlice(name) {
  const start = source.indexOf(`${name}: {`);
  if (start < 0) return null;
  // Walk braces so nested nothing can fool it.
  let i = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let j = i; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  return end < 0 ? null : source.slice(i, end + 1);
}

const en = dictSlice('en');
const zh = dictSlice('zh');
ok(en !== null && zh !== null, 'both locale dictionaries are present in client.js');

const keysOf = (block) => new Set([...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
const enKeys = keysOf(en);
const zhKeys = keysOf(zh);

const missingEn = [...used].filter((k) => !enKeys.has(k)).sort();
const missingZh = [...used].filter((k) => !zhKeys.has(k)).sort();
ok(missingEn.length === 0, 'every t(key) literal exists in the EN dictionary', missingEn.join(',') || `${used.size} keys checked`);
ok(missingZh.length === 0, 'every t(key) literal exists in the ZH dictionary', missingZh.join(',') || `${used.size} keys checked`);

// The reverse direction matters less (a stale key is harmless), but parity between the two
// dictionaries does: an EN-only key means a Chinese user sees English.
const enOnly = [...enKeys].filter((k) => !zhKeys.has(k)).sort();
const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
ok(enOnly.length === 0, 'no EN-only keys (Chinese users would see English)', enOnly.join(',') || 'parity');
ok(zhOnly.length === 0, 'no ZH-only keys', zhOnly.join(',') || 'parity');

// The PRD §4 hotkey bar is a hard requirement, so assert the [M] entry in both languages.
const enHasM = /hint\.keys['"]?: '[^']*\[M\]/.test(en);
const zhHasM = /hint\.keys['"]?: '[^']*\[M\]/.test(zh);
ok(enHasM, "EN hotkey bar documents [M] (PRD §4 '[M] 将选中目录软链接迁移至E盘')");
ok(zhHasM, 'ZH hotkey bar documents [M]');

// The placeholders each translated string uses must match between languages, or {root}/{size}
// silently render as literal braces in one of them.
function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}
const pairs = [...en.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm)];
let mismatch = 0;
for (const [, key, value] of pairs) {
  const zhMatch = zh.match(new RegExp(`^\\s*'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'm'));
  if (!zhMatch) continue;
  if (placeholders(value) !== placeholders(zhMatch[1])) {
    mismatch += 1;
    console.log(`   placeholder mismatch on '${key}': en={${placeholders(value)}} zh={${placeholders(zhMatch[1])}}`);
  }
}
ok(mismatch === 0, 'every translated string uses the same {placeholders} in both languages', `${pairs.length} pairs compared`);

console.log(`\nSUMMARY pass=${pass} fail=${fail} verdict=${fail === 0 ? 'GREEN' : 'RED'}`);
process.exit(fail === 0 ? 0 : 1);
