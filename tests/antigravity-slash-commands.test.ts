import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_APP_COMMANDS } from "../src/gateway/antigravity-commands.js";
import { gatewayCommands, renderGatewayHelp } from "../src/gateway/commands.js";
import {
  parseAntigravityLocalCommand,
  renderAntigravityLocalCommandReply,
} from "../src/core/shared/antigravity-commands.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { blocksText } from "../src/client-protocol/index.js";

describe("Antigravity slash commands adaptation (#187)", () => {
  it("exposes adapted Antigravity slash commands (excluding /btw and /remote-control) with bilingual copy", () => {
    const names = ANTIGRAVITY_APP_COMMANDS.map((c) => c.command);
    for (const expected of [
      "swarm",
      "grill-me",
      "plan",
      "teamwork",
      "run-workflow",
      "browser",
      "learn",
      "automation",
      "schedule",
      "boost",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain("btw");
    expect(names).not.toContain("remote-control");
    expect(names).not.toContain("goal");
    expect(names).not.toContain("compact");
    for (const entry of ANTIGRAVITY_APP_COMMANDS) {
      expect(entry.description.i18n.en_us.trim().length).toBeGreaterThan(0);
      expect(entry.description.i18n.zh_cn.trim().length).toBeGreaterThan(0);
      expect(entry.description.i18n.zh_cn).not.toBe(entry.description.i18n.en_us);
    }

    // Antigravity menu works immediately before ACP advertises anything and orders curated commands before generic skills.
    // Excluded commands like /remote-control stay hidden even if advertised dynamically over ACP.
    const live = [
      { name: "zzz-custom-skill", description: "Custom skill" },
      { name: "swarm", description: "Raw English swarm description" },
      { name: "remote-control", description: "Remote control over QR" },
    ];
    const menu = gatewayCommands("antigravity", "", live);
    expect(menu.filter((c) => c.command === "swarm")).toHaveLength(1);
    expect(menu.some((c) => c.command.toLowerCase() === "remote-control")).toBe(false);
    expect(menu.findIndex((c) => c.command === "swarm")).toBeLessThan(menu.findIndex((c) => c.command === "zzz-custom-skill"));
    expect(renderGatewayHelp("antigravity", "zh")).toContain("/swarm");
    expect(renderGatewayHelp("antigravity", "zh")).toContain("/run-workflow");
    expect(renderGatewayHelp("antigravity", "en")).toContain("/grill-me");
    expect(renderGatewayHelp("antigravity", "en")).not.toContain("/remote-control");
  });

  it("parses only /automation locally while letting /swarm board and /swarm <task> pass through to the ACP swarm handler", () => {
    expect(parseAntigravityLocalCommand("/swarm board")).toBeNull();
    expect(parseAntigravityLocalCommand("/swarm board --watch")).toBeNull();
    expect(parseAntigravityLocalCommand("/swarm split work across packages")).toBeNull();
    expect(parseAntigravityLocalCommand("/remote-control")).toBeNull();
    expect(parseAntigravityLocalCommand("/automation")).toEqual({ kind: "automation", request: "" });
    expect(parseAntigravityLocalCommand("/automation every morning at 9am check CI")).toEqual({
      kind: "automation",
      request: "every morning at 9am check CI",
    });
    expect(parseAntigravityLocalCommand("/plan design api")).toBeNull();
    expect(parseAntigravityLocalCommand("/grill-me")).toBeNull();
  });

  it("renders localized replies for /automation", async () => {
    const autoEn = await renderAntigravityLocalCommandReply(
      { kind: "automation", request: "Summarize CI every morning" },
      "en",
    );
    expect(autoEn.commandLabel).toBe("/automation");
    expect(autoEn.markdown).toContain("/cron add 0 9 * * * Summarize CI every morning");
    expect(autoEn.markdown).toContain("/schedule Summarize CI every morning");

    const autoZh = await renderAntigravityLocalCommandReply(
      { kind: "automation", request: "每天早上9点汇总日报" },
      "zh",
    );
    expect(autoZh.markdown).toContain("/cron add 0 9 * * * 每天早上9点汇总日报");
    expect(autoZh.markdown).toContain("/schedule 每天早上9点汇总日报");
  });

  it("handles /automation locally on Antigravity while forwarding /swarm board, native commands & /goal stop cleanly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-slash-gw-"));
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({ engine: "antigravity", antigravityRuntime: "acp", locale: "zh" }),
    );
    const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run(
      "INSERT INTO bots(id,name,engine,secret_hash) VALUES('agy','Antigravity','antigravity',?)",
      [hashSecret(secret)],
    );
    const forwarded: string[] = [];
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        forwarded.push(input.text);
        return { text: `FORWARDED:${input.text}` };
      }),
    };
    const channel = await attachGateway({
      stateDir,
      url: hub.url.replace("http", "ws") + "/instance",
      botId: "agy",
      secret,
      engine: "antigravity",
      bridge,
      runtime: createCoreServiceRuntime(),
    });
    try {
      const conv = await hub.store.createConversation("owner", ["agy"], "AGY Commands", "create");
      const send = async (text: string) => {
        const { message } = await hub.store.sendMessage("owner", {
          conversationId: conv.id,
          clientMsgId: `m_${randomBytes(8).toString("hex")}`,
          text,
          attachments: [],
        });
        await vi.waitFor(async () => expect(await hub.store.pendingForBot("agy")).toHaveLength(0), { timeout: 5_000 });
        const replies = (await hub.store.snapshot("owner", conv.id)).messages.filter(
          (m) => m.authorType === "bot" && m.replyTo === message.id,
        );
        return replies.map((m) => blocksText(m.blocks)).join("\n");
      };

      const autoReply = await send("/automation 每周一检查依赖");
      expect(autoReply).toContain("/cron add 0 9 * * * 每周一检查依赖");
      expect(forwarded).toHaveLength(0);

      // Native ACP commands and `/swarm board` pass through cleanly to the engine adapter (PR #167 real Swarm board).
      await send("/swarm board");
      await send("/swarm split across client and host");
      await send("/grill-me design the notification center");
      await send("/plan add dark mode");
      await send("/teamwork ship offline cache");
      await send("/run-workflow audit open PRs");
      await send("/browser inspect checkout page");
      await send("/learn capture testing rule");
      await send("/goal stop");
      expect(forwarded).toEqual([
        "/swarm board",
        "/swarm split across client and host",
        "/grill-me design the notification center",
        "/plan add dark mode",
        "/teamwork ship offline cache",
        "/run-workflow audit open PRs",
        "/browser inspect checkout page",
        "/learn capture testing rule",
        "/goal clear",
      ]);
    } finally {
      await channel.disconnect();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
