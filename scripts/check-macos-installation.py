#!/usr/bin/env python3
"""Read-only installed-App audit. Reports private local paths; do not publish raw output.

Checks immediate .app children of the selected directory, /Applications and
~/Applications, plus on-disk LaunchAgents. Does not launch Apps, query secrets,
change registration, or certify loaded login items, Dock links or custom folders.
"""
import argparse
import json
import os
import plistlib
from pathlib import Path

APP_ID = "com.tarobot.client"


def read_plist(file):
    if file.stat().st_size > 1024 * 1024:
        raise ValueError("plist_too_large")
    value = plistlib.loads(file.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("invalid_plist")
    return value


def references_app(argument, app):
    if not isinstance(argument, str) or not Path(argument).is_absolute():
        return False
    # Missing trailing runtime files still resolve existing parent symlinks.
    # Keep the lexical check as well for a retained but broken installation.
    return (Path(argument).is_relative_to(app)
            or Path(argument).resolve().is_relative_to(app))


def inspect_installation(app, roots, home):
    app = app.resolve(strict=True)
    info = read_plist(app / "Contents/Info.plist")
    executable = info.get("CFBundleExecutable")
    if app.suffix != ".app" or info.get("CFBundleIdentifier") != APP_ID:
        raise ValueError("selected_app_identity_mismatch")
    if not isinstance(executable, str) or Path(executable).name != executable or executable in ("", ".", ".."):
        raise ValueError("invalid_app_executable")
    program = (app / "Contents/MacOS" / executable).resolve(strict=True)
    if not program.is_file() or not program.is_relative_to(app):
        raise ValueError("invalid_app_executable")
    issues, copies, inspected = [], {app}, []
    for root in sorted({app.parent, *(p.resolve() for p in roots)}):
        if not root.exists():
            continue
        inspected.append(str(root))
        try:
            with os.scandir(root) as entries:
                candidates = [Path(entry.path) for entry in entries if entry.name.lower().endswith(".app")]
            if len(candidates) > 1024:
                raise ValueError("too_many_apps")
            for candidate in candidates:
                try:
                    metadata = read_plist(candidate / "Contents/Info.plist")
                    if metadata.get("CFBundleIdentifier") == APP_ID:
                        copies.add(candidate.resolve(strict=True))
                except (OSError, ValueError, plistlib.InvalidFileException):
                    issues.append({"code": "unreadable_app", "path": str(candidate)})
        except (OSError, ValueError):
            issues.append({"code": "unreadable_app_directory", "path": str(root)})
    duplicates = sorted(copies - {app})
    for duplicate in duplicates:
        issues.append({"code": "duplicate_app_identity", "path": str(duplicate)})

    agents = home / "Library/LaunchAgents"
    login = agents / "TaroBot.plist"
    login_state = "absent"
    if login.exists() or login.is_symlink():
        try:
            if login.is_symlink():
                raise ValueError("linked_login_item")
            value = read_plist(login)
            args = value.get("ProgramArguments")
            if value.get("Label") != "TaroBot":
                raise ValueError("foreign_login_item")
            if value.get("RunAtLoad") is True:
                login_state = "enabled"
                # Extra arguments or a Program override are not the managed entry.
                if not isinstance(args, list) or len(args) != 1 or not isinstance(args[0], str) or value.get("Program"):
                    raise ValueError("unexpected_login_command")
                if Path(args[0]).resolve() != program:
                    login_state = "stale"
                    issues.append({"code": "stale_login_item", "path": str(login)})
            else:
                login_state = "disabled"
        except (OSError, ValueError, plistlib.InvalidFileException):
            login_state = "conflict"
            issues.append({"code": "login_item_conflict", "path": str(login)})

    # Record dependencies before anyone considers retiring a duplicate. Never
    # include command arguments, environment variables or credential contents.
    references = []
    if agents.exists():
        try:
            with os.scandir(agents) as entries:
                files = [Path(entry.path) for entry in entries if entry.name.endswith(".plist")]
            if len(files) > 1024:
                raise ValueError("too_many_agents")
        except (OSError, ValueError):
            files = []
            issues.append({"code": "unreadable_launch_agents_directory", "path": str(agents)})
        for file in sorted(files):
            try:
                if file.is_symlink():
                    raise ValueError("linked_agent")
                value = read_plist(file)
                args = value.get("ProgramArguments", [])
                commands = (args if isinstance(args, list) else []) + [value.get("Program")]
                for duplicate in duplicates:
                    if any(references_app(arg, duplicate) for arg in commands):
                        references.append({"agent": str(file), "app": str(duplicate)})
            except (OSError, ValueError, RuntimeError, plistlib.InvalidFileException):
                issues.append({"code": "unreadable_launch_agent", "path": str(file)})
    return {"ok": not issues, "app": str(app), "version": info.get("CFBundleShortVersionString"),
            "roots": inspected, "loginItem": login_state, "issues": issues,
            "duplicateDependencies": references, "scope": "on-disk bundles and LaunchAgents only"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--root", type=Path, action="append", default=[], help="Additional installation folder (not recursive)")
    args = parser.parse_args()
    home = Path.home()
    report = inspect_installation(args.app, [Path("/Applications"), home / "Applications", *args.root], home)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
