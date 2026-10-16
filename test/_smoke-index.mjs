// Lead smoke test: does index.js load, and does Config validate?
import * as m from '../index.js';

console.log('name       :', m.name);
console.log('inject     :', JSON.stringify(m.inject));
console.log('apply      :', typeof m.apply);

const S = m.Config['~standard'];
console.log('Config     :', typeof m.Config, '| ~standard:', !!S, '| version:', S.version, '| vendor:', S.vendor);

const bad = S.validate({ enabled: true, debounceMs: 'oops', escapeRoot: 'E:/x' });
console.log('validate bad:', JSON.stringify(bad));

const ok = S.validate({ enabled: false, debounceMs: 1000 });
console.log('validate ok :', JSON.stringify(ok));

console.log('resolveConfig escapeRoot:', m.resolveConfig({}).escapeRoot);
console.log('resolveConfig defaults  :', JSON.stringify(m.resolveConfig({}).envMap));
