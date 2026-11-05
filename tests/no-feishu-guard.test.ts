import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const root = fileURLToPath(new URL("../", import.meta.url));
const preload = path.join(root, "tests/helpers/gateway-no-feishu.cjs");
const execute = promisify(execFile);

it.each(["commonjs", "module"])("blocks direct/shell/absolute/Node-wrapped CLI and low-level children in %s even when callers catch errors", async mode => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-guard-canary-"));
  const marker = path.join(temporary, "unexpected-execution"), fake = path.join(temporary, "lark-cli.cjs"), report = path.join(temporary, "report.jsonl");
  try {
    await writeFile(fake, 'require("node:fs").writeFileSync(process.env.GUARD_MARKER, "executed");');
    await writeFile(report, "");
    // Positive control: this disposable fixture really would execute without a guard.
    execFileSync(process.execPath, [fake], { env: { ...process.env, GUARD_MARKER: marker } });
    expect(await readFile(marker, "utf8")).toBe("executed"); await rm(marker);
    const imports = mode === "module" ? 'import * as cp from "node:child_process";' : 'const cp = require("node:child_process");';
    const program = `${imports}
      const failures = [];
      const attempts = [
        () => cp.spawn("lark-cli", ["--version"]),
        () => cp.execFile(process.env.GUARD_FAKE, []),
        () => cp.execFileSync(process.execPath, [process.env.GUARD_FAKE]),
        () => cp.spawnSync("lark-cli", []),
        () => cp.exec("lark-cli --version"),
        () => cp.execSync("lark-cli --version"),
        () => cp.spawn("sh", ["-c", "lark-cli --version"]),
        () => cp.fork(process.env.GUARD_FAKE),
        () => new cp.ChildProcess().spawn({ file: process.execPath, args: [process.execPath, process.env.GUARD_FAKE], envPairs: [], stdio: [] })
      ];
      for (const attempt of attempts) { try { attempt(); failures.push("not-blocked"); } catch (error) { failures.push(error.message); } }
      console.log(JSON.stringify(failures));`;
    const { stdout } = await execute(process.execPath, ["--require", preload, "--input-type=" + mode, "-e", program], { cwd: root, env: { ...process.env, GUARD_MARKER: marker, GUARD_FAKE: fake, TAROBOT_GATEWAY_GUARD_REPORT: report }, timeout: 15000 });
    const failures = JSON.parse(stdout.trim());
    expect(failures).toHaveLength(9); expect(failures.every((value: string) => /^gateway_no_feishu_guard:process$/.test(value))).toBe(true);
    const events = (await readFile(report, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toHaveLength(9);
    expect(events.every(event => event.kind === "process")).toBe(true);
    expect(events.every(event => Object.keys(event).sort().join(",") === "kind,pid")).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

it("automatically fails a Gateway test file when a subprocess violation is swallowed", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-guard-swallow-"));
  const marker = path.join(temporary, "unexpected-execution"), fake = path.join(temporary, "lark-cli.cjs");
  try {
    await writeFile(fake, 'require("node:fs").writeFileSync(process.env.GUARD_MARKER, "executed");');
    let code: number | undefined, output = "";
    try {
      await execute(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "tests/fixtures/gateway-guard.vitest.config.ts"], {
        cwd: root, env: { ...process.env, GUARD_MARKER: marker, GUARD_FAKE: fake, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 20000,
      });
    } catch (error) { const result = error as { code?: number; stdout?: string; stderr?: string }; code = result.code; output = (result.stdout ?? "") + (result.stderr ?? ""); }
    expect(code, output).toBe(1);
    expect(output).toContain("Gateway test attempted a Feishu SDK call or unapproved subprocess");
    expect(output).toContain('"kind":"process"');
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 25000);

it.runIf(process.platform === "darwin")("allows only the fixed read-only boot UUID probe", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-guard-epoch-")), report = path.join(temporary, "report.jsonl");
  try {
    await writeFile(report, "");
    const program = `const cp=require('node:child_process');
      const uuid=cp.execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'}).trim();
      if(!/^[a-f0-9-]{36}$/i.test(uuid))throw Error('uuid');
      for(const args of [['-n','kern.hostname'],['-w','kern.bootsessionuuid=bad'],['-n','kern.bootsessionuuid','kern.hostname']]){
        try{cp.execFileSync('/usr/sbin/sysctl',args);throw Error('not-blocked');}catch(e){if(!e.message.startsWith('gateway_no_feishu_guard:'))throw e;}
      }`;
    await execute(process.execPath, ["--require", preload, "-e", program], { cwd: root, env: { ...process.env, TAROBOT_GATEWAY_GUARD_REPORT: report }, timeout: 10000 });
    const events = (await readFile(report, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toHaveLength(3); expect(events.every(event => event.kind === "process")).toBe(true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

it("keeps SDK call detection without installing the retired SDK", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-sdk-shape-"));
  const marker = path.join(temporary, "unexpected-execution"), report = path.join(temporary, "report.jsonl");
  try {
    await writeFile(report, "");
    const program = `const fs = require('node:fs');
      function touch() { fs.writeFileSync(process.env.GUARD_MARKER, 'executed'); }
      const sdkShape = { Client: touch, WSClient: touch, createLarkChannel: touch,
        registerApp: touch, defaultHttpInstance: { get: touch } };
      sdkShape.defaultHttpInstance.get();
      if(fs.readFileSync(process.env.GUARD_MARKER,'utf8')!=='executed')throw Error('positive-control');
      fs.unlinkSync(process.env.GUARD_MARKER);
      const guard = require(process.env.GUARD_PRELOAD).install(process.env.GUARD_CANARY_REPORT);
      const sdk = guard.guardSdk(sdkShape), failures = [];
      try {
        for (const call of [()=>new sdk.Client(), ()=>new sdk.WSClient(),
          ()=>sdk.createLarkChannel(), ()=>sdk.registerApp(), ()=>sdk.defaultHttpInstance.get()]) {
          try { call(); failures.push('not-blocked'); } catch(e) { failures.push(e.message); }
        }
      } finally { guard.dispose(); }
      console.log(JSON.stringify(failures));`;
    const { TAROBOT_GATEWAY_GUARD_REPORT: _inherited, ...env } = process.env;
    const { stdout } = await execute(process.execPath, ["-e", program], {
      cwd: root, env: { ...env, GUARD_PRELOAD: preload, GUARD_MARKER: marker, GUARD_CANARY_REPORT: report }, timeout: 10000,
    });
    expect(JSON.parse(stdout.trim())).toEqual(Array(5).fill("gateway_no_feishu_guard:sdk"));
    const events = (await readFile(report, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toHaveLength(5);
    expect(events.every(event => event.kind === "sdk" && Object.keys(event).sort().join(",") === "kind,pid")).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
