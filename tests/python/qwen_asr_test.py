import importlib.util
import json
import os
try: import fcntl
except ImportError: fcntl = None
import concurrent.futures
import pathlib
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("qwen_server", pathlib.Path(__file__).resolve().parents[2] / "integrations/qwen3-asr/server.py")
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class QwenTest(unittest.TestCase):
    def setUp(self):
        self.server = server_module.create_server(None, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def post(self, body=b'{"path":"/fixture/audio.wav"}', headers=None, endpoint="/transcribe"):
        request = urllib.request.Request(self.url + endpoint, data=body, headers=headers or {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=3) as result:
                return result.status, result.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def test_protocol(self):
        with patch.object(server_module, "validate_audio"), patch.object(server_module, "transcribe_chunked", return_value=("转写正常", 1)):
            self.assertEqual(self.post(), (200, "转写正常"))
            self.assertEqual(self.post(headers={"Content-Type": "application/json", "Origin": "https://example.com"})[0], 403)
            self.assertEqual(self.post(headers={"Content-Type": "text/plain"})[0], 415)
            self.assertEqual(self.post(body=b"x" * 17000)[0], 413)
            self.assertEqual(self.post(body=b"invalid")[0], 400)
            self.assertEqual(self.post(endpoint="/shutdown")[0], 404)

    def test_health_does_not_wait_for_inference(self):
        entered, release = threading.Event(), threading.Event()
        def infer(*_args):
            entered.set()
            release.wait(3)
            return "ready", 1
        with patch.object(server_module, "validate_audio"), patch.object(server_module, "transcribe_chunked", side_effect=infer):
            result = []
            worker = threading.Thread(target=lambda: result.append(self.post()))
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                with urllib.request.urlopen(self.url + "/health", timeout=0.5) as response:
                    self.assertEqual(response.read(), b"ok")
            finally:
                release.set()
                worker.join(3)
            self.assertEqual(result, [(200, "ready")])

    def test_queue_limit_and_after_request_watchdog(self):
        entered,release=threading.Event(),threading.Event()
        def infer(*_args):
            entered.set();release.wait(5);return 'ready',1
        with patch.object(server_module,'validate_audio'),patch.object(server_module,'transcribe_chunked',side_effect=infer),patch.object(self.server.watchdog,'check') as check:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                futures=[pool.submit(self.post) for _ in range(8)]
                try:
                    self.assertTrue(entered.wait(2))
                    import time
                    deadline=time.monotonic()+2
                    while time.monotonic()<deadline:
                        with urllib.request.urlopen(self.url+'/status') as response:status=json.load(response)
                        if status['activeRequests']==8:break
                        time.sleep(.02)
                    self.assertEqual(status['activeRequests'],8)
                    self.assertEqual(self.post()[0],503)
                    self.assertNotIn('path',json.dumps(status))
                finally:release.set()
                self.assertTrue(all(f.result()[0]==200 for f in futures))
            self.assertEqual(check.call_count,8)
            check.assert_called_with('after request')

    @unittest.skipIf(fcntl is None, 'service registration is POSIX only')
    def test_repair_lock_fences_new_requests_and_respects_busy_work(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'ASR_CONTROL_LOCK':d+'/control.lock'}):
            guard=server_module.request_guard()
            other=os.open(d+'/control.lock',os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
                os.close(guard);guard=None
                fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertEqual(self.post()[0],503)
            finally:
                if guard is not None:os.close(guard)
                os.close(other)

    @unittest.skipIf(fcntl is None, 'service registration is POSIX only')
    def test_cold_model_loading_holds_repair_guard(self):
        entered,release=threading.Event(),threading.Event()
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'ASR_CONTROL_LOCK':d+'/control.lock'}):
            def load():entered.set();release.wait(3);return None
            with patch.object(server_module,'load_model',side_effect=load),patch.object(server_module,'create_server'):
                worker=threading.Thread(target=server_module.load_server);worker.start()
                try:
                    self.assertTrue(entered.wait(2));fd=os.open(d+'/control.lock',os.O_RDWR)
                    try:
                        with self.assertRaises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    finally:os.close(fd)
                finally:release.set();worker.join(3)

    def test_input_errors_do_not_mark_healthy_inference_as_broken(self):
        with patch.object(server_module,'validate_audio',side_effect=ValueError('private')):
            self.assertEqual(self.post()[0],400)
        with urllib.request.urlopen(self.url+'/status') as response:self.assertEqual(json.load(response)['consecutiveFailures'],0)
        with patch.object(server_module,'validate_audio'),patch.object(server_module,'transcribe_chunked',side_effect=RuntimeError('private')):
            self.assertEqual(self.post(),(500,'transcription failed'))
        with urllib.request.urlopen(self.url+'/status') as response:self.assertEqual(json.load(response)['consecutiveFailures'],1)
        with patch.object(server_module,'validate_audio'),patch.object(server_module,'transcribe_chunked',return_value=('',0)):
            self.assertEqual(self.post()[0],422)
        with urllib.request.urlopen(self.url+'/status') as response:self.assertEqual(json.load(response)['consecutiveFailures'],0)

    def test_duration_and_invalid_paths(self):
        with tempfile.NamedTemporaryFile() as audio:
            for value in ["nan", "inf", "-1", "0", "301"]:
                with patch.object(server_module.subprocess, "run", return_value=Mock(stdout=value)):
                    with self.assertRaises(ValueError):
                        server_module.validate_audio(audio.name)
            with patch.object(server_module.subprocess, "run", return_value=Mock(stdout="3")):
                server_module.validate_audio(audio.name)
        with self.assertRaises(ValueError):
            server_module.validate_audio("relative.wav")

    def test_decode_errors_return_400_without_paths_or_stderr(self):
        with patch.object(server_module, "validate_audio"), patch.object(server_module, "transcribe_chunked", side_effect=ValueError("/private/audio.m4a secret stderr")):
            self.assertEqual(self.post(), (400, "invalid or unsupported audio; check ffprobe and duration"))


if __name__ == "__main__":
    unittest.main()
