import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { dispatcherInstructions } from "../src/gateway/agent-instructions.js";

const root = path.resolve(import.meta.dirname, "..");

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("Superagent English naming and New Bot experimental copy (#123)", () => {
  it("uses Superagent (not Chancellor) in English UI strings, CLI help, and Bot guidance", () => {
    const enLocale = JSON.parse(readFileSync(path.join(root, "client/src/locales/en.json"), "utf8")) as Record<string, string>;
    const remaining = Object.entries(enLocale).filter(([, value]) => /\bchancellor\b/i.test(value));
    expect(remaining).toEqual([]);

    expect(enLocale["作为幕僚长"]).toBe("Make it a Superagent");
    expect(enLocale["幕僚长"]).toBe("Superagent");
    expect(enLocale["幕僚长设置"]).toBe("Superagent settings");
    expect(enLocale["实验功能"]).toBe("Experimental");
    expect(enLocale["superagent：你只说目标，它拆分任务，调用本机已装的 CLI 去做。只能在创建时选择。"]).toBe(
      "Tell it the goal; it splits the work and runs it with the CLIs installed on this host. Can only be chosen at creation."
    );

    const cliSource = readFileSync(path.join(root, "src/host-cli/cli.ts"), "utf8");
    expect(cliSource).toContain("创建幕僚长（Superagent）");
    expect(cliSource).not.toMatch(/\bchancellor\b/i);

    const instructions = dispatcherInstructions("msg_test");
    expect(instructions).toContain("幕僚长 (Superagent)");
    expect(instructions).not.toMatch(/\bchancellor\b/i);

    for (const rel of [
      "src/core/commands.ts",
      "src/core/config-card.ts",
      "src/core/shared/engine-commands.ts",
      "src/state/instance-config.ts",
      "src/ui/ui-api.ts",
    ]) {
      const content = readFileSync(path.join(root, rel), "utf8");
      expect(content, rel).not.toContain("Chief of Staff");
      expect(content, rel).toContain("Pi is available for ordinary Bots, not Superagent Bots.");
    }
  });

  it("shows the experimental badge and concise superagent Chinese hint in NewBot", () => {
    const newBot = readFileSync(path.join(root, "client/src/NewBot.tsx"), "utf8");
    expect(newBot).toContain('t("作为幕僚长")');
    expect(newBot).toContain('className="new-bot-experimental-badge">{t("实验功能")}');
    expect(newBot).toContain('t("superagent：你只说目标，它拆分任务，调用本机已装的 CLI 去做。只能在创建时选择。")');
    expect(newBot).toContain('t("刚开始建议先建普通 Bot，这里不勾选。")');
  });

  it("has no user-visible English Chancellor prose in README or docs Markdown", () => {
    const files = [
      path.join(root, "README.md"),
      path.join(root, "README.en.md"),
      path.join(root, "README.zh-CN.md"),
      path.join(root, "assets/product/README.md"),
      ...walkMarkdown(path.join(root, "docs")),
    ];
    const leaks: string[] = [];
    for (const file of files) {
      const stripped = readFileSync(file, "utf8")
        .replace(/assets\/product\/chancellor[^\s)"'>]*/g, "")
        .replace(/<a id="chancellor"><\/a>/g, "")
        .replace(/README\.md#chancellor/g, "");
      if (/\bchancellor\b/i.test(stripped)) {
        leaks.push(path.relative(root, file));
      }
    }
    expect(leaks).toEqual([]);
  });

  it("keeps workspaces-capture.json and demo-capture.json hashes synced with disk and uses Superagent in demo-capture.json", () => {
    const sha256 = (rel: string) => createHash("sha256").update(readFileSync(path.join(root, rel))).digest("hex");
    const workspaces = JSON.parse(readFileSync(path.join(root, "assets/product/workspaces-capture.json"), "utf8")) as {
      images: Array<{ file: string; sha256: string }>;
      animations: Array<{ file: string; sha256: string }>;
    };
    for (const item of [...workspaces.images, ...workspaces.animations]) {
      expect(sha256(`assets/product/${item.file}`), item.file).toBe(item.sha256);
    }

    const demo = JSON.parse(readFileSync(path.join(root, "assets/product/demo-capture.json"), "utf8")) as {
      images: Array<{ file: string; locale: string; sha256: string; scenes: Array<{ label: string; source: string; sourceSha256: string }> }>;
    };
    for (const image of demo.images) {
      expect(sha256(`assets/product/${image.file}`), image.file).toBe(image.sha256);
      for (const scene of image.scenes) {
        expect(sha256(`assets/product/${scene.source}`), `${image.file} -> ${scene.source}`).toBe(scene.sourceSha256);
      }
    }
    const enDemo = demo.images.find(image => image.locale === "en");
    expect(enDemo).toBeDefined();
    expect(enDemo!.scenes.map(scene => scene.label)).toContain("Superagent · Follow every ticket.");
    expect(enDemo!.scenes.some(scene => /\bchancellor\b/i.test(scene.label))).toBe(false);
  });
});
