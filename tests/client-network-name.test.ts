import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultNetworkName } from "../client/src/network-name.js";
import { hostNameSchema } from "../src/client-protocol/host-profile.js";
import { setLocale } from "../client/src/i18n.js";
beforeEach(() => vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } }));
afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); });
it.each(["zh", "en"] as const)("keeps default network names valid in %s even for a full-length host name", locale => {
  setLocale(locale);
  for (const name of ["Mac mini", "机".repeat(100), "a".repeat(100)]) expect(hostNameSchema.safeParse(defaultNetworkName(name)).success).toBe(true);
  expect(defaultNetworkName("Mac mini")).toContain("Mac mini");
});
