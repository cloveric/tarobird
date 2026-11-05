import { execFile } from "node:child_process";
import { realpath, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);

it.skipIf(process.platform === "win32")("installs local ASR without copying model weights or changing existing configuration", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qwen-install-")));
  try {
    const target = path.join(root, "local asr"); await mkdir(target);
    await writeFile(path.join(target, ".env.local"), "PRIVATE_SENTINEL");
    const { stdout } = await exec("bash", [path.resolve("scripts/install-qwen-asr.sh"), "--dir", target, "--no-deps"], {env:{...process.env,HOME:root}});
    expect(stdout).toContain("No running service has been restarted");
    expect(await readFile(path.join(target, ".env.local"), "utf8")).toBe("PRIVATE_SENTINEL");
    expect(await readFile(path.join(target, "server.py"), "utf8")).toContain('"127.0.0.1"');
    await expect(readFile(path.join(target, "models/weights.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await exec("bash", [path.resolve("scripts/install-qwen-asr.sh"), "--dir", target, "--no-deps"], {env:{...process.env,HOME:root}});
    expect(await readFile(path.join(target, ".env.local"), "utf8")).toBe("PRIVATE_SENTINEL");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("checks local ASR protocol, concurrency and duration limits without loading model weights", async () => {
  const { stderr } = await exec("python3", ["-B", path.resolve("tests/python/qwen_asr_test.py")], { timeout: 15000 });
  expect(stderr).toContain("OK");
}, 20_000);

it.each(process.platform === "win32" ? ["qwen_watchdog_test.py", "qwen_decode_test.py"] : ["qwen_watchdog_test.py", "qwen_installer_test.py", "qwen_decode_test.py"])("checks %s without models or external services", async script => {
  const { stderr } = await exec("python3", ["-B", path.resolve("tests/python", script)], { timeout: 15000 });
  expect(stderr).toContain("OK");
}, 20_000);

it.skipIf(process.platform === "win32")("supports a service dry-run without writing files or downloading models", async () => {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"qwen-dry-run-")));
  try {
    const target=path.join(root,"target");
    const {stdout}=await exec("bash",[path.resolve("scripts/install-qwen-asr.sh"),"--dir",target,"--with-model","--as-service","--dry-run"],{env:{...process.env,HOME:root}});
    expect(JSON.parse(stdout)).toMatchObject({downloadModel:true});
    await expect(readFile(path.join(target,"installation.json"))).rejects.toMatchObject({code:"ENOENT"});
    await expect(exec("bash",[path.resolve("scripts/install-qwen-asr.sh"),"--unknown"])).rejects.toMatchObject({code:2});
  } finally { await rm(root,{recursive:true,force:true}); }
});
