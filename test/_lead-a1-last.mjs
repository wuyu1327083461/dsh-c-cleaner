// Lead: confirm the last remaining A1 spelling. Hypothesis: 'C:\PROGRA~1\SomeApp\a.dll' has a
// nonexistent PARENT (C:\Program Files\SomeApp), so realpath(parent) throws ENOENT and the alias
// survives. The current recipe only realpaths the immediate parent.
import { isProtectedPath } from '../lib/classifier.js';

const cases = [
  'C:\\PROGRA~1\\SomeApp\\a.dll',            // alias + nonexistent parent  <- suspected MISS
  'C:\\PROGRA~1\\SomeApp\\nested\\deep.dll', // alias + two nonexistent components
  'C:\\PROGRA~1\\evil.exe',                  // alias + existing parent (works)
  'C:\\PROGRA~2\\Nope\\b.dll',               // x86 alias + nonexistent parent
];
for (const c of cases) {
  const got = isProtectedPath(c);
  console.log(`${got ? 'ok  ' : 'MISS'}  ${JSON.stringify(c)} -> ${got}`);
}
