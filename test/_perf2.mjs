import fs from 'node:fs';
import path from 'node:path';
import { ProcessTree } from '../lib/process-tree.js';
import { CWatcher } from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = resolveConfig({ pollIntervalMs: 5000 });

console.log('=== confirm WHY the churn dir was filtered ===');
console.log('os.tmpdir()          :', (await import('node:os')).tmpdir());
console.log('=> escapeRoot        :', cfg.escapeRoot);
console.log('=> protectRoots      :');
for (const r of cfg.protectRoots) console.log('     ', r);
console.log('');
