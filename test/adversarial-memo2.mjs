// verifier probe: DIRECT memo test, replacing the invalid inference in adversarial-memo.mjs.
// The previous probe concluded "memo ineffective" from a flat 1-dir vs 200-dir ratio. That
// inference is INVALID: a flat ratio is equally consistent with (a) the memo being broken, or
// (b) the memo working while some OTHER per-call cost dominates. This probe measures the memo
// where it is observable: in a FRESH process the memoiser starts empty, so call #1 must pay the
// realpath syscall and later calls in the SAME directory must not. Cold-vs-warm in one process
// isolates the memo with no inference required.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;

if (process.argv[2] === '--child') {
  // Child: measure cold vs warm for a single directory.
  const { resolveConfig } = await import('../lib/config.js');
  const { isProtectedPath } = await import('../lib/classifier.js');
  const cfg = resolveConfig({});
  const dir = path.join(process.env.LOCALAPPDATA || '', 'Temp', `dshcc_memo2_${process.argv[3]}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < 200; i++) { const p = path.join(dir, `f${i}.tmp`); if (!fs.existsSync(p)) fs.writeFileSync(p, 'x'); files.push(p); }

  const t0 = process.hrtime.bigint();
  isProtectedPath(files[0], cfg.protectRoots);
  const cold = Number(process.hrtime.bigint() - t0);

  // Warm: same directory, so the memo should now hit.
  let warmTotal = 0n;
  for (let i = 1; i < files.length; i++) {
    const a = process.hrtime.bigint();
    isProtectedPath(files[i], cfg.protectRoots);
    warmTotal += process.hrtime.bigint() - a;
  }
  const warm = Number(warmTotal) / (files.length - 1);
  // A DIFFERENT directory, still cold within this process.
  const dir2 = path.join(process.env.LOCALAPPDATA || '', 'Temp', `dshcc_memo2b_${process.argv[3]}`);
  fs.mkdirSync(dir2, { recursive: true });
  const p2 = path.join(dir2, 'x.tmp'); fs.writeFileSync(p2, 'x');
  const a2 = process.hrtime.bigint();
  isProtectedPath(p2, cfg.protectRoots);
  const cold2 = Number(process.hrtime.bigint() - a2);

  process.stdout.write(JSON.stringify({ cold, warm, cold2 }) + '\n');
} else {
  console.log('DIRECT memo test: cold (first call, realpath paid) vs warm (same dir, memo hit)');
  console.log('measured in a FRESH process each run so the memo always starts empty');
  console.log('');
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', `${STAMP}_${i}`], { encoding: 'utf8' });
    runs.push(JSON.parse(out.trim().split('\n').pop()));
  }
  const med = (k) => { const v = runs.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const cold = med('cold'), warm = med('warm'), cold2 = med('cold2');
  console.log(`  call #1 in a NEW directory (cold, pays realpath)  ${Math.round(cold).toString().padStart(8)} ns`);
  console.log(`  calls #2..#200 in the SAME directory (memo hit)   ${Math.round(warm).toString().padStart(8)} ns`);
  console.log(`  first call in ANOTHER directory (cold again)      ${Math.round(cold2).toString().padStart(8)} ns`);
  console.log('');
  console.log('  cold/warm ratio =', (cold / warm).toFixed(2) + 'x', '(median of 5 fresh-process runs)');
  console.log('');
  if (cold > warm * 3 && cold2 > warm * 3) {
    console.log('>>> MEMO IS EFFECTIVE: a first call in a directory pays a large fixed cost,');
    console.log('    subsequent calls in that SAME directory are markedly cheaper, and a call in a');
    console.log('    NEW directory pays the cold cost again. This is the per-directory memo working.');
    console.log('');
    console.log('    Consequence for my earlier probe: the flat 1-dir vs 200-dir RATIO was NOT');
    console.log('    evidence of a broken memo. Both shapes are dominated by a per-call cost that');
    console.log('    is independent of the memo (canonicalString() over every config protectRoot).');
    console.log('    The memo saves the realpath only; it cannot make the whole guard ~0.9us/call.');
  } else {
    console.log('>>> MEMO NOT OBSERVABLE: cold and warm cost the same, so the resolve is not being');
    console.log('    reused (or the realpath is not the dominant term). Treat as a MEDIUM finding.');
  }
}
