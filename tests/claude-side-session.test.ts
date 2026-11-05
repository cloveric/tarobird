import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { ClaudeSideQuestionChannel, boundedSideHistory, removeClaudeSessionResidue } from "../src/codex/claude-side-question.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const PARENT = "11111111-2222-4333-8444-555555555555";

class FakeStream extends EventEmitter { emitData(chunk: string) { this.emit("data", chunk); } }
class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) this.lines.push(text);
    callback?.(null);
    return true;
  }
}
class FakeChild extends EventEmitter {
  stdin = new FakeWritable(); stdout = new FakeStream(); stderr = new FakeStream();
  kill() { return true; }
  close(code: number | null) { this.emit("close", code); }
  frames() { return this.stdin.lines.map((line) => JSON.parse(line) as Record<string, any>); }
  emitJson(value: object) { this.stdout.emitData(JSON.stringify(value) + "\n"); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met in time");
}

function harness(childEnv?: NodeJS.ProcessEnv) {
  const children: FakeChild[] = [];
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const spawnFn = (_command: string, args: string[], options: { cwd?: string }) => {
    const child = new FakeChild(); children.push(child); calls.push({ args, cwd: options.cwd }); return child;
  };
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn: spawnFn as never, workspacePath: "/tmp/claude-side", ...(childEnv ? { childEnv } : {}) });
  return { adapter, children, calls };
}

const sideRequests = (child: FakeChild) => child.frames().filter((frame) => frame.type === "control_request" && frame.request?.subtype === "side_question");
const answer = (child: FakeChild, requestId: string, response: string | null) =>
  child.emitJson({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { response } } });

async function liveParent(h: ReturnType<typeof harness>) {
  const turn = h.adapter.sendUserMessage(PARENT, { text: "Long task", files: [] });
  await waitFor(() => h.children[0]?.stdin.lines.length === 1);
  const parent = h.children[0]!;
  parent.emitJson({ type: "system", subtype: "init", session_id: PARENT });
  return { turn, parent };
}

describe("Claude native side questions", () => {
  it("reports an honest native, concurrent, tool-less capability", () => {
    expect(harness().adapter.sideCapability()).toEqual({ context: "native", concurrent: true, readOnly: "no-tools", residue: "none", seesInProgressTurn: true, attachments: { images: false, files: "text", paths: false } });
  });

  it("refuses a logical parent ID without spawning anything", async () => {
    const h = harness();
    await expect(h.adapter.openSideSession({ sourceSessionId: "tarobot-9" })).rejects.toThrow("no_main_session");
    expect(h.children).toHaveLength(0);
  });

  it("asks the live parent worker alongside its turn, carries side history and never touches the turn", async () => {
    const h = harness();
    try {
      const { turn, parent } = await liveParent(h);
      const side = await h.adapter.openSideSession({ sourceSessionId: PARENT });
      const first = side.send({ text: "What is it doing?", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => sideRequests(parent).length === 1);
      const request = sideRequests(parent)[0]!;
      expect(request.request).toEqual({ subtype: "side_question", question: "What is it doing?" });
      // An unrelated response must not settle this side question.
      parent.emitJson({ type: "control_response", response: { subtype: "success", request_id: "other", response: { response: "wrong" } } });
      answer(parent, request.request_id, "Refactoring the parser.");
      await expect(first).resolves.toEqual({ text: "Refactoring the parser." });

      const second = side.send({ text: "Why?", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => sideRequests(parent).length === 2);
      expect(sideRequests(parent)[1]!.request.history).toEqual([{ question: "What is it doing?", response: "Refactoring the parser." }]);
      answer(parent, sideRequests(parent)[1]!.request_id, "Because tests failed.");
      await expect(second).resolves.toEqual({ text: "Because tests failed." });

      await side.dispose();
      expect(h.children).toHaveLength(1);
      parent.emitJson({ type: "result", result: "parent done", session_id: PARENT });
      await expect(turn).resolves.toMatchObject({ text: "parent done" });
      expect(parent.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    } finally { await h.adapter.destroy(); }
  });

  it("inlines side text attachments into the string question and its history, and refuses images and binaries", async () => {
    const h = harness();
    try {
      const { turn, parent } = await liveParent(h);
      const side = await h.adapter.openSideSession({ sourceSessionId: PARENT });
      const text = { attachmentId: "att_txt", path: "/private/side/1-log.txt", name: "log.txt", mime: "text/plain", size: 40, kind: "text" as const, text: "ERROR-MARKER-7 at line 3", partial: true };
      const first = side.send({ text: "What failed?", attachments: [text], onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => sideRequests(parent).length === 1);
      const question = sideRequests(parent)[0]!.request.question as string;
      expect(question).toMatch(/^What failed\?/);
      expect(question).toContain("ERROR-MARKER-7 at line 3");
      expect(question).toContain("Only the beginning of this file is available");
      expect(question).not.toContain("/private/side");
      answer(parent, sideRequests(parent)[0]!.request_id, "Line 3.");
      await expect(first).resolves.toEqual({ text: "Line 3." });
      const second = side.send({ text: "And then?", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => sideRequests(parent).length === 2);
      expect(sideRequests(parent)[1]!.request.history[0].question).toContain("ERROR-MARKER-7");
      answer(parent, sideRequests(parent)[1]!.request_id, "Nothing.");
      await second;
      for (const kind of ["image", "binary"] as const) {
        await expect(side.send({ text: "look", attachments: [{ ...text, kind, text: undefined }], onEngineEvent: () => {}, abortSignal: new AbortController().signal })).rejects.toThrow("attachment_unsupported");
      }
      expect(sideRequests(parent)).toHaveLength(2);
      await side.dispose();
      parent.emitJson({ type: "result", result: "parent done", session_id: PARENT });
      await turn;
    } finally { await h.adapter.destroy(); }
  });

  it("cancels only the side question with control_cancel_request", async () => {
    const h = harness();
    try {
      const { turn, parent } = await liveParent(h);
      const side = await h.adapter.openSideSession({ sourceSessionId: PARENT });
      const controller = new AbortController();
      const pending = side.send({ text: "Summarize", onEngineEvent: () => {}, abortSignal: controller.signal });
      await waitFor(() => sideRequests(parent).length === 1);
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
      const requestId = sideRequests(parent)[0]!.request_id;
      expect(parent.frames()).toContainEqual({ type: "control_cancel_request", request_id: requestId });
      // A late answer for the cancelled request is ignored and the parent continues.
      answer(parent, requestId, "late");
      parent.emitJson({ type: "result", result: "still running fine", session_id: PARENT });
      await expect(turn).resolves.toMatchObject({ text: "still running fine" });
      await side.dispose();
    } finally { await h.adapter.destroy(); }
  });

  it("uses an isolated unpersisted, tool-less fork when the parent has no live worker", async () => {
    const h = harness();
    try {
      const side = await h.adapter.openSideSession({ sourceSessionId: PARENT, workspaceOverride: "/tmp/other-workspace" });
      const pending = side.send({ text: "Recap", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => h.children.length === 1 && sideRequests(h.children[0]!).length === 1);
      const args = h.calls[0]!.args;
      expect(args).toEqual(expect.arrayContaining(["--resume", PARENT, "--fork-session", "--session-id", side.nativeId, "--no-session-persistence", "--restricted", "--strict-mcp-config", "--no-chrome"]));
      expect(args[args.indexOf("--tools") + 1]).toBe("");
      expect(args).not.toContain("-r");
      expect(h.calls[0]!.cwd).toBe("/tmp/other-workspace");
      const child = h.children[0]!;
      expect(child.frames().some((frame) => frame.type === "user")).toBe(false);
      // Any permission request on the fork is refused.
      child.emitJson({ type: "control_request", request_id: "perm", request: { subtype: "can_use_tool", tool_name: "Write" } });
      expect(child.frames()).toContainEqual({ type: "control_response", response: { subtype: "success", request_id: "perm", response: { behavior: "deny", message: "Side conversations are read-only." } } });
      answer(child, sideRequests(child)[0]!.request_id, "A recap.");
      await expect(pending).resolves.toEqual({ text: "A recap." });
      await side.dispose();
      await expect(side.send({ text: "again", onEngineEvent: () => {}, abortSignal: new AbortController().signal })).rejects.toThrow("expired");
    } finally { await h.adapter.destroy(); }
  });

  it("re-asks in an isolated fork when the parent worker exits under a side question", async () => {
    const h = harness();
    try {
      const { turn, parent } = await liveParent(h);
      void turn.catch(() => undefined);
      const side = await h.adapter.openSideSession({ sourceSessionId: PARENT });
      const pending = side.send({ text: "Status?", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => sideRequests(parent).length === 1);
      parent.close(1);
      await waitFor(() => h.children.length === 2 && sideRequests(h.children[1]!).length === 1);
      answer(h.children[1]!, sideRequests(h.children[1]!)[0]!.request_id, "Recovered answer");
      await expect(pending).resolves.toEqual({ text: "Recovered answer" });
      await side.dispose();
    } finally { await h.adapter.destroy(); }
  });

  it("maps a missing parent conversation to no_main_session", async () => {
    const h = harness();
    try {
      const side = await h.adapter.openSideSession({ sourceSessionId: PARENT });
      const pending = side.send({ text: "?", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => h.children.length === 1);
      h.children[0]!.stderr.emitData(`No conversation found with session ID: ${PARENT}\n`);
      h.children[0]!.close(1);
      await expect(pending).rejects.toThrow("no_main_session");
      await side.dispose();
    } finally { await h.adapter.destroy(); }
  });

  it("removes only the fork's own residue and never follows symbolic links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-side-residue-"));
    try {
      const fork = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await mkdir(path.join(root, "projects", "-tmp-a", fork), { recursive: true });
      await writeFile(path.join(root, "projects", "-tmp-a", `${fork}.jsonl`), "{}\n");
      await writeFile(path.join(root, "projects", "-tmp-a", `${PARENT}.jsonl`), "{}\n");
      await mkdir(path.join(root, "session-env", fork), { recursive: true });
      const outside = path.join(root, "outside.jsonl");
      await writeFile(outside, "keep\n");
      await mkdir(path.join(root, "projects", "-tmp-b"), { recursive: true });
      await symlink(outside, path.join(root, "projects", "-tmp-b", `${fork}.jsonl`));
      await expect(removeClaudeSessionResidue(root, fork)).resolves.toEqual([]);
      expect(await readdir(path.join(root, "projects", "-tmp-a"))).toEqual([`${PARENT}.jsonl`]);
      expect(await readdir(path.join(root, "session-env"))).toEqual([]);
      expect(await readdir(path.join(root, "projects", "-tmp-b"))).toEqual([`${fork}.jsonl`]);
      await removeClaudeSessionResidue(root, "../../etc");
      expect(await readdir(root)).toEqual(expect.arrayContaining(["outside.jsonl", "projects", "session-env"]));
    } finally { await removeTempRoot(root); }
  });

  it("bounds side history and reports error responses", async () => {
    expect(boundedSideHistory(Array.from({ length: 45 }, (_, i) => ({ question: `q${i}`, response: "r" })))).toHaveLength(40);
    expect(boundedSideHistory([{ question: "a".repeat(150_000), response: "" }, { question: "b".repeat(100_000), response: "" }])).toHaveLength(1);
    const written: any[] = [];
    const channel = new ClaudeSideQuestionChannel((payload) => written.push(payload));
    const pending = channel.ask({ question: "q", history: [], signal: new AbortController().signal });
    expect(channel.handle({ type: "control_response", response: { subtype: "error", request_id: written[0].request_id, error: "Side questions are unavailable" } })).toBe(true);
    await expect(pending).rejects.toThrow("Side questions are unavailable");
    const empty = channel.ask({ question: "q", history: [], signal: new AbortController().signal });
    expect(channel.handle({ type: "control_request_progress", request_id: written[1].request_id })).toBe(true);
    channel.handle({ type: "control_response", response: { subtype: "success", request_id: written[1].request_id, response: { response: null } } });
    await expect(empty).rejects.toThrow("no side answer");
  });
});
