import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import * as permissionHook from "../src/codex/claude-permission-hook.js";
import * as instructionFiles from "../src/codex/claude-instructions-file.js";
import { ProcessClaudeAdapter } from "../src/codex/claude-adapter.js";
import { EngineIncompleteResponseError } from "../src/codex/adapter.js";

async function waitForSpawn(calls: Array<unknown>): Promise<void> {
  // Prompt files and policy are read asynchronously before the fake process starts.
  // Wait for readiness, not an assumed number of event-loop ticks under suite load.
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
}

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  written = "";

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.written += chunk;
    callback?.(null);
    return true;
  }

  end(callback?: () => void): void {
    callback?.();
  }
}

class FakeClaudeChildProcess extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();

  close(code: number | null) {
    this.emit("close", code);
  }
}

function createSpawnHarness() {
  const child = new FakeClaudeChildProcess();
  const calls: Array<{
    command: string;
    args: string[];
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    };
  }> = [];

  const spawnFn = (
    command: string,
    args: string[],
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    },
  ) => {
    calls.push({ command, args, options });
    return child;
  };

  return { child, calls, spawnFn };
}

describe("ProcessClaudeAdapter", () => {
  it.each(["array", "lines", "single", "empty-result"])("rejects synthetic no-response padding in %s output", async (format) => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });
    const pending = adapter.sendUserMessage("native-A", { text: "Do the task", files: [] });
    const rejected = expect(pending).rejects.toBeInstanceOf(EngineIncompleteResponseError);
    await waitForSpawn(calls);
    const placeholder = { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } };
    const events = [placeholder, { type: "result", result: format === "empty-result" ? "" : "No response requested.", session_id: "native-A" }];
    child.stdout.emitData(format === "single" ? JSON.stringify(placeholder) : format === "array" ? JSON.stringify(events) : events.map(value => JSON.stringify(value)).join("\n"));
    child.close(0);
    await rejected;
    expect(calls).toHaveLength(1);
  });

  it.each(["Hello", "No response requested."])("retains the real answer %s following resume padding", async (text) => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });
    const pending = adapter.sendUserMessage("native-A", { text: `Reply exactly ${text}`, files: [] });
    await waitForSpawn(calls);
    child.stdout.emitData(JSON.stringify([
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
      { type: "assistant", message: { model: "claude-opus", content: [{ type: "text", text }] } },
      { type: "result", result: text, session_id: "native-A" },
    ]));
    child.close(0);
    await expect(pending).resolves.toMatchObject({ text });
  });

  it("creates a logical TaroBot session placeholder", async () => {
    const adapter = new ProcessClaudeAdapter("claude");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "tarobot-12345",
    });
  });

  it("builds a Claude invocation with Chrome, instructions, workspace, and resume", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const configPath = path.join(root, "config.json");
    const workspacePath = path.join(root, "workspace");

    try {
      await writeFile(instructionsPath, "You are a reviewer.", "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }), "utf8");
      const adapter = new ProcessClaudeAdapter("claude", {
        spawnFn,
        instructionsPath,
        configPath,
        workspacePath,
        enableChromeIntegration: true,
      });

      const promise = adapter.sendUserMessage("session-123", {
        text: "Review this",
        files: ["a.ts"],
      });
      await waitForSpawn(calls);
      expect(calls[0]?.command).toBe("claude");
      expect(calls[0]?.args).toEqual([
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--chrome",
        "-r",
        "session-123",
        "--permission-mode",
        "bypassPermissions",
        "--append-system-prompt-file",
        expect.stringContaining("instructions.md"),
        "--add-dir",
        workspacePath,
      ]);
      expect(calls[0]?.options.cwd).toBe(workspacePath);
      expect(calls[0]?.options.windowsHide).toBe(true);
      const promptFilePath = calls[0]?.args[calls[0].args.indexOf("--append-system-prompt-file") + 1];
      expect(promptFilePath).toBeTruthy();
      await expect(readFile(promptFilePath!, "utf8")).resolves.toContain("You are a reviewer.");
      expect(calls[0]?.args.join(" ")).not.toContain("You are a reviewer.");
      expect(child.stdin.written).not.toContain("You are a reviewer.");
      expect(child.stdin.written).toContain("Review this\nAttachment: a.ts");

      child.stdout.emitData('{"type":"result","result":"Looks good","session_id":"session-123"}');
      child.close(0);

      await expect(promise).resolves.toEqual({
        text: "Looks good",
        sessionId: "session-123",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reloads Chrome policy for each process invocation and preserves the native session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chrome-process-"));
    const { child, calls, spawnFn } = createSpawnHarness();
    const configPath = path.join(root, "config.json");
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn, configPath, enableChromeIntegration: true });
    try {
      for (const enabled of [false, true, false]) {
        await writeFile(configPath, JSON.stringify({ engine: "claude", claudeChrome: enabled }));
        calls.length = 0;
        const pending = adapter.sendUserMessage("chrome-native-session", { text: "Check", files: [] });
        await waitForSpawn(calls);
        expect(calls[0]!.args).toContain(enabled ? "--chrome" : "--no-chrome");
        expect(calls[0]!.args).not.toContain(enabled ? "--no-chrome" : "--chrome");
        expect(calls[0]!.args).toContain("chrome-native-session");
        child.stdout.emitData('{"type":"result","result":"OK","session_id":"chrome-native-session"}');
        child.close(0); await expect(pending).resolves.toMatchObject({ text: "OK", sessionId: "chrome-native-session" });
      }
    } finally { await removeTempRoot(root); }
  });

  it.each(["manual", "auto", "acceptEdits"] as const)("honors the configured Claude %s permission mode without bypass", async (permissionMode) => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-native-permission-"));
    try {
      const configPath = path.join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal", claudePermissionMode: permissionMode }));
      const adapter = new ProcessClaudeAdapter("claude", { spawnFn, configPath });
      const pending = adapter.sendUserMessage("telegram-12345", { text: "Review this", files: [] });
      await waitForSpawn(calls);
      const args = calls[0]!.args;
      expect(args[args.indexOf("--permission-mode") + 1]).toBe(permissionMode);
      expect(args).not.toContain("bypassPermissions");
      child.stdout.emitData('{"type":"result","result":"Looks good","session_id":"session-123"}');
      child.close(0);
      await expect(pending).resolves.toMatchObject({ text: "Looks good" });
    } finally { await removeTempRoot(root); }
  });

  it("defaults configured Claude instances without approval mode to unsafe bypass", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, "{}\n", "utf8");
      const adapter = new ProcessClaudeAdapter("claude", {
        spawnFn,
        configPath,
      });

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Review this",
        files: [],
      });
      await waitForSpawn(calls);

      child.stdout.emitData('{"type":"result","result":"Looks good","session_id":"session-123"}');
      child.close(0);

      await expect(promise).resolves.toEqual({
        text: "Looks good",
        sessionId: "session-123",
      });
      expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
      expect(calls[0]?.args).not.toContain("--disallowedTools");
      expect(calls[0]?.args).not.toContain("AskUserQuestion");
      expect(calls[0]?.args).not.toContain("bypassPermissions");
      expect(calls[0]?.args).not.toContain("--chrome");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("can disallow AskUserQuestion for plain transports", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", {
      spawnFn,
      disallowedTools: ["AskUserQuestion"],
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Review this",
      files: [],
    });
    await waitForSpawn(calls);

    child.stdout.emitData('{"type":"result","result":"Looks good","session_id":"session-123"}');
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Looks good",
      sessionId: "session-123",
    });
    expect(calls[0]?.args).toContain("--disallowedTools");
    expect(calls[0]?.args).toContain("AskUserQuestion");
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are a reviewer.", "utf8");
      const adapter = new ProcessClaudeAdapter("claude", {
        spawnFn,
        instructionsPath,
      });

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });
      await waitForSpawn(calls);
      expect(calls[0]?.args).not.toContain("--system-prompt");
      expect(calls[0]?.args).not.toContain("--append-system-prompt");
      expect(calls[0]?.args).toContain("--append-system-prompt-file");
      const promptFilePath = calls[0]?.args[calls[0].args.indexOf("--append-system-prompt-file") + 1];
      expect(promptFilePath).toBeTruthy();
      const promptFile = await readFile(promptFilePath!, "utf8");
      expect(promptFile).toContain("You are a reviewer.");
      expect(promptFile).toContain("[Telegram Bridge Capabilities]");
      expect(calls[0]?.args.join(" ")).not.toContain("You are a reviewer.");
      expect(child.stdin.written).not.toContain("[Agent Instructions]");
      expect(child.stdin.written).not.toContain("[Bridge Instructions]");

      child.stdout.emitData('{"type":"result","result":"ok","session_id":"session-abc"}');
      child.close(0);
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("only forwards side-channel extra env keys to the Claude child process", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      extraEnv: {
        CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
        CCTB_SEND_TOKEN: "token",
        CCTB_SEND_COMMAND: "/tmp/.cctb-send/helper",
        CCTB_CRON_URL: "http://127.0.0.1:12345/cron/token",
        CCTB_CRON_TOKEN: "cron-token",
        PATH: `/tmp/.cctb-bin${path.delimiter}/usr/bin`,
        LD_PRELOAD: "/tmp/injected.dylib",
        NODE_OPTIONS: "--require /tmp/injected.js",
      },
    });
    await waitForSpawn(calls);

    child.stdout.emitData('{"type":"result","result":"ok","session_id":"session-abc"}');
    child.close(0);
    await promise;

    expect(calls[0]?.options.env).toMatchObject({
      CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
      CCTB_SEND_TOKEN: "token",
      CCTB_SEND_COMMAND: "/tmp/.cctb-send/helper",
      PATH: `/tmp/.cctb-bin${path.delimiter}/usr/bin`,
    });
    expect(calls[0]?.options.env?.CCTB_CRON_URL).toBeUndefined();
    expect(calls[0]?.options.env?.CCTB_CRON_TOKEN).toBeUndefined();
    expect(calls[0]?.options.env?.LD_PRELOAD).toBeUndefined();
    expect(calls[0]?.options.env?.NODE_OPTIONS).toBeUndefined();
  });

  it("injects a Claude permission prompt MCP tool when Telegram approval is available", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Edit package.json",
      files: [],
      onApprovalRequest: async () => ({ behavior: "deny" }),
    });
    await waitForSpawn(calls);

    const configIndex = calls[0]?.args.indexOf("--mcp-config") ?? -1;
    expect(configIndex).toBeGreaterThanOrEqual(0);
    const configPath = calls[0]!.args[configIndex + 1]!;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers?: {
        cctb_approval?: {
          type?: string;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
      };
    };
    const server = config.mcpServers?.cctb_approval;
    expect(server?.type).toBe("stdio");
    expect(server?.command).toBeTruthy();
    expect(server?.args?.[0]).toMatch(/claude-permission-mcp-server\.(?:js|ts)$/);
    expect(calls[0]!.args.join(" ")).not.toContain(server?.env?.CCTB_CLAUDE_APPROVAL_URL);
    expect(server?.env?.CCTB_CLAUDE_APPROVAL_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/claude-permission\/[A-Za-z0-9_-]+$/);

    const promptToolIndex = calls[0]?.args.indexOf("--permission-prompt-tool") ?? -1;
    expect(promptToolIndex).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.args[promptToolIndex + 1]).toBe("mcp__cctb_approval__approve");
    child.stdout.emitData('{"type":"result","result":"ok","session_id":"session-abc"}');
    child.close(0); await promise;
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes quoted Windows claude.cmd paths", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter('"C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd"', {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"result","result":"ok","session_id":"session-abc"}');
    child.close(0);
    await promise;

    expect(calls[0]?.command.toLowerCase()).toContain("cmd");
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd",
      "-p",
    ]);
    expect(calls[0]?.options.windowsHide).toBe(true);
  });

  it("rejects when Claude returns is_error instead of resolving as text", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"result","is_error":true,"result":"auth expired"}');
    child.close(0);

    await expect(promise).rejects.toThrow("auth expired");
  });

  it("parses Claude JSON array output and returns the result event text", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(JSON.stringify([
      { type: "system", subtype: "init", session_id: "session-123" },
      { type: "assistant", message: { content: [{ type: "text", text: "intermediate" }] } },
      { type: "result", result: "Looks good", session_id: "session-123" },
    ]));
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Looks good",
      sessionId: "session-123",
    });
  });

  it("preserves intermediate Claude send-file tags when the final result only summarizes delivery", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate images",
      files: [],
    });

    child.stdout.emitData([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Working on it." }] },
        session_id: "session-files",
      },
      {
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "Files ready:\n[send-file:/tmp/workspace/01-cover.png]",
          }],
        },
        session_id: "session-files",
      },
      { type: "result", result: "Files delivered.", session_id: "session-files" },
    ].map((event) => JSON.stringify(event)).join("\n"));
    child.close(0);

    await expect(promise).resolves.toMatchObject({
      text: "Files ready:\n[send-file:/tmp/workspace/01-cover.png]\nFiles delivered.",
      sessionId: "session-files",
    });
  });

  it("preserves intermediate Claude send-image tags when the final result only summarizes delivery", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate a cover image",
      files: [],
    });

    child.stdout.emitData([
      {
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "Cover ready:\n[send-image:/tmp/workspace/01-cover.png]",
          }],
        },
        session_id: "session-images",
      },
      { type: "result", result: "Cover image sent.", session_id: "session-images" },
    ].map((event) => JSON.stringify(event)).join("\n"));
    child.close(0);

    await expect(promise).resolves.toMatchObject({
      text: "Cover ready:\n[send-image:/tmp/workspace/01-cover.png]\nCover image sent.",
      sessionId: "session-images",
    });
  });

  it("preserves intermediate send-file tags that are not repeated in the final result", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate two images",
      files: [],
    });

    child.stdout.emitData([
      {
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "First file ready:\n[send-file:/tmp/workspace/01-cover.png]",
          }],
        },
        session_id: "session-files",
      },
      {
        type: "result",
        result: "Second file ready:\n[send-file:/tmp/workspace/02-core.png]",
        session_id: "session-files",
      },
    ].map((event) => JSON.stringify(event)).join("\n"));
    child.close(0);

    await expect(promise).resolves.toMatchObject({
      text: "First file ready:\n[send-file:/tmp/workspace/01-cover.png]\nSecond file ready:\n[send-file:/tmp/workspace/02-core.png]",
      sessionId: "session-files",
    });
  });

  it("does not duplicate intermediate send-file tags already present in the final result", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate one image",
      files: [],
    });

    child.stdout.emitData([
      {
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "File ready:\n[send-file:/tmp/workspace/01-cover.png]",
          }],
        },
        session_id: "session-files",
      },
      {
        type: "result",
        result: "File ready:\n[send-file:/tmp/workspace/01-cover.png]",
        session_id: "session-files",
      },
    ].map((event) => JSON.stringify(event)).join("\n"));
    child.close(0);

    await expect(promise).resolves.toMatchObject({
      text: "File ready:\n[send-file:/tmp/workspace/01-cover.png]",
      sessionId: "session-files",
    });
  });

  it("falls back to visible assistant text when the result event is empty", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(JSON.stringify([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from assistant" }] },
        session_id: "session-abc",
      },
      { type: "result", result: "", session_id: "session-abc" },
    ]));
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Hello from assistant",
      sessionId: "session-abc",
    });
  });

  it("accumulates multiple assistant text events when the result event is empty", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(JSON.stringify([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "First chunk" }] },
        session_id: "session-xyz",
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Second chunk" }] },
        session_id: "session-xyz",
      },
      { type: "result", result: "", session_id: "session-xyz" },
    ]));
    child.close(0);

    await expect(promise).resolves.toMatchObject({
      text: "First chunk\nSecond chunk",
      sessionId: "session-xyz",
    });
  });

  it("keeps child and background results out of the one-shot parent answer and binding", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });
    const turn = adapter.sendUserMessage("telegram-parent", { text: "parent request", files: [] });
    child.stdout.emitData(JSON.stringify([
      { type: "assistant", message: { content: [{ type: "text", text: "parent answer" }] }, session_id: "parent" },
      { type: "result", result: "", session_id: "parent" },
      { type: "assistant", parent_tool_use_id: "agent", message: { content: [{ type: "text", text: "CHILD_SECRET" }] }, session_id: "child" },
      { type: "result", parent_tool_use_id: "agent", result: "CHILD_SECRET", session_id: "child" },
      { type: "result", origin: { kind: "task-notification" }, result: "old task", session_id: "parent" },
    ]));
    child.close(0);
    await expect(turn).resolves.toMatchObject({ text: "parent answer", sessionId: "parent" });
  });

  it("returns an empty-response message for an empty Claude event array", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData("[]");
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Claude returned an empty response.",
      sessionId: undefined,
    });
  });

  it("surfaces the is_error message even when the process exits with non-zero code", async () => {
    // Claude CLI exits with code 1 on 401 auth errors but still writes the
    // error JSON to stdout. We must resolve with stdout so parseResult() can
    // throw the real message, not "claude exited with code 1".
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401"}');
    child.close(1);

    await expect(promise).rejects.toThrow(/Failed to authenticate/);
  });

  it.each([false, true])("rejects a CLI authentication assistant frame instead of returning an answer (result frame=%s)", async terminal => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });
    const result = adapter.sendUserMessage("auth-check", { text: "Hello", files: [] });
    const failure = "Failed to authenticate: OAuth session expired and could not be refreshed";
    const frame = { type: "assistant", error: "authentication_failed", isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: failure }] } };
    child.stdout.emitData(JSON.stringify(terminal ? [frame, { type: "result", is_error: true, result: "" }] : frame));
    child.close(1);
    await expect(result).rejects.toMatchObject({ name: "ClaudeError", message: failure });
  });

  it("rejects an unresolved API error even when the terminal frame says success", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });
    const result = adapter.sendUserMessage("auth-check", { text: "Hello", files: [] });
    child.stdout.emitData(JSON.stringify([
      { type: "assistant", error: "authentication_failed", message: { content: [] } },
      { type: "result", is_error: false, result: "" },
    ]));
    child.close(0);
    await expect(result).rejects.toMatchObject({ name: "ClaudeError", message: "Claude authentication failed" });
  });

  it("does not turn truncated JSON from a failed process into a successful answer", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });
    const result = adapter.sendUserMessage("truncated", { text: "Hello", files: [] });
    child.stdout.emitData('[{"type":"assistant","message":');
    child.stderr.emitData("fatal: crashed");
    child.close(1);
    await expect(result).rejects.toThrow("fatal: crashed");
  });

  it("surfaces stderr when Claude exits non-zero after stream events without a result", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData([
      '{"type":"system","subtype":"hook_started","session_id":"session-abc"}',
      '{"type":"system","subtype":"hook_response","session_id":"session-abc"}',
    ].join("\n"));
    child.stderr.emitData("No deferred tool marker found in the resumed session.");
    child.close(1);

    await expect(promise).rejects.toThrow(/No deferred tool marker found/);
  });

  it("does not throw an empty error when Claude returns is_error with an empty result", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"result","is_error":true,"result":"","subtype":"error","session_id":"session-abc"}');
    child.close(0);

    await expect(promise).rejects.toThrow(/Unknown error from Claude CLI/);
  });

  it("inherits CLAUDE_CONFIG_DIR from the parent env so bots track the main CLI", async () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-shared-test";
    try {
      const adapter = new ProcessClaudeAdapter("claude") as unknown as { childEnv: NodeJS.ProcessEnv };
      expect(adapter.childEnv.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-shared-test");
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = original;
      }
    }
  });

  it("does not trigger multiple promise settlements when error is followed by close", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", {
      spawnFn,
    });
    let multipleResolve: { type: string } | null = null;
    const handler = (type: string) => {
      multipleResolve = { type };
    };

    process.once("multipleResolves", handler);

    try {
      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      child.emit("error", new Error("boom"));
      child.close(1);

      await expect(promise).rejects.toThrow("boom");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(multipleResolve).toBeNull();
    } finally {
      process.removeListener("multipleResolves", handler);
    }
  });
});


it("closes the approval listener if private MCP configuration creation fails", async () => {
  const close = vi.fn(async () => {});
  const hook = vi.spyOn(permissionHook, "startClaudePermissionHookServer").mockResolvedValue({ url: "http://127.0.0.1:12345/fixture", close });
  const create = vi.spyOn(instructionFiles, "createClaudeInstructionsFile").mockRejectedValue(new Error("ENOSPC fixture"));
  const { calls, spawnFn } = createSpawnHarness();
  try {
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });
    await expect(adapter.sendUserMessage("tarobot-cleanup", { text: "work", files: [], onApprovalRequest: async () => ({ behavior: "deny" }) })).rejects.toThrow("ENOSPC fixture");
    expect(close).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(0);
  } finally { hook.mockRestore(); create.mockRestore(); }
});
