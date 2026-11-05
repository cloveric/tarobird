import importlib.util
import pathlib
import threading
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('qwen_server', pathlib.Path(__file__).resolve().parents[2] / 'integrations/qwen3-asr/server.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class WatchdogTest(unittest.TestCase):
    def test_selection(self):
        for env, enabled, reason in [({},False,'manual'),({'XPC_SERVICE_NAME':'0'},False,'manual'),
             ({'XPC_SERVICE_NAME':'com.example.asr'},True,'launchd'),({'INVOCATION_ID':'abc'},True,'systemd'),
             ({'ASR_RECYCLE_IDLE':'0','INVOCATION_ID':'abc'},False,'explicit'),({'ASR_RECYCLE_IDLE':'1'},True,'explicit')]:
            self.assertEqual(m.recycle_policy(env,parent_pid=1,parent_name="systemd",verifier=lambda *_:True),(enabled,reason))
        self.assertFalse(m.recycle_policy({'XPC_SERVICE_NAME':'TaroBot'},parent_pid=20)[0])
        self.assertFalse(m.recycle_policy({'INVOCATION_ID':'abc'},parent_pid=20,parent_name='bash')[0])
        self.assertFalse(m.recycle_policy({'XPC_SERVICE_NAME':'TaroBot'},parent_pid=1,verifier=lambda *_:False)[0])
        self.assertFalse(m.recycle_policy({'INVOCATION_ID':'abc'},parent_pid=1,parent_name='systemd',verifier=lambda *_:False)[0])
        with self.assertRaises(ValueError): m.recycle_policy({'ASR_RECYCLE_IDLE':'yes'})

    def test_supervisor_requires_exact_pid_and_success_restart(self):
        with patch.object(m.subprocess,'run') as run:
            run.return_value=types.SimpleNamespace(stdout=f"pid = {m.os.getpid()}\nproperties = runatload",returncode=0)
            self.assertFalse(m.supervisor_restart_confirmed('launchd',{'XPC_SERVICE_NAME':'fixture'}))
            run.return_value.stdout += ' | keepalive'
            self.assertTrue(m.supervisor_restart_confirmed('launchd',{'XPC_SERVICE_NAME':'fixture'}))
            run.return_value.stdout=f"pid = {m.os.getpid()}\nproperties = runatload\nkeepalive = 0"
            self.assertFalse(m.supervisor_restart_confirmed('launchd',{'XPC_SERVICE_NAME':'fixture'}))
            run.return_value.stdout=f"pid = {m.os.getpid()}\nproperties = keepalive\nsemaphores = {{"
            self.assertFalse(m.supervisor_restart_confirmed('launchd',{'XPC_SERVICE_NAME':'fixture'}))
            run.return_value.stdout='pid = 999999\nproperties = keepalive'
            self.assertFalse(m.supervisor_restart_confirmed('launchd',{'XPC_SERVICE_NAME':'fixture'}))
            with patch.object(m.Path,'read_text',return_value='0::/user.slice/app.slice/fixture.service'):
                for restart,expected in [('on-failure',False),('always',True),('on-success',True)]:
                    run.return_value.stdout=f'MainPID={m.os.getpid()}\nRestart={restart}\nInvocationID=abc'
                    self.assertEqual(m.supervisor_restart_confirmed('systemd',{'INVOCATION_ID':'abc'}),expected)

    def test_idle_checks_and_once_only_exit(self):
        state={'inflight':1,'exiting':False}; exits=[]; logs=[]
        dog=m.MemoryWatchdog(state,threading.Lock(),enabled=True,reason='explicit',reader=lambda:6*1024**3,
                             exit_callback=lambda:exits.append(True),logger=logs.append)
        dog.check('periodic'); self.assertFalse(exits)
        state['inflight']=0; dog.check('after request'); dog.check('periodic')
        self.assertEqual(exits,[True]); self.assertTrue(state['exiting'])
        self.assertIn('6.0GB > 5.5GB while idle (after request)',logs[-1])

    def test_periodic_and_close(self):
        exited=threading.Event(); state={'inflight':0,'exiting':False}
        dog=m.MemoryWatchdog(state,threading.Lock(),enabled=True,reason='explicit',interval=.01,
            reader=lambda:6*1024**3,exit_callback=exited.set,logger=lambda _:None)
        dog.start(); self.assertTrue(exited.wait(1)); dog.close()
        self.assertFalse(dog.thread.is_alive())

    def test_unavailable_and_disabled_never_exit(self):
        for enabled in (False,True):
            logs=[]; exits=[]
            dog=m.MemoryWatchdog({'inflight':0,'exiting':False},threading.Lock(),enabled=enabled,reason='manual',
                  reader=lambda:None,exit_callback=lambda:exits.append(True),logger=logs.append)
            self.assertFalse(dog.snapshot()['available']); dog.check('periodic'); self.assertFalse(exits)
            self.assertTrue(any('unavailable' in line for line in logs))

    def test_non_macos_rss_plus_reserved_cuda_not_allocated(self):
        ps=types.SimpleNamespace(Process=lambda:types.SimpleNamespace(memory_info=lambda:types.SimpleNamespace(rss=100)))
        torch=types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda:True,device_count=lambda:2,memory_reserved=lambda i:200))
        with patch.dict(m.sys.modules,{'psutil':ps,'torch':torch}),patch.object(m.sys,'platform','linux'):
            self.assertEqual(m.process_memory_bytes(),500)
        with patch.dict(m.sys.modules,{'psutil':None}),patch.object(m.sys,'platform','win32'):
            self.assertIsNone(m.process_memory_bytes())
        with patch.object(m.sys,'platform','darwin'),patch.object(m,'phys_footprint_bytes',return_value=123):
            self.assertEqual(m.process_memory_bytes(),123)
        with patch.object(m.sys,'platform','darwin'),patch.object(m,'phys_footprint_bytes',return_value=0):
            self.assertIsNone(m.process_memory_bytes())

if __name__=='__main__': unittest.main()
