"""Decoder regressions: stdlib error tests plus real codecs when available.

Run with the ASR virtualenv to require the declared numpy dependency and ffmpeg:
TAROBOT_REQUIRE_ASR_CODECS=1 python -B tests/python/qwen_decode_test.py
No model download or GPU is needed.
"""
import array
import importlib.util
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

spec = importlib.util.spec_from_file_location("qwen_decoder", Path(__file__).resolve().parents[2] / "integrations/qwen3-asr/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
try:
    import numpy as np
except ImportError:
    np = None
CODECS = np is not None and shutil.which("ffmpeg") and shutil.which("ffprobe")
if os.environ.get("TAROBOT_REQUIRE_ASR_CODECS") == "1" and not CODECS:
    raise RuntimeError("Real decoder tests require numpy, ffmpeg and ffprobe")


class DecoderErrors(unittest.TestCase):
    def test_decode_failures_are_sanitized_value_errors(self):
        for result in [SimpleNamespace(returncode=1, stdout=b"", stderr=b"/private/input secret"),
                       SimpleNamespace(returncode=0, stdout=b"", stderr=b""),
                       SimpleNamespace(returncode=0, stdout=b"x", stderr=b"")]:
            with self.subTest(result=result), patch.object(server.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(ValueError, "^audio could not be decoded$"):
                    server.decode_to_wav("/private/input")

    def test_timeout_and_spawn_errors_do_not_expose_subprocess_details(self):
        for error, message in [(subprocess.TimeoutExpired("/private/input", 120, stderr=b"secret"), "audio decode timed out"),
                               (FileNotFoundError("/private/ffmpeg"), "audio decoder unavailable"),
                               (PermissionError("/private/input"), "audio decoder unavailable"),
                               (subprocess.SubprocessError("secret"), "audio decoder unavailable")]:
            with self.subTest(error=error), patch.object(server.subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(ValueError, "^" + message + "$"):
                    server.decode_to_wav("/private/input")

    def test_decoded_duration_is_bounded_even_if_probe_metadata_was_wrong(self):
        with patch.object(server, "MAX_AUDIO_SECONDS", .1), patch.object(server.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"\0" * 3202)) as run:
            with self.assertRaises(server.AudioTooLongError):
                server.decode_to_wav("/private/input")
            args = run.call_args.args[0]
            self.assertEqual(args[args.index("-fs") + 1], "3202")
            self.assertEqual(args[args.index("-t") + 1], "1.1")

    def test_invalid_config_cannot_remove_decoder_output_limit(self):
        for limit in [math.nan, math.inf, 0, -1]:
            with self.subTest(limit=limit), patch.object(server, "MAX_AUDIO_SECONDS", limit), patch.object(server.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    server.decode_to_wav("/private/input")
                run.assert_not_called()


@unittest.skipIf(np is None, "numpy is installed with the ASR service, not the Node-only test environment")
class PcmContract(unittest.TestCase):
    def test_little_endian_pcm_is_mono_float32_in_range_and_argv_is_literal(self):
        audio = "/private/录音 ; $(do-not-run).m4a"
        result = SimpleNamespace(returncode=0, stdout=b"\0\x80\0\0\xff\x7f", stderr=b"")
        with patch.object(server.subprocess, "run", return_value=result) as run:
            wav = server.decode_to_wav(audio)
        self.assertEqual(wav.dtype, np.dtype("float32"))
        self.assertEqual(wav.shape, (3,))
        np.testing.assert_array_equal(wav, np.array([-1, 0, 32767/32768], dtype=np.float32))
        args = run.call_args.args[0]
        self.assertIsInstance(args, list)
        self.assertEqual(args[args.index("-i") + 1], audio)
        for option, value in [("-f", "s16le"), ("-ac", "1"), ("-ar", "16000"), ("-protocol_whitelist", "file,pipe")]:
            self.assertEqual(args[args.index(option) + 1], value)
        self.assertEqual(args[-1], "-")
        self.assertIn("-nostdin", args)
        self.assertEqual(run.call_args.kwargs, {"capture_output": True, "timeout": 120})

    def test_chunking_short_piece_skip_and_cache_cleanup_are_preserved(self):
        short = np.zeros(100, dtype=np.float32)
        first = np.zeros(4800, dtype=np.float32)
        second = np.zeros(9600, dtype=np.float32)
        split = Mock(return_value=[(short, 0), (first, 1), (second, 2)])
        utils = SimpleNamespace(split_audio_into_chunks=split, SAMPLE_RATE=16000)
        model = Mock()
        model.transcribe.side_effect = [[SimpleNamespace(text="第一段")], [SimpleNamespace(text="第二段")]]
        wav = np.zeros(16000, dtype=np.float32)
        with patch.dict(sys.modules, {"qwen_asr.inference.utils": utils}), patch.object(server, "decode_to_wav", return_value=wav), patch.object(server, "release_inference_cache") as cleanup:
            text, count = server.transcribe_chunked(model, "/private/input")
        self.assertIn("第一段", text)
        self.assertIn("第二段", text)
        self.assertEqual(count, 3)
        self.assertEqual(model.transcribe.call_count, 2)
        self.assertEqual(cleanup.call_count, 2)
        split.assert_called_once_with(wav=wav, sr=16000, max_chunk_sec=server.CHUNK_SECONDS)


@unittest.skipUnless(CODECS, "real codec checks require the ASR numpy dependency and ffmpeg/ffprobe")
class RealCodecs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-decode-")
        self.directory = Path(self.temp.name)
        self.source = self.directory / "stereo 48k.wav"
        samples = array.array("h", (int(9000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000) for _ in range(2)))
        if sys.byteorder != "little": samples.byteswap()
        with wave.open(str(self.source), "wb") as audio:
            audio.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
            audio.writeframes(samples.tobytes())

    def tearDown(self):
        self.temp.cleanup()

    def test_real_mobile_containers_decode_without_a_model(self):
        for name, codec, container in [("phone-opus.m4a", "libopus", "mp4"), ("phone-aac.m4a", "aac", "mp4"),
                                       ("voice.ogg", "libopus", "ogg"), ("voice.webm", "libopus", "webm"),
                                       ("voice.mp3", "libmp3lame", "mp3")]:
            with self.subTest(name=name):
                target = self.directory / name
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(self.source), "-c:a", codec, "-f", container, str(target)], check=True, capture_output=True, timeout=10)
                server.validate_audio(str(target))
                before = set(self.directory.iterdir())
                wav = server.decode_to_wav(str(target))
                self.assertEqual(set(self.directory.iterdir()), before, "decoder must not write temporary audio")
                self.assertEqual(wav.dtype, np.dtype("float32"))
                self.assertEqual(wav.ndim, 1)
                self.assertTrue(15500 <= len(wav) <= 17000)
                self.assertTrue(np.isfinite(wav).all())
                self.assertLessEqual(float(np.max(np.abs(wav))), 1)
                self.assertGreater(float(np.max(np.abs(wav))), .05)
        wav = server.decode_to_wav(str(self.source))
        self.assertEqual(len(wav), 16000)

    def test_ffmpeg_cap_rejects_long_decoded_audio_instead_of_returning_a_prefix(self):
        with patch.object(server, "MAX_AUDIO_SECONDS", .1):
            with self.assertRaises(server.AudioTooLongError):
                server.decode_to_wav(str(self.source))

    def test_non_audio_and_no_audio_stream_are_rejected(self):
        text = self.directory / "private-note.txt"
        text.write_text("PRIVATE_CONTENT_SENTINEL")
        with self.assertRaisesRegex(ValueError, "^audio could not be decoded$"):
            server.decode_to_wav(str(text))
        video = self.directory / "silent-video.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                        "color=black:s=16x16:d=1", "-an", "-c:v", "mpeg4", str(video)],
                       check=True, capture_output=True, timeout=10)
        server.validate_audio(str(video))
        with self.assertRaisesRegex(ValueError, "^audio could not be decoded$"):
            server.decode_to_wav(str(video))


if __name__ == "__main__":
    unittest.main()
