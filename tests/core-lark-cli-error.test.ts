import { describe, expect, it } from "vitest";

import { LarkCliError, larkCliErrorFromExec } from "../src/core/lark-cli-error.js";

// Parser for the typed error envelope an optional lark-cli integration writes to
// stderr. Pure data handling: no CLI is spawned and nothing is probed.
describe("larkCliErrorFromExec (typed envelope on a rejected exec's stderr)", () => {
  // The exact shape a promisified child_process.execFile rejection has when the CLI fails:
  // .code is the PROCESS exit status, the typed envelope is on .stderr, stdout is empty.
  const rejectionLike = (stderr: string, exitCode: number) =>
    Object.assign(new Error(`Command failed: lark-cli ...\n${stderr}`), { code: exitCode, stdout: "", stderr });

  it("recovers the typed LarkCliError from a rejected exec's stderr + keeps only the troubleshooter URL", () => {
    const stderr = JSON.stringify({
      ok: false,
      error: {
        type: "authentication",
        subtype: "token_invalid",
        code: 99991668,
        message: "user access token not support",
        troubleshooter: "排查建议查看(Troubleshooting suggestions): https://open.feishu.cn/search?from=openapi&code=99991668",
      },
    });
    const recovered = larkCliErrorFromExec(rejectionLike(stderr, 3), "lark-cli docs +create failed");
    expect(recovered).toBeInstanceOf(LarkCliError);
    const cliErr = recovered as LarkCliError;
    expect(cliErr.larkType).toBe("authentication");
    expect(cliErr.larkCode).toBe(99991668);
    // Only the URL is kept — the surrounding Chinese text + parens would break a card link.
    expect(cliErr.troubleshooter).toBe("https://open.feishu.cn/search?from=openapi&code=99991668");
  });

  it("returns an existing LarkCliError unchanged", () => {
    const original = new LarkCliError({ type: "authentication", code: 99991672 }, "x");
    expect(larkCliErrorFromExec(original, "fb")).toBe(original);
  });

  it("returns the original error when there is no parseable envelope", () => {
    const plain = Object.assign(new Error("Command failed: lark-cli (exit 1)"), { code: 1, stdout: "", stderr: "boom, not json" });
    expect(larkCliErrorFromExec(plain, "fb")).toBe(plain);
  });
});
