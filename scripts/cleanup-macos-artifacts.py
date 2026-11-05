#!/usr/bin/env python3
"""Plan/trash only TaroBot temporary Mac bundles; never erase app contents."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import subprocess
import sys
import time
import uuid

HOURS = 6 * 3600
DEFAULT_ROOTS = [
    "/Volumes/gdrive/taro-tmp.noindex", "/Volumes/gdrive/taro-tmp",
    "/Volumes/gdrive/dev-cache/tarobot-release-target.noindex",
    "/Volumes/gdrive/dev-cache/tarobot-release-target",
    "/Volumes/gdrive/dev-cache/tarocub-macos.noindex",
    "/Volumes/gdrive/dev-cache/tarocub-macos",
]
BUILD = re.compile(r"(?:^|[/\s])(cargo|rustc|tauri|xcodebuild|swiftc|codesign|notarytool|hdiutil|ditto)(?:$|[\s.])")
# Electron packaging runs under node; match its build scripts by argument.
ELECTRON_BUILD = re.compile(r"(?:^|[/\s])(?:electron-(?:build|dev|package|macos-artifacts)|macos-build|desktop-release|windows-build)\.mjs(?:\s|$)")
EXCLUDE = {".git", "node_modules", "incremental", "deps", ".Trash", ".venv", "venv", "site-packages", "registry", "npm-cache", ".gradle", "SourcePackages", "ModuleCache", "bots", "android", "ios", "src", "tests", "e2e", "docs", ".swiftpm", "_cacache"}
IDENTITY = re.compile(r"^com\.(?:tarobot|tarocub)(?:\.|$)")
VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
def below(item, parent):
    return item == parent or parent in item.parents

def active_below(item, parent):
    # macOS may report a canonical-case lsof path while a configured root uses
    # another spelling. For a protection check, conservatively over-preserve on
    # case-sensitive volumes too; a spelling difference must never permit trash.
    item, parent = Path(str(item).casefold()), Path(str(parent).casefold())
    return below(item, parent)

def checked_root(value):
    p = Path(value).absolute()
    if p.is_symlink() or p.resolve() != p:
        raise ValueError(f"Cleanup root must be a physical path, not an alias: {p}")
    if active_below(p, Path("/Applications")) or len(p.parts) < 4:
        raise ValueError("Installed applications and broad filesystem roots are forbidden")
    if str(p) not in DEFAULT_ROOTS and not any(x.endswith(".noindex") for x in p.parts):
        raise ValueError("Additional cleanup roots must be inside .noindex")
    return p

def activity():
    # No environment dumps. Raw arguments/open files never leave this process.
    names = subprocess.run(["/bin/ps", "-axo", "pid=,comm="], capture_output=True, text=True, check=True, timeout=8).stdout
    # Separate columns preserve executable paths containing spaces.
    ps = subprocess.run(["/bin/ps", "-axo", "pid=,args="], capture_output=True, text=True, check=True, timeout=8).stdout
    executables = {}
    for line in names.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2:
            executables[int(fields[0])] = fields[1]
    build = []
    commands = []
    for line in ps.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) < 2:
            continue
        pid, args = int(fields[0]), fields[1]
        command = executables.get(pid, "")
        # Do not classify the cleanup runner's own explanatory command line.
        if pid != os.getpid() and (BUILD.search(command) or re.search(r"(?:^|/)tauri(?:\.js)?(?:\s|$)", args) or ELECTRON_BUILD.search(args)):
            build.append({"pid": pid, "name": Path(command).name})
        commands.append((pid, args))
    ls = subprocess.run(["/usr/sbin/lsof", "-n", "-P", "-a", "-u", str(os.getuid()), "-F", "pn"],
                        capture_output=True, text=True, timeout=12)
    if ls.returncode not in (0, 1) or not ls.stdout or "incomplete" in ls.stderr.lower():
        raise RuntimeError("Cannot establish active-file ownership; cleanup refused")
    opened = []
    pid = None
    for line in ls.stdout.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n/") and pid != os.getpid():
            opened.append((pid, Path(line[1:])))
    return {"builders": build, "commands": commands, "opened": opened}

def collect(roots):
    result = []
    seen = set()
    visited = 0
    def walk(p, root):
        nonlocal visited
        if p.is_symlink():
            return
        st = p.stat()
        identity = (st.st_dev, st.st_ino)
        if identity in seen:
            return
        seen.add(identity)
        visited += 1
        if visited > 100000:
            raise RuntimeError(f"Discovery bound exceeded at {p}; narrow the roots")
        if p.suffix == ".app":
            info = p / "Contents/Info.plist"
            if not info.is_file():
                return
            with info.open("rb") as f:
                metadata = plistlib.load(f)
            if not IDENTITY.match(str(metadata.get("CFBundleIdentifier", ""))):
                return
            relative = p.relative_to(root)
            task = root / relative.parts[0] if len(relative.parts) > 1 else root
            result.append({"path": p, "task": task, "root": root,
                           "version": str(metadata.get("CFBundleShortVersionString", "")),
                           "backup": p.parent.name == "macos-ready" and p.name == "TaroBot.app" and metadata.get("CFBundleIdentifier") in ("com.tarobot.client", "com.tarocub.client")})
            return
        if p.name in EXCLUDE or p.suffix == ".xcarchive" or (p.name == "build" and p.parent.name in ("debug", "release")):
            return
        with os.scandir(p) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    walk(Path(entry.path), root)
    for root in roots:
        if root.exists():
            walk(root, root)
    return result

def recent_tree(app, cutoff):
    # A preserved bundle mtime alone is insufficient: files inside may be newer.
    for directory, dirs, files in os.walk(app, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
        for name in [""] + dirs + files:
            p = Path(directory) / name
            if p.lstat().st_mtime > cutoff:
                return True
    return False

def task_pending(task):
    for filename in ["activation.json", "activation-job.json"]:
        p = task / filename
        if not p.is_file():
            continue
        data = json.loads(p.read_text())
        if filename == "activation.json":
            # A rollback remains protected until the final GUI/runtime/model gates.
            if data.get("status") not in ("complete", "completed", "verified") and not (
                str(data.get("status", "")).startswith("installed")
                and data.get("guiWindowVerified") is True
                and data.get("realInstalledModelResponseVerified") is True):
                return True
        elif not (task / "activation.json").exists():
            return True
    return False

def plan_cleanup(roots, snapshot, now=None, keep_version=None, own_modified=None):
    own_modified = own_modified or {}
    now = time.time() if now is None else now
    candidates = collect(roots)
    backups = [c for c in candidates if c["backup"] and VERSION.fullmatch(c["version"])]
    # Publication of an older version must never retire a newer backup.
    newest = max(backups, key=lambda c: (tuple(map(int, c["version"].split("."))), c["path"].stat().st_mtime), default=None)
    blocked = bool(snapshot["builders"]) or newest is None or (
        keep_version is not None and not any(c["version"] == keep_version for c in backups))
    items = []
    for c in candidates:
        app, task = c["path"], c["task"]
        artifact_parents = [p for p in app.parents if below(p, task)]
        reason = None
        if newest and app.samefile(newest["path"]):
            reason = "latest-macos-ready"
        elif blocked:
            reason = "build-active" if snapshot["builders"] else "verified-version-backup-missing"
        elif any(p.stat().st_mtime > now - HOURS and own_modified.get(str(p)) != p.stat().st_mtime_ns for p in artifact_parents):
            reason = "directory-modified-within-six-hours"
        elif any(active_below(p, task) for _, p in snapshot["opened"]) or any(str(task).casefold() in args.casefold() for pid, args in snapshot["commands"] if pid != os.getpid()):
            reason = "active-process-uses-task-directory"
        elif any((p / "OWNER-HOLD.json").exists() for p in app.parents):
            # A held release candidate stays until its owner removes the hold;
            # presence alone protects it, even if the receipt cannot be parsed.
            # All ancestors: a custom root may sit below the held task.
            reason = "owner-hold"
        elif any(task_pending(p) for p in [task, *(p for p in app.parents if not below(p, c["root"]))]):
            reason = "activation-not-fully-accepted"
        elif recent_tree(app, now - HOURS):
            reason = "bundle-modified-within-six-hours"
        items.append({"path": str(app), "task": str(task), "version": c["version"],
                      "action": "skip" if reason else "trash", "reason": reason,
                      "identity": [app.stat().st_dev, app.stat().st_ino]})
    return {"mode": "dry-run", "blocked": blocked, "builders": snapshot["builders"],
            "keep": str(newest["path"]) if newest else None, "items": items}

def trash_bundle(app, expected_identity, trash=None, envelope_parent=None):
    if app.is_symlink() or app.resolve() != app or active_below(app, Path("/Applications")) or app.suffix != ".app":
        raise ValueError("Refusing an installed, aliased or non-app target")
    st = app.stat()
    if [st.st_dev, st.st_ino] != expected_identity:
        raise ValueError("Bundle identity changed after planning")
    # Trash the noindex envelope, not the bare .app: otherwise Trash itself can
    # reintroduce the bundle to Spotlight. No shell expansion, deletion or rm.
    parent = envelope_parent or app.parent
    if parent.resolve() != parent or active_below(parent, Path("/Applications")):
        raise ValueError("Unsafe retirement staging parent")
    envelope = parent / (".tarobot-retired-" + uuid.uuid4().hex + ".noindex")
    envelope.mkdir(mode=0o700)
    if envelope.stat().st_dev != st.st_dev:
        envelope.rmdir()
        raise ValueError("Retirement staging must be on the same volume")
    moved = envelope / app.name
    try:
        app.rename(moved)
        if trash:
            trash(envelope)
        else:
            subprocess.run(["/usr/bin/trash", str(envelope)], check=True, timeout=30, capture_output=True)
        if envelope.exists():
            raise RuntimeError("Trash command returned without moving its target")
    except BaseException:
        if moved.exists() and not app.exists():
            moved.rename(app)
        if envelope.exists() and not any(envelope.iterdir()):
            envelope.rmdir()
        raise
    return envelope.name

def perform_cleanup(roots, apply=False, keep_version=None, get_activity=activity, now=None, trash=None, verify_backup=None, checkpoint=lambda report: None):
    snapshot = get_activity()
    report = plan_cleanup(roots, snapshot, now, keep_version)
    report["mode"] = "apply" if apply else "dry-run"
    report["trashed"] = []
    checkpoint(report)
    if not apply or report["blocked"]:
        return report
    keep = Path(report["keep"])
    def identity(path):
        try:
            st = path.stat()
            return [st.st_dev, st.st_ino]
        except FileNotFoundError:
            return None
    verified = identity(keep)
    if verify_backup:
        verify_backup(keep)
    else:
        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", report["keep"]], check=True, timeout=45, capture_output=True)
    own_modified = {}
    # Recheck active processes, freshness and backup selection for EVERY item.
    for item in list(report["items"]):
        if item["action"] != "trash":
            continue
        fresh = plan_cleanup(roots, get_activity(), now, keep_version, own_modified)
        # The verified backup must still be the same bundle; a moved or replaced
        # (unverified) backup cannot justify further retirement in this run.
        # A newer backup appearing mid-run is not in the original trash set.
        if fresh["blocked"] or verified is None or identity(keep) != verified:
            report["deferred"] = "activity-or-backup-changed"
            break
        current = next((c for c in fresh["items"] if c["path"] == item["path"]), None)
        if not current or current["action"] != "trash" or current["identity"] != item["identity"]:
            item.update(action="skip", reason="changed-during-cleanup")
            checkpoint(report)
            continue
        trash_bundle(Path(item["path"]), item["identity"], trash)
        parent = Path(item["path"]).parent
        own_modified[str(parent)] = parent.stat().st_mtime_ns
        report["trashed"].append(item["path"])
        checkpoint(report)
    return report

def normalize_legacy_trash(apply=False, get_activity=activity, trash_root=None, now=None, candidates=None, checkpoint=lambda rows: None, trash=None):
    """Wrap only already-trashed historical installer backups, never erase them."""
    root = Path(trash_root) if trash_root else Path.home() / ".Trash"
    if root.is_symlink() or not root.is_dir():
        return []
    now = time.time() if now is None else now
    rows = []
    for value in candidates if candidates is not None else root.iterdir():
        app = Path(value)
        if app.parent != root:
            raise ValueError("Legacy backup must already be directly inside the user's Trash")
        if app.is_symlink() or not app.is_dir() or not re.fullmatch(r"\.(?:TaroBot|TaroCub)-before-\d+\.\d+\.\d+\.app", app.name):
            continue
        with (app / "Contents/Info.plist").open("rb") as f:
            metadata = plistlib.load(f)
        if not IDENTITY.match(str(metadata.get("CFBundleIdentifier", ""))):
            continue
        snapshot = get_activity()
        reason = None
        if snapshot["builders"]:
            reason = "build-active"
        elif recent_tree(app, now - HOURS):
            reason = "bundle-modified-within-six-hours"
        elif any(below(p, app) for _, p in snapshot["opened"]) or any(str(app) in args for pid, args in snapshot["commands"] if pid != os.getpid()):
            reason = "active-process-uses-bundle"
        row = {"path": str(app), "action": "skip" if reason else "wrap-already-in-trash", "reason": reason}
        rows.append(row)
        if apply and not reason:
            st = app.stat()
            identity = [st.st_dev, st.st_ino]
            # An in-Trash rename left the old Spotlight entry indexed in live
            # acceptance. Use an actual system Trash transition from a same-
            # volume noindex envelope; failed trash restores the original App.
            name = trash_bundle(app, identity, trash, envelope_parent=root.parent)
            destination = root / name / app.name
            row["destination"] = str(destination)
            checkpoint(rows)
            moved = destination.stat()
            if [moved.st_dev, moved.st_ino] != identity:
                raise RuntimeError("Retired backup identity read-back mismatch")
        checkpoint(rows)
    return rows

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", action="append", help="Repeat to select .noindex roots; default includes known legacy artifact roots")
    parser.add_argument("--normalize-legacy-trash", action="store_true", help="Re-trash historical .TaroBot-before-VERSION.app backups through a same-volume .noindex envelope; never empty Trash")
    parser.add_argument("--legacy-trash-app", action="append", help="Limit legacy Trash normalization to exact known indexed backup paths; no Trash enumeration")
    parser.add_argument("--apply", action="store_true", help="Use /usr/bin/trash; the default is read-only")
    parser.add_argument("--keep-version", help="Require a macos-ready backup for this published version before cleanup")
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args()
    roots = [checked_root(p) for p in args.root or DEFAULT_ROOTS]
    receipt = Path(args.receipt).absolute()
    receipt.parent.mkdir(parents=True, exist_ok=True)
    # Serialize cleanup runs. Stale locks are deliberately not stolen.
    lock = Path("/private/tmp/tarobot-macos-artifact-cleanup.lock")
    acquired = False
    report = {"mode": "apply" if args.apply else "dry-run", "status": "running", "trashed": [], "items": []}
    def checkpoint(state):
        nonlocal report
        report = state
        report["roots"] = [str(p) for p in roots]
        report["checkedAt"] = time.time()
        temporary = receipt.with_name(receipt.name + ".partial")
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(receipt)
    def trash_checkpoint(rows):
        report["legacyTrash"] = rows
        checkpoint(report)
    try:
        checkpoint(report)
        if args.apply:
            if sys.platform != "darwin" or not Path("/usr/bin/trash").is_file():
                raise RuntimeError("Apply requires macOS /usr/bin/trash")
            lock.mkdir(mode=0o700)
            acquired = True
        def timed_out(signum, frame):
            raise TimeoutError("Artifact cleanup exceeded its bounded scan deadline")
        signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(150)
        report = perform_cleanup(roots, args.apply, args.keep_version, checkpoint=checkpoint)
        if args.normalize_legacy_trash or args.legacy_trash_app:
            report["legacyTrash"] = normalize_legacy_trash(args.apply, candidates=args.legacy_trash_app, checkpoint=trash_checkpoint)
        report["status"] = "deferred" if report["blocked"] or report.get("deferred") else "complete"
        checkpoint(report)
        print(json.dumps({"receipt": str(receipt), "mode": report["mode"], "blocked": report["blocked"],
                          "status": report["status"],
                          "keep": report["keep"], "trashed": len(report["trashed"]),
                          "skipped": sum(i["action"] == "skip" for i in report["items"])}))
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        checkpoint(report)
        raise
    finally:
        signal.alarm(0)
        if acquired:
            lock.rmdir()

if __name__ == "__main__":
    main()
