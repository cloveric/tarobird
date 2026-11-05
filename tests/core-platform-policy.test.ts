import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleCoreGroupCommandBeforeAccess } from "../src/core/commands.js";
import { applyCoreConfigCardAction } from "../src/core/config-card.js";
import { checkGroupMsgScope, renderGroupMsgScopeWarning } from "../src/core/group-scope-check.js";
import { normalizeCoreMessage } from "../src/core/message-normalizer.js";
import { withPlatformPolicy, type PlatformPolicy } from "../src/core/platform-policy.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { maybeSendLarkScopeAuthCard } from "../src/core/scope-auth.js";

// Scope checks and scope-auth cards are platform policies. Core never inspects
// an app on its own; these fixtures inject an explicit fake policy instead.
function fakeScopePolicy() {
  const checkGroupScope = vi.fn<NonNullable<PlatformPolicy["checkGroupScope"]>>(async () => "missing");
  const groupScopeWarning = vi.fn<NonNullable<PlatformPolicy["groupScopeWarning"]>>(
    (locale, appId, domain, instanceName) => `SCOPE-WARNING ${locale} ${appId} ${domain} ${instanceName}`,
  );
  return { policy: { checkGroupScope, groupScopeWarning } satisfies PlatformPolicy, checkGroupScope, groupScopeWarning };
}

describe("core group-message scope policy", () => {
  it("returns 'unknown' and no warning when no platform policy is selected (never nags or probes)", async () => {
    expect(await checkGroupMsgScope({ appId: "cli_x", appSecret: "sek" })).toBe("unknown");
    expect(await checkGroupMsgScope({})).toBe("unknown");
    expect(renderGroupMsgScopeWarning("zh", "cli_x", "feishu", "alpha")).toBe("");
  });
});

describe("core scope-auth policy", () => {
  const channel = () => ({
    send: vi.fn(async () => ({ messageId: "sent_1" })),
    stream: vi.fn(async () => ({ messageId: "stream_1" })),
    downloadResource: vi.fn(async () => Buffer.alloc(0)),
  });

  it("returns false and sends nothing when no platform policy is selected", async () => {
    const target = channel();

    await expect(maybeSendLarkScopeAuthCard({ channel: target, chatId: "oc_chat", appId: "cli_x", locale: "en" }, new Error("code 99991672"))).resolves.toBe(false);
    expect(target.send).not.toHaveBeenCalled();
  });

  it("hands the failed operation to the selected policy unchanged", async () => {
    const target = channel();
    const error = new Error("permission denied");
    const scopeAuth = vi.fn<NonNullable<PlatformPolicy["scopeAuth"]>>(async () => true);
    const input = { channel: target, chatId: "oc_chat", appId: "cli_x", domain: "feishu", options: { replyTo: "om_1" }, locale: "zh" as const };

    await expect(withPlatformPolicy({ scopeAuth }, () => maybeSendLarkScopeAuthCard(input, error))).resolves.toBe(true);
    expect(scopeAuth).toHaveBeenCalledWith(input, error);
  });
});

describe("group scope credential propagation", () => {
  it("passes runtime credentials to the selected policy for /group all when service secrets are absent from process.env", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-group-scope-runtime-"));
    const runtime = createCoreServiceRuntime();
    runtime.appInfo = { appId: "cli_runtime", appSecret: "runtime-secret", domain: "feishu" };
    const channel = { send: vi.fn(async () => ({ messageId: "sent_1" })) };
    const { policy, checkGroupScope, groupScopeWarning } = fakeScopePolicy();
    const normalized = normalizeCoreMessage({
      messageId: "om_group_all",
      chatId: "oc_group",
      chatType: "group",
      senderId: "ou_user",
      content: "/group all",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    });

    try {
      const handled = await withPlatformPolicy(policy, () => handleCoreGroupCommandBeforeAccess({
        channel: channel as never,
        bridge: {
          checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
        } as never,
        runtime,
        stateDir,
        instanceName: "alpha",
        requestApproval: vi.fn() as never,
      }, normalized!, "/group all", "en"));

      expect(handled).toBe(true);
      expect(checkGroupScope).toHaveBeenCalledWith({
        appId: "cli_runtime",
        appSecret: "runtime-secret",
        domain: "feishu",
      });
      expect(groupScopeWarning).toHaveBeenCalledWith("en", "cli_runtime", "feishu", "alpha");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("SCOPE-WARNING en cli_runtime feishu alpha");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps runtime credentials on the config-card submit path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-group-scope-config-submit-"));
    const { policy, checkGroupScope } = fakeScopePolicy();

    try {
      const result = await withPlatformPolicy(policy, () => applyCoreConfigCardAction(stateDir, {
        cctb_lark: "config",
        action: "submit",
        conversationKey: "lark:oc_group",
        bridgeChatType: "group",
        larkChatId: "oc_group",
      }, "en", {
        engine: "codex",
        fast: "off",
        yolo: "off",
        locale: "en",
        group: "all",
      }, {
        appId: "cli_runtime",
        appSecret: "runtime-secret",
        domain: "feishu",
        instanceName: "alpha",
      }));

      expect(checkGroupScope).toHaveBeenCalledWith({
        appId: "cli_runtime",
        appSecret: "runtime-secret",
        domain: "feishu",
      });
      expect(result).toContain("SCOPE-WARNING en cli_runtime feishu alpha");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
