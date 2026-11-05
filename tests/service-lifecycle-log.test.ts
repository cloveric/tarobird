import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendServiceLifecycleEventSync,
  SERVICE_LIFECYCLE_LOG_FILE,
} from "../src/runtime/service-lifecycle-log.js";

describe("service lifecycle log", () => {
  it("redacts nested secrets and numeric credentials while retaining recovery diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-lifecycle-redaction-"));
    try {
      const diagnostics = { channel: "gateway", uncleanBoots: 3, retryAfterMs: 60000, exitCode: -1, recoverySkipped: true };
      appendServiceLifecycleEventSync(root, {
        type: "service.fatal", instanceName: "test-bot", detail: "Authorization: Basic fixture-base64",
        metadata: { ...diagnostics, token: 424242, apiKey: { id: "object-secret" }, nested: { error: "Bearer nested-secret" }, argv: ["--token=argv-secret"] },
      });
      const raw = await readFile(path.join(root, SERVICE_LIFECYCLE_LOG_FILE), "utf8"), event = JSON.parse(raw);
      for (const secret of ["fixture-base64", "424242", "object-secret", "nested-secret", "argv-secret"]) expect(raw).not.toContain(secret);
      expect(event).toMatchObject({ detail: "Authorization: [redacted]", metadata: { ...diagnostics, token: "[redacted]", apiKey: "[redacted]", nested: { error: "Bearer [redacted]" }, argv: ["--token=[redacted]"] } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("appends JSONL lifecycle events without truncating previous entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-lifecycle-"));

    appendServiceLifecycleEventSync(root, {
      type: "service.starting",
      instanceName: "bot6",
      detail: "first",
    });
    appendServiceLifecycleEventSync(root, {
      type: "process.signal",
      instanceName: "bot6",
      detail: "SIGTERM",
      metadata: { pid: 123 },
    });

    const raw = await readFile(path.join(root, SERVICE_LIFECYCLE_LOG_FILE), "utf8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "service.starting",
      instanceName: "bot6",
      detail: "first",
    });
    expect(lines[0]?.timestamp).toEqual(expect.any(String));
    expect(lines[0]?.pid).toEqual(process.pid);
    expect(lines[1]).toMatchObject({
      type: "process.signal",
      instanceName: "bot6",
      detail: "SIGTERM",
      metadata: { pid: 123 },
    });
  });

  it("does not throw when the state path cannot be used", () => {
    expect(() => {
      appendServiceLifecycleEventSync("/dev/null/not-a-directory", {
        type: "service.starting",
        instanceName: "bot6",
      });
    }).not.toThrow();
  });
});
