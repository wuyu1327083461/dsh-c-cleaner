# Lead probe: is psutil's children(recursive=True) fast enough for the PRD 6.1 CPU budget,
# and does open_files() on just the tree members give rule #1 (handle -> pid) attribution?
import json, sys, time
def main():
    root = int(sys.argv[1])
    reps = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    import psutil
    t_start = time.time()
    import_ms = (t_start) * 1000
    out = []
    proc = psutil.Process(root)
    for i in range(reps):
        t0 = time.time()
        try:
            kids = proc.children(recursive=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "children failed: %s" % e})); return
        t1 = time.time()
        members = [proc] + kids
        handles = {}
        names = {}
        denied = 0
        for p in members:
            try:
                try: names[p.pid] = p.name()
                except Exception: pass
                for f in p.open_files():
                    handles.setdefault(f.path, []).append(p.pid)
            except Exception:
                denied += 1
        t2 = time.time()
        out.append({
            "rep": i,
            "childrenMs": round((t1 - t0) * 1000, 1),
            "handlesMs": round((t2 - t1) * 1000, 1),
            "members": len(members),
            "handlePaths": len(handles),
            "denied": denied,
        })
    print(json.dumps({
        "ok": True, "pid": root, "psutil": psutil.__version__,
        "importMs": round(import_ms, 1), "reps": out,
        "memberNames": [names.get(p.pid) for p in members],
        "sampleHandles": list(handles.items())[:5],
    }))
try: main()
except Exception as e: print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
