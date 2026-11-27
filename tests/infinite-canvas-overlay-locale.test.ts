import { expect, it, vi } from "vitest";
import { hostBridge } from "../integrations/infinite-canvas/overlay/host-bridge";
import {
  getCanvasMessages,
  initializeCanvasLocale,
  subscribeCanvasLocale,
} from "../integrations/infinite-canvas/overlay/locale";

it("uses the trusted initial and live Host locales for its Japanese, English and Chinese overlay", async () => {
  const protocol = "tarobird.plugin.v1";
  let receive: (event: { source: object; data: object }) => void = () => {
    throw Error("missing bridge listener");
  };
  const parent = {
    postMessage(message: { id: string; method: string }) {
      expect(message.method).toBe("host.hello");
      receive({ source: parent, data: { protocol, id: message.id, ok: true, result: { locale: "ja-JP" } } });
    },
  };
  vi.stubGlobal("window", {
    parent,
    addEventListener(type: string, listener: typeof receive) {
      expect(type).toBe("message");
      receive = listener;
    },
  });
  const hello = await hostBridge.hello();
  const stop = initializeCanvasLocale(hello.locale);
  const updated = vi.fn();
  const unsubscribe = subscribeCanvasLocale(updated);
  try {
    expect(getCanvasMessages()).toMatchObject({
      thirdPartyNode: "サードパーティノード",
      reviewInstall: "確認してインストール",
      runNode: "ノードを実行",
      agentReady: "Agent に接続済み",
      connect: "接続する",
    });
    expect(getCanvasMessages().agentDescription).toContain("TaroBird Bot");
    expect(getCanvasMessages().enableWarning).toContain("SHA-256");
    expect(getCanvasMessages().removeWarning("Canvas example")).toContain("Canvas example");
    expect(getCanvasMessages().startupError).toContain("Infinite Canvas");

    receive({ source: {}, data: { protocol, type: "host.context", locale: "en" } });
    receive({ source: parent, data: { protocol: "other", type: "host.context", locale: "en" } });
    receive({ source: parent, data: { protocol, type: "host.context", locale: "unknown" } });
    expect(updated).not.toHaveBeenCalled();

    receive({ source: parent, data: { protocol, type: "host.context", locale: "en-US" } });
    expect(updated).toHaveBeenCalledTimes(1);
    expect(getCanvasMessages().confirmNodeAction).toBe("Confirm third-party node action");

    receive({ source: parent, data: { protocol, type: "host.context", locale: "zh-CN" } });
    expect(updated).toHaveBeenCalledTimes(2);
    expect(getCanvasMessages().enableNodes).toBe("允许安装第三方节点");
  } finally {
    unsubscribe();
    stop();
    vi.unstubAllGlobals();
  }
});
