/**
 * Lead probe: every refusal path in lib/symlink-migrate.js must actually refuse.
 * A migration feature that says yes too often destroys data, so each rule gets a case.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { inspectDirectory, removeJunction, findCandidates } from '../lib/symlink-migrate.js';

const cfg = resolveConfig({ migrateTargetRoot: 'E:\\dsh_escape_cache\\migrated' });
const C_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const id = Date.now().toString(36);
let pass = 0;
let fail = 0;

function expectRefusal(fn, wantCode, what) {
  let plan;
  try {
    plan = fn();
  } catch (e) {
    console.log(`FAIL ${what} -> threw ${e.message}`);
    fail += 1;
    return;
  }
  if (plan.ok === false && plan.code === wantCode) {
    pass += 1;
    console.log(`PASS ${what} -> ${plan.code}`);
  } else {
    fail += 1;
    console.log(`FAIL ${what} -> want ${wantCode}, got ${plan.ok ? 'OK(MIGRATABLE)' : plan.code} :: ${plan.reason}`);
  }
}

function expectSuccess(fn, what) {
  const plan = fn();
  if (plan.ok) {
    pass += 1;
    console.log(`PASS ${what} -> OK(MIGRATABLE)`);
  } else {
    fail += 1;
    console.log(`FAIL ${what} -> ${plan.code} :: ${plan.reason}`);
  }
}

// fixtures
const stubborn = path.join(C_TEMP, 'p3_adv_' + id);
fs.rmSync(stubborn, { recursive: true, force: true });
fs.mkdirSync(path.join(stubborn, 'sub'), { recursive: true });
fs.writeFileSync(path.join(stubborn, 'sub', 'a.bin'), Buffer.alloc(1024, 1));

const plainFile = path.join(C_TEMP, 'p3_adv_file_' + id + '.log');
fs.writeFileSync(plainFile, 'x');

const emptyDir = path.join(C_TEMP, 'p3_adv_empty_' + id);
fs.mkdirSync(emptyDir, { recursive: true });

const withJunction = path.join(C_TEMP, 'p3_adv_junc_' + id);
fs.mkdirSync(withJunction, { recursive: true });
fs.writeFileSync(path.join(withJunction, 'real.txt'), 'real');
fs.symlinkSync(stubborn, path.join(withJunction, 'inner_link'), 'junction');

const realDir = path.join(C_TEMP, 'p3_adv_realdir_' + id);

try {
  // --- the happy path must still pass ---
  expectSuccess(() => inspectDirectory(stubborn, cfg), 'ordinary stubborn dir inside %TEMP%');

  // --- basic input rules ---
  expectRefusal(() => inspectDirectory('', cfg), 'BAD_PATH', 'empty path');
  expectRefusal(() => inspectDirectory('C:\\definitely\\not\\here\\' + id, cfg), 'MISSING', 'missing path');
  expectRefusal(() => inspectDirectory(plainFile, cfg), 'NOT_A_DIRECTORY', 'a regular FILE');
  expectRefusal(() => inspectDirectory(path.join(withJunction, 'inner_link'), cfg), 'ALREADY_LOGGED', 'already a junction');

  // --- protected roots (decided lexically, before the path is touched) ---
  expectRefusal(() => inspectDirectory('C:\\Windows', cfg), 'PROTECTED', 'C:\\Windows (protected)');
  expectRefusal(() => inspectDirectory('C:\\Windows\\Temp\\foo\\bar', cfg), 'PROTECTED', 'inside C:\\Windows');
  expectRefusal(() => inspectDirectory('C:\\Program Files\\x\\y', cfg), 'PROTECTED', 'inside Program Files');
  expectRefusal(() => inspectDirectory('C:\\Users\\kiuhg\\Desktop\\sub', cfg), 'PROTECTED', 'inside Desktop');
  // C:\Users CONTAINS the Desktop/Documents protect roots, so the ancestor rule fires and is
  // more specific than the depth rule. Refusing it is correct whichever reason wins.
  expectRefusal(() => inspectDirectory('C:\\Users', cfg), 'ANCESTOR_OF_PROTECTED', 'C:\\Users (contains protected roots)');

  // --- watch roots: the root is off-limits, its children are the whole point ---
  expectRefusal(() => inspectDirectory(C_TEMP, cfg), 'PROTECTED', '%TEMP% itself (a watch root)');
  expectRefusal(() => inspectDirectory(path.dirname(C_TEMP), cfg), 'ANCESTOR_OF_WATCH_ROOT', '%LOCALAPPDATA% (ancestor of watch root)');
  expectRefusal(() => inspectDirectory('C:\\Users\\kiuhg\\AppData', cfg), 'ANCESTOR_OF_WATCH_ROOT', 'AppData (ancestor of watch root)');

  // --- owned paths ---
  expectRefusal(() => inspectDirectory('E:\\dsh_escape_cache\\huggingface', cfg), 'PROTECTED', 'inside escapeRoot');
  expectRefusal(() => inspectDirectory('E:\\dsh_escape_cache\\migrated\\x', cfg), 'PROTECTED', 'inside migrate target');

  // --- volume rule ---
  const sameVolCfg = resolveConfig({ migrateTargetRoot: 'C:\\somewhere\\migrated' });
  expectRefusal(() => inspectDirectory(stubborn, sameVolCfg), 'SAME_VOLUME', 'target on the SAME volume');

  // --- no target root configured at all ---
  const bareCfg = { isWindows: true, protectRoots: [], watchDirs: [], escapeRoot: null, migrateTargetRoot: null };
  expectRefusal(() => inspectDirectory(stubborn, bareCfg), 'NO_TARGET_ROOT', 'no escapeRoot/migrateTargetRoot configured');

  // --- tree rules ---
  expectRefusal(() => inspectDirectory(emptyDir, cfg), 'EMPTY', 'empty directory');
  expectRefusal(() => inspectDirectory(withJunction, cfg), 'CONTAINS_REPARSE_POINTS', 'tree containing a junction');

  // --- removeJunction must refuse a real directory (the data-loss trap) ---
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'keep.txt'), 'must survive');
  const rmRes = removeJunction(realDir);
  const survived = fs.existsSync(path.join(realDir, 'keep.txt'));
  if (rmRes.ok === false && rmRes.code === 'NOT_A_JUNCTION' && survived) {
    pass += 1;
    console.log('PASS removeJunction(real dir) -> NOT_A_JUNCTION, contents survived');
  } else {
    fail += 1;
    console.log(`FAIL removeJunction(real dir) -> ${JSON.stringify(rmRes)} survived=${survived}`);
  }

  // --- findCandidates only ever offers migratable dirs ---
  // Candidates group by the file's IMMEDIATE parent, so a.bin in `stubborn\sub` proposes
  // `stubborn\sub` — the intended granularity (the folder a toolchain keeps refilling).
  const sub = path.join(stubborn, 'sub');
  const rows = [
    { file_path: path.join(sub, 'a.bin'), file_size: 50 * 1024 * 1024, category: 'CAUTION_CACHE' },
    { file_path: path.join('C:\\Windows\\Temp\\x', 'a.bin'), file_size: 50 * 1024 * 1024, category: 'SAFE_TO_DELETE' },
    { file_path: path.join(C_TEMP, 'tiny', 'a.bin'), file_size: 10, category: 'SAFE_TO_DELETE' },
  ];
  const cands = findCandidates(rows, cfg);
  const offeredSub = cands.some((c) => c.path.toLowerCase() === sub.toLowerCase());
  const offeredWindows = cands.some((c) => c.path.toLowerCase().startsWith('c:\\windows'));
  const offeredTiny = cands.some((c) => c.path.toLowerCase().includes('tiny'));
  if (offeredSub && !offeredWindows && !offeredTiny) {
    pass += 1;
    console.log(`PASS findCandidates -> ${JSON.stringify(cands.map((c) => [path.basename(c.path), c.bytes]))} (skipped C:\\Windows\\Temp and the 10-byte dir)`);
  } else {
    fail += 1;
    console.log(`FAIL findCandidates sub=${offeredSub} windows=${offeredWindows} tiny=${offeredTiny} :: ${JSON.stringify(cands)}`);
  }
} finally {
  for (const p of [stubborn, plainFile, emptyDir, withJunction, realDir]) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* fixture cleanup is best-effort */
    }
  }
}

console.log(`\nSUMMARY pass=${pass} fail=${fail} verdict=${fail === 0 ? 'GREEN' : 'RED'}`);
process.exit(fail === 0 ? 0 : 1);
