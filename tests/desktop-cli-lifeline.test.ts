import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

it("native helper EOF before its JSON authorization cannot execute start or stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-lifeline-"));
  try {
    for (const action of ["start", "stop", "status"]) {
      const source = `import { runDesktopHostCli } from ${JSON.stringify(pathToFileURL(path.resolve('src/hub/desktop.ts')).href)}; await runDesktopHostCli(${JSON.stringify([action, path.join(root, "unused")])});`;
      const result = await new Promise<{ code: number; stderr: string }>(resolve => {
        const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { timeout: 10000 }, (error, _stdout, stderr) => resolve({ code: Number(error?.code ?? 0), stderr }));
        child.stdin!.end();
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("desktop_host_input_missing");
      expect(await readdir(root)).toEqual([]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
