import importlib.util
import json
import pathlib
import plistlib
import tempfile
import unittest
# macOS /var is a system alias; fixtures use its canonical directory.
tempfile.tempdir = str(pathlib.Path(tempfile.gettempdir()).resolve())
from unittest.mock import patch, Mock

spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).resolve().parents[2]/'scripts/qwen-asr-install.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def fixture_model(root):
    root.mkdir()
    (root/'config.json').write_text('{"model_type":"qwen3_asr"}')
    for name in ['tokenizer_config.json','vocab.json','merges.txt','preprocessor_config.json']:(root/name).write_text('{}')
    header=json.dumps({'weight':{'data_offsets':[0,4]}}).encode()
    (root/'model.safetensors').write_bytes(len(header).to_bytes(8,'little')+header+b'1234')

class InstallerTest(unittest.TestCase):
    def test_model_and_truncation(self):
        with tempfile.TemporaryDirectory() as d:
            model=pathlib.Path(d)/'model';fixture_model(model)
            self.assertTrue(m.model_present(model))
            p=model/'model.safetensors';p.write_bytes(p.read_bytes()[:-1]);self.assertFalse(m.model_present(model))

    def test_service_templates_and_paths(self):
        target=pathlib.Path('/safe/path with "quotes" $special%name')
        dest,data,commands,_,_=m.service_plan(target,target/'model','fixture','darwin',pathlib.Path('/home/fixture'))
        value=plistlib.loads(data);self.assertTrue(value['KeepAlive'])
        self.assertEqual(value['EnvironmentVariables']['ASR_RECYCLE_IDLE'],'1')
        self.assertEqual(value['ProgramArguments'][0],str(target/'.venv/bin/python'))
        self.assertEqual(commands[1][0:2],['launchctl','bootstrap'])
        _,data,commands,_,_=m.service_plan(target,target/'model','fixture','linux',pathlib.Path('/home/fixture'))
        self.assertIn('Restart=always',data);self.assertIn('ASR_RECYCLE_IDLE=1',data)
        self.assertIn('$$special%%name',data)
        self.assertIn('WorkingDirectory='+str(target).replace('%','%%')+'\n',data)
        self.assertNotIn('WorkingDirectory="',data)
        with self.assertRaisesRegex(m.InstallError,'invalid_path'):m.service_plan(pathlib.Path('/bad\npath'),target,'id','linux')
        self.assertEqual(commands[-1],['systemctl','--user','enable','--now',m.UNIT])
        with self.assertRaises(m.InstallError):m.service_plan(target,target,'id','win32')

    def test_disk_and_symlink(self):
        with patch.object(m,'free_bytes',return_value=1):
            with self.assertRaisesRegex(m.InstallError,'insufficient_disk_space'):m.check_space(pathlib.Path('/path'),2)
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d);(p/'link').symlink_to(p/'actual')
            with self.assertRaisesRegex(m.InstallError,'unsafe_symlink'):m.safe(p/'link'/'child')

    def test_environment_preserves_other_keys_and_updates_duplicates(self):
        with tempfile.TemporaryDirectory() as d:
            home=pathlib.Path(d);(home/'.tarobot').mkdir()
            p=home/'.tarobot/integrations.env';p.write_text('# keep\nTAVILY_API_KEY=private-placeholder\nASR_MODEL_PATH=old\nASR_MODEL_PATH=duplicate\n')
            m.update_env(home,{'ASR_MODEL_PATH':'/a b/"$`test','ASR_SERVICE_COMMAND':"'/a b/python' '/a b/control.py' --restart"})
            data=p.read_text();self.assertIn('# keep\nTAVILY_API_KEY=private-placeholder\n',data)
            self.assertEqual(data.count('ASR_MODEL_PATH='),1);self.assertEqual(p.stat().st_mode&0o777,0o600)

    def test_cross_process_lock_refuses_second_holder(self):
        with tempfile.TemporaryDirectory() as d:
            with m.install_lock(pathlib.Path(d)):
                with self.assertRaisesRegex(m.InstallError,'installation_busy'):
                    with m.install_lock(pathlib.Path(d)):pass

    def test_reuse_model_does_not_download_or_change_old_files(self):
        with tempfile.TemporaryDirectory() as d:
            home=pathlib.Path(d);model=home/'model';fixture_model(model)
            target=home/'standard'
            args=Mock(dir=str(target),as_service=False,dry_run=False,with_model=True,no_deps=True)
            with patch.object(m.Path,'home',return_value=home),patch.dict(m.os.environ,{'ASR_MODEL_PATH':str(model)}),patch.object(m,'run') as run:
                m.install(args);run.assert_not_called()
            self.assertEqual(json.loads((target/'installation.json').read_text())['modelPath'],str(model))
            self.assertTrue(m.model_present(model));self.assertFalse((home/'.tarobot/integrations.env').exists())

    def test_repair_requires_idle_identity_and_shared_cooldown(self):
        with tempfile.TemporaryDirectory() as d:
            target=pathlib.Path(d)
            (target/'installation.json').write_text(json.dumps({'format':1,'installationId':'fixture','modelPath':d+'/model','port':8412,'service':True}))
            args=['installer','--dir',d,'--restart']
            with patch.object(m.sys,'argv',args),patch.object(m,'run') as run,patch.object(m,'probe',return_value={'installationId':'other','activeRequests':0}):
                with self.assertRaisesRegex(m.InstallError,'service_identity_mismatch'):m.main()
                run.assert_not_called()
            with patch.object(m.sys,'argv',args),patch.object(m,'run') as run,patch.object(m,'probe',return_value={'installationId':'fixture','activeRequests':1}):
                with self.assertRaisesRegex(m.InstallError,'service_busy'):m.main()
                run.assert_not_called()
            with patch.object(m.sys,'argv',args),patch.object(m,'run') as run,patch.object(m,'probe',return_value={'installationId':'fixture','activeRequests':0}):
                (target/'last-repair').write_text('damaged')
                m.main();m.main();self.assertEqual(run.call_count,1)
            (target/'last-repair').unlink()
            with patch.object(m.sys,'argv',args),patch.object(m,'run') as run,patch.object(m,'probe',return_value={'installationId':'fixture','activeRequests':0,'consecutiveFailures':0}):
                m.main();run.assert_not_called()

    def test_service_manager_preflight_precedes_downloads(self):
        with tempfile.TemporaryDirectory() as d:
            home=pathlib.Path(d);model=home/'model';fixture_model(model)
            args=Mock(dir=str(home/'target'),as_service=True,dry_run=False,with_model=True,no_deps=True)
            with patch.object(m.Path,'home',return_value=home),patch.dict(m.os.environ,{'ASR_MODEL_PATH':str(model)}),patch.object(m.subprocess,'run',return_value=Mock(returncode=1)),patch.object(m.socket,'socket'),patch.object(m,'run') as run:
                with self.assertRaisesRegex(m.InstallError,'service_manager_unavailable'):m.install(args)
                run.assert_not_called();self.assertFalse((home/'target').exists())

    def test_failed_registration_removes_confirmed_unloaded_plist(self):
        with tempfile.TemporaryDirectory() as d:
            home=pathlib.Path(d);model=home/'model';fixture_model(model)
            target=home/'target';args=Mock(dir=str(target),as_service=True,dry_run=False,with_model=True,no_deps=True)
            probes=[Mock(returncode=0),Mock(returncode=1),Mock(returncode=113)]
            with patch.object(m.Path,'home',return_value=home),patch.object(m.sys,'platform','darwin'),patch.dict(m.os.environ,{'ASR_MODEL_PATH':str(model)}),patch.object(m.socket,'socket'),patch.object(m.shutil,'which',return_value='/usr/bin/fixture'),patch.object(m.subprocess,'run',side_effect=probes),patch.object(m,'run',side_effect=m.InstallError('registration_failed')):
                with self.assertRaisesRegex(m.InstallError,'registration_failed'):m.install(args)
            self.assertFalse((home/'Library/LaunchAgents'/f'{m.LABEL}.plist').exists())
            self.assertFalse((home/'.tarobot/integrations.env').exists())
            self.assertFalse(json.loads((target/'installation.json').read_text())['service'])

    def test_explicit_invalid_model_cannot_download_into_old_directory(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(m.os.environ,{'ASR_MODEL_PATH':d}):
            args=Mock(dir=d+'/target',as_service=False,dry_run=False,with_model=True,no_deps=True)
            with patch.object(m,'run') as run:
                with self.assertRaisesRegex(m.InstallError,'configured_model_incomplete'):m.install(args)
                run.assert_not_called()

if __name__=='__main__':unittest.main()
