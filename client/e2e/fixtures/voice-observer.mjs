// Only the owned managed worker is observed. Forward native process arguments,
// ASR requests and responses unchanged; never retain credentials or signed URLs.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

if (process.argv[1] === process.env.TAROCUB_VOICE_WORKER_ENTRY && process.env.TAROCUB_VOICE_OBSERVER_LOG) {
  const record = (value) => appendFileSync(process.env.TAROCUB_VOICE_OBSERVER_LOG, JSON.stringify({ at: Date.now(), ...value }) + "\n");
  const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const fetchNative = globalThis.fetch;
  globalThis.fetch = async function (...args) {
    const url = String(args[0]);
    if (url !== (process.env.ASR_HTTP_URL || "http://127.0.0.1:8412/transcribe")) return Reflect.apply(fetchNative, this, args);
    const body = JSON.parse(args[1].body);
    record({ type: "local.request", sha256: digest(body.path) });
    const result = await Reflect.apply(fetchNative, this, args);
    record({ type: "local.response", status: result.status });
    return result;
  };
  const spawnNative = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(spawnNative, this, args);
    record({ type: "process.start", pid: child.pid, executable: path.basename(String(args[0])) });
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (argv.some((arg) => path.basename(arg) === "tingwu_transcribe.py")) {
      record({ type: "cloud.start", pid: child.pid, sha256: digest(argv[argv.indexOf("--file") + 1]), jobDir: argv[argv.indexOf("--out-dir") + 1] });
    }
    child.once("exit", (code, signal) => record({ type: "process.exit", pid: child.pid, code, signal }));
    return child;
  };
  syncBuiltinESMExports();
}
