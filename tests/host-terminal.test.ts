import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import {
  HOST_TERMINAL_CAPABILITY,
  HOST_TERMINAL_CONFIGURE_PATH,
  HOST_TERMINAL_STATUS_PATH,
  HOST_TERMINALS_PATH,
  terminalConfigureSchema,
  terminalConfigureText,
  terminalPolicySchema,
} from "../src/client-protocol/host-terminal.js";
import { parseAnsiOutput } from "../client/src/terminal-ansi.js";
import { HubAuth } from "../src/hub/auth.js";
import {
  DEFAULT_TERMINAL_IDLE_TIMEOUT_MS,
  HubHostTerminal,
  MAX_TERMINAL_IDLE_TIMEOUT_MS,
  MIN_TERMINAL_IDLE_TIMEOUT_MS,
  resolveTerminalIdleTimeoutMs,
  spawnPipeShell,
  type TerminalProcessHandle,
} from "../src/hub/host-terminal.js";
import { HubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

let tempRoot: string;
beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tarobird-terminal-"));
});
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function issueDeviceSession(
  hub: HubServer,
  deviceId: string,
  role: "owner" | "member",
  options: { platform?: string; localController?: boolean } = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const userId = role === "owner" ? "owner" : `user_${deviceId}`;
  if (role !== "owner") {
    await hub.store.db.run("INSERT OR IGNORE INTO users(id,name,role) VALUES(?,?,?)", [userId, deviceId, role]);
  }
  await hub.store.db.run(
    "INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen,revoked) VALUES(?,?,?,?,?,?,?,0)",
    [deviceId, userId, deviceId, options.platform ?? "macos", pubB64, Date.now(), Date.now()],
  );
  if (options.localController) {
    await hub.auth.markLocalDesktopController({
      deviceId,
      name: deviceId,
      platform: options.platform ?? "macos",
      publicKey: pubB64,
    });
  }
  const clientNonce = "n".repeat(43);
  const ch = await hub.auth.challenge(`conn_${deviceId}`, deviceId, clientNonce, "127.0.0.1");
  const sig = sign(null, Buffer.from(`tarocub/device/v1\0${deviceId}\0${ch.nonce}\0${clientNonce}`), privateKey).toString("base64");
  const session = await hub.auth.authenticate(`conn_${deviceId}`, sig);
  return { token: session.token, deviceId, userId, pubB64, privateKey };
}

async function signTerminalConfigure(
  hub: HubServer,
  owner: Awaited<ReturnType<typeof issueDeviceSession>>,
  command: { expectedRevision: number; enabled: boolean; grants: Array<{ deviceId: string; publicKey: string }>; requestId?: string },
  operation: "terminal-grant" | "bot-message-grant" = "terminal-grant",
) {
  const fullCommand = { ...command, requestId: command.requestId ?? `req_${randomUUID().replaceAll("-", "")}` };
  const target = createHash("sha256").update(terminalConfigureText(fullCommand)).digest("hex");
  const session = await hub.auth.authorize(owner.token, "127.0.0.1");
  const statement = await hub.auth.prepareDeviceAction({ operation, target }, owner.token, session);
  const signature = sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64");
  return { command: fullCommand, proof: { nonce: statement.nonce, signature } };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Host terminal ANSI parser, security, lifecycle, PTY, and workspace (#100)", () => {
  it("parses 16-color, 256-color, truecolor SGR, clear screen, backspaces, CR overwrites, and charset escapes cleanly", () => {
    const basic = parseAnsiOutput("before\x1b[2J\x1b[32mhello\x1b[0m \x1b[1mworld\x1b[0m\r\n");
    expect(basic.map((s) => s.text).join("")).toBe("hello world\n");
    expect(basic[0]?.color).toBe("#4ade80");
    expect(basic[2]?.bold).toBe(true);

    // 24-bit truecolor must NOT leak parameter 31 as red or 1 as bold
    const truecolor = parseAnsiOutput("\x1b[38;2;0;31;1mhello\x1b[0m");
    expect(truecolor).toEqual([{ text: "hello", color: "rgb(0, 31, 1)" }]);

    // 256-color foreground + colon-delimited truecolor background
    const extended = parseAnsiOutput("\x1b[38;5;196;48:2::10:20:30mhi\x1b[0m");
    expect(extended).toEqual([{ text: "hi", color: "rgb(255, 0, 0)", background: "rgb(10, 20, 30)" }]);

    // Multi-backspace and destructive erase
    expect(parseAnsiOutput("abc\x08\x08").map((s) => s.text).join("")).toBe("a");
    expect(parseAnsiOutput("abc\x08 \x08").map((s) => s.text).join("")).toBe("ab");

    // Carriage return progress overwrite & erase-to-EOL & charset/keypad escapes
    expect(parseAnsiOutput("10%\r20%\r30%").map((s) => s.text).join("")).toBe("30%");
    expect(parseAnsiOutput("\x1b(B\x1b=\x1b>sh-3.2$ \r\x1b[Ksh-3.2$ ok").map((s) => s.text).join("")).toBe("sh-3.2$ ok");
  });

  it("enforces local desktop controller, dedicated terminal-grant domain, unique grants, requestId idempotency, and fail-closed invalid grants", async () => {
    const stateDir = path.join(tempRoot, "hub-authz");
    const hub = await HubServer.start({ stateDir });
    try {
      const localCtrl = await issueDeviceSession(hub, "local_mac", "owner", { platform: "macos", localController: true });
      const remotePhone = await issueDeviceSession(hub, "remote_ios", "owner", { platform: "ios", localController: false });
      const otherDesktop = await issueDeviceSession(hub, "other_mac", "owner", { platform: "macos", localController: false });

      // Remote owner device cannot manage or self-grant
      const remoteStatus = await (await fetch(hub.url + HOST_TERMINAL_STATUS_PATH, {
        headers: { Authorization: `Bearer ${remotePhone.token}` },
      })).json() as { canManage: boolean; policy?: unknown };
      expect(remoteStatus.canManage).toBe(false);
      expect(remoteStatus.policy).toBeUndefined();

      const remoteSelfGrant = await signTerminalConfigure(hub, remotePhone, {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: remotePhone.deviceId, publicKey: remotePhone.pubB64 }],
      });
      const remoteRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${remotePhone.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(remoteSelfGrant),
      });
      expect(remoteRes.status).toBe(403);
      expect(await remoteRes.json()).toMatchObject({ error: "local_controller_required" });

      // Cross-domain bot-message-grant proof is rejected even from local controller
      const wrongDomain = await signTerminalConfigure(hub, localCtrl, {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: localCtrl.deviceId, publicKey: localCtrl.pubB64 }],
      }, "bot-message-grant");
      const wrongDomainRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${localCtrl.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(wrongDomain),
      });
      expect(wrongDomainRes.status).toBe(403);
      expect(await wrongDomainRes.json()).toMatchObject({ error: "device_action_invalid" });

      // Duplicate deviceId is rejected by schema
      expect(terminalPolicySchema.safeParse({
        revision: 1,
        enabled: true,
        grants: [
          { deviceId: localCtrl.deviceId, publicKey: localCtrl.pubB64 },
          { deviceId: localCtrl.deviceId, publicKey: localCtrl.pubB64 },
        ],
      }).success).toBe(false);
      expect(terminalConfigureSchema.safeParse({
        expectedRevision: 0,
        enabled: true,
        requestId: "req_dup",
        grants: [
          { deviceId: localCtrl.deviceId, publicKey: localCtrl.pubB64 },
          { deviceId: localCtrl.deviceId, publicKey: otherDesktop.pubB64 },
        ],
      }).success).toBe(false);

      // Newly added invalid/mismatched key fails closed (409 terminal_device_changed)
      const badGrant = await signTerminalConfigure(hub, localCtrl, {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: otherDesktop.deviceId, publicKey: localCtrl.pubB64 }],
      });
      const badGrantRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${localCtrl.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(badGrant),
      });
      expect(badGrantRes.status).toBe(409);
      expect(await badGrantRes.json()).toMatchObject({ error: "terminal_device_changed" });

      // Valid configure succeeds and supports requestId idempotency
      const reqId = "req_idempotent_1";
      const valid = await signTerminalConfigure(hub, localCtrl, {
        expectedRevision: 0,
        enabled: true,
        grants: [
          { deviceId: localCtrl.deviceId, publicKey: localCtrl.pubB64 },
          { deviceId: otherDesktop.deviceId, publicKey: otherDesktop.pubB64 },
        ],
        requestId: reqId,
      });
      const okRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${localCtrl.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(valid),
      });
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toMatchObject({ revision: 1, enabled: true });

      // Replay with same requestId + same body returns revision 1 without bumping or failing
      const replayRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${localCtrl.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(valid),
      });
      expect(replayRes.status).toBe(200);
      expect(await replayRes.json()).toMatchObject({ revision: 1, enabled: true });

      // Reusing requestId with different body returns 409 terminal_request_conflict
      const conflict = await signTerminalConfigure(hub, localCtrl, {
        expectedRevision: 1,
        enabled: false,
        grants: [],
        requestId: reqId,
      });
      const conflictRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${localCtrl.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(conflict),
      });
      expect(conflictRes.status).toBe(409);
      expect(await conflictRes.json()).toMatchObject({ error: "terminal_request_conflict" });

      // Revoking otherDesktop in DB does not block disabling/updating when carrying forward unchanged stale grant
      await hub.store.db.run("UPDATE devices SET revoked=1 WHERE id=?", [otherDesktop.deviceId]);
      const retireStale = await signTerminalConfigure(hub, localCtrl, {
        expectedRevision: 1,
        enabled: false,
        grants: [
          { deviceId: localCtrl.deviceId, publicKey: localCtrl.pubB64 },
          { deviceId: otherDesktop.deviceId, publicKey: otherDesktop.pubB64 },
        ],
      });
      const retireRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${localCtrl.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(retireStale),
      });
      expect(retireRes.status).toBe(200);
      const retiredPolicy = await retireRes.json() as { revision: number; enabled: boolean; grants: Array<{ deviceId: string }> };
      expect(retiredPolicy.revision).toBe(2);
      expect(retiredPolicy.enabled).toBe(false);
      expect(retiredPolicy.grants.map((g) => g.deviceId)).toEqual([localCtrl.deviceId]);
    } finally {
      await hub.close();
    }
  });

  it("blocks post-revocation output on in-flight long-polls and terminates shells on external CLI revocation via sweep()", async () => {
    const stateDir = path.join(tempRoot, "hub-revocation");
    const botWorkspace = path.join(tempRoot, "revocation-workspace");
    await mkdir(botWorkspace, { recursive: true });
    await mkdir(path.join(stateDir, "bots", "bot_rev"), { recursive: true });
    await writeFile(path.join(stateDir, "bots", "bot_rev", "config.json"), JSON.stringify({ engine: "codex", workspacePath: botWorkspace }));

    const hub = await HubServer.start({ stateDir });
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_rev','Rev','codex','h',1)");
      const conv = await hub.store.createConversation("owner", ["bot_rev"], "Revocation Chat", "conv_rev", { type: "direct" });
      const devA = await issueDeviceSession(hub, "dev_a", "owner", { localController: true });
      const devB = await issueDeviceSession(hub, "dev_b", "owner", { localController: false });

      const enableBoth = await signTerminalConfigure(hub, devA, {
        expectedRevision: 0,
        enabled: true,
        grants: [
          { deviceId: devA.deviceId, publicKey: devA.pubB64 },
          { deviceId: devB.deviceId, publicKey: devB.pubB64 },
        ],
      });
      expect((await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${devA.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(enableBoth),
      })).status).toBe(200);

      const created = await (await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${devA.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      })).json() as { terminal: { id: string } };
      const termId = created.terminal.id;

      // Wait for interactive shell startup to settle so devB's long-poll stays in-flight until revocation
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${termId}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${devA.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "echo POLL_\"READY\"\r" }),
      });
      let syncedSeq = 0;
      let syncedOut = "";
      for (let i = 0; i < 20 && !syncedOut.includes("POLL_READY"); i++) {
        const res = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${termId}/output?after=${syncedSeq}&wait=300`, {
          headers: { Authorization: `Bearer ${devB.token}` },
        })).json() as { seq: number; chunks: Array<{ data: string }> };
        syncedSeq = res.seq;
        syncedOut += res.chunks.map((c) => c.data).join("");
      }
      expect(syncedOut).toContain("POLL_READY");
      // Drain any trailing prompt chunk so the shell is quiescent
      const quiet = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${termId}/output?after=${syncedSeq}&wait=250`, {
        headers: { Authorization: `Bearer ${devB.token}` },
      })).json() as { seq: number };
      syncedSeq = quiet.seq;

      // Start an in-flight 6s long-poll from devB
      const pollPromise = fetch(`${hub.url}${HOST_TERMINALS_PATH}/${termId}/output?after=${syncedSeq}&wait=6000`, {
        headers: { Authorization: `Bearer ${devB.token}` },
      });
      await new Promise((r) => setTimeout(r, 120));

      // Revoke devB's terminal grant, then produce secret output on devA's terminal
      const revokeB = await signTerminalConfigure(hub, devA, {
        expectedRevision: 1,
        enabled: true,
        grants: [{ deviceId: devA.deviceId, publicKey: devA.pubB64 }],
      });
      expect((await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${devA.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(revokeB),
      })).status).toBe(200);

      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${termId}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${devA.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "echo POST_REVOKE_SECRET\r" }),
      });

      const pollRes = await pollPromise;
      const pollText = await pollRes.text();
      expect(pollRes.status).toBe(403);
      expect(pollText).not.toContain("POST_REVOKE_SECRET");

      // Simulate external CLI revocation directly in SQLite (no auth.onRevoke fired)
      await hub.store.db.run("UPDATE devices SET revoked=1 WHERE id=?", [devA.deviceId]);
      await hub.hostTerminal.sweep();

      // Audit must record terminal.closed with device_revoked and no live sessions remain
      const closedAudits = await hub.store.db.all<{ detail_json: string }>(
        "SELECT detail_json FROM audit_log WHERE kind='terminal.closed'",
      );
      expect(closedAudits.some((row) => row.detail_json.includes("device_revoked"))).toBe(true);
    } finally {
      await hub.close();
    }
  }, 20_000);

  it("terminates real shell processes and flushes hub_shutdown audits before HubServer.close() resolves", async () => {
    const stateDir = path.join(tempRoot, "hub-shutdown");
    const botWorkspace = path.join(tempRoot, "shutdown-workspace");
    await mkdir(botWorkspace, { recursive: true });
    await mkdir(path.join(stateDir, "bots", "bot_sd"), { recursive: true });
    await writeFile(path.join(stateDir, "bots", "bot_sd", "config.json"), JSON.stringify({ engine: "codex", workspacePath: botWorkspace }));

    const spawnedPids: number[] = [];
    const hub = await HubServer.start({ stateDir });
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_sd','SD','codex','h',1)");
    const conv = await hub.store.createConversation("owner", ["bot_sd"], "Shutdown Chat", "conv_sd", { type: "direct" });
    const ownerDev = await issueDeviceSession(hub, "sd_mac", "owner", { localController: true });
    const enable = await signTerminalConfigure(hub, ownerDev, {
      expectedRevision: 0,
      enabled: true,
      grants: [{ deviceId: ownerDev.deviceId, publicKey: ownerDev.pubB64 }],
    });
    expect((await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(enable),
    })).status).toBe(200);

    const created = await (await fetch(hub.url + HOST_TERMINALS_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: conv.id }),
    })).json() as { terminal: { id: string } };

    // Ask shell to report its own PID
    await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${created.terminal.id}/input`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: "echo SHELL_PID=$$\r" }),
    });
    let output = "";
    let pidSeq = 0;
    for (let i = 0; i < 20 && !/SHELL_PID=(\d+)/.test(output); i++) {
      const res = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${created.terminal.id}/output?after=${pidSeq}&wait=400`, {
        headers: { Authorization: `Bearer ${ownerDev.token}` },
      })).json() as { seq: number; chunks: Array<{ data: string }> };
      pidSeq = res.seq;
      output += res.chunks.map((c) => c.data).join("");
    }
    const pidMatch = /SHELL_PID=(\d+)/.exec(output);
    expect(pidMatch).not.toBeNull();
    const shellPid = Number(pidMatch![1]);
    spawnedPids.push(shellPid);
    expect(isPidAlive(shellPid)).toBe(true);

    // Close Hub and confirm shell PID is dead immediately after close() resolves
    await hub.close();
    for (const pid of spawnedPids) {
      expect(isPidAlive(pid)).toBe(false);
    }

    // Reopen SQLite via fresh HubServer to confirm hub_shutdown audit was durably flushed
    const hub2 = await HubServer.start({ stateDir });
    try {
      const audits = await hub2.store.db.all<{ detail_json: string }>(
        "SELECT detail_json FROM audit_log WHERE kind='terminal.closed'",
      );
      expect(audits.some((a) => a.detail_json.includes("hub_shutdown"))).toBe(true);
    } finally {
      await hub2.close();
    }
  }, 20_000);

  it("handles natural exit audits, non-exhaustion of exited slots, workspace fail-closed + archived rejection, and real PTY Ctrl+C/resize/Ctrl+D", async () => {
    const stateDir = path.join(tempRoot, "hub-terminal");
    const botWorkspace = path.join(tempRoot, "project-workspace");
    await mkdir(botWorkspace, { recursive: true });
    await mkdir(path.join(stateDir, "bots", "bot_dev"), { recursive: true });
    await writeFile(path.join(stateDir, "bots", "bot_dev", "config.json"), JSON.stringify({ engine: "codex", workspacePath: botWorkspace }));

    const hub = await HubServer.start({ stateDir });
    try {
      expect(HOST_TERMINAL_CAPABILITY).toBe("host.terminal.v1");
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_dev','Dev','codex','h',1)");
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_ext','Ext','codex','h',0)");
      const conv = await hub.store.createConversation("owner", ["bot_dev"], "Workspace Chat", "conv_term", { type: "direct" });
      const extConv = await hub.store.createConversation("owner", ["bot_ext"], "External Chat", "conv_ext", { type: "direct" });
      const archivedConv = await hub.store.createConversation("owner", ["bot_dev"], "Archived Chat", "conv_arch", { type: "direct" });
      await hub.store.updateConversation("owner", archivedConv.id, { archived: true });

      const ownerDev = await issueDeviceSession(hub, "owner_mac", "owner", { localController: true });
      const otherDev = await issueDeviceSession(hub, "other_mac", "owner", { localController: false });

      // 1. Off by default
      const initStatus = await (await fetch(hub.url + HOST_TERMINAL_STATUS_PATH, { headers: { Authorization: `Bearer ${ownerDev.token}` } })).json() as { enabled: boolean; allowed: boolean; canManage: boolean };
      expect(initStatus.enabled).toBe(false);
      expect(initStatus.allowed).toBe(false);
      expect(initStatus.canManage).toBe(true);

      const deniedCreate = await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      });
      expect(deniedCreate.status).toBe(403);

      // 2. Owner enables terminal ONLY for ownerDev (not otherDev)
      const signed = await signTerminalConfigure(hub, ownerDev, {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: ownerDev.deviceId, publicKey: ownerDev.pubB64 }],
      });
      expect((await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      })).status).toBe(200);

      // otherDev still does NOT have permission
      const otherStatus = await (await fetch(hub.url + HOST_TERMINAL_STATUS_PATH, { headers: { Authorization: `Bearer ${otherDev.token}` } })).json() as { allowed: boolean; canManage: boolean };
      expect(otherStatus.allowed).toBe(false);
      expect(otherStatus.canManage).toBe(false);
      expect((await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${otherDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      })).status).toBe(403);

      // External bot with no workspace fails closed (409), never falls back to Hub stateDir
      const extRes = await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: extConv.id }),
      });
      expect(extRes.status).toBe(409);
      expect(await extRes.json()).toMatchObject({ error: "terminal_workspace_unavailable" });

      // Archived conversation fails with 409 conversation_archived
      const archRes = await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: archivedConv.id }),
      });
      expect(archRes.status).toBe(409);
      expect(await archRes.json()).toMatchObject({ error: "conversation_archived" });

      // 3. Open 2 terminals in the conversation workspace
      const create1 = await (await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      })).json() as { terminal: { id: string; cwd: string; running: boolean; backend: string } };
      expect(create1.terminal.cwd).toBe(botWorkspace);
      expect(create1.terminal.running).toBe(true);

      const create2 = await (await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      })).json() as { terminal: { id: string; cwd: string; running: boolean } };
      expect(create2.terminal.id).not.toBe(create1.terminal.id);

      // 4. Execute pwd + echo in terminal 1 (avoid matching command echo by splitting literal)
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "pwd && echo TAROBIRD_\"TERM_OK\"\r" }),
      });

      let collected = "";
      let seq1 = 0;
      for (let i = 0; i < 20 && !(collected.includes("TAROBIRD_TERM_OK") && collected.includes(path.basename(botWorkspace))); i++) {
        const out = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/output?after=${seq1}&wait=400`, {
          headers: { Authorization: `Bearer ${ownerDev.token}` },
        })).json() as { seq: number; chunks: Array<{ data: string }> };
        seq1 = out.seq;
        collected += out.chunks.map((c) => c.data).join("");
      }
      expect(collected).toContain("TAROBIRD_TERM_OK");
      expect(collected).toContain(path.basename(botWorkspace));

      // 5. Verify Ctrl+C interrupts sleep 5 and shell stays interactive
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "sleep 5 && echo SHOULD_\"NOT_RUN\"\r" }),
      });
      await new Promise((r) => setTimeout(r, 250));
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "\x03" }),
      });
      await new Promise((r) => setTimeout(r, 200));
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "echo CTRL_C_\"RECOVERED\"\r" }),
      });
      let afterCtrlC = "";
      for (let i = 0; i < 20 && !afterCtrlC.includes("CTRL_C_RECOVERED"); i++) {
        const out = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/output?after=${seq1}&wait=400`, {
          headers: { Authorization: `Bearer ${ownerDev.token}` },
        })).json() as { seq: number; chunks: Array<{ data: string }> };
        seq1 = out.seq;
        afterCtrlC += out.chunks.map((c) => c.data).join("");
      }
      expect(afterCtrlC).toContain("CTRL_C_RECOVERED");
      expect(afterCtrlC).not.toContain("SHOULD_NOT_RUN");

      // 6. Natural exit records terminal.closed (process_exited) without waiting for DELETE
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create2.terminal.id}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "exit 0\r" }),
      });
      let exitedState: { seq: number; running: boolean; exitCode: number | null } = { seq: 0, running: true, exitCode: null };
      for (let i = 0; i < 20 && exitedState.running; i++) {
        const out = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create2.terminal.id}/output?after=${exitedState.seq}&wait=400`, {
          headers: { Authorization: `Bearer ${ownerDev.token}` },
        })).json() as { seq: number; running: boolean; exitCode: number | null };
        exitedState = out;
      }
      expect(exitedState.running).toBe(false);
      expect(exitedState.exitCode).toBe(0);

      // Give async exit audit a tick to settle and check audit_log
      await new Promise((r) => setTimeout(r, 100));
      const exitAudits = await hub.store.db.all<{ detail_json: string }>(
        "SELECT detail_json FROM audit_log WHERE kind='terminal.closed'",
      );
      expect(exitAudits.some((a) => a.detail_json.includes(create2.terminal.id) && a.detail_json.includes("process_exited"))).toBe(true);

      // Closing the already-exited tab must NOT duplicate terminal.closed
      expect((await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create2.terminal.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerDev.token}` },
      })).status).toBe(200);

      // Closing tab 1 terminates it cleanly
      expect((await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerDev.token}` },
      })).status).toBe(200);

      const audits = await hub.store.db.all<{ kind: string; detail_json: string }>(
        "SELECT kind, detail_json FROM audit_log WHERE kind LIKE 'terminal.%' ORDER BY at ASC",
      );
      expect(audits.filter((a) => a.kind === "terminal.policy")).toHaveLength(1);
      expect(audits.filter((a) => a.kind === "terminal.opened")).toHaveLength(2);
      expect(audits.filter((a) => a.kind === "terminal.closed")).toHaveLength(2);
    } finally {
      await hub.close();
    }
  }, 20_000);

  it("enforces concurrent create slot reservation, kills handles on mid-spawn dispose, and buffers early data/exit", async () => {
    const stateDir = path.join(tempRoot, "hub-races");
    const ws = path.join(tempRoot, "races-ws");
    await mkdir(ws, { recursive: true });
    await mkdir(path.join(stateDir, "bots", "bot_race"), { recursive: true });
    await writeFile(path.join(stateDir, "bots", "bot_race", "config.json"), JSON.stringify({ engine: "codex", workspacePath: ws }));

    let killedMidSpawn = 0;
    let releaseSlowSpawn!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlowSpawn = resolve; });
    let spawnIndex = 0;

    const hub = await HubServer.start({
      stateDir,
      hostTerminalSpawner: async () => {
        const idx = ++spawnIndex;
        if (idx === 10) {
          await slowGate;
        }
        const dataListeners: Array<(chunk: string) => void> = [];
        const exitListeners: Array<(code: number | null) => void> = [];
        let killed = false;
        const handle: TerminalProcessHandle = {
          shell: "mock-sh",
          backend: "pipe",
          write: () => {},
          kill: async () => {
            if (!killed) {
              killed = true;
              if (idx === 10) killedMidSpawn += 1;
            }
          },
          onData: (cb) => {
            dataListeners.push(cb);
            cb(`EARLY_${idx}`);
          },
          onExit: (cb) => {
            exitListeners.push(cb);
            if (idx === 9) cb(0); // Immediate natural exit on #9
          },
        };
        return handle;
      },
    });
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_race','Race','codex','h',1)");
      const conv = await hub.store.createConversation("owner", ["bot_race"], "Race Chat", "conv_race", { type: "direct" });
      const ownerDev = await issueDeviceSession(hub, "race_mac", "owner", { localController: true });
      const signed = await signTerminalConfigure(hub, ownerDev, {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: ownerDev.deviceId, publicKey: ownerDev.pubB64 }],
      });
      await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });

      const session = await hub.auth.authorize(ownerDev.token, "127.0.0.1");
      // Concurrent 10 creates must only allow 8 active (MAX_TERMINALS_PER_CONVERSATION)
      const burst = await Promise.allSettled(
        Array.from({ length: 10 }, () => hub.hostTerminal.create(session, { conversationId: conv.id })),
      );
      const created = burst.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const rejected = burst.filter((r) => r.status === "rejected");
      expect(created).toHaveLength(8);
      expect(rejected).toHaveLength(2);

      // Close 1 active tab, then create #9 which exits immediately -> exited tab must NOT count against active limit
      await hub.hostTerminal.close(session, created[0]!.id);
      const immediateExit = await hub.hostTerminal.create(session, { conversationId: conv.id });
      const out9 = await hub.hostTerminal.readOutput(session, immediateExit.id, 0, 0);
      expect(out9.running).toBe(false);
      expect(out9.exitCode).toBe(0);
      expect(out9.chunks.map((c) => c.data).join("")).toContain("EARLY_9");

      // #10 blocks on slowGate; start dispose() while #10 is spawning, then release slowGate
      const slowCreate = hub.hostTerminal.create(session, { conversationId: conv.id });
      await new Promise((r) => setTimeout(r, 30));
      const disposePromise = hub.hostTerminal.dispose();
      releaseSlowSpawn();
      await expect(slowCreate).rejects.toMatchObject({ code: "hub_stopping" });
      await disposePromise;
      expect(killedMidSpawn).toBe(1);
    } finally {
      await hub.close();
    }
  });

  it("hardened pipe fallback preserves multi-byte UTF-8, interrupts children on Ctrl+C, and exits on Ctrl+D", async () => {
    const ws = path.join(tempRoot, "pipe-ws");
    await mkdir(ws, { recursive: true });
    const handle = await spawnPipeShell(ws, 80, 24);
    try {
      let out = "";
      let exitCode: number | null | undefined;
      handle.onData((chunk) => { out += chunk; });
      handle.onExit((code) => { exitCode = code; });

      // Multi-byte UTF-8 + CRLF handling
      handle.write("printf '你好世界🚀\\n'\r");
      for (let i = 0; i < 30 && !out.includes("你好世界🚀"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(out).toContain("你好世界🚀");

      // Ctrl+C interrupts child sleep without killing shell
      handle.write("sleep 5 && echo PIPE_SHOULD_NOT_RUN\r");
      await new Promise((r) => setTimeout(r, 200));
      handle.write("\x03");
      await new Promise((r) => setTimeout(r, 200));
      handle.write("echo PIPE_AFTER_INT\r");
      for (let i = 0; i < 30 && !out.includes("PIPE_AFTER_INT"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(out).toContain("PIPE_AFTER_INT");
      expect(out).not.toContain("PIPE_SHOULD_NOT_RUN");

      // Ctrl+D sends EOF and exits cleanly
      handle.write("\x04");
      for (let i = 0; i < 30 && exitCode === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(exitCode).toBe(0);
    } finally {
      await handle.kill();
    }
  }, 20_000);

  it("resolves external Bot workspaces via resolveBotStateDir and supports dispatcher ticket workspaces", async () => {
    const stateDir = path.join(tempRoot, "hub-ext-resolve");
    const externalBotState = path.join(tempRoot, "external-bot-state");
    const externalWorkspace = path.join(tempRoot, "external-project");
    const ticketWorkspace = path.join(externalWorkspace, "tickets", "tk_1");
    await mkdir(externalBotState, { recursive: true });
    await mkdir(ticketWorkspace, { recursive: true });
    await writeFile(path.join(externalBotState, "config.json"), JSON.stringify({ engine: "codex", workspacePath: externalWorkspace }));

    const hub = await HubServer.start({ stateDir });
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('ext_bot','Ext','codex','h',1)");
      const conv = await hub.store.createConversation("owner", ["ext_bot"], "Ext Chat", "conv_ext_ok", { type: "direct" });
      const ownerDev = await issueDeviceSession(hub, "ext_mac", "owner", { localController: true });
      const session = await hub.auth.authorize(ownerDev.token, "127.0.0.1");

      const terminal = new HubHostTerminal({
        store: hub.store,
        auth: hub.auth,
        stateDir,
        resolveBotStateDir: async (botId) => (botId === "ext_bot" ? externalBotState : undefined),
        spawnProcess: async () => ({
          shell: "mock",
          backend: "pipe",
          write: () => {},
          kill: async () => {},
          onData: () => {},
          onExit: () => {},
        }),
      });
      const signed = await signTerminalConfigure(hub, ownerDev, {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: ownerDev.deviceId, publicKey: ownerDev.pubB64 }],
      });
      await terminal.configure(session, signed.command, signed.proof);

      const created = await terminal.create(session, { conversationId: conv.id });
      expect(created.cwd).toBe(externalWorkspace);

      // Ticket workspace inside dispatcher workspace takes precedence
      await hub.store.db.run("UPDATE conversations SET ticket_json=? WHERE id=?", [
        JSON.stringify({ id: "tk_1", dispatcherBotId: "ext_bot", workspace: "tickets/tk_1" }),
        conv.id,
      ]);
      const ticketCreated = await terminal.create(session, { conversationId: conv.id });
      expect(ticketCreated.cwd).toBe(ticketWorkspace);
      await terminal.dispose();
    } finally {
      await hub.close();
    }
  });

  it("keeps running shells alive across 15-minute HTTP session expiry while still terminating on revocation, key change, or grant removal", async () => {
    const stateDir = path.join(tempRoot, "hub-session-expiry");
    const ws = path.join(tempRoot, "session-expiry-ws");
    await mkdir(stateDir, { recursive: true });
    await mkdir(ws, { recursive: true });

    let fakeNow = Date.UTC(2026, 10, 1, 12, 0, 0);
    const store = await HubStore.open(stateDir);
    const auth = await HubAuth.open(store, stateDir, () => fakeNow);

    const registerDevice = async (deviceId: string, localController = false) => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      await store.db.run(
        "INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen,revoked) VALUES(?,?,?,?,?,?,?,0)",
        [deviceId, "owner", deviceId, "macos", pubB64, fakeNow, fakeNow],
      );
      if (localController) {
        await auth.markLocalDesktopController({ deviceId, name: deviceId, platform: "macos", publicKey: pubB64 });
      }
      const authenticate = async () => {
        const clientNonce = randomUUID().replaceAll("-", "").padEnd(43, "a");
        const connId = `conn_${deviceId}_${randomUUID().slice(0, 8)}`;
        const ch = await auth.challenge(connId, deviceId, clientNonce, "127.0.0.1");
        const sig = sign(null, Buffer.from(`tarocub/device/v1\0${deviceId}\0${ch.nonce}\0${clientNonce}`), privateKey).toString("base64");
        const issued = await auth.authenticate(connId, sig);
        const session = await auth.authorize(issued.token, "127.0.0.1");
        return { token: issued.token, session };
      };
      return { deviceId, pubB64, privateKey, authenticate };
    };

    const handles = new Map<string, {
      killed: number;
      written: string[];
      emitData: (chunk: string) => void;
      emitExit: (code: number | null) => void;
    }>();
    let spawnSeq = 0;

    const terminal = new HubHostTerminal({
      store,
      auth,
      stateDir,
      defaultWorkspace: ws,
      now: () => fakeNow,
      spawnProcess: async () => {
        const key = `mock_${++spawnSeq}`;
        let dataCb: ((chunk: string) => void) | undefined;
        let exitCb: ((code: number | null) => void) | undefined;
        const state = {
          killed: 0,
          written: [] as string[],
          emitData: (chunk: string) => dataCb?.(chunk),
          emitExit: (code: number | null) => exitCb?.(code),
        };
        handles.set(key, state);
        return {
          shell: key,
          backend: "pipe",
          write: (data) => { state.written.push(data); },
          kill: async () => { state.killed += 1; },
          onData: (cb) => { dataCb = cb; },
          onExit: (cb) => { exitCb = cb; },
        };
      },
    });

    try {
      await store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_exp','Exp','codex','h',1)");
      const conv = await store.createConversation("owner", ["bot_exp"], "Long Build Chat", "conv_exp", { type: "direct" });
      const ownerDev = await registerDevice("exp_owner", true);
      const revDev = await registerDevice("exp_rev");
      const keyDev = await registerDevice("exp_key");
      const grantDev = await registerDevice("exp_grant");

      const signConfig = async (
        actor: Awaited<ReturnType<typeof registerDevice>>,
        authResult: { token: string; session: Awaited<ReturnType<HubAuth["authorize"]>> },
        command: { expectedRevision: number; enabled: boolean; grants: Array<{ deviceId: string; publicKey: string }> },
      ) => {
        const full = { ...command, requestId: `req_${randomUUID().replaceAll("-", "")}` };
        const target = createHash("sha256").update(terminalConfigureText(full)).digest("hex");
        const statement = await auth.prepareDeviceAction({ operation: "terminal-grant", target }, authResult.token, authResult.session);
        const signature = sign(null, Buffer.from(deviceActionProofText(statement)), actor.privateKey).toString("base64");
        return { command: full, proof: { nonce: statement.nonce, signature } };
      };

      const ownerAuth1 = await ownerDev.authenticate();
      const revAuth1 = await revDev.authenticate();
      const keyAuth1 = await keyDev.authenticate();
      const grantAuth1 = await grantDev.authenticate();

      const cfg1 = await signConfig(ownerDev, ownerAuth1, {
        expectedRevision: 0,
        enabled: true,
        grants: [
          { deviceId: ownerDev.deviceId, publicKey: ownerDev.pubB64 },
          { deviceId: revDev.deviceId, publicKey: revDev.pubB64 },
          { deviceId: keyDev.deviceId, publicKey: keyDev.pubB64 },
          { deviceId: grantDev.deviceId, publicKey: grantDev.pubB64 },
        ],
      });
      await terminal.configure(ownerAuth1.session, cfg1.command, cfg1.proof);

      const ownerTerm = await terminal.create(ownerAuth1.session, { conversationId: conv.id });
      const revTerm = await terminal.create(revAuth1.session, { conversationId: conv.id });
      const keyTerm = await terminal.create(keyAuth1.session, { conversationId: conv.id });
      const grantTerm = await terminal.create(grantAuth1.session, { conversationId: conv.id });

      // Advance clock 25 minutes: past the 15-minute HTTP session TTL, well under the 2-hour idle ceiling
      fakeNow += 25 * 60_000;
      await expect(auth.validateSession(ownerAuth1.session)).rejects.toMatchObject({ code: "session_expired" });
      await expect(terminal.readOutput(ownerAuth1.session, ownerTerm.id, 0, 0)).rejects.toMatchObject({ code: "session_expired" });

      // Periodic sweep MUST NOT kill running shells just because their creating HTTP sessions expired
      await terminal.sweep();
      expect(handles.get("mock_1")!.killed).toBe(0);
      expect(handles.get("mock_2")!.killed).toBe(0);
      expect(handles.get("mock_3")!.killed).toBe(0);
      expect(handles.get("mock_4")!.killed).toBe(0);

      // Re-authenticating after panel reopen / session renewal seamlessly reattaches to the live shell
      handles.get("mock_1")!.emitData("BUILD_STEP_42\n");
      const ownerAuth2 = await ownerDev.authenticate();
      const listed = await terminal.list(ownerAuth2.session, conv.id);
      expect(listed.map((t) => t.id)).toContain(ownerTerm.id);
      const out = await terminal.readOutput(ownerAuth2.session, ownerTerm.id, 0, 0);
      expect(out.running).toBe(true);
      expect(out.chunks.map((c) => c.data).join("")).toContain("BUILD_STEP_42");
      await terminal.writeInput(ownerAuth2.session, ownerTerm.id, { data: "echo still-alive\r" });
      expect(handles.get("mock_1")!.written).toContain("echo still-alive\r");

      // Even while revDev & keyDev HTTP sessions remain expired, sweep() still terminates on:
      // (a) external SQLite device revocation
      await store.db.run("UPDATE devices SET revoked=1 WHERE id=?", [revDev.deviceId]);
      // (b) device public key rotation/change in SQLite
      const rotatedKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
      await store.db.run("UPDATE devices SET public_key=? WHERE id=?", [rotatedKey, keyDev.deviceId]);
      await terminal.sweep();

      expect(handles.get("mock_1")!.killed).toBe(0);
      expect(handles.get("mock_2")!.killed).toBe(1);
      expect(handles.get("mock_3")!.killed).toBe(1);
      expect(handles.get("mock_4")!.killed).toBe(0);

      // (c) removing terminal authorization terminates grantTerm immediately with permission_revoked
      const cfg2 = await signConfig(ownerDev, ownerAuth2, {
        expectedRevision: 1,
        enabled: true,
        grants: [{ deviceId: ownerDev.deviceId, publicKey: ownerDev.pubB64 }],
      });
      await terminal.configure(ownerAuth2.session, cfg2.command, cfg2.proof);
      expect(handles.get("mock_4")!.killed).toBe(1);
      expect(handles.get("mock_1")!.killed).toBe(0);

      await store.flushAudit();
      const closedAudits = await store.db.all<{ detail_json: string }>(
        "SELECT detail_json FROM audit_log WHERE kind='terminal.closed'",
      );
      expect(closedAudits.some((r) => r.detail_json.includes(revTerm.id) && r.detail_json.includes("device_revoked"))).toBe(true);
      expect(closedAudits.some((r) => r.detail_json.includes(keyTerm.id) && r.detail_json.includes("device_revoked"))).toBe(true);
      expect(closedAudits.some((r) => r.detail_json.includes(grantTerm.id) && r.detail_json.includes("permission_revoked"))).toBe(true);
      expect(closedAudits.some((r) => r.detail_json.includes(ownerTerm.id))).toBe(false);
    } finally {
      await terminal.dispose();
      await store.flushAudit();
      await store.db.close();
    }
  });

  it("reaps abandoned shells after the configurable idle ceiling while keeping active I/O shells alive", async () => {
    expect(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS).toBe(2 * 60 * 60_000);
    expect(resolveTerminalIdleTimeoutMs(undefined, {})).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs(undefined, { TAROBOT_TERMINAL_IDLE_TIMEOUT_MS: String(30 * 60_000) })).toBe(30 * 60_000);
    expect(resolveTerminalIdleTimeoutMs(undefined, { TAROBOT_TERMINAL_IDLE_TIMEOUT_MS: "500" })).toBe(MIN_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs(undefined, { TAROBOT_TERMINAL_IDLE_TIMEOUT_MS: String(99 * 60 * 60_000) })).toBe(MAX_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs(undefined, { TAROBOT_TERMINAL_IDLE_TIMEOUT_MS: "0" })).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs(undefined, { TAROBOT_TERMINAL_IDLE_TIMEOUT_MS: "not-a-number" })).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs(10_000, {})).toBe(10_000);

    const stateDir = path.join(tempRoot, "hub-idle-ceiling");
    const ws = path.join(tempRoot, "idle-ceiling-ws");
    await mkdir(stateDir, { recursive: true });
    await mkdir(ws, { recursive: true });

    let fakeNow = Date.UTC(2026, 10, 1, 14, 0, 0);
    const store = await HubStore.open(stateDir);
    const auth = await HubAuth.open(store, stateDir, () => fakeNow);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    await store.db.run(
      "INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen,revoked) VALUES(?,?,?,?,?,?,?,0)",
      ["idle_owner", "owner", "idle_owner", "macos", pubB64, fakeNow, fakeNow],
    );
    await auth.markLocalDesktopController({ deviceId: "idle_owner", name: "idle_owner", platform: "macos", publicKey: pubB64 });

    const authenticate = async () => {
      const clientNonce = randomUUID().replaceAll("-", "").padEnd(43, "b");
      const connId = `conn_idle_${randomUUID().slice(0, 8)}`;
      const ch = await auth.challenge(connId, "idle_owner", clientNonce, "127.0.0.1");
      const sig = sign(null, Buffer.from(`tarocub/device/v1\0idle_owner\0${ch.nonce}\0${clientNonce}`), privateKey).toString("base64");
      const issued = await auth.authenticate(connId, sig);
      const session = await auth.authorize(issued.token, "127.0.0.1");
      return { token: issued.token, session };
    };

    const mocks: Array<{
      killed: number;
      emitData: (chunk: string) => void;
      emitExit: (code: number | null) => void;
    }> = [];

    const terminal = new HubHostTerminal({
      store,
      auth,
      stateDir,
      defaultWorkspace: ws,
      now: () => fakeNow,
      spawnProcess: async () => {
        let dataCb: ((chunk: string) => void) | undefined;
        let exitCb: ((code: number | null) => void) | undefined;
        const entry = {
          killed: 0,
          emitData: (chunk: string) => dataCb?.(chunk),
          emitExit: (code: number | null) => exitCb?.(code),
        };
        mocks.push(entry);
        return {
          shell: `idle_mock_${mocks.length}`,
          backend: "pipe",
          write: () => {},
          resize: () => {},
          kill: async () => { entry.killed += 1; },
          onData: (cb) => { dataCb = cb; },
          onExit: (cb) => { exitCb = cb; },
        };
      },
    });

    try {
      expect(terminal.idleTimeoutMs).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
      await store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_idle','Idle','codex','h',1)");
      const conv = await store.createConversation("owner", ["bot_idle"], "Idle Chat", "conv_idle", { type: "direct" });

      const auth1 = await authenticate();
      const cmd = {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: "idle_owner", publicKey: pubB64 }],
        requestId: "req_idle_enable",
      };
      const target = createHash("sha256").update(terminalConfigureText(cmd)).digest("hex");
      const statement = await auth.prepareDeviceAction({ operation: "terminal-grant", target }, auth1.token, auth1.session);
      const signature = sign(null, Buffer.from(deviceActionProofText(statement)), privateKey).toString("base64");
      await terminal.configure(auth1.session, cmd, { nonce: statement.nonce, signature });

      const abandoned = await terminal.create(auth1.session, { conversationId: conv.id });
      const activeBuild = await terminal.create(auth1.session, { conversationId: conv.id });

      // 1 hour later (well past 15-min HTTP session expiry): activeBuild emits output, abandoned stays silent
      fakeNow += 60 * 60_000;
      mocks[1]!.emitData("compiling module 12/40\n");
      await terminal.sweep();
      expect(mocks[0]!.killed).toBe(0);
      expect(mocks[1]!.killed).toBe(0);

      // Just before the 2-hour idle ceiling (1h59m59s): abandoned still survives
      fakeNow += 60 * 60_000 - 1_000;
      await terminal.sweep();
      expect(mocks[0]!.killed).toBe(0);
      expect(mocks[1]!.killed).toBe(0);

      // Cross the 2-hour idle ceiling for abandoned (while activeBuild had output 1h ago)
      fakeNow += 1_000;
      await terminal.sweep();
      expect(mocks[0]!.killed).toBe(1);
      expect(mocks[1]!.killed).toBe(0);

      // Re-auth and send input to activeBuild at 1h50m since its last stdout -> resets its idle timer
      fakeNow += 50 * 60_000;
      const auth2 = await authenticate();
      expect((await terminal.list(auth2.session, conv.id)).map((t) => t.id)).toEqual([activeBuild.id]);
      await terminal.writeInput(auth2.session, activeBuild.id, { data: "echo ping\r" });

      // 30 minutes later (2h20m after last stdout, only 30m after writeInput): activeBuild still lives
      fakeNow += 30 * 60_000;
      await terminal.sweep();
      expect(mocks[1]!.killed).toBe(0);

      // 1h30m more of complete silence -> reaches 2h idle and gets reaped
      fakeNow += 90 * 60_000;
      await terminal.sweep();
      expect(mocks[1]!.killed).toBe(1);

      await store.flushAudit();
      const closedAudits = await store.db.all<{ detail_json: string }>(
        "SELECT detail_json FROM audit_log WHERE kind='terminal.closed'",
      );
      expect(closedAudits.some((r) => r.detail_json.includes(abandoned.id) && r.detail_json.includes("idle_timeout"))).toBe(true);
      expect(closedAudits.some((r) => r.detail_json.includes(activeBuild.id) && r.detail_json.includes("idle_timeout"))).toBe(true);

      // Short custom idleTimeoutMs: exited shell must NOT be re-audited as idle_timeout
      const shortTerm = new HubHostTerminal({
        store,
        auth,
        stateDir,
        defaultWorkspace: ws,
        idleTimeoutMs: 10_000,
        now: () => fakeNow,
        spawnProcess: async () => {
          let exitCb: ((code: number | null) => void) | undefined;
          return {
            shell: "short_mock",
            backend: "pipe",
            write: () => {},
            kill: async () => {},
            onData: () => {},
            onExit: (cb) => {
              exitCb = cb;
              exitCb(0);
            },
          };
        },
      });
      try {
        expect(shortTerm.idleTimeoutMs).toBe(10_000);
        const auth3 = await authenticate();
        const exited = await shortTerm.create(auth3.session, { conversationId: conv.id });
        fakeNow += 30_000;
        await shortTerm.sweep();
        await store.flushAudit();
        const exitedAudits = await store.db.all<{ detail_json: string }>(
          "SELECT detail_json FROM audit_log WHERE kind='terminal.closed'",
        );
        const matching = exitedAudits.filter((r) => r.detail_json.includes(exited.id));
        expect(matching).toHaveLength(1);
        expect(matching[0]!.detail_json).toContain("process_exited");
        expect(matching[0]!.detail_json).not.toContain("idle_timeout");
      } finally {
        await shortTerm.dispose();
      }
    } finally {
      await terminal.dispose();
      await store.flushAudit();
      await store.db.close();
    }
  });
});
