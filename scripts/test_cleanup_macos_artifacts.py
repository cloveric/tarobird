import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup-macos-artifacts.py"))
c=importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(suffix=".noindex")
        self.root=Path(self.temp.name).resolve()
        self.now=time.time()
        self.empty={"builders":[],"commands":[],"opened":[]}
    def tearDown(self):
        self.temp.cleanup()
    def app(self, relative, version="1.0.119"):
        p=self.root/relative
        (p/"Contents").mkdir(parents=True)
        with (p/"Contents/Info.plist").open("wb") as f:
            plistlib.dump({"CFBundleIdentifier":"com.tarobot.client","CFBundleShortVersionString":version},f)
        return p
    def age(self):
        old=self.now-c.HOURS-10
        for parent,dirs,files in os.walk(self.root):
            for name in dirs+files: os.utime(Path(parent)/name,(old,old))
        os.utime(self.root,(old,old))
    def setup_apps(self):
        latest=self.app("release-current/macos-ready/TaroBot.app")
        old=self.app("release-old/macos-ready/TaroBot.app","1.0.118")
        fixture=self.app("audit/TaroBot Side Window Acceptance.app")
        self.age()
        return latest,old,fixture
    def plan(self,snapshot=None,**kw):
        return c.plan_cleanup([self.root],snapshot or self.empty,now=self.now,**kw)
    def test_only_latest_backup_is_retained(self):
        latest,old,fixture=self.setup_apps()
        report=self.plan()
        self.assertEqual(report["keep"],str(latest))
        self.assertEqual({i["path"] for i in report["items"] if i["action"]=="trash"},{str(old),str(fixture)})
    def test_rebranded_backup_is_retained_alongside_legacy_app_discovery(self):
        old=self.app("release-old/macos-ready/TaroBot.app","1.1.1")
        latest=self.app("release-new/macos-ready/TaroBird.app","1.1.2")
        self.age()
        report=self.plan(keep_version="1.1.2")
        self.assertEqual(report["keep"],str(latest))
        self.assertEqual({i["path"] for i in report["items"] if i["action"]=="trash"},{str(old)})
    def case_alias(self):
        alias=self.root.with_name(self.root.name.removesuffix(".noindex").swapcase()+".noindex")
        if alias == self.root or not alias.exists() or not alias.samefile(self.root):
            self.skipTest("requires a case-insensitive filesystem")
        return alias
    def test_case_alias_roots_do_not_duplicate_or_retire_the_retained_backup(self):
        latest,old,fixture=self.setup_apps()
        alias=self.case_alias()
        report=c.plan_cleanup([self.root,alias],self.empty,now=self.now)
        self.assertEqual(len(report["items"]),3)
        self.assertTrue(all(i["action"]=="skip" for i in report["items"] if Path(i["path"]).samefile(latest)))
    def test_case_alias_root_preserves_tasks_opened_by_canonical_paths(self):
        latest,old,fixture=self.setup_apps()
        alias=self.case_alias()
        snapshot={**self.empty,"opened":[(5,old/"Contents/Info.plist")],"commands":[(6,str(fixture.parent))]}
        report=c.plan_cleanup([alias],snapshot,now=self.now)
        self.assertTrue(all(i["action"]=="skip" for i in report["items"]))
    def test_versions_use_numeric_order_not_mtime(self):
        self.app("older/macos-ready/TaroBot.app","1.0.9")
        latest=self.app("newer/macos-ready/TaroBot.app","1.0.100")
        self.assertEqual(self.plan()["keep"],str(latest))
    def test_recent_task_and_recent_descendant_are_skipped(self):
        latest,old,fixture=self.setup_apps()
        os.utime(old.parents[1],None)
        os.utime(fixture/"Contents/Info.plist",None)
        report=self.plan()
        self.assertTrue(all(i["action"]=="skip" for i in report["items"]))
    def test_recent_intermediate_directory_is_skipped(self):
        self.setup_apps()
        nested=self.app("audit/extracted/bundle/mac/TaroBot.app")
        self.age()
        os.utime(nested.parents[2],None)
        self.assertEqual(next(i for i in self.plan()["items"] if i["path"]==str(nested))["reason"],"directory-modified-within-six-hours")
    def test_builds_and_missing_published_backup_block_cleanup(self):
        self.setup_apps()
        self.assertTrue(self.plan({**self.empty,"builders":[{"pid":2,"name":"cargo"}]})["blocked"])
        self.assertTrue(self.plan(keep_version="1.0.120")["blocked"])
    def test_activity_detects_build_paths_with_spaces(self):
        responses=[
            SimpleNamespace(stdout="222 /Users/test/Application Support/bin/cargo\n333 /usr/bin/node\n"),
            SimpleNamespace(stdout="222 cargo build\n333 node /work/node_modules/@tauri-apps/cli/tauri.js build\n"),
            SimpleNamespace(stdout="p222\nn/work/project\n",stderr="",returncode=0),
        ]
        with patch.object(c.subprocess,"run",side_effect=responses): snapshot=c.activity()
        self.assertEqual({b["pid"] for b in snapshot["builders"]},{222,333})
    def test_cwd_open_files_and_command_references_preserve_task(self):
        _,old,fixture=self.setup_apps()
        report=self.plan({**self.empty,"opened":[(5,old.parents[1]/"source")],"commands":[(6,str(fixture.parent))]})
        self.assertTrue(all(i["action"]=="skip" for i in report["items"]))
    def test_unaccepted_activation_preserves_rollback(self):
        _,old,_=self.setup_apps()
        (old.parents[1]/"activation.json").write_text('{"status":"installed_runtime_and_model_verified_pending_gui"}')
        self.age()
        self.assertEqual(next(i for i in self.plan()["items"] if i["path"]==str(old))["reason"],"activation-not-fully-accepted")
    def test_owner_hold_preserves_held_electron_release(self):
        latest,_,_=self.setup_apps()
        held=self.root/"release-1.0.121-hold"
        package=self.app("release-1.0.121-hold/mac-a1/package.noindex/packages/TaroBot-darwin-arm64/TaroBot.app","1.0.121")
        stage=self.app("release-1.0.121-hold/mac-a1/artifacts.noindex/dmg-stage-x.noindex/TaroBot.app","1.0.121")
        acceptance=self.app("electron-acceptance/package.noindex/packages/TaroBot-darwin-arm64/TaroBot.app","1.0.121")
        with (acceptance/"Contents/Info.plist").open("wb") as f:
            plistlib.dump({"CFBundleIdentifier":"com.tarobot.electron.acceptance","CFBundleShortVersionString":"1.0.121"},f)
        (held/"OWNER-HOLD.json").write_text("{not json")
        self.age()
        reasons={i["path"]:i["reason"] for i in self.plan()["items"]}
        self.assertEqual(reasons[str(package)],"owner-hold")
        self.assertEqual(reasons[str(stage)],"owner-hold")
        self.assertIsNone(reasons[str(acceptance)])
        trash=self.root/"trash.noindex";trash.mkdir()
        report=c.perform_cleanup([self.root],True,get_activity=lambda:self.empty,now=self.now,
            trash=lambda envelope:envelope.rename(trash/envelope.name),verify_backup=lambda p:self.assertEqual(p,latest))
        self.assertTrue(package.is_dir() and stage.is_dir())
        self.assertIn(str(acceptance),report["trashed"])
    def test_nested_owner_hold_protects_custom_output_root(self):
        self.setup_apps()
        output=self.root/"custom-output.noindex"
        app=self.app("custom-output.noindex/package.noindex/packages/TaroBot-darwin-arm64/TaroBot.app","1.0.122")
        (output/"OWNER-HOLD.json").write_text("{}")
        self.age()
        items=c.plan_cleanup([self.root,output],self.empty,now=self.now)["items"]
        self.assertEqual([i["reason"] for i in items if i["path"]==str(app)],["owner-hold"])
        self.assertEqual([i["reason"] for i in c.plan_cleanup([output],self.empty,now=self.now)["items"] if i["path"]==str(app)],["verified-version-backup-missing"])
    def test_activity_detects_electron_packaging(self):
        responses=[
            SimpleNamespace(stdout="401 /opt/homebrew/bin/node\n402 /usr/bin/hdiutil\n403 /opt/homebrew/bin/node\n404 /opt/homebrew/bin/node\n"),
            SimpleNamespace(stdout="401 node /repo/client/scripts/electron-build.mjs --production\n402 hdiutil create -srcfolder x\n403 node /repo/client/scripts/publish-macos-update.mjs --version 1.0.1\n404 node electron-build.mjs --production\n"),
            SimpleNamespace(stdout="p401\nn/work/project\n",stderr="",returncode=0),
        ]
        with patch.object(c.subprocess,"run",side_effect=responses): snapshot=c.activity()
        self.assertEqual({b["pid"] for b in snapshot["builders"]},{401,402,404})
    def test_symlink_and_installed_roots_refused(self):
        self.setup_apps()
        alias=self.root/"alias.noindex"
        alias.symlink_to("/Applications")
        with self.assertRaises(ValueError):c.checked_root(alias)
        with self.assertRaises(ValueError):c.checked_root("/Applications/TaroBot.app")
        with self.assertRaises(ValueError):c.checked_root("/applications/unused.noindex/subdirectory")
        with self.assertRaisesRegex(ValueError,"Refusing an installed"):
            c.trash_bundle(Path("/applications/NeverCreatedAuditFixture.app"), [0, 0])
        self.assertNotIn(str(alias),[i["path"] for i in self.plan()["items"]])
    def test_actual_moves_use_noindex_envelope_and_preserve_latest(self):
        latest,old,fixture=self.setup_apps()
        trash=self.root/"trash.noindex";trash.mkdir()
        received=[]
        def fake_trash(envelope):
            self.assertTrue(envelope.name.endswith(".noindex"))
            self.assertEqual(len(list(envelope.glob("*.app"))),1)
            received.append(envelope)
            envelope.rename(trash/envelope.name)
        report=c.perform_cleanup([self.root],True,get_activity=lambda:self.empty,now=self.now,trash=fake_trash,verify_backup=lambda p:self.assertEqual(p,latest))
        self.assertEqual(len(report["trashed"]),2)
        self.assertTrue(latest.exists());self.assertFalse(old.exists());self.assertFalse(fixture.exists())
    def test_trash_failure_restores_original_bundle(self):
        _,old,_=self.setup_apps()
        identity=[old.stat().st_dev,old.stat().st_ino]
        with self.assertRaises(RuntimeError):
            c.trash_bundle(old,identity,lambda _:(_ for _ in ()).throw(RuntimeError("trash denied")))
        self.assertTrue((old/"Contents/Info.plist").exists())
    def test_exception_immediately_after_rename_restores_original_bundle(self):
        _,old,_=self.setup_apps()
        identity=[old.stat().st_dev,old.stat().st_ino]
        rename=Path.rename
        def interrupted(source,destination):
            result=rename(source,destination)
            if source == old: raise TimeoutError("injected signal after rename")
            return result
        with patch.object(Path,"rename",interrupted):
            with self.assertRaises(TimeoutError):
                c.trash_bundle(old,identity,lambda _:self.fail("must restore before trash"))
        self.assertTrue((old/"Contents/Info.plist").exists())
        self.assertEqual(list(old.parent.glob(".tarobot-retired-*")),[])
    def test_completed_move_is_checkpointed_before_later_failure(self):
        self.setup_apps()
        trash=self.root/"trash.noindex";trash.mkdir()
        checkpoints=[]
        calls=0
        def move(envelope):
            nonlocal calls
            calls+=1
            if calls==2: raise RuntimeError("later trash denied")
            envelope.rename(trash/envelope.name)
        with self.assertRaises(RuntimeError):
            c.perform_cleanup([self.root],True,get_activity=lambda:self.empty,now=self.now,trash=move,verify_backup=lambda _:None,checkpoint=lambda report:checkpoints.append(json.loads(json.dumps(report))))
        self.assertEqual(len(checkpoints[-1]["trashed"]),1)
        self.assertFalse(Path(checkpoints[-1]["trashed"][0]).exists())
    def test_new_build_between_plan_and_move_defers(self):
        self.setup_apps()
        calls=0
        def snapshots():
            nonlocal calls
            calls+=1
            return self.empty if calls==1 else {**self.empty,"builders":[{"pid":2,"name":"xcodebuild"}]}
        report=c.perform_cleanup([self.root],True,get_activity=snapshots,now=self.now,verify_backup=lambda _:None)
        self.assertEqual(report["trashed"],[])
        self.assertEqual(report["deferred"],"activity-or-backup-changed")
    def test_newer_backup_mid_run_keeps_verified_backup_and_untouched_newer(self):
        latest,old,fixture=self.setup_apps()
        trash=self.root/"trash.noindex";trash.mkdir()
        newer=self.root/"release-newer/macos-ready/TaroBot.app"
        def newer_after_verify(p):
            self.assertEqual(p,latest)
            self.app("release-newer/macos-ready/TaroBot.app","1.0.120");self.age()
        report=c.perform_cleanup([self.root],True,get_activity=lambda:self.empty,now=self.now,trash=lambda e:e.rename(trash/e.name),verify_backup=newer_after_verify)
        # Only items planned before verification move; neither backup is retired.
        self.assertTrue(latest.is_dir() and newer.is_dir())
        self.assertEqual(set(report["trashed"]),{str(old),str(fixture)})
    def test_moved_verified_backup_defers(self):
        latest,old,_=self.setup_apps()
        report=c.perform_cleanup([self.root],True,get_activity=lambda:self.empty,now=self.now,trash=lambda e:self.fail("must not trash"),verify_backup=lambda p:p.rename(p.with_name("Moved.app")))
        self.assertEqual(report["deferred"],"activity-or-backup-changed")
        self.assertTrue(old.is_dir())
    def test_replaced_verified_backup_defers(self):
        latest,old,_=self.setup_apps()
        def replace_after_verify(p):
            moved=p.with_name("Verified.app");p.rename(moved)
            self.app("release-current/macos-ready/TaroBot.app");self.age()
        report=c.perform_cleanup([self.root],True,get_activity=lambda:self.empty,now=self.now,trash=lambda e:self.fail("must not trash"),verify_backup=replace_after_verify)
        self.assertEqual(report["deferred"],"activity-or-backup-changed")
        self.assertTrue(old.is_dir())
    def test_custom_root_below_held_or_activating_task_alone(self):
        self.setup_apps()
        for name,receipt,reason in [("held-task","OWNER-HOLD.json","owner-hold"),("install-task","activation.json","activation-not-fully-accepted")]:
            output=self.root/name/"electron-output.noindex"
            app=self.app(f"{name}/electron-output.noindex/package.noindex/packages/TaroBot-darwin-arm64/TaroBot.app","1.0.122")
            (self.root/name/receipt).write_text('{"status":"held_for_confirmed_audit_fix"}')
            self.age()
            items=c.plan_cleanup([self.root/"release-current",output],self.empty,now=self.now)["items"]
            self.assertEqual([i["reason"] for i in items if i["path"]==str(app)],[reason])
    def test_old_trash_backup_is_wrapped_without_deletion(self):
        root=self.root/"Trash";root.mkdir()
        app=self.app("Trash/.TaroBot-before-1.0.1.app")
        self.age()
        report=c.normalize_legacy_trash(True,lambda:self.empty,root,self.now,trash=lambda envelope:envelope.rename(root/envelope.name))
        self.assertFalse(app.exists())
        self.assertTrue(Path(report[0]["destination"]).is_dir())
        self.assertTrue(Path(report[0]["destination"]).parent.name.endswith(".noindex"))
        self.assertEqual(c.normalize_legacy_trash(True,lambda:self.empty,root,self.now),[])
    def test_exact_trash_backup_does_not_enumerate_trash(self):
        root=self.root/"Trash";root.mkdir()
        app=self.app("Trash/.TaroBot-before-1.0.1.app")
        self.age()
        with patch.object(Path,"iterdir",side_effect=PermissionError("Trash enumeration denied")):
            rows=c.normalize_legacy_trash(True,lambda:self.empty,root,self.now,candidates=[app],trash=lambda envelope:envelope.rename(root/envelope.name))
        self.assertTrue(Path(rows[0]["destination"]).is_dir())
        with self.assertRaises(ValueError):
            c.normalize_legacy_trash(True,lambda:self.empty,root,self.now,candidates=[self.root/"outside.app"])
    def test_legacy_trash_failure_restores_original(self):
        root=self.root/"Trash";root.mkdir()
        app=self.app("Trash/.TaroBot-before-1.0.1.app")
        self.age()
        with self.assertRaises(RuntimeError):
            c.normalize_legacy_trash(True,lambda:self.empty,root,self.now,trash=lambda _:(_ for _ in ()).throw(RuntimeError("trash denied")))
        self.assertTrue((app/"Contents/Info.plist").exists())

    def test_main_persists_failure_receipt(self):
        receipt=self.root/"failed.json"
        with patch.object(c.sys,"argv",["cleanup","--root",str(self.root),"--receipt",str(receipt)]), patch.object(c,"perform_cleanup",side_effect=PermissionError("permission denied")):
            with self.assertRaises(PermissionError): c.main()
        report=json.loads(receipt.read_text())
        self.assertEqual(report["status"],"failed")
        self.assertIn("permission denied",report["error"])

    def test_unknown_app_and_non_app_data_are_untouched(self):
        self.setup_apps()
        other=self.app("audit/Other.app")
        with (other/"Contents/Info.plist").open("wb") as f:plistlib.dump({"CFBundleIdentifier":"org.other.app"},f)
        (self.root/"audit/data.sqlite").write_text("do not touch")
        self.assertNotIn(str(other),[i["path"] for i in self.plan()["items"]])

if __name__=="__main__":unittest.main()
