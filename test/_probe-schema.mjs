// Probe: confirm the schemastery API surface used by index.js Config.
import { createRequire } from 'node:module';
const req = createRequire('E:/dsh/.dsh/profiles/tauri/package.json');
const zpath = req.resolve('@deepseek-ai/schemastery');
const mod = await import('file:///' + zpath.replaceAll('\\', '/'));
const z = mod.default;
console.log('resolved:', zpath);
console.log('type:', typeof z, 'has object():', typeof z.object, 'has array():', typeof z.array);
const S = z.object({
  enabled: z.boolean().default(true).description('总开关'),
  escapeRoot: z.string().description('root'),
  count: z.number().default(50),
  watchDirs: z.array(z.object({ path: z.string(), recursive: z.boolean(), maxDepth: z.number() })),
  envMap: z.object({}),
  list: z.array(z.string()),
});
console.log('schema built OK');
console.log('parse partial  :', JSON.stringify(S({ escapeRoot: 'E:\\x' })));
console.log('parse with all :', JSON.stringify(S({ enabled: false, escapeRoot: 'E:\\x', count: 7 })));
// How does the loader call it?
console.log('typeof S:', typeof S, 'callable:', typeof S === 'function');
