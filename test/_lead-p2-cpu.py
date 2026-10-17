import json, os, sys, time
try:
    import psutil
except Exception as e:
    print(json.dumps({"ok": False, "error": "psutil:" + str(e)})); sys.exit(0)
root = int(sys.argv[1]) if len(sys.argv) > 1 else os.getpid()
out = {"ok": True, "root": root, "reps": []}
try:
    proc = psutil.Process(root)
    members = [proc] + proc.children(recursive=True)
    for r in range(3):
        c0, w0 = time.process_time(), time.perf_counter()
        n = 0
        for p in members:
            try: n += len(p.open_files())
            except Exception: pass
        out["reps"].append({
            "wallMs": round((time.perf_counter() - w0) * 1000, 1),
            "cpuMs": round((time.process_time() - c0) * 1000, 1),
            "files": n, "members": len(members)})
    out["verdict"] = "warm sweep cost measured"
except Exception as e:
    out["ok"] = False; out["error"] = type(e).__name__ + ":" + str(e)
print(json.dumps(out))
