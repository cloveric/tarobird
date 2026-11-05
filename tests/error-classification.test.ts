import { describe, expect, it } from "vitest";

import { FileWorkflowPreparationError } from "../src/runtime/file-workflow.js";
import {
  classifyFailure,
  getBusErrorSemantics,
  isStaleSessionError,
} from "../src/runtime/error-classification.js";
import { renderCoreUserFacingError, renderedEngineFailure } from "../src/core/errors.js";
import { engineRetryReason } from "../src/codex/turn-retry.js";
import { claudeError } from "../src/codex/claude-errors.js";
import { renderCategorizedErrorMessage } from "../src/runtime/message-renderer.js";
import { EngineCancellationUnconfirmedError, EngineContextCompactionPendingError, EngineIncompleteResponseError, EngineStopTooLateError } from "../src/codex/adapter.js";

describe("classifyFailure auth detection", () => {
  it("gives host-local Claude login instructions without obsolete transport labels", () => {
    const error = claudeError("Failed to authenticate: OAuth session expired and could not be refreshed");
    expect(classifyFailure(error)).toBe("auth");
    expect(getBusErrorSemantics("auth").retryable).toBe(false);
    for (const locale of ["zh", "en"] as const) {
      const message = renderCoreUserFacingError(error, "engine", locale);
      expect(message).toContain("claude auth login");
      expect(message).not.toMatch(/飞书|Lark|Telegram|重启|restart/i);
      expect(renderCoreUserFacingError(new Error("Unauthorized 401"), "engine", locale)).not.toMatch(/飞书|Lark|Telegram|claude auth login/i);
      expect(renderCoreUserFacingError(new Error("Unauthorized 401"), "tool", locale)).not.toMatch(/飞书|Lark|Telegram|claude auth login/i);
    }
  });
  it("explains incomplete engine replies without suggesting restart or automatic replay", () => {
    const error = new EngineIncompleteResponseError("internal placeholder detail");
    expect(classifyFailure(error)).toBe("engine-incomplete");
    expect(getBusErrorSemantics(classifyFailure(error))).toEqual({ code: "engine_incomplete", retryable: false });
    expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("本轮未确认完成");
    expect(renderCoreUserFacingError(error, "engine", "zh")).not.toMatch(/重启|internal placeholder/);
    expect(renderCoreUserFacingError(error, "engine", "en")).toContain("Review the run");
    expect(renderCategorizedErrorMessage("engine-incomplete", error.message, "zh", "claude")).toContain("检查已执行操作");
  });
  it("explains a DeepSeek writer handoff without leaking the private session identity", () => {
    const error = Object.assign(new Error('session "private-session-id" is already owned by an active write handle'), { code: "session/writer-held" });
    expect(classifyFailure(error)).toBe("engine-busy");
    expect(classifyFailure(new Error(error.message))).not.toBe("engine-busy");
    expect(getBusErrorSemantics("engine-busy")).toEqual({ code: "engine_busy", retryable: true });
    const zh = renderCoreUserFacingError(error, "engine", "zh");
    expect(zh).toContain("DeepSeek 会话仍被占用");
    expect(zh).toContain("无需清空对话");
    expect(zh).not.toContain("private-session-id");
    expect(renderCategorizedErrorMessage("engine-busy", error.message, "en", "deepseek")).toContain("could not accept this message");
  });
  it("explains a concrete Antigravity preset conflict without exposing arbitrary stderr", () => {
    const error = new Error('Antigravity emitted result before init\nAntigravity stderr:\nerror: invalid model selection (--model "gemini-3.8-flash-high" --effort "low"): --model gemini-3.8-flash-high conflicts with --effort=low\n/private/secret=do-not-render');
    expect(classifyFailure(error)).toBe("engine-settings");
    const message = renderCoreUserFacingError(error, "engine", "zh");
    expect(message).toContain("gemini-3.8-flash-high"); expect(message).toContain("low"); expect(message).toContain("high"); expect(message).toContain("无需重启");
    expect(message).not.toContain("do-not-render"); expect(message).not.toContain("/private/");
  });
  it("explains an Antigravity model-effort rejection instead of suggesting restart", () => {
    const error = new Error('Antigravity emitted result before init\nAntigravity stderr:\nerror: invalid model selection (--model "" --effort "xhigh"): gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)');
    expect(classifyFailure(error)).toBe("engine-settings");
    expect(getBusErrorSemantics("engine-settings")).toEqual({ code: "engine_settings", retryable: false });
    const zh = renderCoreUserFacingError(error, "engine", "zh");
    expect(zh).toContain("gemini-3.8-flash 不支持 xhigh"); expect(zh).toContain("low、medium、high"); expect(zh).toContain("无需重启");
    expect(renderCoreUserFacingError(error, "engine", "en")).toContain("no restart is needed");
    expect(renderCategorizedErrorMessage("engine-settings", error.message, "en", "antigravity")).toContain("Available levels: low, medium, high");
    expect(zh).not.toContain("stderr");
  });
  it("explains an unconfirmed stop in both App languages without suggesting blind replay", () => {
    const error = new EngineCancellationUnconfirmedError({ cause: new Error("private transport details") });
    expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("尚未确认停止");
    expect(renderCoreUserFacingError(error, "engine", "en")).toContain("may still run");
    expect(renderCoreUserFacingError(error, "engine", "en")).not.toContain("private transport details");
    expect(renderCoreUserFacingError(new EngineStopTooLateError(), "engine", "zh")).toContain("未取消任何任务");
    expect(renderCoreUserFacingError(new EngineCancellationUnconfirmedError(undefined, "goal-active"), "engine", "zh")).toContain("因此没有停止");
  });
  it("distinguishes an unconfirmed compaction, a waiting retry and pending recovery without calling them failures", () => {
    const render = (state: EngineContextCompactionPendingError["state"], limitMs: number, locale: "zh" | "en") =>
      renderCoreUserFacingError(new EngineContextCompactionPendingError("internal detail", state, limitMs), "engine", locale);
    const timedOut = render("timed-out", 300_000, "zh"), waiting = render("waiting", 300_000, "zh"), recovering = render("recovering", 900_000, "zh");
    expect(timedOut).toContain("5 分钟内未确认完成，结果未知");
    expect(timedOut).toContain("不会重复压缩或改用新会话");
    expect(waiting).toContain("上一次上下文压缩仍在等待结果");
    expect(waiting).toContain("没有重复压缩");
    expect(recovering).toContain("超过 15 分钟仍无结果");
    expect(recovering).toContain("自动重启并恢复原会话");
    for (const text of [timedOut, waiting, recovering]) {
      expect(text).toContain("原会话");
      expect(text).not.toMatch(/失败|重启实例|internal detail/);
    }
    expect(new Set([timedOut, waiting, recovering]).size).toBe(3);
    expect(render("timed-out", 300_000, "en")).toContain("result is unknown");
    expect(render("waiting", 300_000, "en")).toContain("still unconfirmed");
    expect(render("recovering", 900_000, "en")).toContain("15 minutes");
    for (const state of ["timed-out", "waiting", "recovering"] as const) expect(render(state, 300_000, "en")).not.toMatch(/fail|Restart the instance/i);
  });
  it("classifies Claude 401 authentication errors as auth", () => {
    expect(
      classifyFailure(new Error("Failed to authenticate. API Error: 401")),
    ).toBe("auth");
    expect(
      classifyFailure(new Error("authentication_error: Invalid authentication credentials")),
    ).toBe("auth");
  });

  it("keeps existing auth patterns working", () => {
    expect(classifyFailure(new Error("not logged in"))).toBe("auth");
    expect(classifyFailure(new Error("unauthorized"))).toBe("auth");
    expect(classifyFailure(new Error("Please run /login"))).toBe("auth");
    expect(classifyFailure(new Error(
      "Antigravity emitted result before init\n\n" +
      "Error: authentication required. Run 'agy' to log in, then retry.\n" +
      "error: authentication failed or timed out",
    ))).toBe("auth");
  });

  it("classifies Kimi's auth-prefixed 5-hour quota error as quota, not auth", () => {
    const error = new Error(
      "Authentication required: 403 You've reached your 5-hour usage limit. " +
      "Your quota will reset when the current 5-hour window ends. " +
      "To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
    );

    expect(classifyFailure(error)).toBe("engine-quota");
    expect(getBusErrorSemantics("engine-quota")).toEqual({ code: "engine_quota", retryable: false });
    const zh = renderCoreUserFacingError(error, "engine", "zh");
    expect(zh).toContain("Kimi 当前 5 小时使用额度已用完");
    expect(zh).toContain("重新登录或重启都无效");
    expect(zh).not.toContain("认证已失效");
    const en = renderCoreUserFacingError(error, "engine", "en");
    expect(en).toContain("5-hour usage quota is exhausted");
    expect(en).toContain("signing in again or restarting will not help");
  });

  it("classifies current Codex and Claude usage-limit messages as quota", () => {
    expect(classifyFailure(new Error("You've hit your usage limit"))).toBe("engine-quota");
    expect(classifyFailure(new Error("Quota exceeded"))).toBe("engine-quota");
    expect(classifyFailure(new Error("Codex error code: usageLimitExceeded"))).toBe("engine-quota");
    for (const message of [
      "You've hit your limit",
      "You've hit your fast limit",
      "You've hit your monthly spend limit",
      "Usage limit reached",
      "spend limit reached (team plan)",
    ]) {
      expect(classifyFailure(new Error(message))).toBe("engine-quota");
    }
  });

  it("preserves an available Claude quota reset hint in channel messages", () => {
    const error = new Error("You've hit your fast limit. Your limit resets in 2 hours.");

    expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("resets in 2 hours");
    expect(renderCategorizedErrorMessage("engine-quota", error.message, "en", "claude"))
      .toContain("resets in 2 hours");
  });

  it("renders the Antigravity startup auth failure instead of restart advice", () => {
    const error = new Error(
      "Antigravity emitted result before init\n\n" +
      "Error: authentication required. Run 'agy' to log in, then retry.\n" +
      "error: authentication failed or timed out",
    );
    const zh = renderCoreUserFacingError(error, "engine", "zh");
    expect(zh).toContain("Antigravity 认证刷新失败");
    expect(zh).toContain("运行 `agy`");
    expect(zh).not.toContain("重启实例");
    const en = renderCoreUserFacingError(error, "engine", "en");
    expect(en).toContain("Antigravity authentication could not be refreshed");
    expect(en).not.toContain("Restart");
  });

  it("does not misclassify unrelated errors as auth", () => {
    expect(classifyFailure(new Error("file not found"))).not.toBe("auth");
    expect(classifyFailure(new Error("network timeout"))).not.toBe("auth");
  });

  it("matches 401 only as a standalone number, not inside larger numbers", () => {
    expect(classifyFailure(new Error("request failed with status 401"))).toBe("auth");
    expect(classifyFailure(new Error("turn used 84012 tokens"))).not.toBe("auth");
    expect(classifyFailure(new Error("context window is 140100 tokens"))).not.toBe("auth");
  });
});

describe("classifyFailure specificity", () => {
  it("explains malformed DeepSeek tool input without claiming a crash or inviting automatic replay", () => {
    const error = new Error("DeepSeek Harness agent failed: DeepSeek Messages stream: tool input is invalid JSON\nprivate-tool-arguments-must-not-render");
    const category = classifyFailure(error);
    expect(category).toBe("engine-tool-input");
    expect(getBusErrorSemantics(category)).toEqual({ code: "engine_tool_input", retryable: false });
    expect(engineRetryReason(error)).toBeUndefined();
    for (const locale of ["zh", "en"] as const) {
      const text = renderCoreUserFacingError(error, "engine", locale);
      expect(text).toContain(locale === "zh" ? "工具调用参数格式有误" : "malformed tool arguments");
      expect(text).toContain(locale === "zh" ? "核对已执行操作" : "Review completed operations");
      expect(text).toContain(locale === "zh" ? "无需重启实例" : "No instance restart is needed");
      expect(text).not.toContain("private-tool-arguments");
      expect(text).toBe(renderCategorizedErrorMessage(category, error.message, locale, "deepseek"));
      // Invalid output does not establish an unhealthy CLI or exhaust its quota.
      expect(renderedEngineFailure(text)).toBeUndefined();
    }
  });

  it("limits malformed-tool classification to the specific DeepSeek provider diagnostic", () => {
    expect(classifyFailure("DeepSeek Messages stream: tool input is invalid JSON")).toBe("engine-tool-input");
    for (const message of ["tool input is invalid JSON", "Invalid JSON in config.json", "DeepSeek Harness agent failed: other failure", "Tool echoed: DeepSeek Messages stream: tool input is invalid JSON"]) {
      expect(classifyFailure(new Error(message))).not.toBe("engine-tool-input");
    }
  });

  it("classifies named DeepSeek Harness backend failures as engine-cli", () => {
    expect(classifyFailure(new Error("DeepSeek Harness stream error: connection reset"))).toBe("engine-cli");
    expect(classifyFailure(new Error("dsh crashed while handling the turn"))).toBe("engine-cli");
  });

  it("does not treat generic app-server mentions as engine-cli failures", () => {
    expect(classifyFailure(new Error("status page mentions app-server maintenance"))).toBe("unknown");
  });

  it("does not treat engine names inside tool error paths as engine-cli failures", () => {
    expect(
      classifyFailure(new Error("lark-cli failed in /tmp/claude-code-sandbox/workspace/input with 500")),
    ).toBe("unknown");
  });

  it("classifies explicit engine runtime failures", () => {
    expect(classifyFailure(new Error("Codex runtime process failed to start"))).toBe("engine-cli");
    expect(classifyFailure(new Error("claude cli failed"))).toBe("engine-cli");
    expect(classifyFailure(new Error("engine failed during continuation"))).toBe("engine-cli");
    expect(classifyFailure(new Error("claude exited with code 1"))).toBe("engine-cli");
  });

  it("classifies Codex backend reconnect-exhaustion as engine-backend, distinct from engine-cli", () => {
    expect(classifyFailure(new Error("Reconnecting... 5/5"))).toBe("engine-backend");
    expect(classifyFailure(new Error("codex stream error\nReconnecting... 4/5"))).toBe("engine-backend");
    expect(classifyFailure(new Error("API Error: 529 Overloaded"))).toBe("engine-backend");
    expect(classifyFailure(new Error("Claude reported an error (api_error_status=529)"))).toBe("engine-backend");
    expect(classifyFailure(new Error("Selected model is at capacity. Please try a different model."))).toBe("engine-backend");
    expect(
      classifyFailure(new Error("API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model")),
    ).toBe("engine-backend");
    // a process/startup failure is still engine-cli, not engine-backend
    expect(classifyFailure(new Error("Codex runtime process failed to start"))).not.toBe("engine-backend");
    // a bare reconnect mention without an N/M attempt counter is NOT this category
    expect(classifyFailure(new Error("the websocket is reconnecting"))).toBe("unknown");
  });

  it("renders a clear retry message for engine-backend instead of the generic run-failed one", () => {
    const err = new Error("Reconnecting... 5/5");
    expect(renderCoreUserFacingError(err, "engine", "zh")).toContain("模型后端暂时过载或连接中断");
    expect(renderCoreUserFacingError(err, "engine", "zh")).toContain("请重试");
    expect(renderCoreUserFacingError(err, "engine", "zh")).not.toContain("本轮运行失败");
    expect(renderCoreUserFacingError(err, "engine", "en")).toContain("model backend is temporarily overloaded or disconnected");
  });

  it("classifies model-service 429 responses as retryable rate limits without stealing channel 429s", () => {
    expect(classifyFailure(new Error("API Error: 429 Too Many Requests"))).toBe("engine-rate-limit");
    expect(classifyFailure(new Error("api_error_status=429 rate limited"))).toBe("engine-rate-limit");
    expect(classifyFailure(new Error("Codex HTTP status 429"))).toBe("engine-rate-limit");
    expect(classifyFailure(new Error("DeepSeek Harness agent failed: code=rate_limit_exceeded"))).toBe("engine-rate-limit");
    expect(classifyFailure(new Error("Telegram API request failed: 429 Too Many Requests"))).toBe("telegram-delivery");
    expect(classifyFailure(new Error("Lark API error: rate_limit_exceeded"))).not.toBe("engine-rate-limit");
    expect(getBusErrorSemantics("engine-rate-limit")).toEqual({ code: "engine_rate_limit", retryable: true });

    const error = new Error("API Error: 429 Too Many Requests");
    expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("模型服务当前触发限流");
    expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("重启实例都无效");
    expect(renderCategorizedErrorMessage("engine-rate-limit", error.message, "en")).toContain("rate-limiting");
  });

  it("classifies DeepSeek exhausted-balance responses as quota failures", () => {
    expect(classifyFailure(new Error("DeepSeek Harness agent failed: HTTP 402 Payment Required"))).toBe("engine-quota");
    expect(classifyFailure(new Error("DeepSeek Harness agent failed: insufficient_balance"))).toBe("engine-quota");
    expect(getBusErrorSemantics("engine-quota")).toEqual({ code: "engine_quota", retryable: false });
  });

  it("classifies provider content-policy rejections without restart advice", () => {
    const error = new Error(
      "DeepSeek Harness agent failed: Content Exists Risk (request_id: e40cddfa-0c74-4109-b6af-c763266e2b77)",
    );

    expect(classifyFailure(error)).toBe("engine-content-policy");
    expect(classifyFailure(new Error("Codex turn failed: content_filter"))).toBe("engine-content-policy");
    expect(classifyFailure(new Error("Authentication required: 403 DeepSeek Content Exists Risk")))
      .toBe("engine-content-policy");
    expect(classifyFailure(new Error("Codex runtime failed\n⚠️ MCP startup warnings: content policy blocked")))
      .toBe("engine-cli");
    expect(classifyFailure(new Error("documentation mentions content filters"))).toBe("unknown");
    expect(getBusErrorSemantics("engine-content-policy"))
      .toEqual({ code: "engine_content_policy", retryable: false });

    const zh = renderCoreUserFacingError(error, "engine", "zh");
    expect(zh).toContain("内容安全策略拦截");
    expect(zh).toContain("/reset");
    expect(zh).toContain("重启实例无效");
    expect(zh).not.toContain("请重启实例后重试");

    const en = renderCoreUserFacingError(error, "engine", "en");
    expect(en).toContain("content-safety policy blocked");
    expect(en).toContain("restarting the instance will not help");

    expect(renderCategorizedErrorMessage("engine-content-policy", error.message, "zh", "deepseek"))
      .toContain("换一种表述");
    expect(renderCategorizedErrorMessage("engine-content-policy", error.message, "zh", "deepseek"))
      .not.toContain("请重启实例后重试");
    const telegramEn = renderCategorizedErrorMessage("engine-content-policy", error.message, "en", "deepseek");
    expect(telegramEn).toContain("content-safety policy blocked");
    expect(telegramEn).not.toContain("Restart the instance");
  });

  it.each([
    "Selected model is at capacity. Please try a different model.\nCodex error code: serverOverloaded",
    "No capacity available for model gpt-example",
  ])("explains service capacity without claiming quota or storage exhaustion: %s", (detail) => {
    const err = new Error(detail);
    expect(classifyFailure(err)).toBe("engine-backend");
    expect(getBusErrorSemantics(classifyFailure(err))).toEqual({ code: "engine_backend", retryable: true });
    for (const zh of [
      renderCoreUserFacingError(err, "engine", "zh"),
      renderCategorizedErrorMessage("engine-backend", err.message, "zh"),
    ]) {
      expect(zh).toContain("模型服务暂时繁忙");
      expect(zh).toContain("不代表账号额度用完或本机存储已满");
      expect(zh).toContain("临时切换模型");
      expect(zh).toContain("无需重启实例");
      expect(zh).not.toContain("容量已满");
    }
    for (const en of [
      renderCoreUserFacingError(err, "engine", "en"),
      renderCategorizedErrorMessage("engine-backend", err.message, "en"),
    ]) {
      expect(en).toContain("model service is temporarily busy");
      expect(en).toContain("does not mean your account quota is exhausted or your local storage is full");
      expect(en).toContain("switch models");
    }
  });

  it("classifies the single-turn time-cap timeout as engine-timeout, distinct from engine-cli", () => {
    expect(classifyFailure(new Error("Codex app-server turn timed out after 60 minutes"))).toBe("engine-timeout");
    expect(classifyFailure(new Error("Antigravity process turn timed out after 60 minutes\n[state]"))).toBe("engine-timeout");
    expect(classifyFailure(new Error("Codex app-server turn became inactive after 30 minutes"))).toBe("engine-timeout");
    // a process/startup failure (no "turn timed out after N minutes") stays engine-cli
    expect(classifyFailure(new Error("Codex runtime process failed to start"))).toBe("engine-cli");
    // engine-timeout is NOT auto-retryable (rerunning the same long task times out again)
    expect(getBusErrorSemantics("engine-timeout")).toEqual({ code: "engine_timeout", retryable: false });
  });

  it("covers the Claude inactivity-watchdog wording with the engine-timeout category", () => {
    // Wording emitted by ClaudeStreamAdapter's inactivity watchdog; it must not
    // fall through to engine-cli ("restart the instance"), and the renderer picks
    // the minute count out of the detail.
    const err = new Error(
      "Claude turn became inactive after 30 minutes with no engine output; the wedged CLI was stopped. Send /timeout off before a genuinely long silent task.",
    );
    expect(classifyFailure(err)).toBe("engine-timeout");
    expect(renderCategorizedErrorMessage("engine-timeout", err.message, "en")).toContain("30-minute");
  });

  it("classifies a busy Claude session (live background tasks) as engine-busy, not engine-cli", () => {
    const err = new Error(
      "Claude session has 2 background tasks still running, so the new engine settings cannot be applied yet. Retry once they finish, or send /reset to start a fresh session.",
    );
    expect(classifyFailure(err)).toBe("engine-busy");
    // Transient: the same call works once the background work ends.
    expect(getBusErrorSemantics("engine-busy")).toEqual({ code: "engine_busy", retryable: true });
    // The old behavior told the operator to restart the instance for a healthy engine.
    expect(renderCategorizedErrorMessage("engine-busy", err.message, "en")).not.toContain("Restart the instance");
  });

  it("explains a permission switch blocked by background work in both transports", () => {
    const error = new Error("Codex approval mode changed while busy; wait for active/background tasks to finish before starting another turn");
    expect(classifyFailure(error)).toBe("engine-busy");
    expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("等待完成后再重试");
    expect(renderCoreUserFacingError(error, "engine", "en")).toContain("no restart");
    expect(renderCategorizedErrorMessage(classifyFailure(error), error.message, "zh")).toContain("无需重启或清空对话");
    expect(renderCategorizedErrorMessage(classifyFailure(error), error.message, "en")).toContain("Wait for it to finish");
  });

  it("classifies a locally occupied Codex thread as retryable engine-busy", () => {
    const err = new Error("Codex thread thread-B already has an in-flight turn");
    expect(classifyFailure(err)).toBe("engine-busy");
    expect(getBusErrorSemantics("engine-busy")).toEqual({ code: "engine_busy", retryable: true });
  });

  it("renders an accurate time-cap message pointing at /timeout, not the misleading 'restart' one", () => {
    const err = new Error("Codex app-server turn timed out after 60 minutes");
    const zh = renderCoreUserFacingError(err, "engine", "zh");
    expect(zh).toContain("60 分钟");
    expect(zh).toContain("/timeout off");
    expect(zh).not.toContain("请重启实例后重试");      // the misleading advice is gone
    const en = renderCoreUserFacingError(err, "engine", "en");
    expect(en).toContain("/timeout off");
    expect(en).not.toContain("Restart the instance");
  });

  it("renders the actual Lark timeout duration and distinguishes inactivity from the hard cap", () => {
    const hardCap = renderCoreUserFacingError(
      new Error("Codex app-server turn timed out after 15 minutes"),
      "engine",
      "zh",
    );
    expect(hardCap).toContain("15 分钟");
    expect(hardCap).toContain("运行上限");
    expect(hardCap).not.toContain("60 分钟");

    const inactive = renderCoreUserFacingError(
      new Error("Claude turn became inactive after 30 minutes with no engine output"),
      "engine",
      "en",
    );
    expect(inactive).toContain("30 minutes");
    expect(inactive).toContain("inactivity watchdog");
  });

  it("renders Telegram engine timeouts with /timeout guidance instead of blind retry advice", () => {
    const err = new Error("Codex process turn became inactive after 30 minutes");
    const zh = renderCategorizedErrorMessage("engine-timeout", err.message, "zh");
    expect(zh).toContain("/timeout");
    expect(zh).not.toContain("请重试");
    const en = renderCategorizedErrorMessage("engine-timeout", err.message, "en");
    expect(en).toContain("/timeout");
    expect(en).not.toContain("try again");
  });

  it("does not treat generic archive mentions as file-workflow failures", () => {
    expect(classifyFailure(new Error("archive the previous messages for me"))).toBe("unknown");
  });

  it("classifies a corrupt usage ledger as workflow state so budget checks fail visibly", () => {
    expect(classifyFailure(new Error("Usage state is corrupt and no valid last-good backup is available")))
      .toBe("workflow-state");
  });

  it("classifies file workflow preparation errors by type", () => {
    expect(
      classifyFailure(new FileWorkflowPreparationError("upload-1", new Error("temporary failure"))),
    ).toBe("file-workflow");
  });

  it("classifies Telegram input file download failures as file workflow errors", () => {
    expect(
      classifyFailure(new Error("Telegram API request failed for getFile: Bad Request: file is too big")),
    ).toBe("file-workflow");
    expect(
      classifyFailure(new Error("Telegram API request failed for downloadFile: 500 Internal Server Error")),
    ).toBe("file-workflow");
  });

  it("does not treat generic zip mentions as file-workflow failures", () => {
    expect(classifyFailure(new Error("Remote peer mentioned export.zip in an unrelated error"))).toBe("unknown");
  });
});

describe("isStaleSessionError", () => {
  it("matches Claude's 'No conversation found' message", () => {
    expect(
      isStaleSessionError(new Error("No conversation found with session ID: abc-123")),
    ).toBe(true);
  });

  it("classifies the same errors as session-state", () => {
    expect(classifyFailure(new Error("No conversation found with session ID: abc-123"))).toBe("session-state");
  });

  it("does not match unrelated errors", () => {
    expect(isStaleSessionError(new Error("file not found"))).toBe(false);
    expect(isStaleSessionError(new Error("auth expired"))).toBe(false);
  });
});

describe("getBusErrorSemantics", () => {
  it("maps failure categories to shared bus error semantics", () => {
    expect(getBusErrorSemantics("auth")).toEqual({ code: "auth", retryable: false });
    expect(getBusErrorSemantics("telegram-conflict")).toEqual({ code: "telegram_conflict", retryable: true });
    expect(getBusErrorSemantics("workflow-state")).toEqual({ code: "workflow_state", retryable: false });
    expect(getBusErrorSemantics("engine-backend")).toEqual({ code: "engine_backend", retryable: true });
    expect(getBusErrorSemantics("engine-rate-limit")).toEqual({ code: "engine_rate_limit", retryable: true });
    expect(getBusErrorSemantics("engine-quota")).toEqual({ code: "engine_quota", retryable: false });
    expect(getBusErrorSemantics("engine-content-policy"))
      .toEqual({ code: "engine_content_policy", retryable: false });
    expect(getBusErrorSemantics("unknown")).toEqual({ code: "unknown", retryable: true });
  });
});

describe("MCP startup warnings do not steer classification", () => {
  it("classifies by the underlying error, not the appended warning text", () => {
    const error = new Error(
      "turn became inactive after 30 minutes\n\n⚠️ MCP startup warning:\n- server github: 401 Unauthorized",
    );
    expect(classifyFailure(error)).toBe("engine-timeout");
  });

  it("still classifies a genuine auth failure that carries a warning", () => {
    const error = new Error(
      "not logged in — please run /login\n\n⚠️ MCP startup warnings:\n- server tavily: timeout",
    );
    expect(classifyFailure(error)).toBe("auth");
  });
});
