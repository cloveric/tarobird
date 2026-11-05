import type { CoreBridgeLike } from "../src/core/types.js";
// Migrated for issue #48 from tests/service.test.ts (retired Telegram transport).
//
// The original cases reached these rules through handleNormalizedTelegramMessage /
// processTelegramUpdates. They now call the shared implementations the remaining
// paths use: runtime/file-workflow.ts (attachment + archive workflows),
// core/shared/session-commands.ts (/reset guards), and the Core message handler
// under its default compatibility channel profile (commands, access gates,
// delegation bookkeeping, workflow settlement). Telegram rendering, polling and
// callback-ack assertions stayed with the retired transport; see disposition.json.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderCoreUserFacingError } from "../src/core/errors.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { stableCoreNumericId } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { handleLocalSessionCoreCommand } from "../src/core/shared/session-commands.js";
import { classifyFailure } from "../src/runtime/error-classification.js";
import {
  boundArchiveSummary,
  FileWorkflowPreparationError,
  prepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow,
} from "../src/runtime/file-workflow.js";
import { SessionStateError } from "../src/runtime/session-manager.js";
import { FileWorkflowStore } from "../src/state/file-workflow-store.js";
import { JsonStore } from "../src/state/json-store.js";
import { SessionStore } from "../src/state/session-store.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import {
  createZipBuffer,
  expectLarkFinalAnswer,
  fakeChannel,
  fakeLarkMessage,
  type FakeLarkChannel,
} from "./helpers/core-compat-fixtures.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const CONTINUE_HINT_REPLY = "Reply \"继续分析\" or press Continue Analysis to continue this archive.";
const CONTINUE_HINT_BARE = "Bare /continue resumes the latest waiting archive.";
const TARGETED_RETRY_HINT = "Retry this specific archive from its original summary: press Continue Analysis again there or reply \"继续分析\" to that summary.";
const CORE_CHAT_ID = stableCoreNumericId("lark:oc_chat");
const CORE_USER_ID = stableCoreNumericId("user:ou_user");

afterEach(() => {
  vi.restoreAllMocks();
});

function replaceBufferContents(buffer: Buffer, search: string, replace: string): Buffer {
  const searchBytes = Buffer.from(search, "utf8");
  const replaceBytes = Buffer.from(replace, "utf8");

  if (searchBytes.length !== replaceBytes.length) {
    throw new Error("replacement must preserve byte length");
  }

  const patched = Buffer.from(buffer);
  let offset = 0;
  while (offset <= patched.length - searchBytes.length) {
    const foundAt = patched.indexOf(searchBytes, offset);
    if (foundAt === -1) {
      break;
    }

    replaceBytes.copy(patched, foundAt);
    offset = foundAt + searchBytes.length;
  }

  return patched;
}

/** Writes an uploaded file where a channel download would have left it. */
async function downloadedAttachment(root: string, fileName: string, contents: string | Buffer) {
  const localPath = path.join(root, "inbox", fileName);
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, contents);
  return { attachment: { fileId: `${fileName}-id`, fileName, kind: "document" as const }, localPath };
}

/** Archive workflow record in the persisted file-workflow.json shape. */
function archiveRecord(input: {
  uploadId: string;
  status: string;
  sourceFile: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  summaryMessageId?: number;
  chatId?: number;
  userId?: number;
}) {
  return {
    uploadId: input.uploadId,
    chatId: input.chatId ?? 123,
    userId: input.userId ?? 456,
    kind: "archive",
    status: input.status,
    sourceFiles: [input.sourceFile],
    derivedFiles: [],
    summary: input.summary,
    ...(input.summaryMessageId !== undefined ? { summaryMessageId: input.summaryMessageId } : {}),
    extractedPath: `workspace/.telegram-files/${input.uploadId}/extracted`,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

async function writeWorkflowRecords(root: string, records: unknown[]): Promise<void> {
  await writeFile(path.join(root, "file-workflow.json"), JSON.stringify({ records }), "utf8");
}

async function readWorkflowRecords(root: string): Promise<Array<{ uploadId: string; status: string; kind: string; summary: string }>> {
  return (JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
    records: Array<{ uploadId: string; status: string; kind: string; summary: string }>;
  }).records;
}

function sentPayloads(channel: FakeLarkChannel): string {
  return JSON.stringify([
    ...(channel.send.mock.calls as unknown[][]),
    ...((channel.updateCard?.mock?.calls as unknown[][] | undefined) ?? []),
  ]);
}

function markdownReplies(channel: FakeLarkChannel): string[] {
  return (channel.send.mock.calls as unknown[][])
    .map((call) => (call[1] as { markdown?: unknown } | undefined)?.markdown)
    .filter((value): value is string => typeof value === "string");
}

function allowAllBridge(handleAuthorizedMessage: ReturnType<typeof vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>> = vi.fn(async () => ({ text: "done" }))) {
  return {
    checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
    handleAuthorizedMessage,
  };
}

function commandMessage(text: string) {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

async function withIsolatedCodexHome<T>(run: () => Promise<T>): Promise<T> {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(codexHome, { recursive: true, force: true });
  }
}

describe("shared archive workflow rules", () => {
  it("persists a failed archive workflow record when extraction is rejected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));

    try {
      const preparation = prepareAttachmentWorkflow({
        stateDir: root,
        chatId: 123,
        userId: 456,
        text: "",
        downloadedAttachments: [await downloadedAttachment(root, "bad.zip", "not a zip archive")],
      });
      const error = await preparation.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FileWorkflowPreparationError);
      const records = await readWorkflowRecords(root);
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(expect.objectContaining({
        kind: "archive",
        status: "failed",
        extractedPath: expect.stringContaining(path.join("workspace", ".telegram-files")),
        sourceFiles: [expect.stringContaining(path.join("workspace", ".telegram-files"))],
        summary: expect.stringMatching(/invalid|zip|archive/i),
      }));
      expect((error as FileWorkflowPreparationError).workflowRecordId).toBe(records[0]!.uploadId);
      // Same user-facing category the retired transport rendered.
      expect(classifyFailure(error)).toBe("file-workflow");
      expect(renderCoreUserFacingError(error, "prepare", "en")).toBe("Error: file processing failed. Try a smaller or different file.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects archive entries that escape into a sibling prefix directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const placeholderEntryName = "xxxxxxxxxxxxxxxxxxxxxxxxxx";
    const zipBuffer = replaceBufferContents(
      createZipBuffer({
        [placeholderEntryName]: "escape attempt",
        "README.md": "# hello",
      }),
      placeholderEntryName,
      "../extracted-evil/file.txt",
    );

    try {
      await expect(prepareAttachmentWorkflow({
        stateDir: root,
        chatId: 123,
        userId: 456,
        text: "",
        downloadedAttachments: [await downloadedAttachment(root, "evil.zip", zipBuffer)],
      })).rejects.toBeInstanceOf(FileWorkflowPreparationError);

      const records = await readWorkflowRecords(root);
      expect(records[0]).toEqual(
        expect.objectContaining({
          kind: "archive",
          status: "failed",
          summary: expect.stringMatching(/escapes target directory/i),
        }),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("resumes the most recently updated waiting archive even when records are out of order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(root, [
      archiveRecord({
        uploadId: "archive-new",
        status: "awaiting_continue",
        sourceFile: "repo-new.zip",
        summary: "archive summary new",
        createdAt: "2026-04-10T00:05:00.000Z",
      }),
      archiveRecord({
        uploadId: "archive-old",
        status: "awaiting_continue",
        sourceFile: "repo-old.zip",
        summary: "archive summary old",
        createdAt: "2026-04-10T00:00:00.000Z",
      }),
    ]);

    try {
      const result = await prepareArchiveContinueWorkflow({ stateDir: root, chatId: 123, text: "/continue" });

      expect(result).toEqual(expect.objectContaining({
        kind: "direct",
        files: [],
        workflowRecordId: "archive-new",
        text: expect.stringContaining("archive summary new"),
      }));
      expect(result?.text).not.toContain("archive summary old");

      // The caller settles the claim after delivery (Core: settleProcessing in finally).
      await new FileWorkflowStore(root).settleProcessing("archive-new", "delivered");
      expect(await readWorkflowRecords(root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uploadId: "archive-new", status: "completed" }),
          expect.objectContaining({ uploadId: "archive-old", status: "awaiting_continue" }),
        ]),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects new uploads when three archives are already waiting for continuation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(root, [
      archiveRecord({ uploadId: "archive-1", status: "awaiting_continue", sourceFile: "repo-1.zip", summary: "archive summary one", createdAt: "2026-04-10T00:00:00.000Z" }),
      archiveRecord({ uploadId: "archive-2", status: "awaiting_continue", sourceFile: "repo-2.zip", summary: "archive summary two", createdAt: "2026-04-10T00:01:00.000Z" }),
      archiveRecord({ uploadId: "archive-3", status: "awaiting_continue", sourceFile: "repo-3.zip", summary: "archive summary three", createdAt: "2026-04-10T00:02:00.000Z" }),
    ]);

    try {
      // Core records only single-archive uploads as workflows, so the cap is
      // exercised through that branch (the original sent a .txt document).
      const result = await prepareAttachmentWorkflow({
        stateDir: root,
        chatId: 123,
        userId: 456,
        text: "analyze this archive",
        downloadedAttachments: [await downloadedAttachment(root, "repo-4.zip", createZipBuffer({ "README.md": "# hello" }))],
      });

      expect(result).toEqual({
        kind: "reply",
        text: "Too many active file tasks for this chat. Wait for current tasks to finish or use /reset.",
      });
      const records = await readWorkflowRecords(root);
      expect(records).toHaveLength(3);
      expect(records.every((record) => record.status === "awaiting_continue")).toBe(true);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("continues the explicitly targeted archive when multiple archives are waiting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(root, [
      archiveRecord({
        uploadId: "a0000000-0000-0000-0000-000000000001",
        status: "awaiting_continue",
        sourceFile: "repo.zip",
        summary: "archive summary one",
        createdAt: "2026-04-10T00:00:00.000Z",
      }),
      archiveRecord({
        uploadId: "b0000000-0000-0000-0000-000000000002",
        status: "awaiting_continue",
        sourceFile: "repo-2.zip",
        summary: "archive summary two",
        createdAt: "2026-04-10T00:01:00.000Z",
      }),
    ]);

    try {
      // The Telegram Continue Analysis callback normalized to exactly this command.
      const result = await prepareArchiveContinueWorkflow({
        stateDir: root,
        chatId: 123,
        text: "/continue --upload a0000000-0000-0000-0000-000000000001",
      });

      expect(result).toEqual(expect.objectContaining({
        kind: "direct",
        workflowRecordId: "a0000000-0000-0000-0000-000000000001",
        text: expect.stringContaining("[Archive Analysis Context]"),
        suppressReplyContext: false,
      }));
      expect(result?.text).toContain("archive summary one");
      expect(result?.text).not.toContain("archive summary two");
      expect(result?.text).not.toBe("/continue");
      expect(await readWorkflowRecords(root)).toEqual(expect.arrayContaining([
        expect.objectContaining({ uploadId: "a0000000-0000-0000-0000-000000000001", status: "processing" }),
        expect.objectContaining({ uploadId: "b0000000-0000-0000-0000-000000000002", status: "awaiting_continue" }),
      ]));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replies with an already-completed message when a replied summary targets a completed archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(root, [
      archiveRecord({
        uploadId: "a0000000-0000-0000-0000-000000000001",
        status: "completed",
        sourceFile: "repo.zip",
        summary: "archive summary one",
        summaryMessageId: 41,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:02:00.000Z",
      }),
      archiveRecord({
        uploadId: "b0000000-0000-0000-0000-000000000002",
        status: "awaiting_continue",
        sourceFile: "repo-2.zip",
        summary: "archive summary two",
        summaryMessageId: 42,
        createdAt: "2026-04-10T00:01:00.000Z",
      }),
    ]);

    try {
      await expect(prepareArchiveContinueWorkflow({
        stateDir: root,
        chatId: 123,
        text: "继续分析 看看结构",
        replyContext: { messageId: 41, text: "archive summary one" },
      })).resolves.toEqual({
        kind: "reply",
        text: "That archive has already completed continued analysis in this chat.",
      });
      // Core's Continue Analysis card action targets by upload id instead.
      await expect(prepareArchiveContinueWorkflow({
        stateDir: root,
        chatId: 123,
        text: "/continue --upload a0000000-0000-0000-0000-000000000001",
      })).resolves.toEqual({
        kind: "reply",
        text: "That archive has already completed continued analysis in this chat.",
      });
      // The other waiting archive was not claimed by the targeted requests.
      expect(await readWorkflowRecords(root)).toContainEqual(expect.objectContaining({
        uploadId: "b0000000-0000-0000-0000-000000000002",
        status: "awaiting_continue",
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replies with an already-processing message when the targeted continue is requested again mid-run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(root, [
      archiveRecord({
        uploadId: "a0000000-0000-0000-0000-000000000001",
        status: "processing",
        sourceFile: "repo.zip",
        summary: "archive summary one",
        summaryMessageId: 41,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      }),
    ]);

    try {
      await expect(prepareArchiveContinueWorkflow({
        stateDir: root,
        chatId: 123,
        text: "/continue --upload a0000000-0000-0000-0000-000000000001",
      })).resolves.toEqual({
        kind: "reply",
        text: "That archive is already being processed in this chat.",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("guides targeted archive retries back to the same summary after continuation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(root, [
      archiveRecord({
        uploadId: "a0000000-0000-0000-0000-000000000001",
        status: "awaiting_continue",
        sourceFile: "repo.zip",
        summary: "archive summary one",
        summaryMessageId: 41,
        createdAt: "2026-04-10T00:00:00.000Z",
      }),
    ]);
    const store = new FileWorkflowStore(root);

    try {
      const first = await prepareArchiveContinueWorkflow({
        stateDir: root,
        chatId: 123,
        text: "/continue --upload a0000000-0000-0000-0000-000000000001",
      });
      expect(first).toEqual(expect.objectContaining({ kind: "direct", failureHint: TARGETED_RETRY_HINT }));

      // The run failed: the caller settles the claim as failed and shows the hint.
      await store.settleProcessing("a0000000-0000-0000-0000-000000000001", "failed");
      expect(await readWorkflowRecords(root)).toContainEqual(expect.objectContaining({ status: "failed" }));

      // An explicit retry of the same archive is accepted and keeps the hint;
      // a bare continue does not broaden to the failed archive.
      await expect(prepareArchiveContinueWorkflow({ stateDir: root, chatId: 123, text: "/continue" })).resolves.toEqual({
        kind: "reply",
        text: "There is no archive waiting for continued analysis in this chat.",
      });
      const retry = await prepareArchiveContinueWorkflow({
        stateDir: root,
        chatId: 123,
        text: "/continue --upload a0000000-0000-0000-0000-000000000001",
      });
      expect(retry).toEqual(expect.objectContaining({
        kind: "direct",
        workflowRecordId: "a0000000-0000-0000-0000-000000000001",
        failureHint: TARGETED_RETRY_HINT,
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("fails closed for malformed targeted /continue --upload syntax instead of resuming the latest archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(root, [
      archiveRecord({
        uploadId: "a0000000-0000-0000-0000-000000000001",
        status: "awaiting_continue",
        sourceFile: "repo.zip",
        summary: "archive summary one",
        summaryMessageId: 41,
        createdAt: "2026-04-10T00:00:00.000Z",
      }),
    ]);

    try {
      await expect(prepareArchiveContinueWorkflow({ stateDir: root, chatId: 123, text: "/continue --upload" })).resolves.toEqual({
        kind: "reply",
        text: 'Malformed continue command. Use /continue, the Continue Analysis button, or reply "继续分析" to the archive summary.',
      });
      expect(await readWorkflowRecords(root)).toEqual([
        expect.objectContaining({ uploadId: "a0000000-0000-0000-0000-000000000001", status: "awaiting_continue" }),
      ]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("bounds a long archive summary before delivery with the continue hints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const manyFiles = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `src/feature-${String(index).padStart(3, "0")}/component-${String(index).padStart(3, "0")}.ts`,
        `export const value${index} = ${index};`,
      ]),
    );
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      ...manyFiles,
    });

    try {
      const result = await prepareAttachmentWorkflow({
        stateDir: root,
        chatId: 123,
        userId: 456,
        text: "",
        downloadedAttachments: [await downloadedAttachment(root, "repo.zip", zipBuffer)],
      });

      expect(result).toEqual(expect.objectContaining({ kind: "reply", workflowRecordId: expect.any(String) }));
      const delivered = boundArchiveSummary(result!.text);
      expect(delivered).toContain(CONTINUE_HINT_REPLY);
      expect(delivered).toContain(CONTINUE_HINT_BARE);
      expect(delivered.length).toBeLessThanOrEqual(3900);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not append an archive summary record in processing state before delivery succeeds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const appendSpy = vi.spyOn(FileWorkflowStore.prototype, "append");
    const limitedAppendSpy = vi.spyOn(FileWorkflowStore.prototype, "appendIfChatBelowActiveLimit");

    try {
      const result = await prepareAttachmentWorkflow({
        stateDir: root,
        chatId: 123,
        userId: 456,
        text: "",
        downloadedAttachments: [await downloadedAttachment(root, "repo.zip", zipBuffer)],
      });

      expect(appendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ status: "processing" }));
      expect(limitedAppendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ status: "processing" }), expect.anything());
      expect(limitedAppendSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "preparing", kind: "archive" }), 3);
      expect(await readWorkflowRecords(root)).toEqual([
        expect.objectContaining({ uploadId: result!.workflowRecordId, status: "awaiting_continue" }),
      ]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("classifies unreadable file-workflow state during archive continuation as an internal recovery error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(path.join(root, "file-workflow.json"), "{not valid json", "utf8");

    try {
      const error = await prepareArchiveContinueWorkflow({ stateDir: root, chatId: 123, text: "继续分析" })
        .catch((caught: unknown) => caught);

      expect(error).toEqual(expect.objectContaining({ message: "invalid file workflow state" }));
      expect(classifyFailure(error)).toBe("workflow-state");
      expect(renderCoreUserFacingError(error, "prepare", "en")).toBe(
        "Error: workflow state is unavailable. Retry later or ask an operator to check the service.",
      );
      expect(renderCoreUserFacingError(error, "prepare", "zh")).toBe("错误：工作流状态不可用，请稍后重试或让运维检查服务状态。");
      await expect(readFile(path.join(root, "file-workflow.json"), "utf8")).resolves.toBe("{not valid json");
    } finally {
      await removeTempRoot(root);
    }
  });
});

describe("shared /reset session-state guards", () => {
  async function runReset(root: string, sessionStore: SessionStore) {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const updateInstanceConfig = vi.fn();
    const error = await handleLocalSessionCoreCommand({
      stateDir: root,
      startedAt: Date.now() - 10,
      locale: "en",
      cfg: { engine: "codex" },
      normalized: commandMessage("/reset"),
      context: { api: api as never, instanceName: "default", updateId: 77 },
      sessionStore,
      updateInstanceConfig,
    }).then(() => undefined, (caught: unknown) => caught);
    return { api, updateInstanceConfig, error };
  }

  it("shows operator guidance when unreadable session state is encountered on /reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(path.join(root, "session.json"), "{not valid json", "utf8");

    try {
      const { api, updateInstanceConfig, error } = await runReset(root, new SessionStore(path.join(root, "session.json")));

      expect(error).toBeInstanceOf(SessionStateError);
      expect((error as SessionStateError).message).toBe(
        "Session state is unreadable right now. The operator needs to repair session state and retry.",
      );
      expect((error as SessionStateError).repairable).toBe(true);
      await expect(readFile(path.join(root, "session.json"), "utf8")).resolves.toBe("{not valid json");
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(updateInstanceConfig).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("shows operator guidance when /reset hits non-repairable session-state read failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const readSpy = vi.spyOn(JsonStore.prototype, "read");
    readSpy.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    try {
      const { api, error } = await runReset(root, new SessionStore(path.join(root, "session.json")));

      expect(error).toBeInstanceOf(SessionStateError);
      expect((error as SessionStateError).message).toBe(
        "Session state is unavailable right now. The operator needs to restore read access and retry.",
      );
      expect((error as SessionStateError).repairable).toBe(false);
      expect(api.sendMessage).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("keeps /reset on explicit session-state guidance when wrapped permission failures lose errno metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const inspectSpy = vi.spyOn(SessionStore.prototype, "inspect");
    inspectSpy.mockResolvedValueOnce({
      state: { chats: [] },
      warning: "session state unreadable",
      repairable: false,
    });

    try {
      const { api, error } = await runReset(root, new SessionStore(path.join(root, "session.json")));

      expect(error).toBeInstanceOf(SessionStateError);
      expect((error as SessionStateError).message).toBe(
        "Session state is unavailable right now. The operator needs to restore read access and retry.",
      );
      // Rendered as session state, never as a write-policy failure.
      expect(classifyFailure(error)).toBe("session-state");
      expect(api.sendMessage).not.toHaveBeenCalled();
    } finally {
      inspectSpy.mockRestore();
      await removeTempRoot(root);
    }
  });
});

describe("core service shared rules (compatibility profile)", () => {
  it("marks a continued archive as failed when engine execution fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeWorkflowRecords(stateDir, [
      archiveRecord({
        uploadId: "a0000000-0000-0000-0000-000000000001",
        status: "awaiting_continue",
        sourceFile: "repo.zip",
        summary: "archive summary one",
        createdAt: "2026-04-10T00:00:00.000Z",
        chatId: CORE_CHAT_ID,
        userId: CORE_USER_ID,
      }),
    ]);
    let inFlightStatus: string | undefined;
    const channel = fakeChannel();
    const bridge = allowAllBridge(vi.fn(async () => {
      inFlightStatus = (await readWorkflowRecords(stateDir))[0]?.status;
      throw new Error("engine failed during continuation");
    }));

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_continue_fail", content: "继续分析 看看结构" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(inFlightStatus).toBe("processing");
      expect((await readWorkflowRecords(stateDir))[0]?.status).toBe("failed");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not mark a continued archive completed until delivery fully succeeds", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n", "utf8");
    await writeWorkflowRecords(stateDir, [
      archiveRecord({
        uploadId: "a0000000-0000-0000-0000-000000000001",
        status: "awaiting_continue",
        sourceFile: "repo.zip",
        summary: "archive summary one",
        createdAt: "2026-04-10T00:00:00.000Z",
        chatId: CORE_CHAT_ID,
        userId: CORE_USER_ID,
      }),
    ]);
    const channel = fakeChannel({
      send: vi.fn(async (_chatId: string, payload: unknown) => {
        if (payload && typeof payload === "object" && "file" in payload) {
          throw new Error("file upload failed after response");
        }
        return { messageId: "sent_1" };
      }),
    });
    const bridge = allowAllBridge(vi.fn(async (input: { requestOutputDir?: string }) => {
      if (!input.requestOutputDir) {
        throw new Error("missing request output dir");
      }
      const reportPath = path.join(input.requestOutputDir, "report.txt");
      await writeFile(reportPath, "hello from workflow", "utf8");
      // Core delivers explicit artifact directives (the retired transport also
      // swept the output directory).
      return { text: `continuation complete\n[send-file:${reportPath}]` };
    }));

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_continue_delivery", content: "继续分析 并生成文件发给我" }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { file: expect.objectContaining({ fileName: "report.txt" }) },
        expect.anything(),
      );
      expect((await readWorkflowRecords(stateDir))[0]?.status).toBe("failed");
      expectLarkFinalAnswer(channel, "continuation complete");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns a concise status message for /status with blocking tasks called out separately", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }) + "\n", "utf8");
    await new SessionStore(path.join(stateDir, "session.json")).upsert({
      telegramChatId: CORE_CHAT_ID,
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-bound",
      status: "idle",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    const workflowRecord = (uploadId: string, kind: string, status: string, sourceFile: string, summary: string, at: string) => ({
      uploadId,
      chatId: CORE_CHAT_ID,
      userId: CORE_USER_ID,
      kind,
      status,
      sourceFiles: [sourceFile],
      derivedFiles: [],
      summary,
      createdAt: at,
      updatedAt: at,
    });
    await writeWorkflowRecords(stateDir, [
      workflowRecord("one", "document", "processing", "a.txt", "first", "2026-04-10T00:00:00.000Z"),
      workflowRecord("two", "archive", "preparing", "prep.zip", "preparing summary", "2026-04-10T00:00:30.000Z"),
      workflowRecord("three", "archive", "awaiting_continue", "b.zip", "second", "2026-04-10T00:01:00.000Z"),
      workflowRecord("four", "document", "failed", "c.txt", "third failed", "2026-04-10T00:02:00.000Z"),
      workflowRecord("five", "document", "completed", "d.txt", "fourth", "2026-04-10T00:03:00.000Z"),
    ]);
    const channel = fakeChannel();
    const bridge = allowAllBridge();

    try {
      await withIsolatedCodexHome(async () => await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_status_counts", content: "/status" }),
      }));

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("Engine: codex");
      expect(rendered).toContain("Session bound: yes");
      expect(rendered).toContain("Current thread: thread-bound");
      expect(rendered).toContain("Blocking workflows: 3");
      expect(rendered).toContain("Waiting workflows: 1");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("degrades /status when session and workflow state are unreadable", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }) + "\n", "utf8");
    await writeFile(path.join(stateDir, "session.json"), "{not valid json", "utf8");
    await writeFile(path.join(stateDir, "file-workflow.json"), "{not valid json", "utf8");
    const channel = fakeChannel();
    const bridge = allowAllBridge();

    try {
      await withIsolatedCodexHome(async () => await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_status_degraded", content: "/status" }),
      }));

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("Engine: codex");
      expect(rendered).toContain("Session bound: unknown (session state unreadable)");
      expect(rendered).toContain("Workflows: unknown (file workflow state unreadable)");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects /ultrareview on Codex engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const channel = fakeChannel();
    const bridge = allowAllBridge();

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_ultrareview_codex", content: "/ultrareview" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(sentPayloads(channel)).toContain("Claude");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports no data on /usage when usage.json is absent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const channel = fakeChannel();
    const bridge = allowAllBridge();

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_usage_empty", content: "/usage" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(markdownReplies(channel).join("\n")).toMatch(/No usage data yet|暂无用量数据/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders aggregate usage on /usage when data exists", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(
      path.join(stateDir, "usage.json"),
      JSON.stringify({
        totalInputTokens: 1234,
        totalOutputTokens: 567,
        totalCachedTokens: 89,
        totalCostUsd: 0.123,
        requestCount: 3,
        lastUpdatedAt: "2026-04-17T00:00:00.000Z",
      }),
      "utf8",
    );
    const channel = fakeChannel();
    const bridge = allowAllBridge();

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_usage_totals", content: "/usage" }),
      });

      const text = markdownReplies(channel).join("\n");
      expect(text).toContain("1,234");
      expect(text).toContain("567");
      expect(text).toContain("$0.1230");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("shows engine choices and applies /engine switches", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({ engine: "claude", model: "opus", locale: "en" }, null, 2) + "\n",
      "utf8",
    );
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    await sessionStore.upsert({
      telegramChatId: CORE_CHAT_ID,
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    await sessionStore.upsert({
      telegramChatId: 456,
      codexSessionId: "thread-other",
      status: "idle",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    const channel = fakeChannel();
    const bridge = allowAllBridge();
    const runtime = createCoreServiceRuntime();

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_engine_list", content: "/engine" }),
      });

      const listing = markdownReplies(channel).join("\n");
      expect(listing).toContain("Current engine: claude");
      expect(listing).toContain("Choose an engine with /engine <name>:");
      for (const engine of ["claude", "codex", "kimi", "deepseek", "antigravity"]) {
        expect(listing).toContain(`/engine ${engine}`);
      }

      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_engine_switch", content: "/engine codex" }),
      });

      const switched = markdownReplies(channel).at(-1);
      expect(switched).toContain("Engine set to codex.");
      expect(switched).toContain("cleared the previous model override");
      expect(switched).toContain("reset this instance's session bindings");
      const configText = await readFile(path.join(stateDir, "config.json"), "utf8");
      expect(configText).toContain('"engine": "codex"');
      expect(configText).not.toContain('"model"');
      await expect(sessionStore.findByChatId(CORE_CHAT_ID)).resolves.toBeNull();
      await expect(sessionStore.findByChatId(456)).resolves.toBeNull();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records usage for /btw turns", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const channel = fakeChannel();
    const bridge = allowAllBridge(vi.fn(async () => ({
      text: "side answer",
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cachedTokens: 3,
        costUsd: 0.42,
      },
    })));

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_btw_usage", content: "/btw side question" }),
      });

      const usage = JSON.parse(await readFile(path.join(stateDir, "usage.json"), "utf8"));
      expect(usage).toMatchObject({
        requestCount: 1,
        totalInputTokens: 12,
        totalOutputTokens: 7,
        totalCachedTokens: 3,
        totalCostUsd: 0.42,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks /btw when the budget is already exhausted", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ budgetUsd: 0.5 }), "utf8");
    await writeFile(
      path.join(stateDir, "usage.json"),
      JSON.stringify({
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCachedTokens: 0,
        totalCostUsd: 0.75,
        requestCount: 2,
        lastUpdatedAt: "2026-04-17T00:00:00.000Z",
      }),
      "utf8",
    );
    const channel = fakeChannel();
    const bridge = allowAllBridge();

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_btw_budget", content: "/btw side question" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(sentPayloads(channel)).toMatch(/Budget exhausted|预算已用尽/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records usage for the local /fan turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const channel = fakeChannel();
    const delegateToInstance = vi.fn(async () => ({
      success: true,
      text: "peer answer",
      fromInstance: "peer-bot",
    }));
    const bridge = allowAllBridge(vi.fn(async () => ({
      text: "local answer",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        cachedTokens: 4,
        costUsd: 0.8,
      },
    })));

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: ["peer-bot"],
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: ["peer-bot"],
              chain: [],
              verifier: null,
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        instanceName: "alpha",
        message: fakeLarkMessage({ messageId: "om_fan_usage", content: "/fan compare these answers" }),
      });

      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({ targetInstance: "peer-bot" }));
      const usage = JSON.parse(await readFile(path.join(stateDir, "usage.json"), "utf8"));
      expect(usage).toMatchObject({
        requestCount: 1,
        totalInputTokens: 20,
        totalOutputTokens: 10,
        totalCachedTokens: 4,
        totalCostUsd: 0.8,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records usage for the execute leg of /verify", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const channel = fakeChannel();
    const delegateToInstance = vi.fn(async () => ({
      success: true,
      text: "verification looks good",
      fromInstance: "reviewer",
    }));
    const bridge = allowAllBridge(vi.fn(async () => ({
      text: "implementation done",
      usage: {
        inputTokens: 30,
        outputTokens: 15,
        cachedTokens: 5,
        costUsd: 1.25,
      },
    })));

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: ["reviewer"],
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: [],
              chain: [],
              verifier: "reviewer",
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        instanceName: "alpha",
        message: fakeLarkMessage({ messageId: "om_verify_usage", content: "/verify fix this carefully" }),
      });

      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({ targetInstance: "reviewer" }));
      const usage = JSON.parse(await readFile(path.join(stateDir, "usage.json"), "utf8"));
      expect(usage).toMatchObject({
        requestCount: 1,
        totalInputTokens: 30,
        totalOutputTokens: 15,
        totalCachedTokens: 5,
        totalCostUsd: 1.25,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  async function expectResetBlockedByAccess(decision: { kind: "deny" | "reply"; text: string }): Promise<void> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await new SessionStore(path.join(stateDir, "session.json")).upsert({
      telegramChatId: CORE_CHAT_ID,
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    const before = await readFile(path.join(stateDir, "session.json"), "utf8");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => decision),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_reset_denied", content: "/reset" }),
      });

      expect(channel.send).toHaveBeenLastCalledWith(
        "oc_chat",
        { text: expect.stringContaining(decision.text) },
        expect.objectContaining({ replyTo: "om_reset_denied" }),
      );
      await expect(readFile(path.join(stateDir, "session.json"), "utf8")).resolves.toBe(before);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  it("does not reset session state when /reset is denied by access control", async () => {
    await expectResetBlockedByAccess({ kind: "deny", text: "This chat is not authorized for this instance." });
  });

  it("does not reset session state when /reset is blocked by pairing access control", async () => {
    await expectResetBlockedByAccess({ kind: "reply", text: "Pair this private chat with code ABC123" });
  });

  it("does not let unauthorized users probe approval commands", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async ({ userId }: { userId: number }) => (
        userId === CORE_USER_ID
          ? { kind: "allow" as const }
          : { kind: "deny" as const, text: "This chat is not authorized for this instance." }
      )),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_approve_probe", senderId: "ou_intruder", content: "/approve" }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "This chat is not authorized for this instance." },
        expect.objectContaining({ replyTo: "om_approve_probe" }),
      );
      expect(sentPayloads(channel)).not.toContain("No pending approval.");
      expect(sentPayloads(channel)).not.toContain("没有待处理的审批。");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders a write-permission error with recovery guidance", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const channel = fakeChannel();
    const bridge = allowAllBridge(vi.fn(async () => {
      throw new Error("write access denied");
    }));

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_write_denied", content: "hello" }),
      });

      expect(classifyFailure(new Error("write access denied"))).toBe("write-permission");
      expect(sentPayloads(channel)).toContain("错误：当前运行环境没有写入权限，请调整权限后重试。");
      expect(renderCoreUserFacingError(new Error("write access denied"), "engine", "en")).toBe(
        "Error: the current runtime cannot write to disk. Please adjust permissions and retry.",
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records an interrupted completion when /stop aborts an in-flight engine turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    const runtime = createCoreServiceRuntime();
    const channel = fakeChannel();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const bridge = allowAllBridge(vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(new Error("Task was stopped by user")), { once: true });
      });
      return { text: "unreachable" };
    }));

    try {
      const firstRun = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_first", content: "first" }),
      });
      await started;
      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_stop", content: "/stop" }),
      });
      await firstRun;

      const events = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        outcome: "interrupted",
      }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: "turn.completed", outcome: "error" }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured timeout override into engine turns", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-shared-rules-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", disableRuntimeTimeout: true }) + "\n", "utf8");
    const channel = fakeChannel();
    const bridge = allowAllBridge();

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_long_task", content: "long task" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({ disableRuntimeTimeout: true }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
