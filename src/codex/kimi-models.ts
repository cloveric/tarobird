import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import type { ModelSettings } from "../client-protocol/model.js";

type Choice = ModelSettings["choices"][number];
export type KimiModel = Choice & { defaultThinking?: string };
export type KimiModelConfig = { defaultModel?: string; models: KimiModel[] };
const levels = ["low", "high", "max"] as const;
const maxBytes = 1024 * 1024;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const modelId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\p{Cc}]/u.test(value);

/** Only expose model metadata: config.toml also contains provider credentials.
 * Read fresh so native /model and catalog updates take effect at safe boundaries.
 * Bound the read, reject special files, and allow ordinary config symlinks. */
export async function readKimiModelConfig(env = process.env, home?: string): Promise<KimiModelConfig> {
  try {
    const file = await realpath(path.join(home ?? env.KIMI_CODE_HOME ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".kimi-code"), "config.toml"));
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let contents: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return { models: [] };
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > stat.size) return { models: [] };
      contents = bytes.subarray(0, size).toString("utf8");
    } finally { await handle.close(); }
    const config = parse(contents);
    const models: KimiModel[] = [];
    for (const [id, value] of Object.entries(record(config.models) ?? {}).slice(0, 512)) {
      const model = record(value);
      if (!modelId(id) || !model || !modelId(model.model) || typeof model.provider !== "string") continue;
      const efforts: Choice["efforts"] = ["", ...levels.filter(level => Array.isArray(model.support_efforts) && model.support_efforts.includes(level))];
      const alwaysThinking = Array.isArray(model.capabilities) && model.capabilities.includes("always_thinking");
      const canThink = Array.isArray(model.capabilities) && model.capabilities.includes("thinking");
      const defaultThinking = canThink && !alwaysThinking && record(config.thinking)?.enabled === false ? "off"
        : levels.includes(model.default_effort as typeof levels[number]) && efforts.includes(model.default_effort as typeof levels[number]) ? model.default_effort as string
        : alwaysThinking && efforts.length === 1 ? "on" : undefined;
      const label = typeof model.display_name === "string" ? model.display_name.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) : undefined;
      models.push({ id, ...(label ? { label } : {}), efforts, ...(defaultThinking ? { defaultThinking } : {}) });
    }
    return { ...(modelId(config.default_model) ? { defaultModel: config.default_model } : {}), models };
  } catch {
    // Missing/old/malformed configuration leaves native ACP in charge. Never
    // echo TOML parse errors: they may contain credentials from nearby lines.
    return { models: [] };
  }
}
