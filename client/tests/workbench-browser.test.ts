import { describe, expect, it } from "vitest";
import { browserAddress, browserPayload } from "../src/workbench-browser.js";

describe("workbench browser App boundary", () => {
  it("never permits model supplied scope, actor, partition, window or filesystem uploads", () => {
    for (const field of ["scope", "source", "window", "windowId", "partition", "tab", "force", "script", "path"]) {
      expect(() => browserPayload({ action: "click", ref: "r1.2.3", [field]: "override" })).toThrow("invalid_browser_args");
    }
    expect(() => browserPayload({ action: "upload_begin", name: "secret.txt", size: 1 })).toThrow("unsupported_action");
    expect(() => browserPayload({ action: "upload", ref: "r1.2.3", files: ["/private/key"] })).toThrow("invalid_browser_args");
    expect(browserPayload({ action: "upload", ref: "r1.2.3", attachmentIds: ["att_authorized"] })).toEqual({ action: "upload", fields: { ref: "r1.2.3", attachmentIds: ["att_authorized"] } });
  });
  it("retains only bounded native action fields and rejects unsupported script execution", () => {
    expect(browserPayload({ action: "observe", navigation: 3, maxElements: 20 })).toEqual({ action: "observe", fields: { navigation: 3, maxElements: 20 } });
    expect(() => browserPayload({ action: "evaluate", expression: "document.cookie" })).toThrow("unsupported_action");
    expect(() => browserPayload({ action: "__proto__" })).toThrow("unsupported_action");
  });
  it("requires the user's UI gesture to release takeover or clear/open local website data", () => {
    for (const action of ["resume", "clear_data", "download_open", "download_reveal"]) expect(() => browserPayload({ action })).toThrow("unsupported_action");
    expect(browserPayload({ action: "takeover" })).toEqual({ action: "takeover", fields: {} });
  });
  it("keeps native App schemes and javascript out of the address bar", () => {
    for (const address of ["file:///etc/passwd", "javascript:alert(1)", "tarobot://app", "data:text/html,hello", "chrome://settings"]) expect(() => browserAddress(address)).toThrow("unsupported_scheme");
    expect(browserAddress("https://example.com/a?q=x")).toBe("https://example.com/a?q=x");
    expect(browserAddress("example.com")).toBe("https://example.com/");
    expect(browserAddress("本周天气")).toBe("https://www.google.com/search?q=%E6%9C%AC%E5%91%A8%E5%A4%A9%E6%B0%94");
    expect(browserAddress("  ")).toBe("about:blank");
  });
});
