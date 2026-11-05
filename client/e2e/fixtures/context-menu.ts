import { installNativeContextMenu } from "../../src/native-context-menu.js";
import { setLocale } from "../../src/i18n.js";
import { bridge } from "./context-menu-native.js";
const query = new URLSearchParams(location.search);
Object.assign(window, { isTauri: query.get("platform") !== "web" });
setLocale(query.get("locale") === "en" ? "en" : "zh");
const stop = installNativeContextMenu();
document.getElementById("app-menu")!.addEventListener("contextmenu", e => { e.preventDefault(); document.getElementById("result")!.textContent = "重命名"; });
Object.assign(window, { contextFixture: { bridge, stop } });
