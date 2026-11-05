import { beforeEach, expect, it, vi } from "vitest";
import { invoke, isElectron } from "../src/desktop-bridge.js";
import { clearWorkbenchBrowserData, clearLocalBrowserData } from "../src/workbench-reset.js";

vi.mock("../src/desktop-bridge.js", () => ({ invoke: vi.fn(), isElectron: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(isElectron).mockReturnValue(true); });
const scopes = [{host:"host-A",user:"owner",conversation:"chat-A"}];
it("keeps removal scoped to the explicit host and saved conversations", async () => {
  vi.mocked(invoke).mockResolvedValue({cleared:1,failed:[]});
  await clearWorkbenchBrowserData("host-A",scopes);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workbench_browser_reset",{host:"host-A",scopes});
});
it("does not call native cleanup from browsers or mobile", async () => {
  vi.mocked(isElectron).mockReturnValue(false);
  await clearWorkbenchBrowserData("host-A",scopes); expect(invoke).not.toHaveBeenCalled();
});
it.each([undefined,{cleared:0},{cleared:-1,failed:[]},{cleared:1,failed:["partition-A"]}])("does not claim an invalid or partial receipt completed cleanup: %j", async result => {
  vi.mocked(invoke).mockResolvedValue(result);
  await expect(clearWorkbenchBrowserData("host-A",scopes)).rejects.toThrow("网页登录数据未能完全清除");
});
it("keeps a native failure retryable without exposing its internal details", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("private_internal_path"));
  await expect(clearWorkbenchBrowserData("host-A",scopes)).rejects.toThrow("旧连接已停止，请重试清理");
});

it("full device reset includes personal data even without a Host identity", async () => {
  vi.mocked(invoke).mockResolvedValue({cleared:1,failed:[]});
  await clearLocalBrowserData();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workbench_browser_reset", {host:"tarobot-personal-browser-v1",scopes:[{host:"tarobot-personal-browser-v1",user:"local",conversation:"personal"}]});
});
it("full reset independently clears personal and selected Host data", async () => {
  vi.mocked(invoke).mockResolvedValue({cleared:1,failed:[]});
  await clearLocalBrowserData("host-A",scopes);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(vi.mocked(invoke).mock.calls[1]).toEqual(["workbench_browser_reset",{host:"host-A",scopes}]);
});
