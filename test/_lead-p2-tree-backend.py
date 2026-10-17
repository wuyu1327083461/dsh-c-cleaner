# Candidate ProcessTree backend: one-shot JSON {rows:[{pid,ppid,name}]} for the dsh tree.
# Measures the SPWAN cost of a psutil-based enumeration against the PowerShell CIM backend.
import json
import sys
import time

root = int(sys.argv[1]) if len(sys.argv) > 1 else 0

try:
    import psutil
except Exception as exc:
    print(json.dumps({"ok": False, "error": "import psutil failed: %s" % exc}))
    raise SystemExit(0)

t0 = time.time()
try:
    proc = psutil.Process(root)
    kids = proc.children(recursive=True)
except Exception as exc:
    print(json.dumps({"ok": False, "error": "Process(%s) failed: %s" % (root, exc)}))
    raise SystemExit(0)
t1 = time.time()

rows = []
for p in [proc] + kids:
    try:
        rows.append({"pid": p.pid, "ppid": p.ppid(), "name": p.name()})
    except Exception:
        pass
t2 = time.time()

print(json.dumps({
    "ok": True,
    "root": root,
    "count": len(rows),
    "childrenMs": round((t1 - t0) * 1000, 1),
    "namesMs": round((t2 - t1) * 1000, 1),
    "endToEndMs": round((t2 - t0) * 1000, 1),
    "rows": rows,
}))
