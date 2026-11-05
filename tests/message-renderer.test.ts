import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import {
  chunkReplyMessage,
  renderAccessCheckMessage,
  renderAttachmentDownloadMessage,
  renderCategorizedErrorMessage,
  renderErrorMessage,
  renderExecutionMessage,
  renderPairingMessage,
  renderPrivateChatRequiredMessage,
  renderSessionStateErrorMessage,
  renderSessionResetMessage,
  renderUnauthorizedMessage,
  renderUsageMessage,
  renderWorkingMessage,
} from "../src/runtime/message-renderer.js";

describe("chunkReplyMessage", () => {
  it("splits long messages into fixed-size chunks", () => {
    const message = "a".repeat(5000);

    const chunks = chunkReplyMessage(message, 4000);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(1000);
  });

  it("rejects non-positive limits", () => {
    expect(() => chunkReplyMessage("hello", 0)).toThrow(RangeError);
  });

  it("rejects invalid numeric limits", () => {
    expect(() => chunkReplyMessage("hello", Number.NaN)).toThrow(RangeError);
    expect(() => chunkReplyMessage("hello", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => chunkReplyMessage("hello", 3.5)).toThrow(RangeError);
  });

  it("does not split surrogate pairs across chunk boundaries", () => {
    const chunks = chunkReplyMessage(`aaaa${"😀".repeat(2)}bbbb`, 6);

    expect(chunks).toEqual(["aaaa😀", "😀bbbb"]);
  });

  it("rejects limits that cannot safely encode a surrogate pair", () => {
    expect(() => chunkReplyMessage("😀a", 1)).toThrow(RangeError);
  });

  it("closes and reopens fenced code blocks across chunk boundaries", () => {
    const message = ["before", "```js", "const answer = 42;", "```", "after"].join("\n");

    const chunks = chunkReplyMessage(message, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("```js");
    expect(chunks[0]).toMatch(/```$/);
    expect(chunks[1]).toMatch(/^```js/);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
  });

  it("preserves tilde and long-backtick fences while chunking", () => {
    const tilde = ["before", "~~~ts", "const 文本 = '很长的一段内容';", "~~~", "after"].join("\n");
    const longTicks = ["````md", "```nested```", "more content", "````"].join("\n");

    const tildeChunks = chunkReplyMessage(tilde, 24);
    const tickChunks = chunkReplyMessage(longTicks, 20);

    expect(tildeChunks.length).toBeGreaterThan(1);
    expect(tildeChunks.every((chunk) => chunk.length <= 24)).toBe(true);
    expect(tildeChunks[0]).toMatch(/~~~$/);
    expect(tildeChunks[1]).toMatch(/^~~~ts/);
    expect(tickChunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(tickChunks.some((chunk) => chunk.startsWith("````md"))).toBe(true);
  });

  it("reserves room for synthetic fence closers at line boundaries", () => {
    const chunks = chunkReplyMessage(["```js", "xxxxx", "y", "```"].join("\n"), 15);

    expect(chunks.every((chunk) => chunk.length <= 15)).toBe(true);
    expect(chunks[0]).toMatch(/```$/);
    expect(chunks[1]).toMatch(/^```js/);
  });

  it("rejects fenced limits that cannot consume content instead of looping", () => {
    expect(() => chunkReplyMessage(["```js", "x", "```"].join("\n"), 10)).toThrow(
      "limit is too small to safely encode a fenced code block",
    );
  });
});

describe("message rendering", () => {
  it("renders the working message", () => {
    expect(renderWorkingMessage()).toBe("Received. Starting your session...");
  });

  it("renders error messages", () => {
    expect(renderErrorMessage("boom")).toBe("Error: boom");
  });

  it("renders progress and access messages", () => {
    expect(renderAccessCheckMessage()).toBe("Checking access policy...");
    expect(renderAttachmentDownloadMessage(1)).toBe("Downloading 1 attachment...");
    expect(renderAttachmentDownloadMessage(2)).toBe("Downloading 2 attachments...");
    expect(renderExecutionMessage()).toBe("Working on your request...");
    expect(renderUnauthorizedMessage()).toBe("This chat is not authorized for this instance.");
    expect(renderPrivateChatRequiredMessage()).toBe("This bot only accepts private chats.");
    expect(renderPairingMessage("ABC123")).toBe("Pair this private chat with code ABC123");
  });

  it("renders categorized error and reset messages", () => {
    expect(renderSessionResetMessage()).toBe("Session reset for this chat.");
    expect(renderSessionResetMessage(true)).toBe(
      "Session state was unreadable. An operator needs to repair the instance session state before this chat can be reset.",
    );
    expect(renderSessionStateErrorMessage(true)).toBe(
      "Error: Session state is unreadable right now. The operator needs to repair session state and retry.",
    );
    expect(renderSessionStateErrorMessage(false)).toBe(
      "Error: Session state is unavailable right now. The operator needs to restore read access and retry.",
    );
    expect(renderCategorizedErrorMessage("write-permission", "write access denied")).toBe(
      "Error: File creation is blocked by the current write policy. Retry in a writable mode.",
    );
    expect(renderCategorizedErrorMessage("auth", "missing auth")).toBe(
      "Error: Engine authentication is missing or expired. Re-login for this instance and retry.",
    );
    expect(renderCategorizedErrorMessage("engine-quota", "5-hour usage limit", "en", "kimi")).toBe(
      "Error: Kimi's current 5-hour usage quota is exhausted. Wait for the usage window to reset, or purchase extra usage/upgrade; signing in again or restarting will not help.",
    );
    expect(
      renderCategorizedErrorMessage(
        "auth",
        "error getting token source: You are not logged into Antigravity.",
        "en",
        "antigravity",
      ),
    ).toBe(
      "Error: Antigravity authentication is missing or expired. Open Antigravity CLI locally, sign in again, then retry this Telegram turn.",
    );
    expect(renderCategorizedErrorMessage("telegram-conflict", "409 conflict")).toBe(
      "Error: Another Telegram poller is using this bot token. Stop the duplicate service and retry.",
    );
    expect(renderCategorizedErrorMessage("telegram-delivery", "sendMessage failed")).toBe(
      "Error: Telegram delivery is temporarily unavailable. Retry the request or try again later.",
    );
    expect(
      renderCategorizedErrorMessage(
        "telegram-delivery",
        "Telegram API request failed for sendMessage: Bad Request: can't parse entities: Can't find end of Italic entity",
      ),
    ).toBe(
      "Error: Telegram rejected the reply formatting. The detailed parse error has been logged; retry the request or inspect the logs.",
    );
    expect(renderCategorizedErrorMessage("engine-cli", "engine failed to start")).toBe(
      "Error: The engine runtime failed. Restart the instance and retry.",
    );
    expect(
      renderCategorizedErrorMessage(
        "engine-cli",
        "flags provided but not defined: -model",
        "en",
        "antigravity",
      ),
    ).toBe(
      "Error: Antigravity rejected a CLI startup flag. Update agy or remove the unsupported bridge setting, then retry.",
    );
    expect(
      renderCategorizedErrorMessage(
        "engine-cli",
        "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
      ),
    ).toBe(
      [
        "Error: The engine runtime failed. Restart the instance and retry.",
        "Details: Codex transport stream disconnected while calling chatgpt.com/backend-api/codex/responses. The previous turn failed before producing a final answer; this does not identify a browser or image-generation task by itself.",
      ].join("\n"),
    );
    expect(
      renderCategorizedErrorMessage(
        "engine-cli",
        "stream disconnected before completion",
        "en",
        "claude",
      ),
    ).toBe(
      [
        "Error: The engine runtime failed. Restart the instance and retry.",
        "Details: Claude transport stream disconnected. The previous turn failed before producing a final answer; this does not identify a browser or image-generation task by itself.",
      ].join("\n"),
    );
    expect(
      renderCategorizedErrorMessage(
        "engine-cli",
        "fetch failed for https://chatgpt.com/backend-api/codex/responses?access_token=secret",
      ),
    ).toContain("chatgpt.com/backend-api/codex/responses.");
    expect(
      renderCategorizedErrorMessage(
        "engine-cli",
        "fetch failed for https://chatgpt.com/backend-api/codex/responses?access_token=secret",
      ),
    ).not.toContain("secret");
    expect(
      renderCategorizedErrorMessage(
        "engine-cli",
        "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
        "zh",
      ),
    ).toBe(
      [
        "错误：引擎运行时失败，请重启实例后重试。",
        "详情：Codex 传输流在调用 chatgpt.com/backend-api/codex/responses 时断开。上一轮还没有生成最终回答就失败了；这本身不能说明是浏览器或生图任务失败。",
      ].join("\n"),
    );
    expect(renderCategorizedErrorMessage("file-workflow", "archive extraction failed")).toBe(
      "Error: File handling failed while preparing your request. Retry with a smaller or different file.",
    );
    expect(
      renderCategorizedErrorMessage(
        "file-workflow",
        "Telegram API request failed for getFile: Bad Request: file is too big",
      ),
    ).toBe(
      "Error: This attachment is too large for the current Telegram Bot API download path. Send a file under 20 MB, share a reachable link, or place the file in the bot workspace.",
    );
    expect(
      renderCategorizedErrorMessage(
        "file-workflow",
        "Telegram attachment is too large to download via Bot API: video lesson.mp4 is 27.5 MB",
        "zh",
      ),
    ).toBe(
      "错误：这个附件太大，当前 Telegram Bot API 不能下载到 bot 端。请压缩到 20MB 以内，或发可访问链接/把文件放到 bot workspace 后再让我读取。",
    );
    expect(renderCategorizedErrorMessage("workflow-state", "invalid file workflow state")).toBe(
      "Error: Internal workflow state is unavailable right now. Retry the request later or ask the operator to inspect the service state.",
    );
    expect(renderCategorizedErrorMessage("session-state", "session store unavailable")).toBe(
      "Error: Session state is unavailable right now. The operator needs to repair session state and retry.",
    );
    expect(renderCategorizedErrorMessage("unknown", "boom")).toBe(
      "Error: An unexpected failure occurred. Reset the chat or retry the request.",
    );
  });



  it("distinguishes unmetered engine turns from zero-token usage", () => {
    expect(renderUsageMessage({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostUsd: 0,
      requestCount: 0,
      unmeteredRequestCount: 2,
      lastUpdatedAt: "2026-05-26T00:00:00.000Z",
    }, "zh")).toContain("未返回 token 明细的请求：2");
    expect(renderUsageMessage({
      totalInputTokens: 11,
      totalOutputTokens: 7,
      totalCachedTokens: 3,
      totalCostUsd: 0.0012,
      requestCount: 1,
      unmeteredRequestCount: 1,
      lastUpdatedAt: "2026-05-26T00:00:00.000Z",
    }, "en")).toContain("Requests without token details: 1");
  });
});

describe("codex-fix review regressions (v0.1.205)", () => {
  it("prefers line boundaries when chunking plain prose", async () => {
    const { chunkReplyMessage } = await import("../src/runtime/message-renderer.js");
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${i}: ${"x".repeat(90)}`).join("\n");
    const chunks = chunkReplyMessage(lines, 1000);
    expect(chunks.join("")).toBe(lines);
    // v0.1.203's rewrite split mid-line; every boundary must now land between lines.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith("\n"), `chunk ended mid-line: …${JSON.stringify(chunk.slice(-20))}`).toBe(true);
    }
  });

  it("keeps code lines whole across fence-safe chunk boundaries", async () => {
    const { chunkReplyMessage } = await import("../src/runtime/message-renderer.js");
    const body = Array.from({ length: 40 }, (_, i) => `const v${i} = compute(${i});`).join("\n");
    const text = "```ts\n" + body + "\n```";
    const chunks = chunkReplyMessage(text, 400);
    // Reconstructed content (minus the re-open/close scaffolding) must contain
    // every line INTACT — no line split across two chunks.
    for (let i = 0; i < 40; i += 1) {
      const line = `const v${i} = compute(${i});`;
      expect(chunks.some((chunk) => chunk.includes(line)), `line ${i} was split`).toBe(true);
    }
  });
});
