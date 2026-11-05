#!/usr/bin/env python3
"""
Qwen3-ASR HTTP server — keeps model in memory for fast transcription.

Start: python server.py (loopback only)
Usage: POST application/json {"path": "/absolute/audio.ogg"} to /transcribe
"""

import sys
import os
import warnings
import json
import math
from pathlib import Path
import gc
import datetime
import subprocess
import threading
import re

def request_guard(*, blocking=False):
    """Shared lock held throughout admission/inference, exclusive during repair.
    No network shutdown endpoint; managed services opt in through private env.
    """
    lock_path = os.environ.get("ASR_CONTROL_LOCK")
    if not lock_path:
        return None
    import fcntl
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | (0 if blocking else fcntl.LOCK_NB))
        return fd
    except BaseException:
        os.close(fd)
        raise

warnings.filterwarnings("ignore")
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TRANSFORMERS_VERBOSITY"] = "error"

def configured_model_path():
    explicit = os.environ.get("ASR_MODEL_PATH")
    if explicit:
        return os.path.expanduser(explicit)
    root = Path(__file__).resolve().parent
    config = root / "installation.json"
    if config.is_file():
        try:
            value = json.loads(config.read_text())
            if value.get("format") == 1 and os.path.isabs(value["modelPath"]):
                return value["modelPath"]
        except (ValueError, KeyError, TypeError):
            raise RuntimeError("Invalid local ASR installation configuration") from None
    return str(root / "models" / "Qwen3-ASR-0.6B")

MODEL_PATH = configured_model_path()
PORT = int(os.environ.get("ASR_PORT", "8412"))
MAX_AUDIO_SECONDS = float(os.environ.get("ASR_MAX_AUDIO_SECONDS", "300"))
# Feed the model short pieces: long single inputs blow up MPS memory and hit the
# token cap (a 270s input came back truncated and looping). Cut at low-energy points.
CHUNK_SECONDS = float(os.environ.get("ASR_CHUNK_SECONDS", "45"))
MAX_NEW_TOKENS = int(os.environ.get("ASR_MAX_NEW_TOKENS", "512"))
# float16 halves memory vs float32 on Apple GPU; override with ASR_DTYPE=float32 if needed.
DTYPE_NAME = os.environ.get("ASR_DTYPE", "float16")
# Watchdog: when idle and the process footprint exceeds this, exit and let launchd
# (KeepAlive) start a fresh process.
WATCHDOG_GB = float(os.environ.get("ASR_WATCHDOG_GB", "5.5"))

class AudioTooLongError(ValueError):
    pass

def log(message):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", file=sys.stderr)

def load_model():
    if not Path(MODEL_PATH).is_dir():
        raise RuntimeError("Model missing; follow integrations/qwen3-asr/README.md")
    import torch
    import logging
    logging.getLogger("transformers").setLevel(logging.ERROR)
    from qwen_asr import Qwen3ASRModel

    if torch.backends.mps.is_available():
        device, dtype = "mps", getattr(torch, DTYPE_NAME)
    elif torch.cuda.is_available():
        device, dtype = "cuda:0", torch.bfloat16
    else:
        device, dtype = "cpu", torch.float32

    model = Qwen3ASRModel.from_pretrained(
        MODEL_PATH, dtype=dtype, device_map=device,
        max_inference_batch_size=1, max_new_tokens=MAX_NEW_TOKENS,
    )
    log(f"Model loaded on {device} ({dtype}), chunk={CHUNK_SECONDS:.0f}s, max_new_tokens={MAX_NEW_TOKENS}")
    return model

def release_inference_cache():
    gc.collect()
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as e:
        log("Cache cleanup skipped")


def phys_footprint_bytes(pid=None):
    """Physical footprint (what Activity Monitor calls Memory), via proc_pid_rusage."""
    import ctypes
    class RUsageInfoV0(ctypes.Structure):
        _fields_ = [("ri_uuid", ctypes.c_uint8 * 16), ("ri_user_time", ctypes.c_uint64),
                    ("ri_system_time", ctypes.c_uint64), ("ri_pkg_idle_wkups", ctypes.c_uint64),
                    ("ri_interrupt_wkups", ctypes.c_uint64), ("ri_pageins", ctypes.c_uint64),
                    ("ri_wired_size", ctypes.c_uint64), ("ri_resident_size", ctypes.c_uint64),
                    ("ri_phys_footprint", ctypes.c_uint64), ("ri_proc_start_abstime", ctypes.c_uint64),
                    ("ri_proc_exit_abstime", ctypes.c_uint64)]
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        info = RUsageInfoV0()
        if libproc.proc_pid_rusage(ctypes.c_int(pid or os.getpid()), 0, ctypes.byref(info)) == 0:
            return int(info.ri_phys_footprint)
    except Exception:
        pass
    return 0

def supervisor_restart_confirmed(kind, env):
    """Environment inheritance alone cannot prove this process will be restarted."""
    try:
        if kind == "launchd":
            label = env.get("XPC_SERVICE_NAME", "")
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", label): return False
            result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"],
                                    capture_output=True, text=True, timeout=2, check=True)
            pid = re.search(r"(?m)^\s*pid = (\d+)\s*$", result.stdout)
            properties = re.search(r"(?m)^\s*properties = ([^\n]+)$", result.stdout)
            always = properties and "keepalive" in [part.strip().lower() for part in properties.group(1).split("|")]
            conditional = re.search(r"(?m)^\s*semaphores = \{", result.stdout)
            return bool(pid and int(pid.group(1)) == os.getpid() and always and not conditional)
        groups = Path("/proc/self/cgroup").read_text()
        units = re.findall(r"(?:^|/)([^/\n]+\.service)(?:/|$)", groups, re.MULTILINE)
        if not units: return False
        for prefix in (["systemctl", "--user"], ["systemctl"]):
            result = subprocess.run([*prefix, "show", units[-1], "-p", "MainPID", "-p", "Restart", "-p", "InvocationID"],
                                    capture_output=True, text=True, timeout=2)
            values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
            if (result.returncode == 0 and values.get("MainPID") == str(os.getpid())
                and values.get("Restart") in ("always", "on-success")
                and values.get("InvocationID") == env.get("INVOCATION_ID")): return True
    except Exception:
        pass
    return False


def recycle_policy(env=None, *, parent_pid=None, parent_name=None, verifier=supervisor_restart_confirmed):
    env = os.environ if env is None else env
    if "ASR_RECYCLE_IDLE" in env:
        if env["ASR_RECYCLE_IDLE"] not in ("0", "1"):
            raise ValueError("ASR_RECYCLE_IDLE must be 0 or 1")
        return env["ASR_RECYCLE_IDLE"] == "1", "explicit"
    parent_pid = os.getppid() if parent_pid is None else parent_pid
    # GUI applications pass XPC_SERVICE_NAME to children too. Only a direct
    # launchd child can rely on that name for automatic restart.
    if env.get("XPC_SERVICE_NAME", "").strip() not in ("", "0") and parent_pid == 1 and verifier("launchd", env):
        return True, "launchd"
    if env.get("INVOCATION_ID", "").strip():
        try:
            if parent_name is None:
                import psutil
                parent_name = psutil.Process(parent_pid).name()
            if parent_name == "systemd" and verifier("systemd", env):
                return True, "systemd"
        except Exception:
            pass
    if env.get("INVOCATION_ID") or env.get("XPC_SERVICE_NAME", "") not in ("", "0"):
        return False, "unverified supervisor (inherited environment)"
    return False, "manual"


def process_memory_bytes():
    """macOS includes MPS in footprint; elsewhere RSS + this process's CUDA pool.
    Return None on failure, never claim that an unreadable process consumes zero.
    """
    try:
        if sys.platform == "darwin":
            value = phys_footprint_bytes()
        else:
            import psutil
            value = psutil.Process().memory_info().rss
            # load_model has already imported torch. Do not initialize it just
            # for monitoring a model-less test or diagnostic process.
            torch = sys.modules.get("torch")
            if torch is not None and torch.cuda.is_available():
                value += sum(torch.cuda.memory_reserved(i) for i in range(torch.cuda.device_count()))
        return int(value) if value > 0 else None
    except Exception:
        return None


def deferred_exit():
    timer = threading.Timer(0.5, lambda: os._exit(0))
    timer.daemon = True
    timer.start()


class MemoryWatchdog:
    def __init__(self, state, lock, *, enabled, reason, interval=300, limit_gb=WATCHDOG_GB,
                 reader=process_memory_bytes, exit_callback=deferred_exit, logger=log):
        if not math.isfinite(interval) or interval <= 0 or not math.isfinite(limit_gb) or limit_gb <= 0:
            raise ValueError("Watchdog interval and limit must be finite positive numbers")
        self.state, self.lock = state, lock
        self.enabled, self.reason, self.interval, self.limit_gb = enabled, reason, interval, limit_gb
        self.reader, self.exit_callback, self.logger = reader, exit_callback, logger
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.periodic, name="asr-memory-watchdog", daemon=True)
        self.available = None
        self.logger(f"Watchdog: {'enabled' if enabled else 'disabled'} ({reason}); interval={interval:g}s, limit={limit_gb:g}GB")
        self.memory()

    def memory(self):
        try:
            value = self.reader()
        except Exception:
            value = None
        available = isinstance(value, int) and value > 0
        if not available and self.available is not False:
            self.logger("Watchdog unavailable: cannot read process memory")
        elif available and self.available is False:
            self.logger("Watchdog: memory reading recovered")
        self.available = available
        return value if available else None

    def snapshot(self):
        value = self.memory()
        return {"enabled": self.enabled, "reason": self.reason, "available": value is not None,
                "memoryBytes": value, "limitBytes": int(self.limit_gb * 1024**3), "intervalSeconds": self.interval}

    def check(self, reason):
        if not self.enabled or self.stop.is_set():
            return
        with self.lock:
            if self.state["inflight"] or self.state["exiting"]:
                return
        value = self.memory()
        if value is None or value <= self.limit_gb * 1024**3:
            return
        # Admission and retirement share the lock; queued requests count too.
        with self.lock:
            if self.state["inflight"] or self.state["exiting"] or self.stop.is_set():
                return
            self.state["exiting"] = True
        self.logger(f"Watchdog: footprint {value / 1024**3:.1f}GB > {self.limit_gb:g}GB while idle ({reason}); exiting for supervisor restart")
        self.exit_callback()

    def periodic(self):
        while not self.stop.wait(self.interval):
            self.check("periodic")

    def start(self):
        if self.enabled:
            self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread.is_alive():
            self.thread.join(timeout=2)


def _join_texts(parts):
    out = ""
    for t in parts:
        t = (t or "").strip()
        if not t:
            continue
        if out and out[-1].isascii() and out[-1].isalnum() and t[0].isascii() and t[0].isalnum():
            out += " "
        out += t
    return out

def decode_to_wav(audio_path):
    """Decode local audio to mono 16 kHz float32 PCM without a temporary file.

    Decode containers such as Opus-in-MP4 directly instead of depending on a
    Python audio library's optional format backends. Bound decoded output too:
    container duration metadata alone is not a trustworthy allocation limit.
    """
    sample_rate = 16000
    if not math.isfinite(MAX_AUDIO_SECONDS) or MAX_AUDIO_SECONDS <= 0:
        raise ValueError("invalid audio duration limit")
    max_bytes = int(MAX_AUDIO_SECONDS * sample_rate) * 2
    try:
        proc = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-xerror",
             "-protocol_whitelist", "file,pipe", "-i", audio_path,
             "-map", "0:a:0", "-vn", "-sn", "-dn",
             "-t", str(MAX_AUDIO_SECONDS + 1), "-fs", str(max_bytes + 2),
             "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", str(sample_rate), "-"],
            capture_output=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise ValueError("audio decode timed out") from None
    except (OSError, subprocess.SubprocessError):
        raise ValueError("audio decoder unavailable") from None
    if proc.returncode != 0 or not proc.stdout or len(proc.stdout) % 2:
        raise ValueError("audio could not be decoded")
    # ffmpeg -fs may exceed its byte limit by one encoded packet. Reject the
    # whole input rather than silently transcribing a duration-truncated prefix.
    if len(proc.stdout) > max_bytes:
        raise AudioTooLongError("decoded audio exceeds the local duration limit")
    import numpy as np  # Already a declared model dependency; keep startup light.
    wav = np.frombuffer(proc.stdout, dtype="<i2").astype(np.float32)
    wav /= np.float32(32768.0)
    return wav


def transcribe_chunked(model, audio_path):
    """Decode once, split at low-energy points into <=CHUNK_SECONDS pieces, run them one by one."""
    from qwen_asr.inference.utils import split_audio_into_chunks, SAMPLE_RATE
    wav = decode_to_wav(audio_path)
    pieces = split_audio_into_chunks(wav=wav, sr=SAMPLE_RATE, max_chunk_sec=CHUNK_SECONDS)
    texts = []
    for piece, _offset in pieces:
        if piece.shape[0] < int(0.3 * SAMPLE_RATE):
            continue
        try:
            results = model.transcribe(audio=(piece, SAMPLE_RATE), language=None)
            texts.append(results[0].text if results else "")
        finally:
            release_inference_cache()
    return _join_texts(texts), len(pieces)


def validate_audio(audio_path):
    if not isinstance(audio_path, str) or not os.path.isabs(audio_path) or not os.path.isfile(audio_path):
        raise ValueError("Expected an absolute path to an existing audio file")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
         "default=noprint_wrappers=1:nokey=1", audio_path],
        capture_output=True, text=True, timeout=10, check=True,
    )
    duration = float(probe.stdout.strip())
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Cannot determine audio duration")
    if duration > MAX_AUDIO_SECONDS:
        raise AudioTooLongError("Audio exceeds the local duration limit; use bridge chunking or Tingwu")


def create_server(model, port=PORT):
    """JSON path interface for the host. Browser origins and large requests are refused.
    Health checks remain responsive while serialized inference is in progress.
    Local processes on this account are trusted; do not expose this port on LAN.
    """
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
    infer_lock, state_lock = threading.Lock(), threading.Lock()
    state = {"inflight": 0, "exiting": False, "failures": 0}

    enabled, reason = recycle_policy()
    watchdog = MemoryWatchdog(state, state_lock, enabled=enabled, reason=reason,
                              interval=float(os.environ.get("ASR_WATCHDOG_INTERVAL", "300")))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def respond(self, status, text):
            data = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/status":
                if self.headers.get("Origin") or self.headers.get("Sec-Fetch-Site"):
                    return self.respond(403, "browser requests are not supported")
                with state_lock:
                    current = dict(state)
                return self.respond(200, json.dumps({"format": 1, "service": "tarobot-qwen3-asr",
                    "installationId": os.environ.get("ASR_INSTALLATION_ID", ""),
                    "modelPresent": Path(MODEL_PATH).is_dir(), "activeRequests": current["inflight"],
                    "exiting": current["exiting"], "consecutiveFailures": current["failures"], "watchdog": watchdog.snapshot()}))
            self.respond(200 if self.path == "/health" else 404, "ok" if self.path == "/health" else "not found")

        def do_POST(self):
            if self.path != "/transcribe":
                return self.respond(404, "not found")
            if self.headers.get("Origin") or self.headers.get("Sec-Fetch-Site"):
                return self.respond(403, "browser requests are not supported")
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                return self.respond(415, "expected application/json")
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 16384:
                    return self.respond(413, "invalid request size")
            except ValueError:
                return self.respond(400, "invalid request size")
            try:
                guard = request_guard()
            except OSError:
                return self.respond(503, "service busy; retry")
            with state_lock:
                if state["exiting"] or state["inflight"] >= 8:
                    if guard is not None: os.close(guard)
                    return self.respond(503, "service busy; retry")
                state["inflight"] += 1
            try:
                data = json.loads(self.rfile.read(size))
                audio_path = data.get("path") if isinstance(data, dict) else None
                validate_audio(audio_path)
                with infer_lock:
                    try:
                        text, _pieces = transcribe_chunked(model, audio_path)
                    except Exception:
                        with state_lock: state["failures"] += 1
                        raise
                    else:
                        with state_lock: state["failures"] = 0
                if not text.strip():
                    return self.respond(422, "no speech recognized")
                self.respond(200, text)
            except (ValueError, subprocess.SubprocessError):
                self.respond(400, "invalid or unsupported audio; check ffprobe and duration")
            except Exception:
                # Never echo a local file path, audio contents or arbitrary exception.
                self.respond(500, "transcription failed")
            finally:
                with state_lock:
                    state["inflight"] -= 1
                if guard is not None: os.close(guard)
                watchdog.check("after request")

    class AsrServer(ThreadingHTTPServer):
        daemon_threads = True
        def server_close(self):
            watchdog.close()
            super().server_close()

    server = AsrServer(("127.0.0.1", port), Handler)
    server.watchdog = watchdog
    watchdog.start()
    return server


def load_server():
    # Loading a large model is legitimate work too: repair must not reset it.
    startup_guard = request_guard(blocking=True)
    try:
        server = create_server(load_model())
    finally:
        if startup_guard is not None: os.close(startup_guard)
    return server


if __name__ == "__main__":
    server = load_server()
    log(f"Qwen3-ASR listening on loopback port {server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
