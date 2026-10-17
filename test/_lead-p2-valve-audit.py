# Lead-owned audit (read-only): how much of the LOCKED_CRITICAL tier is earned only by the
# PRD 3.3 safety valve's loose substring match (auth/config/token/credential) rather than by a
# real lock or a real credential shape?
#
# Reports counts only. Touches nothing.
import json
import os
import re
import sys
import urllib.request
from collections import Counter

RE = re.compile(r'\.lock$|\.sqlite3?$|\.db$|auth|config|token|credential', re.I)
STRONG = ('.lock', '.sqlite', '.sqlite3', '.db', 'credentials', 'auth.json', 'token')


def fetch(url, data=None, origin=None):
    headers = {'content-type': 'application/json'}
    if origin:
        headers['origin'] = origin
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except Exception:
            return e.code, None


base = 'http://127.0.0.1:3080/c-cleaner/api'
status, body = fetch(base + '/state')
print('GET /state ->', status)
if status != 200 or not body:
    print('FATAL: no snapshot')
    sys.exit(1)

v = body.get('value') or {}
rows = v.get('rows') or []
hj = v.get('hijack') or {}
print('hijack keys      =', sorted(hj.keys()))
print('hijack installed =', hj.get('installed'))
for k in ('variables', 'applied', 'vars', 'redirected', 'keys', 'map'):
    if k in hj:
        val = hj[k]
        print('  hijack.%s = %r' % (k, (len(val) if hasattr(val, '__len__') else val)))
print('escapeRoot       =', v.get('escapeRoot'))
print('rows             =', len(rows))
print('tiers            =', dict(Counter(r.get('category') for r in rows)))

msi = [r for r in rows if r['file_path'].lower().endswith('.msi')]
print()
print('--- why are %d .msi rows still tracked? ---' % len(msi))
for m in msi:
    b = os.path.basename(m['file_path'])
    hit = RE.search(b)
    print('  base=%s' % b[:64])
    print('    regex hit = %r  category = %s  is_locked = %s' % (hit.group(0) if hit else None, m.get('category'), m.get('is_locked')))

locked = [r for r in rows if r.get('category') == 'LOCKED_CRITICAL']
print()
print('--- LOCKED_CRITICAL composition (%d rows) ---' % len(locked))
real_lock = [r for r in locked if r.get('is_locked')]
valve_only = []
for r in locked:
    if r.get('is_locked'):
        continue
    b = os.path.basename(r['file_path'])
    hit = RE.search(b)
    if hit:
        valve_only.append((hit.group(0).lower(), b))
print('  rows with a REAL lock handle   =', len(real_lock))
print('  rows with no lock, valve only  =', len(valve_only))
print('  by matched substring =', dict(Counter(k for k, _ in valve_only)))
print('  samples:')
for k, b in valve_only[:15]:
    print('    [%-10s] %s' % (k, b[:76]))
