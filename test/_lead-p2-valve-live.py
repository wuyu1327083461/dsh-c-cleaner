# Lead-owned Phase 2 probe: the §3.3 SAFETY VALVE, end to end through the LIVE panel API.
#
# Closes the loop on the one PRD conflict in the noise gate: PRD 3.2 says only
# dsh-attributable or AI-signature files are RECORDED, but PRD 3.3 says a
# credential-shaped file must surface as LOCKED_CRITICAL and be shown with its holder.
# A pure signature gate silently drops `credentials.json` (matches no glob), so the
# gate carries an explicit valve. This proves the valve holds in the RUNNING harness.
#
#   python test/_lead-p2-valve-live.py
import json
import os
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:3080/c-cleaner/api/"
TEMP = os.path.join(os.environ.get("LOCALAPPDATA", r"C:\Users\kiuhg\AppData\Local"), "Temp")

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


def get():
    with urllib.request.urlopen(BASE + "state") as r:
        return json.load(r)["value"]


def main():
    stamp = "%d" % (time.time() * 1000 % 1000000)
    d = os.path.join(TEMP, "dshcc_lead_valve_" + stamp)
    os.makedirs(d, exist_ok=True)
    cases = {
        # (name, basename, expected tracked?, expected tier)
        "credential (valve)": ("credentials.json", True, "LOCKED_CRITICAL"),
        "token file (valve)": ("session.token", True, "LOCKED_CRITICAL"),
        "sqlite db (valve)": ("cache.sqlite", True, "LOCKED_CRITICAL"),
        "signature glob": ("pip-valve-probe.log", True, "SAFE_TO_DELETE"),
        "other-software noise": ("Win11SDK_ValveProbe.msi", False, None),
        "random unknown name": ("zqx_other_app_blob.bin", False, None),
    }
    for _, (base, _, _) in cases.items():
        with open(os.path.join(d, base), "w", encoding="utf-8") as f:
            f.write("probe %s\n" % stamp)

    print("wrote %d probe files to %s" % (len(cases), d))
    time.sleep(11)  # debounce (3s) + watcher settle + API read

    rows = {r["file_path"].lower(): r for r in get()["rows"]}
    for label, (base, expect_tracked, expect_tier) in cases.items():
        path = os.path.join(d, base).lower()
        row = rows.get(path)
        check(
            "%s: tracked=%s" % (label, expect_tracked),
            (row is not None) == expect_tracked,
            "row=%r" % (row,),
        )
        if row is not None and expect_tier is not None:
            check(
                "%s: tier is %s" % (label, expect_tier),
                row.get("category") == expect_tier,
                "got %r (reason=%r)" % (row.get("category"), row.get("reason")),
            )

    # The rubber stamp, at the layer where it actually lives: the DB (PRD §5 schema) has
    # no `reason` column, so the reason string is a classifier-level field. Assert it
    # there directly — the persisted row only has to carry the tier.
    cred = rows.get(os.path.join(d, "credentials.json").lower())
    if cred is not None:
        check(
            "credential row is locked/greyed as LOCKED_CRITICAL",
            cred.get("category") == "LOCKED_CRITICAL",
            "category=%r" % cred.get("category"),
        )

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import subprocess

    # NOTE: an absolute `F:/...` specifier is NOT a valid ESM URL on Windows
    # (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), so the probe imports RELATIVE to a file
    # written INTO the plugin's own test/ directory.
    here = os.path.dirname(os.path.abspath(__file__))
    probe = os.path.join(here, "_lead-p2-classify-probe.mjs")
    js = (
        "import { classify } from '../lib/classifier.js';\n"
        "const r = classify({ path: process.argv[2], size: 14, mtimeMs: Date.now(), sourceProcess: null },\n"
        "  { cfg: { protectRoots: [], useRecycleBin: true }, tree: null });\n"
        "console.log(JSON.stringify({ category: r.category, reason: r.reason }));\n"
    )
    with open(probe, "w", encoding="utf-8") as f:
        f.write(js)
    out = subprocess.run(
        ["node", probe, os.path.join(d, "credentials.json")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=here,
    )
    parsed = {}
    try:
        parsed = json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:
        pass
    check(
        "classify() independently returns LOCKED_CRITICAL for credentials.json",
        parsed.get("category") == "LOCKED_CRITICAL",
        (out.stdout or "") + (out.stderr or ""),
    )
    check(
        "classify() explains WHY (reason names a rule)",
        bool(parsed.get("reason")),
        (out.stdout or "") + (out.stderr or ""),
    )

    print("\nSUMMARY pass=%d fail=%d total=%d" % (PASS, FAIL, PASS + FAIL))
    print("probe dir: %s" % d)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
