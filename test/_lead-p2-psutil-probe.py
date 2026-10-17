# Lead probe (Phase 2 recon): measure whether psutil can supply BOTH halves of the
# PRD 3.2 attribution contract in ONE spawn, and how long a sweep takes.
#   1. recursive child-process set of a root pid  -> tree membership
#   2. per-tree-member open-file handles          -> handle reverse lookup
# Emits a single JSON object on stdout. Never raises: a broken env must still report.
import json
import os
import sys
import time


def main():
    root = int(sys.argv[1]) if len(sys.argv) > 1 else os.getpid()
    try:
        import psutil
    except Exception as exc:  # pragma: no cover - environment probe
        print(json.dumps({"ok": False, "error": "import psutil failed: %s" % exc}))
        return

    t0 = time.time()
    procs = []
    try:
        for p in psutil.process_iter(["pid", "ppid", "name"]):
            try:
                procs.append(p.info)
            except Exception:
                pass
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "process_iter failed: %s" % exc}))
        return
    t1 = time.time()

    children = {}
    for info in procs:
        pid = info.get("pid")
        ppid = info.get("ppid")
        if pid is None or ppid is None:
            continue
        children.setdefault(ppid, []).append(pid)

    members = []
    seen = set()
    stack = [root]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        members.append(cur)
        stack.extend(children.get(cur, []))
    t2 = time.time()

    handles = {}
    denied = 0
    names = {}
    for pid in members:
        try:
            proc = psutil.Process(pid)
            try:
                names[pid] = proc.name()
            except Exception:
                pass
            for f in proc.open_files():
                key = os.path.normcase(os.path.abspath(f.path))
                handles.setdefault(key, []).append(pid)
        except Exception:
            denied += 1
    t3 = time.time()

    print(json.dumps({
        "ok": True,
        "psutil": getattr(psutil, "__version__", "?"),
        "python": sys.version.split()[0],
        "root": root,
        "procCount": len(procs),
        "memberCount": len(members),
        "handleCount": sum(len(v) for v in handles.values()),
        "handlePaths": len(handles),
        "denied": denied,
        "enumerateMs": round((t1 - t0) * 1000, 1),
        "treeMs": round((t2 - t1) * 1000, 1),
        "handlesMs": round((t3 - t2) * 1000, 1),
        "totalMs": round((t3 - t0) * 1000, 1),
        "memberSample": [{"pid": p, "name": names.get(p)} for p in members[:6]],
        "handleSample": [{"path": k, "pids": v} for k, v in list(handles.items())[:6]],
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # keep the contract "never raises"
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))
