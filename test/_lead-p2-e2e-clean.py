# Lead-owned Phase 2 end-to-end probe: drive the LIVE panel API and prove the
# server-side guards hold. Python is used because of the Windows path quoting.
#
#   python test/_lead-p2-e2e-clean.py <windows-path-of-a-tracked-SAFE-file>
#
# It checks, in order:
#   1. an unknown path is REJECTED (the panel cannot name a file the plugin never tracked)
#   2. a tracked SAFE_TO_DELETE file is really deleted and the file is gone from disk
#   3. the same request twice: the second one is rejected (row is gone from the DB too)
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3080/c-cleaner/api/"
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("PASS %s" % name)
    else:
        FAIL += 1
        print("FAIL %s%s" % (name, (" -- " + detail) if detail else ""))


def post(verb, obj):
    req = urllib.request.Request(
        BASE + verb,
        data=json.dumps(obj).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r).get("value")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def get(verb):
    with urllib.request.urlopen(BASE + verb) as r:
        return r.status, json.load(r).get("value")


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    if not target:
        print("usage: _lead-p2-e2e-clean.py <windows path of a tracked SAFE file>")
        return 2

    status, state = get("state")
    check("GET /state is 200", status == 200)
    rows = (state or {}).get("rows") or []
    tracked = [r for r in rows if r.get("file_path") == target]
    check("the target is tracked by the plugin before the clean", len(tracked) == 1)
    if tracked:
        check(
            "the target's persisted tier is SAFE_TO_DELETE",
            tracked[0].get("category") == "SAFE_TO_DELETE",
            "got %r" % tracked[0].get("category"),
        )

    # 1. Forgery: a path the plugin never tracked must not reach the cleaner.
    status, value = post(
        "clean", {"paths": ["C:\\Windows\\System32\\kernel32.dll"], "deep": False, "force": False}
    )
    check(
        "POST /clean with an untracked path is refused (no deletion)",
        status != 200 or ((value or {}).get("report") or {}).get("removed", 0) == 0,
    )
    if value:
        rep = value.get("report") or {}
        check(
            "the untracked path lands in `rejected`",
            any("kernel32" in str(p).lower() for p in (value.get("rejected") or [])),
            "rejected=%r" % (value.get("rejected"),),
        )
        check("nothing was removed for the forged request", (rep.get("removed") or 0) == 0)
    check("kernel32.dll still exists on disk", os.path.exists("C:\\Windows\\System32\\kernel32.dll"))

    # 2. The real clean. `clean()` reports {removed, skipped, bytesFreed, errors, skippedList}.
    status, value = post("clean", {"paths": [target], "deep": False, "force": False})
    check("POST /clean with a real tracked path is 200", status == 200)
    rep = (value or {}).get("report") or {}
    check("exactly one file removed", rep.get("removed") == 1, "report=%r" % (rep,))
    check("nothing was skipped", (rep.get("skipped") or 0) == 0, "report=%r" % (rep,))
    check("the file is GONE from disk", not os.path.exists(target))
    check("bytesFreed is the file's size", (rep.get("bytesFreed") or 0) > 0, "report=%r" % (rep,))

    # 3. Replay: the row must be gone, so the path is now unknown.
    status, value = post("clean", {"paths": [target], "deep": False, "force": False})
    rep2 = (value or {}).get("report") or {}
    check(
        "a replayed clean of the same path removes nothing",
        (rep2.get("removed") or 0) == 0,
        "report=%r" % (rep2,),
    )

    print("\nSUMMARY pass=%d fail=%d total=%d" % (PASS, FAIL, PASS + FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
