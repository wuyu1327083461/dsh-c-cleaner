import json, os, sys, time
try:
    import psutil
except Exception as e:
    print(json.dumps({"ok": False, "error": "psutil:" + str(e)})); sys.exit(0)
root = int(sys.argv[1]) if len(sys.argv) > 1 else os.getpid()
out = {"ok": True, "root": root}
try:
    t0 = time.perf_counter()
    proc = psutil.Process(root)
    kids = proc.children(recursive=True)
    members = [proc] + kids
    out["childrenMs"] = round((time.perf_counter() - t0) * 1000, 1)
    rows = []
    t1 = time.perf_counter()
    for p in members:
        s = time.perf_counter()
        n = 0; err = None
        try:
            n = len(p.open_files())
        except Exception as e:
            err = type(e).__name__
        rows.append({"pid": p.pid, "name": p.name(), "files": n,
                     "ms": round((time.perf_counter() - s) * 1000, 1), "err": err})
    out["handlesMs"] = round((time.perf_counter() - t1) * 1000, 1)
    out["members"] = len(members)
    rows.sort(key=lambda r: -r["ms"])
    out["rows"] = rows
    out["totalHandleFiles"] = sum(r["files"] for r in rows)
except Exception as e:
    out["ok"] = False; out["error"] = type(e).__name__ + ":" + str(e)
print(json.dumps(out))
