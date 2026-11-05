// Build launcher icons from the owner's selected master and the macOS status
// item from its separate monochrome vector mask.
// Uses the pinned local Tauri CLI; run `npm ci --prefix client` first.
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const client = join(root, "client");
const icons = join(client, "src-tauri/icons");
const cli = join(client, "node_modules/@tauri-apps/cli/tauri.js");
const source = join(root, "assets/brand/tarobot-master.png");
const cutout = join(root, "assets/brand/tarobot-tray-master.png");
const identity = JSON.parse(readFileSync(join(root, "assets/brand/brand-identity.json"), "utf8"));
const sha256 = data => createHash("sha256").update(data).digest("hex");
if (sha256(readFileSync(join(root, identity.launcher.art))) !== identity.launcher.sha256) throw new Error("Approved launcher artwork differs from brand-identity.json");
if (sha256(readFileSync(join(root, "assets/brand/phoenix-art.png"))) !== identity.rawArtSha256) throw new Error("Selected phoenix artwork differs from brand-identity.json");
const generate = (...args) => execFileSync(process.execPath, [cli, "icon", ...args], { cwd: client, stdio: "inherit" });
const work = mkdtempSync(join(tmpdir(), "tarobot-icons-"));
try {
  generate(join(root, "assets/brand/phoenix-cutout.svg"), "--output", join(work, "cutout"), "--png", "1254");
  const cutoutBytes = readFileSync(join(work, "cutout/1254x1254.png"));
  if (sha256(cutoutBytes) !== identity.cutoutSha256) throw new Error("Phoenix cutout framing differs from brand-identity.json");
  writeFileSync(cutout, cutoutBytes);
  // Launcher artwork is separately approved; existing scene/launch marks and
  // avatars remain intact. Only platform padding/masks/sizes are generated.
  generate(join(root, "assets/brand/app-icon.svg"), "--output", join(work, "master"), "--png", "1024");
  copyFileSync(join(work, "master/1024x1024.png"), source);
  // Generate outside src-tauri so the CLI cannot redirect icons into an
  // optional gen/android checkout and leave the Capacitor copies stale.
  const generated = join(work, "all");
  generate(join(root, "assets/brand/icons.json"), "--output", generated);
  generate(source, "--output", join(work, "web"), "--png", "64", "--png", "180");
  generate(cutout, "--output", join(work, "mark"), "--png", "256", "--png", "384");
  // Windows supplies no system mask: package the approved square as a rounded
  // tile with transparent corners, without changing the separate Mac template.
  generate(join(root, "assets/brand/windows.svg"), "--output", join(work, "windows-master"), "--png", "1024");
  const windowsMaster = join(root, "assets/brand/tarobot-windows-master.png");
  copyFileSync(join(work, "windows-master/1024x1024.png"), windowsMaster);
  generate(windowsMaster, "--output", join(work, "windows"));
  copyFileSync(join(work, "windows/icon.ico"), join(generated, "icon.ico"));
  // Tauri also embeds PNGs for default window/tray icons, independently of ICO.
  for (const file of ["32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.png"]) {
    copyFileSync(join(work, "windows", file), join(generated, file));
  }
  // macOS keeps its own outer rounded tile and transparent margin.
  generate(join(root, "assets/brand/macos.svg"), "--output", join(work, "macos"));
  // The CLI's ICNS container uses unordered entries. Canonicalize their order
  // without touching the encoded images, so regeneration makes no noisy diff.
  const icns = readFileSync(join(work, "macos/icon.icns"));
  if (icns.toString("ascii", 0, 4) !== "icns" || icns.readUInt32BE(4) !== icns.length) throw new Error("Invalid ICNS container");
  const entries = [];
  for (let offset = 8; offset < icns.length;) {
    if (offset + 8 > icns.length) throw new Error("Truncated ICNS entry");
    const size = icns.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > icns.length) throw new Error("Invalid ICNS entry size");
    entries.push(icns.subarray(offset, offset + size));
    offset += size;
  }
  entries.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)));
  writeFileSync(join(generated, "icon.icns"), Buffer.concat([icns.subarray(0, 8), ...entries]));
  cpSync(generated, icons, { recursive: true });
  // Keep the separate 36px RGBA template mask; Electron owns its display size.
  // Regeneration must not bring back the coloured 3D mascot.
  generate(join(root, "assets/brand/tray-macos.svg"), "--output", join(work, "tray"), "--png", "36");
  copyFileSync(join(work, "tray/36x36.png"), join(icons, "tray-macos.png"));

  // Capacitor owns the shipped phone apps, so updating Tauri's copies alone is
  // insufficient. Keep Android density variants and the iOS catalog in sync.
  const android = join(client, "android/app/src/main/res");
  for (const folder of readdirSync(join(generated, "android"))) {
    mkdirSync(join(android, folder), { recursive: true });
    for (const name of readdirSync(join(generated, "android", folder))) {
      copyFileSync(join(generated, "android", folder, name), join(android, folder, name));
    }
  }
  copyFileSync(join(generated, "ios/AppIcon-512@2x.png"), join(client, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"));
  for (const [size, name] of [[64, "favicon"], [180, "apple-touch-icon"]]) {
    copyFileSync(join(work, "web", `${size}x${size}.png`), join(client, "src/brand", `${name}.png`));
  }
  const mark = join(work, "mark/256x256.png");
  copyFileSync(mark, join(client, "src/brand/tarobot.png"));
  copyFileSync(mark, join(client, "ios/App/App/Assets.xcassets/TaroBotMark.imageset/tarobot.png"));
  copyFileSync(join(work, "mark/384x384.png"), join(client, "ios/App/App/Assets.xcassets/TaroBotMark.imageset/tarobot@3x.png"));
  // Android's Theme.SplashScreen uses @mipmap/ic_launcher directly. Retire
  // unreferenced legacy splash bitmaps; do not create a second unused mark.
  for (const folder of readdirSync(android).filter(name => /^drawable(?:-|$)/.test(name))) {
    rmSync(join(android, folder, "splash.png"), { force: true });
  }
  // Phone glyphs keep their existing artwork when the Mac tray is refined.
  const mask = readFileSync(join(root, "assets/brand/fox-monochrome.svg"), "utf8").match(/\bd="([^"]+)"/)?.[1].replace(/\s+/g, " ").trim();
  if (!mask) throw new Error("Monochrome template path missing");
  const vector = (adaptive = false) => `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${adaptive ? 108 : 24}dp" android:height="${adaptive ? 108 : 24}dp" android:viewportWidth="${adaptive ? 108 : 40}" android:viewportHeight="${adaptive ? 108 : 40}">${adaptive ? '<group android:scaleX="1.6" android:scaleY="1.6" android:translateX="25.2" android:translateY="25.2">' : '<group android:translateX="2" android:translateY="2">'}<path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="${mask}"/></group></vector>\n`;
  writeFileSync(join(android, "drawable/ic_notification.xml"), vector());
  writeFileSync(join(android, "drawable/ic_launcher_monochrome.xml"), vector(true));
  const adaptiveDir = join(android, "mipmap-anydpi-v33");
  mkdirSync(adaptiveDir, { recursive: true });
  for (const name of ["ic_launcher", "ic_launcher_round"]) {
    const xml = readFileSync(join(android, "mipmap-anydpi-v26", `${name}.xml`), "utf8");
    writeFileSync(join(adaptiveDir, `${name}.xml`), xml.replace("</adaptive-icon>", '  <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>'));
  }
  const files = [];
  files.push(windowsMaster);
  const collect = dir => { for (const file of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, file.name); if (file.isDirectory()) collect(path); else files.push(path); } };
  collect(icons);
  for (const dir of readdirSync(android).filter(name => /^mipmap-/.test(name))) collect(join(android, dir));
  for (const path of [source, cutout, join(client, "src/brand/tarobot.png"), join(client, "src/brand/favicon.png"), join(client, "src/brand/apple-touch-icon.png"), join(client, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"), join(client, "ios/App/App/Assets.xcassets/TaroBotMark.imageset/tarobot.png"), join(client, "ios/App/App/Assets.xcassets/TaroBotMark.imageset/tarobot@3x.png"), ...["drawable/ic_notification.xml", "drawable/ic_launcher_monochrome.xml", "values/ic_launcher_background.xml"].map(file => join(android, file))]) files.push(path);
  writeFileSync(join(root, "assets/brand/generated-icons.json"), JSON.stringify({ brand: identity.brand, cutoutSha256: identity.cutoutSha256, launcherSha256: identity.launcher.sha256, files: Object.fromEntries(files.sort().map(path => [path.slice(root.length), sha256(readFileSync(path))])) }, null, 2) + "\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
