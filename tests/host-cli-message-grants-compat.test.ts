import { afterEach, expect, it, vi } from "vitest";
import { HostCliError, LocalHostClient } from "../src/host-cli/client.js";
import { runBotMessagesCommand } from "../src/host-cli/bot-messages.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { crossHost: true, code: "not_found", status: 404, updateHint: true },
  { crossHost: false, code: "not_found", status: 404, updateHint: false },
  { crossHost: true, code: "forbidden", status: 403, updateHint: false },
  { crossHost: true, code: "transport_timeout", status: 504, updateHint: false },
])("reports old-host support without masking other errors: $code/$crossHost", async ({ crossHost, code, status, updateHint }) => {
  const error = new HostCliError(code, status);
  const request = vi.fn().mockRejectedValue(error), close = vi.fn();
  vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ request, close } as unknown as LocalHostClient);
  const result = runBotMessagesCommand("unused-fixture", "grants", { "cross-host": crossHost });
  if (updateHint) await expect(result).rejects.toThrow("更新接收主机");
  else await expect(result).rejects.toBe(error);
  expect(request).toHaveBeenCalledExactlyOnceWith(crossHost ? "/api/bot-messages/cross-host-grants" : "/api/bot-messages/grants");
  expect(close).toHaveBeenCalledOnce();
});
