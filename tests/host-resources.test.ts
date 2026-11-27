import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  formatCpuPercent,
  formatMemoryBytes,
  HOST_RESOURCES_CAPABILITY,
  HOST_RESOURCES_PATH,
  HOST_RESOURCES_STOP_PATH,
  hostResourcesSnapshotSchema,
  sortResourceBots,
} from "../src/client-protocol/host-resources.js";
import {
  buildWindowsProcessSampleScript,
  parsePosixPsOutput,
  parseWindowsProcessJson,
  sanitizeProcessName,
  type OsProcessSample,
} from "../src/hub/host-resources.js";
import { HubServer } from "../src/hub/server.js";

let tempRoot: string;
beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tarobird-resources-"));
});
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("host-resources parsers, Windows PS5.1 script, and formatting (#124)", () => {
  it("parses macOS/Linux ps output (including paths with spaces) and Windows CIM/JSON output cleanly", () => {
    const posix = parsePosixPsOutput([
      "  100     1   2.5  102400 /usr/local/bin/node",
      "  200   100  18.4  262144 /opt/bin/codex",
      "  bad line",
      "  201   200  64.0  524288 python3",
      "  300     1   3.1  150000 /Applications/TaroBird.app/Contents/Frameworks/TaroBird Helper (Renderer).app/Contents/MacOS/TaroBird Helper (Renderer)",
      "  301   300   1.2   80000 /opt/Application Support/TaroBird/node",
    ].join("\n"));
    expect(posix).toHaveLength(5);
    expect(posix[0]).toEqual({ pid: 100, ppid: 1, cpuPercent: 2.5, memoryBytes: 102400 * 1024, name: "node" });
    expect(posix[1]).toEqual({ pid: 200, ppid: 100, cpuPercent: 18.4, memoryBytes: 262144 * 1024, name: "codex" });
    expect(posix[2]).toEqual({ pid: 201, ppid: 200, cpuPercent: 64, memoryBytes: 524288 * 1024, name: "python3" });
    expect(posix[3]).toEqual({ pid: 300, ppid: 1, cpuPercent: 3.1, memoryBytes: 150000 * 1024, name: "TaroBird Helper (Renderer)" });
    expect(posix[4]).toEqual({ pid: 301, ppid: 300, cpuPercent: 1.2, memoryBytes: 80000 * 1024, name: "node" });

    expect(sanitizeProcessName("C:\\Program Files\\TaroBird\\tarocub-client.exe")).toBe("tarocub-client.exe");

    const win = parseWindowsProcessJson(JSON.stringify([
      { ProcessId: 1000, ParentProcessId: 4, Name: "node.exe", WorkingSetSize: 90_000_000, CpuPercent: 3.2 },
      { ProcessId: 1200, ParentProcessId: 1000, Name: "claude.exe", WorkingSetSize: 310_000_000, CpuPercent: 41.7 },
    ]));
    expect(win).toHaveLength(2);
    expect(win[1]).toEqual({ pid: 1200, ppid: 1000, cpuPercent: 41.7, memoryBytes: 310_000_000, name: "claude.exe" });

    // Single-object ConvertTo-Json output (no array wrapper) is also supported.
    const singleWin = parseWindowsProcessJson(JSON.stringify(
      { ProcessId: 1000, ParentProcessId: 4, Name: "C:\\Program Files\\TaroBird\\tarocub-client.exe", WorkingSetSize: 120_000_000, CpuPercent: 5.5 },
    ));
    expect(singleWin).toEqual([{ pid: 1000, ppid: 4, cpuPercent: 5.5, memoryBytes: 120_000_000, name: "tarocub-client.exe" }]);

    expect(formatMemoryBytes(0)).toBe("0 MB");
    expect(formatMemoryBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatMemoryBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
    expect(formatCpuPercent(12.34)).toBe("12.3%");
    expect(formatCpuPercent(142.8)).toBe("143%");
  });

  it("builds a Windows PowerShell 5.1-compatible sampling script without PS7-only operators", () => {
    const script = buildWindowsProcessSampleScript();
    // PowerShell 7-only operators (`??`, `??=`, `&&`, `||`) cause ParserError on Windows PowerShell 5.1.
    expect(script).not.toContain("??");
    expect(script).not.toContain("&&");
    expect(script).not.toContain("||");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("Win32_PerfFormattedData_PerfProc_Process");
    expect(script).toContain("$perf.ContainsKey(");
    expect(script).toContain("ConvertTo-Json -Compress");
  });
});

describe("HubHostResources attribution, isolation, bounds, desktop detection, and stopping (#124)", () => {
  it("attributes concurrent Bots accurately, isolates non-owner members and history, and separates turn_stop from process_tree kills", async () => {
    const hubPid = process.pid;
    const fakeSamples: OsProcessSample[] = [
      { pid: 50, ppid: 1, cpuPercent: 1.5, memoryBytes: 180 * 1024 * 1024, name: "TaroBird" },
      { pid: hubPid, ppid: 50, cpuPercent: 2.0, memoryBytes: 120 * 1024 * 1024, name: "node" },
      // Bot A gateway + active codex engine
      { pid: 7001, ppid: hubPid, cpuPercent: 0.8, memoryBytes: 40 * 1024 * 1024, name: "node" },
      { pid: 7101, ppid: 7001, cpuPercent: 32.5, memoryBytes: 420 * 1024 * 1024, name: "codex" },
      // Bot B gateway + active claude engine
      { pid: 7002, ppid: hubPid, cpuPercent: 0.5, memoryBytes: 38 * 1024 * 1024, name: "node" },
      { pid: 7102, ppid: 7002, cpuPercent: 19.2, memoryBytes: 310 * 1024 * 1024, name: "claude" },
      // Bot C gateway + active pi engine
      { pid: 7003, ppid: hubPid, cpuPercent: 0.6, memoryBytes: 36 * 1024 * 1024, name: "node" },
      { pid: 7103, ppid: 7003, cpuPercent: 8.0, memoryBytes: 190 * 1024 * 1024, name: "pi" },
      // Unattributed child of Hub (visible to owner only)
      { pid: 7999, ppid: hubPid, cpuPercent: 0.4, memoryBytes: 24 * 1024 * 1024, name: "helper-worker" },
      // Unrelated system process (must NEVER appear!)
      { pid: 99999, ppid: 1, cpuPercent: 99.0, memoryBytes: 8 * 1024 * 1024 * 1024, name: "unrelated-system-app" },
    ];
    const botPidMap = new Map<string, number>([
      ["bot_a", 7001],
      ["bot_b", 7002],
      ["bot_c", 7003],
    ]);
    const killedPids: number[] = [];
    const stoppedTurns: Array<{ botId: string; conversationId: string; userId: string }> = [];
    let stopBotTurnBehavior: "true" | "false" | "throw" = "true";

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-attribution"),
      hostResourcesSampler: async () => fakeSamples,
      hostResourcesBotPids: () => new Map(botPidMap),
      hostResourcesKillPid: async (pid) => { killedPids.push(pid); },
      hostResourcesStopBotTurn: async (botId, conversationId, userId) => {
        stoppedTurns.push({ botId, conversationId, userId });
        if (stopBotTurnBehavior === "throw") throw new Error("bot_offline");
        return stopBotTurnBehavior === "true";
      },
    });

    try {
      const now = Date.now();
      for (const [id, name, engine] of [
        ["bot_a", "Codex Bot", "codex"],
        ["bot_b", "Claude Bot", "claude"],
        ["bot_c", "Pi Bot", "pi"],
      ] as const) {
        await hub.store.db.run(
          "INSERT INTO bots(id,name,engine,secret_hash,online) VALUES(?,?,?,?,1)",
          [id, name, engine, `hash_${id}`],
        );
      }
      const convA = await hub.store.createConversation("owner", ["bot_a"], "Alpha Refactor", "conv_a", { type: "direct" });
      const convB = await hub.store.createConversation("owner", ["bot_b"], "Beta Analysis", "conv_b", { type: "direct" });
      const convC = await hub.store.createConversation("owner", ["bot_c"], "Gamma Script", "conv_c", { type: "direct" });
      for (const [botId, conv] of [
        ["bot_a", convA],
        ["bot_b", convB],
        ["bot_c", convC],
      ] as const) {
        await hub.store.db.run(
          "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES(?,?,?,'bot',?,'streaming',1,?)",
          [`msg_${botId}`, conv.id, botId, JSON.stringify([{ type: "text", text: "working…" }]), now],
        );
      }

      // Create a non-owner member with ZERO bot_grants
      await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member_1','Member','member')");

      // Snapshot as owner: sees all 3 bots, exact conversation attribution, excludes unrelated PID 99999
      const ownerSnap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      expect(ownerSnap.canStop).toBe(true);
      expect(ownerSnap.summary.activeTasks).toBe(3);
      expect(ownerSnap.selfProcesses.some((p) => p.kind === "host" && p.pid === hubPid)).toBe(true);
      expect(ownerSnap.selfProcesses.some((p) => p.kind === "app" && p.pid === 50)).toBe(true);
      expect(ownerSnap.unattributed.map((p) => p.pid)).toEqual([7999]);
      expect(JSON.stringify(ownerSnap)).not.toContain("unrelated-system-app");

      const sortedByMem = sortResourceBots(ownerSnap.bots, "memory");
      expect(sortedByMem.map((b) => b.botId)).toEqual(["bot_a", "bot_b", "bot_c"]);
      expect(sortedByMem[0]!.conversations[0]!.title).toBe("Alpha Refactor");
      expect(sortedByMem[0]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([7101]);
      expect(sortedByMem[1]!.conversations[0]!.title).toBe("Beta Analysis");
      expect(sortedByMem[1]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([7102]);
      expect(sortedByMem[2]!.conversations[0]!.title).toBe("Gamma Script");
      expect(sortedByMem[2]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([7103]);

      // Second forced sample appends owner's sparkline history
      const ownerSnap2 = await hub.hostResources.snapshot("owner", true, true);
      expect(ownerSnap2.history).toHaveLength(2);

      // Member with zero bot_grants MUST NOT leak ungranted Bots, Hub unattributed helpers, or owner's history!
      const memberSnap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_1", false, true));
      expect(memberSnap.canStop).toBe(false);
      expect(memberSnap.bots).toEqual([]);
      expect(memberSnap.unattributed).toEqual([]);
      expect(memberSnap.summary.activeTasks).toBe(0);
      expect(memberSnap.summary.engineMemoryBytes).toBe(0);
      for (const forbiddenPid of [7001, 7002, 7003, 7101, 7102, 7103, 7999, 99999]) {
        expect(JSON.stringify(memberSnap)).not.toContain(`"pid":${forbiddenPid}`);
      }
      // Member gets their own isolated history buffer, and ?force=1 does not bypass MIN_HISTORY_INTERVAL_MS or pollute owner
      expect(memberSnap.history).toHaveLength(1);
      const memberSnap2 = await hub.hostResources.snapshot("member_1", false, true);
      expect(memberSnap2.history).toHaveLength(1);
      expect(memberSnap2.history[0]!.memoryBytes).toBe(memberSnap.summary.totalMemoryBytes);
      expect(memberSnap2.history[0]!.memoryBytes).toBeLessThan(ownerSnap2.summary.totalMemoryBytes);

      // Owner's history remains untouched by member calls
      const ownerSnapCheck = await hub.hostResources.snapshot("owner", true, false);
      expect(ownerSnapCheck.history).toHaveLength(2);
      expect(ownerSnapCheck.history.every((pt) => pt.memoryBytes === ownerSnap.summary.totalMemoryBytes)).toBe(true);

      // Grant member_1 access to shared bot_a while owner has a private active turn (convA) on bot_a:
      // member_1 must NOT see owner's engine subprocess (7101) in bot.unattributed!
      await hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('member_1','bot_a')");
      const memberSharedIdle = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_1", false, false));
      expect(memberSharedIdle.bots).toHaveLength(1);
      expect(memberSharedIdle.bots[0]!.botId).toBe("bot_a");
      expect(memberSharedIdle.bots[0]!.activeTurns).toBe(0);
      expect(memberSharedIdle.bots[0]!.conversations).toEqual([]);
      expect(memberSharedIdle.bots[0]!.unattributed.map((p) => p.pid)).toEqual([7001]);
      expect(JSON.stringify(memberSharedIdle)).not.toContain(`"pid":7101`);

      // When member_1 ALSO runs a conversation on shared bot_a alongside owner's private turn on a single shared worker (7101),
      // owner's engine process (7101) must NOT be misattributed to member_1's conversation!
      const memberConv = await hub.store.createConversation("member_1", ["bot_a"], "Member Chat", "conv_member_a", { type: "direct" });
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES(?,?,?,'bot',?,'streaming',1,?)",
        ["msg_member_a", memberConv.id, "bot_a", JSON.stringify([{ type: "text", text: "member working…" }]), now + 500],
      );
      const memberSharedActive = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_1", false, false));
      expect(memberSharedActive.bots[0]!.activeTurns).toBe(1);
      expect(memberSharedActive.bots[0]!.conversations).toHaveLength(1);
      expect(memberSharedActive.bots[0]!.conversations[0]!.conversationId).toBe(memberConv.id);
      expect(memberSharedActive.bots[0]!.conversations[0]!.processes).toEqual([]);
      expect(memberSharedActive.bots[0]!.unattributed.map((p) => p.pid)).toEqual([7001]);
      expect(JSON.stringify(memberSharedActive)).not.toContain(`"pid":7101`);

      // Graceful conversation stop routes through stopBotTurn and never kills PIDs
      stopBotTurnBehavior = "true";
      const turnStopOk = await hub.hostResources.stop("owner", { botId: "bot_a", conversationId: convA.id });
      expect(turnStopOk).toEqual({ ok: true, stopped: true, method: "turn_stop" });
      expect(stoppedTurns).toEqual([{ botId: "bot_a", conversationId: convA.id, userId: "owner" }]);
      expect(killedPids).toEqual([]);

      // Even if a caller passes both conversationId and pid and stopBotTurn returns false,
      // stop() MUST NOT fall through to killProcessTree (protecting shared persistent engine workers)!
      stopBotTurnBehavior = "false";
      const turnStopFalse = await hub.hostResources.stop("owner", { botId: "bot_a", conversationId: convA.id, pid: 7101 });
      expect(turnStopFalse).toEqual({ ok: true, stopped: false, method: "turn_stop" });
      expect(killedPids).toEqual([]);

      // And if stopBotTurn throws, stop() propagates the error instead of killing the persistent PID!
      stopBotTurnBehavior = "throw";
      await expect(hub.hostResources.stop("owner", { botId: "bot_a", conversationId: convA.id, pid: 7101 })).rejects.toThrow("bot_offline");
      expect(killedPids).toEqual([]);

      // Explicit PID stop (without conversationId) kills ONLY that verified descendant process tree
      const stopRes = await hub.hostResources.stop("owner", { botId: "bot_b", pid: 7102 });
      expect(stopRes).toEqual({ ok: true, stopped: true, method: "process_tree" });
      expect(killedPids).toEqual([7102]);

      // Refuses to kill a PID outside the Bot's process tree (e.g. Hub, gateway, other Bot, or unrelated system PID)
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: 99999 })).rejects.toThrow("resource_process_not_owned");
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: hubPid })).rejects.toThrow("resource_process_not_owned");
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: 7002 })).rejects.toThrow("resource_process_not_owned");
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: 7101 })).rejects.toThrow("resource_process_not_owned");

      // Verify HTTP endpoints: unauthorized fails 401; capability constant exported
      expect(HOST_RESOURCES_CAPABILITY).toBe("host.resources.v1");
      const unauthGet = await fetch(hub.url + HOST_RESOURCES_PATH);
      expect(unauthGet.status).toBe(401);
      const unauthStop = await fetch(hub.url + HOST_RESOURCES_STOP_PATH, { method: "POST", body: JSON.stringify({ botId: "bot_a", pid: 7101 }) });
      expect(unauthStop.status).toBe(401);
    } finally {
      await hub.close();
    }
  });

  it("caps >64 descendant processes and long IDs to schema bounds while keeping accurate summary totals", async () => {
    const hubPid = process.pid;
    const longBotId = `bot_${"a".repeat(120)}`;
    const longConvTitle = "Runaway build storm ".repeat(12).trim();
    const samples: OsProcessSample[] = [
      { pid: hubPid, ppid: 1, cpuPercent: 1.0, memoryBytes: 100 * 1024 * 1024, name: "node" },
      { pid: 8000, ppid: hubPid, cpuPercent: 0.5, memoryBytes: 40 * 1024 * 1024, name: "node" },
    ];
    // 75 child processes under bot gateway 8000 (exceeds schema .max(64))
    let expectedChildMem = 0;
    for (let i = 1; i <= 75; i += 1) {
      const mem = i * 1024 * 1024;
      expectedChildMem += mem;
      samples.push({ pid: 8100 + i, ppid: 8000, cpuPercent: 0.5, memoryBytes: mem, name: `worker-${i}` });
    }
    // 70 unattributed children under hubPid (exceeds schema .max(64))
    let expectedHubUnattrMem = 0;
    for (let i = 1; i <= 70; i += 1) {
      const mem = i * 512 * 1024;
      expectedHubUnattrMem += mem;
      samples.push({ pid: 9100 + i, ppid: hubPid, cpuPercent: 0.1, memoryBytes: mem, name: `hub-child-${i}` });
    }

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-bounds"),
      hostResourcesSampler: async () => samples,
      hostResourcesBotPids: () => new Map([[longBotId, 8000]]),
    });

    try {
      await hub.store.db.run(
        "INSERT INTO bots(id,name,engine,secret_hash,online) VALUES(?,?,?,?,1)",
        [longBotId, "LongBot ".repeat(30), "codex-custom-engine-name-".repeat(3), "hash_long"],
      );
      const longConvId = `conv_${"b".repeat(120)}`;
      await hub.store.db.run(
        "INSERT INTO conversations(id,type,title,owner_id,created_at) VALUES(?,'direct',?,'owner',?)",
        [longConvId, longConvTitle, Date.now()],
      );
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [longConvId]);
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot',?,0)", [longConvId, longBotId]);
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_long',?,?,'bot',?,'streaming',1,?)",
        [longConvId, longBotId, JSON.stringify([{ type: "text", text: "running" }]), Date.now()],
      );

      // Must parse cleanly with zero ZodError!
      const snap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      expect(snap.bots).toHaveLength(1);
      expect(snap.bots[0]!.conversations).toHaveLength(1);
      expect(snap.bots[0]!.conversations[0]!.processes).toHaveLength(64);
      // Highest-memory processes are retained when capped
      expect(snap.bots[0]!.conversations[0]!.processes[0]!.pid).toBe(8175);
      // All process IDs stay within schema max(200)
      expect(snap.bots[0]!.conversations[0]!.processes.every((p) => p.id.length <= 200)).toBe(true);
      expect(snap.unattributed).toHaveLength(64);
      expect(snap.unattributed[0]!.pid).toBe(9170);

      // Summary totals reflect ALL 75 bot children + 70 unattributed children + gateway + host!
      expect(snap.summary.processCount).toBe(1 + 1 + 75 + 70);
      expect(snap.bots[0]!.conversations[0]!.memoryBytes).toBe(expectedChildMem);
      expect(snap.summary.engineMemoryBytes).toBe(40 * 1024 * 1024 + expectedChildMem + expectedHubUnattrMem);
    } finally {
      await hub.close();
    }
  });

  it("detects detached desktop App (`tarocub-client` and helpers) when Hub has ppid=1 without capturing unrelated apps", async () => {
    const hubPid = process.pid;
    const samples: OsProcessSample[] = [
      // Detached Hub (ppid=1, as spawned by desktop-host service)
      { pid: hubPid, ppid: 1, cpuPercent: 1.5, memoryBytes: 110 * 1024 * 1024, name: "node" },
      // Packaged desktop App + macOS helpers + native helper
      { pid: 4000, ppid: 1, cpuPercent: 2.2, memoryBytes: 160 * 1024 * 1024, name: "tarocub-client" },
      { pid: 4001, ppid: 4000, cpuPercent: 4.1, memoryBytes: 240 * 1024 * 1024, name: "TaroBird Helper (Renderer)" },
      { pid: 4002, ppid: 4000, cpuPercent: 1.3, memoryBytes: 95 * 1024 * 1024, name: "TaroBird Helper (GPU)" },
      { pid: 4003, ppid: 4000, cpuPercent: 0.2, memoryBytes: 18 * 1024 * 1024, name: "tarobot-desktop-core" },
      // Unrelated Electron app on the same machine (must NOT be captured!)
      { pid: 8888, ppid: 1, cpuPercent: 12.0, memoryBytes: 500 * 1024 * 1024, name: "Electron" },
      { pid: 8889, ppid: 8888, cpuPercent: 8.0, memoryBytes: 300 * 1024 * 1024, name: "Code Helper (Renderer)" },
    ];

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-detached-app"),
      hostResourcesSampler: async () => samples,
      hostResourcesBotPids: () => new Map(),
    });

    try {
      const snap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      const appPids = snap.selfProcesses.filter((p) => p.kind === "app").map((p) => p.pid).sort((a, b) => a - b);
      expect(appPids).toEqual([4000, 4001, 4002, 4003]);
      expect(snap.summary.appMemoryBytes).toBe((160 + 240 + 95 + 18) * 1024 * 1024);
      expect(JSON.stringify(snap)).not.toContain(`"pid":8888`);
      expect(JSON.stringify(snap)).not.toContain(`"pid":8889`);
    } finally {
      await hub.close();
    }
  });

  it("queries active bot turns via partial index messages_active_bot_turns with zero full table scan of messages", async () => {
    const stateDir = path.join(tempRoot, "hub-query-plan");
    let hub = await HubServer.start({
      stateDir,
      hostResourcesSampler: async () => [
        { pid: process.pid, ppid: 1, cpuPercent: 1.0, memoryBytes: 100 * 1024 * 1024, name: "node" },
        { pid: 6001, ppid: process.pid, cpuPercent: 0.5, memoryBytes: 40 * 1024 * 1024, name: "node" },
        { pid: 6101, ppid: 6001, cpuPercent: 12.0, memoryBytes: 256 * 1024 * 1024, name: "codex" },
      ],
      hostResourcesBotPids: () => new Map([["bot_q", 6001]]),
    });

    try {
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_q','Query Bot','codex','hq',1)");
      const conv = await hub.store.createConversation("owner", ["bot_q"], "Query Plan Chat", "conv_q", { type: "direct" });
      // Seed 500 historical completed/error/deleted messages with non-trivial bodies.
      await hub.store.db.run(
        `WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<500)
         INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at)
         SELECT 'hist_'||n,?,'bot_q','bot','[{"type":"text","text":"completed historical message body"}]',
           CASE WHEN n % 10 = 0 THEN 'deleted' WHEN n % 7 = 0 THEN 'error' ELSE 'complete' END,1,n
         FROM history`,
        [conv.id],
      );
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_active',?,'bot_q','bot',?,'streaming',1,?)",
        [conv.id, JSON.stringify([{ type: "text", text: "working…" }]), Date.now()],
      );

      const verifyIndexedPlan = async (targetHub: HubServer) => {
        const allSpy = vi.spyOn(targetHub.store.db, "all");
        try {
          const snap = hostResourcesSnapshotSchema.parse(await targetHub.hostResources.snapshot("owner", true, true));
          expect(snap.summary.activeTasks).toBe(1);
          expect(snap.bots[0]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([6101]);

          const activeTurnCall = allSpy.mock.calls.find(
            ([sql]) => sql.includes("FROM messages") && sql.includes("author_type='bot'") && sql.includes("pending"),
          );
          expect(activeTurnCall).toBeDefined();
          const plan = await targetHub.store.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${activeTurnCall![0]}`);
          expect(plan.length).toBeGreaterThan(0);
          expect(plan.some((row) => row.detail.includes("USING INDEX messages_active_bot_turns"))).toBe(true);
          expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
          // Zero full table scans of `messages`: every step touching `messages` must use an index.
          expect(plan.some((row) => /\bSCAN\s+messages\b/i.test(row.detail) && !row.detail.includes("USING INDEX") && !row.detail.includes("USING COVERING INDEX"))).toBe(false);
        } finally {
          allSpy.mockRestore();
        }
      };

      await verifyIndexedPlan(hub);

      // Reopening an existing store automatically creates the index without bumping schema_version past the latest (28).
      expect((await hub.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value).toBe("28");
      await hub.store.db.exec("DROP INDEX messages_active_bot_turns");
      await hub.close();

      hub = await HubServer.start({
        stateDir,
        hostResourcesSampler: async () => [
          { pid: process.pid, ppid: 1, cpuPercent: 1.0, memoryBytes: 100 * 1024 * 1024, name: "node" },
          { pid: 6001, ppid: process.pid, cpuPercent: 0.5, memoryBytes: 40 * 1024 * 1024, name: "node" },
          { pid: 6101, ppid: 6001, cpuPercent: 12.0, memoryBytes: 256 * 1024 * 1024, name: "codex" },
        ],
        hostResourcesBotPids: () => new Map([["bot_q", 6001]]),
      });
      expect((await hub.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value).toBe("28");
      await verifyIndexedPlan(hub);
    } finally {
      await hub.close();
    }
  });

  it("caches OS process samples for a short TTL, coalesces in-flight calls, blocks non-owner force bypass, and invalidates on stop", async () => {
    const hubPid = process.pid;
    let fakeNow = 1_700_000_000_000;
    let sampleCalls = 0;
    let releaseFirstSample!: () => void;
    let holdNextSample = true;
    const firstSampleGate = new Promise<void>((resolve) => { releaseFirstSample = resolve; });
    let failNextSample = false;
    let currentEngineMem = 300 * 1024 * 1024;
    let engineAlive = true;

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-cache-coalesce"),
      hostResourcesSampleCacheTtlMs: 2_500,
      hostResourcesNow: () => fakeNow,
      hostResourcesBotPids: () => new Map([["bot_c", 7201]]),
      hostResourcesKillPid: async () => { engineAlive = false; },
      hostResourcesSampler: async () => {
        sampleCalls += 1;
        if (holdNextSample) {
          holdNextSample = false;
          await firstSampleGate;
        }
        if (failNextSample) {
          failNextSample = false;
          throw new Error("transient_sampler_failure");
        }
        return [
          { pid: hubPid, ppid: 1, cpuPercent: 1.0, memoryBytes: 100 * 1024 * 1024, name: "node" },
          { pid: 7201, ppid: hubPid, cpuPercent: 0.4, memoryBytes: 40 * 1024 * 1024, name: "node" },
          ...(engineAlive ? [{ pid: 7301, ppid: 7201, cpuPercent: 25.0, memoryBytes: currentEngineMem, name: "codex" }] : []),
        ];
      },
    });

    try {
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_c','Cache Bot','codex','hc',1)");
      await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member_cache','Member','member')");
      await hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('member_cache','bot_c')");

      // 1. Concurrent requests coalesce onto a SINGLE in-flight OS sample.
      const p1 = hub.hostResources.snapshot("owner", true, false);
      const p2 = hub.hostResources.snapshot("owner", true, false);
      const p3 = hub.hostResources.snapshot("member_cache", false, false);
      releaseFirstSample();
      const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
      expect(sampleCalls).toBe(1);
      expect(s1.summary.engineMemoryBytes).toBe(340 * 1024 * 1024);
      expect(s2.summary.engineMemoryBytes).toBe(340 * 1024 * 1024);
      expect(s3.canStop).toBe(false);
      expect(s3.summary.engineMemoryBytes).toBe(340 * 1024 * 1024);

      // 2. Repeated reads within TTL reuse the cached OS sample without spawning another sample.
      fakeNow += 1_000;
      currentEngineMem = 450 * 1024 * 1024;
      const cachedOwner = await hub.hostResources.snapshot("owner", true, false);
      expect(sampleCalls).toBe(1);
      expect(cachedOwner.summary.engineMemoryBytes).toBe(340 * 1024 * 1024);

      // 3. Non-owner `?force=1` MUST NOT bypass the TTL cache.
      const memberForce = await hub.hostResources.snapshot("member_cache", false, true);
      expect(sampleCalls).toBe(1);
      expect(memberForce.summary.engineMemoryBytes).toBe(340 * 1024 * 1024);

      // 4. Owner explicit refresh (`force=true`) bypasses cache and updates it.
      const ownerForce = await hub.hostResources.snapshot("owner", true, true);
      expect(sampleCalls).toBe(2);
      expect(ownerForce.summary.engineMemoryBytes).toBe(490 * 1024 * 1024);

      // 5. After TTL expires, ordinary read refreshes cleanly.
      fakeNow += 2_600;
      currentEngineMem = 520 * 1024 * 1024;
      const afterTtl = await hub.hostResources.snapshot("owner", true, false);
      expect(sampleCalls).toBe(3);
      expect(afterTtl.summary.engineMemoryBytes).toBe(560 * 1024 * 1024);

      // 6. Stop by PID forces a fresh ancestry check AND invalidates the cache afterward.
      const stopRes = await hub.hostResources.stop("owner", { botId: "bot_c", pid: 7301 });
      expect(stopRes).toEqual({ ok: true, stopped: true, method: "process_tree" });
      expect(sampleCalls).toBe(4);
      const afterStop = await hub.hostResources.snapshot("owner", true, false);
      expect(sampleCalls).toBe(5);
      expect(afterStop.summary.engineMemoryBytes).toBe(40 * 1024 * 1024);

      // 7. A rejected sample never wedges inflight state; subsequent calls recover.
      fakeNow += 3_000;
      failNextSample = true;
      await expect(hub.hostResources.snapshot("owner", true, false)).rejects.toThrow("transient_sampler_failure");
      expect(sampleCalls).toBe(6);
      const recovered = await hub.hostResources.snapshot("owner", true, false);
      expect(sampleCalls).toBe(7);
      expect(recovered.summary.engineMemoryBytes).toBe(40 * 1024 * 1024);
    } finally {
      await hub.close();
    }
  });

  it("avoids blind positional PID assignment on multi-turn Bots and supports exact turnPids linkage when available", async () => {
    const hubPid = process.pid;
    let turnPidsMap: ReadonlyMap<string, readonly number[]> | undefined;
    const samples: OsProcessSample[] = [
      { pid: hubPid, ppid: 1, cpuPercent: 1.0, memoryBytes: 100 * 1024 * 1024, name: "node" },
      // Bot gateway + TWO direct children (e.g. shared engine worker + MCP helper, or two workers)
      { pid: 7500, ppid: hubPid, cpuPercent: 0.5, memoryBytes: 40 * 1024 * 1024, name: "node" },
      { pid: 7510, ppid: 7500, cpuPercent: 18.0, memoryBytes: 280 * 1024 * 1024, name: "codex-app-server" },
      { pid: 7511, ppid: 7510, cpuPercent: 22.0, memoryBytes: 120 * 1024 * 1024, name: "pytest" },
      { pid: 7520, ppid: 7500, cpuPercent: 4.0, memoryBytes: 90 * 1024 * 1024, name: "mcp-helper" },
    ];

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-multiturn"),
      hostResourcesSampler: async () => samples,
      hostResourcesBotPids: () => new Map([["bot_multi", 7500]]),
      hostResourcesTurnPids: (botId) => (botId === "bot_multi" ? turnPidsMap : undefined),
    });

    try {
      const now = Date.now();
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_multi','Multi Bot','codex','hm',1)");
      await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member_m','Member M','member')");
      await hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('member_m','bot_multi')");

      const ownerConv1 = await hub.store.createConversation("owner", ["bot_multi"], "Owner Task 1", "conv_o1", { type: "direct" });
      const ownerConv2 = await hub.store.createConversation("owner", ["bot_multi"], "Owner Task 2", "conv_o2", { type: "direct" });
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('m_o1',?,'bot_multi','bot',?,'streaming',1,?)",
        [ownerConv1.id, JSON.stringify([{ type: "text", text: "running 1" }]), now],
      );
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('m_o2',?,'bot_multi','bot',?,'streaming',1,?)",
        [ownerConv2.id, JSON.stringify([{ type: "text", text: "running 2" }]), now + 100],
      );

      // Case 1: WITHOUT exact turnPids linkage — NEVER blindly assign 7510 -> Owner Task 1 and 7520 -> Owner Task 2!
      const unlinkedOwner = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      const botGroup = unlinkedOwner.bots[0]!;
      expect(botGroup.activeTurns).toBe(2);
      expect(botGroup.conversations).toHaveLength(2);
      expect(botGroup.conversations.every((c) => c.active && c.stoppable && c.processes.length === 0 && c.memoryBytes === 0)).toBe(true);
      // All engine processes stay truthfully grouped under the Bot and contribute to Bot totals!
      expect(botGroup.unattributed.map((p) => p.pid).sort((a, b) => a - b)).toEqual([7500, 7510, 7511, 7520]);
      expect(botGroup.memoryBytes).toBe((40 + 280 + 120 + 90) * 1024 * 1024);

      // Case 2: Member also has an active turn on the same Bot alongside owner's hidden turns, EVEN WITH directChildren.length >= allTurns.length!
      // Owner's processes (7510, 7511, 7520) MUST NEVER leak to member_m!
      const memberConv = await hub.store.createConversation("member_m", ["bot_multi"], "Member Task", "conv_m1", { type: "direct" });
      await hub.store.db.run("DELETE FROM messages WHERE id='m_o2'");
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('m_m1',?,'bot_multi','bot',?,'streaming',1,?)",
        [memberConv.id, JSON.stringify([{ type: "text", text: "member running" }]), now + 200],
      );
      const unlinkedMember = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_m", false, false));
      expect(unlinkedMember.bots[0]!.activeTurns).toBe(1);
      expect(unlinkedMember.bots[0]!.conversations).toHaveLength(1);
      expect(unlinkedMember.bots[0]!.conversations[0]!.conversationId).toBe(memberConv.id);
      expect(unlinkedMember.bots[0]!.conversations[0]!.processes).toEqual([]);
      expect(unlinkedMember.bots[0]!.unattributed.map((p) => p.pid)).toEqual([7500]);
      for (const hiddenPid of [7510, 7511, 7520]) {
        expect(JSON.stringify(unlinkedMember)).not.toContain(`"pid":${hiddenPid}`);
      }

      // Case 3: WITH exact turnPids linkage — each conversation gets its exact linked PID subtree,
      // while hidden owner turns remain invisible to member_m!
      turnPidsMap = new Map<string, readonly number[]>([
        [ownerConv1.id, [7510]],
        [memberConv.id, [7520]],
      ]);
      const linkedMember = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_m", false, false));
      expect(linkedMember.bots[0]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([7520]);
      expect(JSON.stringify(linkedMember)).not.toContain(`"pid":7510`);
      expect(JSON.stringify(linkedMember)).not.toContain(`"pid":7511`);

      const linkedOwner = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      expect(linkedOwner.bots[0]!.conversations).toHaveLength(1);
      expect(linkedOwner.bots[0]!.conversations[0]!.conversationId).toBe(ownerConv1.id);
      expect(linkedOwner.bots[0]!.conversations[0]!.processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([7510, 7511]);
      // Member's linked PID (7520) is shown under Bot unattributed for owner without leaking member conversation title.
      expect(linkedOwner.bots[0]!.unattributed.map((p) => p.pid).sort((a, b) => a - b)).toEqual([7500, 7520]);
    } finally {
      await hub.close();
    }
  });
});
