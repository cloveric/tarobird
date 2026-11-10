import importlib.util
import plistlib
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("installation", Path(__file__).with_name("check-macos-installation.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class InstalledMacTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(suffix=".noindex")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.apps = self.root / "Applications"
        self.home = self.root / "home"
        self.app = self.bundle("TaroBird.app")
        self.login = self.home / "Library/LaunchAgents/TaroBot.plist"

    def bundle(self, name, identity=audit.APP_ID):
        p = self.apps / name
        (p / "Contents/MacOS").mkdir(parents=True)
        (p / "Contents/MacOS/client").write_text("not executable")
        (p / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": identity,
            "CFBundleExecutable": "client", "CFBundleShortVersionString": "1.2.1"}))
        return p

    def agent(self, program, **extra):
        self.login.parent.mkdir(parents=True, exist_ok=True)
        self.login.write_bytes(plistlib.dumps({"Label": "TaroBot", "RunAtLoad": True,
            "ProgramArguments": [str(program)], **extra}))

    def inspect(self):
        return audit.inspect_installation(self.app, [self.apps], self.home)

    def test_single_current_app_without_autostart_is_clean(self):
        self.assertTrue(self.inspect()["ok"])

    def test_current_login_is_clean_and_bytes_unchanged(self):
        self.agent(self.app / "Contents/MacOS/client")
        before = self.login.read_bytes()
        self.assertTrue(self.inspect()["ok"])
        self.assertEqual(self.login.read_bytes(), before)

    def test_duplicate_and_stale_login_are_reported_without_executing_either_app(self):
        old = self.bundle("TaroBot.app")
        self.agent(old / "Contents/MacOS/client")
        result = self.inspect()
        self.assertEqual({i["code"] for i in result["issues"]}, {"duplicate_app_identity", "stale_login_item"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["loginItem"], "stale")

    def test_nonstandard_duplicate_name_and_runtime_dependency_are_detected_without_args(self):
        old = self.bundle("Previous.app")
        self.agent(self.app / "Contents/MacOS/client")
        (self.login.parent / "relay.plist").write_bytes(plistlib.dumps({"ProgramArguments":
            [str(old / "Contents/Resources/host/node"), "private-argument-not-for-output"]}))
        result = self.inspect()
        self.assertEqual(result["duplicateDependencies"], [{"agent": str(self.login.parent / "relay.plist"), "app": str(old)}])
        self.assertNotIn("private-argument", str(result))

    def test_current_app_with_legacy_name_is_valid(self):
        renamed = self.apps / "TaroBot.app"
        self.app.rename(renamed)
        self.app = renamed
        self.agent(self.app / "Contents/MacOS/client")
        self.assertTrue(self.inspect()["ok"])

    def test_dependency_through_a_symlinked_parent_is_not_missed(self):
        old = self.bundle("TaroBot.app")
        alias = self.root / "InstalledAlias"
        alias.symlink_to(self.apps, target_is_directory=True)
        self.agent(self.app / "Contents/MacOS/client")
        relay = self.login.parent / "relay.plist"
        relay.write_bytes(plistlib.dumps({"Program": str(alias / "TaroBot.app/Contents/Resources/host/node")}))
        self.assertEqual(self.inspect()["duplicateDependencies"], [{"agent": str(relay), "app": str(old)}])

    def test_missing_old_bundle_still_reports_stale_login(self):
        self.agent(self.apps / "Gone.app/Contents/MacOS/client")
        self.assertEqual(self.inspect()["issues"][0]["code"], "stale_login_item")

    def test_alias_of_same_bundle_is_not_duplicate(self):
        (self.apps / "Alias.app").symlink_to(self.app, target_is_directory=True)
        self.assertTrue(self.inspect()["ok"])

    def test_foreign_bundle_is_not_duplicate(self):
        self.bundle("Other.app", "example.other")
        self.assertTrue(self.inspect()["ok"])

    def test_symlink_login_is_a_conflict_without_reading_target(self):
        self.agent(self.app / "Contents/MacOS/client")
        other = self.root / "other.plist"
        self.login.rename(other)
        self.login.symlink_to(other)
        self.assertEqual(self.inspect()["loginItem"], "conflict")

    def test_disabled_login_is_not_enabled(self):
        self.agent("/old/client", RunAtLoad=False)
        self.assertTrue(self.inspect()["ok"])
        self.assertEqual(self.inspect()["loginItem"], "disabled")

    def test_foreign_label_and_program_override_fail_closed(self):
        for extra in ({"Label": "Other"}, {"Program": "/other/client"}):
            self.agent(self.app / "Contents/MacOS/client", **extra)
            self.assertEqual(self.inspect()["loginItem"], "conflict")

    def test_malformed_bundle_cannot_silently_pass(self):
        old = self.bundle("TaroBot.app")
        (old / "Contents/Info.plist").write_text("invalid")
        self.assertEqual(self.inspect()["issues"][0]["code"], "unreadable_app")


if __name__ == "__main__":
    unittest.main()
