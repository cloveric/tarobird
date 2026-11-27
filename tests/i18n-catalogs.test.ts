import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import englishUi from "../client/src/locales/en.json" with { type: "json" };
import japaneseUi from "../client/src/locales/ja.json" with { type: "json" };
import { commandDescription, getLocale, setLocale, syncSystemLocale, t, UI_CATALOGS } from "../client/src/i18n.js";
import { resolveLocalePreference, storedLocale, systemLocale } from "../client/src/system-locale.js";
import { renderCoreConfigCard } from "../src/core/config-card.js";
import { renderCoreUserFacingError, renderedEngineFailure, renderedEngineResetHint } from "../src/core/errors.js";
import { gatewayNativeCommandHelp, renderGatewayHelp } from "../src/gateway/commands.js";
import { HOST_EN } from "../src/locales/host-en.js";
import { HOST_JA } from "../src/locales/host-ja.js";
import { hostT } from "../src/locales/index.js";
import { prepareArchiveContinueWorkflow } from "../src/runtime/file-workflow.js";
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  localeBcp47,
  localeIntlTag,
  normalizeLocale,
  translateFromCatalogs,
} from "../src/runtime/locale.js";

const extractPlaceholders = (value: string) =>
  [...value.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(",");

afterEach(() => {
  setLocale("zh");
  vi.unstubAllGlobals();
});

describe("multi-language normalization and tags", () => {
  it("normalizes supported locales and maps tags cleanly", () => {
    expect(SUPPORTED_LOCALES).toEqual(["zh", "en", "ja"]);
    expect(SUPPORTED_LANGUAGES.map((entry) => entry.nativeName)).toEqual(["中文", "English", "日本語"]);
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(normalizeLocale("JA_jp")).toBe("ja");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh");
    expect(normalizeLocale("fr-FR", "en")).toBe("en");
    expect(normalizeLocale(undefined, "zh")).toBe("zh");
    expect(isSupportedLocale("ja")).toBe(true);
    expect(isSupportedLocale("fr")).toBe(false);
    expect(localeBcp47("zh")).toBe("zh-CN");
    expect(localeBcp47("en")).toBe("en");
    expect(localeBcp47("ja")).toBe("ja");
    expect(localeIntlTag("ja")).toBe("ja-JP");
  });

  it("resolves follow-system preference from navigator.language / languages", () => {
    expect(systemLocale({ language: "ja-JP" })).toBe("ja");
    expect(systemLocale({ languages: ["ja", "en-US"], language: "en-US" })).toBe("ja");
    expect(systemLocale({ languages: ["zh-TW", "en"] })).toBe("zh");
    expect(systemLocale({ languages: ["es-ES"] })).toBe("en");
    expect(storedLocale(undefined)).toBe("system");
    expect(resolveLocalePreference("system", { language: "ja-JP" })).toBe("ja");
  });

  it("updates active UI locale and <html lang> when follow-system changes", () => {
    const doc = { documentElement: { lang: "zh-CN" } };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("navigator", { language: "ja-JP", languages: ["ja-JP"] });

    setLocale("system");
    expect(doc.documentElement.lang).toBe("ja");
    expect(t("设置")).toBe("設定");
    expect(t("跟随系统")).toBe("システムに従う");

    vi.stubGlobal("navigator", { language: "fr-FR", languages: ["fr-FR"] });
    syncSystemLocale();
    expect(doc.documentElement.lang).toBe("en");
    expect(t("设置")).toBe("Settings");
  });
});

describe("English fallback for missing keys or unsupported non-Chinese locales", () => {
  it("never falls back to raw Chinese when a non-Chinese key is missing", () => {
    const catalogs = {
      en: { "设置": "Settings", "共 {0} 项": "{0} items" },
      ja: { "设置": "設定", "共 {0} 项": "   " },
    };
    expect(translateFromCatalogs("ja", catalogs, "设置")).toBe("設定");
    expect(translateFromCatalogs("ja", catalogs, "共 {0} 项", [3])).toBe("3 items");
    expect(translateFromCatalogs("fr", catalogs, "设置")).toBe("Settings");
    expect(translateFromCatalogs("zh", catalogs, "设置")).toBe("设置");
  });

  it("resolves slash command descriptions for ja and BCP-47 tags with en fallback", () => {
    const description = {
      defaultValue: "Fallback",
      i18n: { en_us: "English description", ja_jp: "日本語の説明", zh_cn: "中文说明" },
    };
    expect(commandDescription(description, "ja")).toBe("日本語の説明");
    expect(commandDescription(description, "ja-JP")).toBe("日本語の説明");
    expect(commandDescription(description, "zh-CN")).toBe("中文说明");
    expect(commandDescription(description, "fr-FR")).toBe("English description");
    expect(commandDescription({ defaultValue: "Fallback", i18n: { en_us: "English only" } }, "ja")).toBe("English only");
  });

  it("normalizes BCP-47 tags in gateway help and native command guidance", () => {
    expect(renderGatewayHelp("codex", "ja-JP")).toContain("**TaroBird App ヘルプ**");
    expect(renderGatewayHelp("codex", "zh-CN")).toContain("**TaroBird App 使用帮助**");
    expect(renderGatewayHelp("codex", "fr-FR")).toContain("**TaroBird App help**");
    expect(gatewayNativeCommandHelp("group", "ja-JP")).toContain("会話一覧からグループ");
    expect(gatewayNativeCommandHelp("group", "zh-CN")).toContain("在会话列表创建群组和话题");
  });
});

describe("App UI translation catalogs", () => {
  it("covers all en.json keys in ja.json with non-empty strings and matching placeholders", () => {
    const enKeys = Object.keys(englishUi);
    const jaMap = japaneseUi as Record<string, string>;
    expect(Object.keys(UI_CATALOGS)).toEqual(["en", "ja"]);
    expect(enKeys.length).toBeGreaterThan(5000);
    for (const key of enKeys) {
      const jaValue = jaMap[key];
      expect(typeof jaValue, `Missing ja translation for ${key}`).toBe("string");
      expect(jaValue.trim().length, `Empty ja translation for ${key}`).toBeGreaterThan(0);
      expect(extractPlaceholders(jaValue), `Placeholder mismatch for ${key}`).toBe(extractPlaceholders(key));
    }
  });
});

describe("Host message catalogs and core Japanese support", () => {
  it("keeps HOST_EN and HOST_JA 100% aligned with matching placeholders", () => {
    const enKeys = Object.keys(HOST_EN);
    const jaKeys = Object.keys(HOST_JA);
    expect(enKeys.length).toBeGreaterThan(1000);
    expect([...jaKeys].sort()).toEqual([...enKeys].sort());
    for (const key of enKeys) {
      const enVal = HOST_EN[key as keyof typeof HOST_EN];
      const jaVal = HOST_JA[key as keyof typeof HOST_JA];
      expect(enVal.trim().length, `Empty HOST_EN for ${key}`).toBeGreaterThan(0);
      expect(jaVal.trim().length, `Empty HOST_JA for ${key}`).toBeGreaterThan(0);
      expect(extractPlaceholders(enVal), `HOST_EN placeholder mismatch for ${key}`).toBe(extractPlaceholders(key));
      expect(extractPlaceholders(jaVal), `HOST_JA placeholder mismatch for ${key}`).toBe(extractPlaceholders(key));
    }
  });

  it("resolves hostT in zh, en, ja, and falls back to en for unknown non-Chinese locales", () => {
    expect(hostT("zh", "已停止。")).toBe("已停止。");
    expect(hostT("en", "已停止。")).toBe("Stopped.");
    expect(hostT("ja", "已停止。")).toBe("停止しました。");
    expect(hostT("de", "已停止。")).toBe("Stopped.");
    expect(hostT(undefined, "已停止。")).toBe("已停止。");
    expect(hostT("ja", "{0} 个配对用户，{1} 个白名单用户", 2, 5)).toBe("ペアリング済み 2 名、許可リスト 5 名");
  });

  it("recognizes Japanese rendered engine errors and reset hints", () => {
    const jaQuota = renderCoreUserFacingError(
      new Error("quota exceeded; resets 2026-12-01"),
      "engine",
      "ja",
    );
    expect(jaQuota).toContain("利用枠の上限に達しました");
    expect(renderedEngineFailure(jaQuota)).toMatchObject({ category: "engine-quota" });

    const jaWithReset = `${jaQuota} リセット情報：2026-12-01。`;
    expect(renderedEngineResetHint(jaWithReset)).toBe("2026-12-01");
    expect(renderedEngineFailure(jaWithReset)).toEqual({
      category: "engine-quota",
      resetHint: "2026-12-01",
    });

    const jaAuth = hostT("ja", "错误：引擎尚未登录或登录已过期。请先在本机完成认证登录后重试。");
    expect(renderedEngineFailure(jaAuth)).toEqual({ category: "auth" });
  });

  it("renders Japanese option, BCP-47 selection, and clean Chinese heading in core config card", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tarobird-i18n-card-"));
    try {
      const jaCard = await renderCoreConfigCard({
        stateDir,
        conversationKey: "chat:1",
        bridgeChatType: "private",
        larkChatId: "chat_1",
        bridgeChatId: 1,
        locale: "ja-JP",
      });
      const jaJson = JSON.stringify(jaCard);
      expect(jaJson).toContain("✓ 日本語");
      expect(jaJson).toContain("エンジン");
      expect(jaJson).toContain("**言語**");
      expect(jaJson).toContain('"initial_option":"ja"');

      const zhCard = await renderCoreConfigCard({
        stateDir,
        conversationKey: "chat:1",
        bridgeChatType: "private",
        larkChatId: "chat_1",
        bridgeChatId: 1,
        locale: "zh",
      });
      const zhJson = JSON.stringify(zhCard);
      expect(zhJson).toContain("**语言**");
      expect(zhJson).not.toContain("语言区块");

      const enCard = await renderCoreConfigCard({
        stateDir,
        conversationKey: "chat:1",
        bridgeChatType: "private",
        larkChatId: "chat_1",
        bridgeChatId: 1,
        locale: "en",
      });
      const enJson = JSON.stringify(enCard);
      expect(enJson).toContain("**Language**");
      expect(enJson).toContain("- Locale:");
    } finally {
      await fs.promises.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves English /board run-succeeded copy and archive continue default locale", async () => {
    expect(hostT("en", "已通过 {0} 执行 {1}，状态：进入复核。", "Mini Bus writer", "B1"))
      .toBe("Ran B1 via Mini Bus writer; status: moved to review.");
    expect(hostT("en", "已通过 {0} 执行 {1}，状态：已完成。", "Agent Bus writer-bot", "B1"))
      .toBe("Ran B1 via Agent Bus writer-bot; status: done.");

    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tarobird-i18n-archive-"));
    try {
      const enDefault = await prepareArchiveContinueWorkflow({ stateDir, chatId: 1, text: "/continue" });
      expect(enDefault).toEqual({ kind: "reply", text: "There is no archive waiting for continued analysis in this chat." });
      const zhReply = await prepareArchiveContinueWorkflow({ stateDir, chatId: 1, text: "/continue", locale: "zh" });
      expect(zhReply).toEqual({ kind: "reply", text: "当前聊天中没有等待继续分析的压缩包。" });
      const jaReply = await prepareArchiveContinueWorkflow({ stateDir, chatId: 1, text: "/continue", locale: "ja-JP" });
      expect(jaReply).toEqual({ kind: "reply", text: "現在のチャットに解析再開待ちのアーカイブはありません。" });
    } finally {
      await fs.promises.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps module-level UI locale deterministic until setLocale is called", () => {
    expect(getLocale()).toBe("zh");
  });
});
