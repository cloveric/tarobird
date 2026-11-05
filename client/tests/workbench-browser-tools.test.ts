import { describe, expect, it } from "vitest";
import { browserAddress, browserPayload } from "../src/workbench-browser.js";
import { browserZoomStep, readBrowserDevicePreview, readBrowserHistory, readBrowserSettings } from "../src/workbench-browser-tools.js";

describe("browser page tools", () => {
  it("uses the selected search engine without rewriting real addresses", () => {
    expect(browserAddress("猫和狗", "bing")).toBe("https://www.bing.com/search?q=%E7%8C%AB%E5%92%8C%E7%8B%97");
    expect(browserAddress("a b", "duckduckgo")).toBe("https://duckduckgo.com/?q=a%20b");
    expect(browserAddress("a b", "baidu")).toBe("https://www.baidu.com/s?wd=a%20b");
    expect(browserAddress("a b")).toBe("https://www.google.com/search?q=a%20b");
    expect(browserAddress("https://example.com/?q=keep", "bing")).toBe("https://example.com/?q=keep");
    expect(browserAddress("example.com/path", "baidu")).toBe("https://example.com/path");
    expect(() => browserAddress("file:///etc/passwd", "bing")).toThrow("unsupported_scheme");
  });
  it("bounds zoom and steps correctly from non-preset values", () => {
    expect(browserZoomStep(3, 1)).toBe(3); expect(browserZoomStep(.25, -1)).toBe(.25);
    expect(browserZoomStep(1.18, 1)).toBe(1.25); expect(browserZoomStep(1.18, -1)).toBe(1.1);
    expect(browserZoomStep(1, 1)).toBe(1.1); expect(browserZoomStep(1, -1)).toBe(.9);
  });
  it("rejects malformed preferences and preview state", () => {
    expect(readBrowserSettings({searchEngine:"bing", defaultZoom:1.25, recordHistory:false})).toEqual({searchEngine:"bing", defaultZoom:1.25, recordHistory:false});
    for (const input of [null, {}, {searchEngine:"https://evil.test",defaultZoom:1,recordHistory:true}, {searchEngine:"google",defaultZoom:Infinity,recordHistory:true}, {searchEngine:"google",defaultZoom:1,recordHistory:"false"}]) expect(readBrowserSettings(input)).toBeUndefined();
    expect(readBrowserDevicePreview({preset:"phone",landscape:false,width:390,height:844,scale:.5})).toMatchObject({width:390,scale:.5});
    expect(readBrowserDevicePreview({preset:"phone",landscape:false,width:"390",height:844,scale:.5})).toBeUndefined();
  });
  it("history cannot open scripts, files or credentials and remains bounded", () => {
    const entry={id:"one",title:"Example",url:"https://example.com/?q=hi",visitedAt:123};
    expect(readBrowserHistory([entry, {...entry,url:"javascript:alert(1)"}, {...entry,url:"file:///tmp/x"}, {...entry,url:"https://name:password@example.com"}, {...entry,visitedAt:NaN}])).toEqual([entry]);
    expect(readBrowserHistory(Array.from({length:600},(_,i)=>({...entry,id:String(i)})))).toHaveLength(500);
  });
  it("UI tools do not expand Bot page or file permissions", () => {
    for (const action of ["find", "stop_find", "zoom", "device", "print", "save_screenshot", "history", "clear_history", "settings", "settings_set"]) expect(() => browserPayload({action})).toThrow("unsupported_action");
    expect(browserPayload({action:"screenshot",maxWidth:1000})).toEqual({action:"screenshot",fields:{maxWidth:1000}});
  });
});
