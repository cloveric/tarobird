#!/usr/bin/env python3
"""Check shipping app icons, including compiled Android launcher references.

Requires Python 3 and Pillow; Android inspection also requires SDK aapt2,
and Windows EXE inspection requires pefile. Inspect the installed app payload
extracted from each final installer, not an intermediate build.
"""
import argparse
import hashlib
import io
import json
import math
import plistlib
import re
import struct
import subprocess
import zipfile
from pathlib import Path

from PIL import Image, ImageChops, ImageStat
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pixels(data):
    image = Image.open(io.BytesIO(data)).convert("RGBA")
    # PNG optimizers may discard RGB under fully transparent pixels.
    canonical = bytearray(image.tobytes())
    for offset in range(0, len(canonical), 4):
        if not canonical[offset + 3]:
            canonical[offset:offset + 4] = b"\0\0\0\0"
    return image.size, digest(canonical)


def verify_source():
    """Check the selected identity and every generated destination before builds."""
    brand = ROOT / "assets/brand"
    identity = json.loads((brand / "brand-identity.json").read_text())
    manifest = json.loads((brand / "generated-icons.json").read_text())
    launcher = identity["launcher"]
    require(digest((ROOT / launcher["art"]).read_bytes()) == launcher["sha256"],
            "Approved launcher artwork has changed")
    require(manifest["launcherSha256"] == launcher["sha256"], "Generated icons use a different launcher")
    approved = Image.open(ROOT / launcher["art"]).convert("RGB")
    master = Image.open(brand / "tarobot-master.png").convert("RGB")
    require(max(ImageStat.Stat(ImageChops.difference(master, approved.resize(master.size, Image.Resampling.LANCZOS))).mean) < 2,
            "Launcher master does not match the approved artwork")
    windows = Image.open(brand / "tarobot-windows-master.png").convert("RGBA").crop((32, 32, 992, 992))
    difference = ImageChops.difference(windows.convert("RGB"), approved.resize(windows.size, Image.Resampling.LANCZOS))
    require(max(ImageStat.Stat(difference, windows.getchannel("A").point(lambda a: 255 if a >= 250 else 0)).mean) < 2,
            "Windows master does not match the approved artwork")
    require(digest((brand / "phoenix-art.png").read_bytes()) == identity["rawArtSha256"],
            "Selected phoenix artwork has changed")
    require(digest((brand / "tarobot-tray-master.png").read_bytes()) == identity["cutoutSha256"],
            "Selected phoenix cutout has changed")
    require(manifest["cutoutSha256"] == identity["cutoutSha256"], "Generated icons use a different master")
    for relative, expected in manifest["files"].items():
        path = ROOT / relative
        require(path.resolve().is_relative_to(ROOT.resolve()), "Icon manifest path escapes repository")
        require(path.is_file() and digest(path.read_bytes()) == expected, "Stale/missing generated icon: " + relative)
    required = ["client/src-tauri/icons/icon.icns", "client/src-tauri/icons/icon.ico", "client/src-tauri/icons/tray-macos.png",
                "client/src/brand/tarobot.png", "client/src/brand/favicon.png", "client/src/brand/apple-touch-icon.png",
                "client/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
                "client/ios/App/App/Assets.xcassets/TaroBotMark.imageset/tarobot.png",
                "client/ios/App/App/Assets.xcassets/TaroBotMark.imageset/tarobot@3x.png"]
    android = ROOT / "client/android/app/src/main/res"
    for density in ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]:
        required += [f"client/android/app/src/main/res/mipmap-{density}/{name}.png"
                     for name in ["ic_launcher", "ic_launcher_round", "ic_launcher_foreground"]]
        foreground = Image.open(android / ("mipmap-" + density) / "ic_launcher_foreground.png").convert("RGBA")
        require(foreground.getchannel("A").getextrema() == (255, 255),
                "Android close-up must cover its motion field: " + density)
        if density == "xxxhdpi":
            # Check all four rendered bleed edges, not just alpha, so a
            # flat gray motion field cannot hide artwork chopped at an edge. A few pixels cross real colour boundaries;
            # the 95th percentile allows those while rejecting a straight cut.
            low, high = round(foreground.width / 6), round(foreground.width * 5 / 6)
            seams = [[((low - 1, n), (low, n)) for n in range(low, high)],
                     [((high - 1, n), (high, n)) for n in range(low, high)],
                     [((n, low - 1), (n, low)) for n in range(low, high)],
                     [((n, high - 1), (n, high)) for n in range(low, high)]]
            for seam in seams:
                differences = sorted(max(abs(a - b) for a, b in zip(foreground.getpixel(p)[:3], foreground.getpixel(q)[:3]))
                                     for p, q in seam)
                require(differences[int(len(differences) * .95)] <= 24,
                        "Android motion area exposes a hard artwork edge")
    # This is an approved full-bleed composition, not the old transparent
    # silhouette. Verify its critical features rather than treating the opaque
    # background as unsafe artwork. The image rect also prevents double inset.
    svg_ns = "{http://www.w3.org/2000/svg}"
    foreground_svg = ElementTree.parse(brand / "android-foreground.svg")
    artwork = foreground_svg.find(svg_ns + "image")
    require(artwork is not None, "Android foreground has no artwork")
    rect = [float(artwork.attrib[key]) for key in ["x", "y", "width", "height"]]
    require(rect == launcher["android"]["imageRect"] == [18, 18, 72, 72],
            "Android foreground does not map the approved artwork to its viewport")
    require(artwork.attrib.get("{http://www.w3.org/1999/xlink}href") == "launcher-art.png",
            "Android foreground references a different artwork")
    for left, top, right, bottom in launcher["android"]["criticalEyeBounds"]:
        require(all(math.hypot(rect[0] + x * rect[2] - 54, rect[1] + y * rect[3] - 54) < 33
                    for x in [left, right] for y in [top, bottom]),
                "Mascot eyes exceed Android's guaranteed safe circle")
    for relative in required:
        require(relative in manifest["files"], "Generation omitted an entry point: " + relative)
    mark = pixels((ROOT / "client/src/brand/tarobot.png").read_bytes())
    ios_mark = ROOT / "client/ios/App/App/Assets.xcassets/TaroBotMark.imageset"
    require(pixels((ios_mark / "tarobot.png").read_bytes()) == mark, "iOS launch mark differs from App mark")
    images = json.loads((ios_mark / "Contents.json").read_text())["images"]
    require({image["scale"]: image.get("filename") for image in images} ==
            {"2x": "tarobot.png", "3x": "tarobot@3x.png"}, "iOS launch scales are not wired to the generated marks")
    require(Image.open(ios_mark / "tarobot@3x.png").size == (384, 384), "Missing high-resolution iOS launch mark")
    storyboard = ElementTree.parse(ROOT / "client/ios/App/App/Base.lproj/LaunchScreen.storyboard")
    require(storyboard.find(".//imageView[@image='TaroBotMark']") is not None, "iOS launch screen no longer uses the checked mark")
    require(not list(android.glob("drawable*/splash.png")), "A legacy density-specific splash survives")
    styles = ElementTree.parse(android / "values/styles.xml")
    launch = styles.find("style[@name='AppTheme.NoActionBarLaunch']")
    require(launch is not None and launch.attrib.get("parent") == "Theme.SplashScreen", "Android launch theme changed")
    launch_items = {item.attrib["name"]: item.text for item in launch.findall("item")}
    require(launch_items.get("windowSplashScreenAnimatedIcon") == "@mipmap/ic_launcher", "Android launch does not use the checked launcher icon")
    android_ns = "{http://schemas.android.com/apk/res/android}"
    activity = ElementTree.parse(android.parent / "AndroidManifest.xml").find("application/activity")
    require(activity is not None and activity.attrib.get(android_ns + "theme") == "@style/AppTheme.NoActionBarLaunch",
            "Android activity does not use the checked launch theme")
    for relative in ["assets/brand/tarobot-master.png", "client/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"]:
        image = Image.open(ROOT / relative).convert("RGBA")
        require(image.size == (1024, 1024) and image.getchannel("A").getextrema() == (255, 255),
                "iOS launcher must be opaque and 1024 square")
    tray = Image.open(ROOT / "client/src-tauri/icons/tray-macos.png").convert("RGBA")
    require(tray.size == (36, 36) and tray.getchannel("A").getextrema() == (0, 255), "Invalid macOS template")
    require(all(tray.getpixel((x, y))[:3] == (0, 0, 0) for y in range(36) for x in range(36)
                if tray.getpixel((x, y))[3]), "macOS template must be a pure alpha mask")
    for relative in ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png"]:
        require(Image.open(ROOT / "client/src-tauri/icons" / relative).convert("RGBA").getchannel("A").getextrema() == (0, 255),
                "Default desktop window/tray PNG lost transparency")
    for name in ["ic_launcher", "ic_launcher_round"]:
        document = ElementTree.parse(android / "mipmap-anydpi-v33" / (name + ".xml"))
        require(document.find("monochrome") is not None, "Android themed icon is missing")
    for name in ["ic_notification", "ic_launcher_monochrome"]:
        ElementTree.parse(android / "drawable" / (name + ".xml"))
    _, windows_sizes, _ = windows_icon_source()
    return {"brand": identity["brand"], "cutoutSha256": identity["cutoutSha256"], "launcherSha256": launcher["sha256"],
            "generatedFilesVerified": len(manifest["files"]), "iosLaunchMarkParity": True,
            "iosLaunchScales": ["2x", "3x"], "androidLaunchUsesVerifiedIcon": True,
            "iosOpaque": True, "macosTemplate": True, "androidThemedIcons": True, "androidCriticalFeaturesSafe": True,
            "windowsTransparentSizes": windows_sizes}


def verify_mac(app):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    config = json.loads((ROOT / "client/src-tauri/tauri.conf.json").read_text())
    require(info["CFBundleIdentifier"] == config["identifier"], "Mac bundle identifier changed")
    name = info["CFBundleIconFile"]
    name = name if name.endswith(".icns") else name + ".icns"
    expected = (ROOT / "client/src-tauri/icons/icon.icns").read_bytes()
    actual = (app / "Contents/Resources" / name).read_bytes()
    require(actual == expected, "Packaged Mac icon is stale or differs from the selected icon")
    require(info["CFBundleShortVersionString"] == config["version"], "Mac version differs from source")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    return {"version": info["CFBundleShortVersionString"], "iconSha256": digest(actual)}


def silhouette_iou(frame, cutout):
    actual = frame.convert("RGBA").getchannel("A").point(lambda value: 255 if value > 127 else 0).convert("1")
    expected = cutout.resize(frame.size, Image.Resampling.LANCZOS).getchannel("A").point(lambda value: 255 if value > 127 else 0).convert("1")
    intersection = ImageChops.logical_and(actual, expected).histogram()[255]
    union = ImageChops.logical_or(actual, expected).histogram()[255]
    return intersection / max(union, 1)


def windows_icon_source():
    source = (ROOT / "client/src-tauri/icons/icon.ico").read_bytes()
    cutout_bytes = (ROOT / "assets/brand/tarobot-windows-master.png").read_bytes()
    manifest = json.loads((ROOT / "assets/brand/generated-icons.json").read_text())
    require(digest(cutout_bytes) == manifest["files"]["assets/brand/tarobot-windows-master.png"],
            "Windows reference tile differs from the generated master")
    cutout = Image.open(io.BytesIO(cutout_bytes)).convert("RGBA")
    icon = Image.open(io.BytesIO(source))
    sizes = sorted(icon.ico.sizes())
    require(sizes == [(n, n) for n in [16, 24, 32, 48, 64, 256]], "Unexpected Windows ICO sizes")
    for size in sizes:
        frame = icon.ico.getimage(size).convert("RGBA")
        alpha = frame.getchannel("A")
        width, height = size
        require(alpha.getextrema() == (0, 255), "Windows icon must preserve alpha: " + str(size))
        require(all(alpha.getpixel(point) == 0 for point in
                    [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]),
                "Windows icon corners are not transparent: " + str(size))
        # The approved launcher now has a warm-gray tile. Transparent corners
        # remain required; the old cutout must not silently survive in the ICO.
        require(silhouette_iou(frame, cutout) >= .95,
                "Windows icon silhouette differs from the approved tile: " + str(size))
        reference = cutout.resize(size, Image.Resampling.LANCZOS)
        differences = [abs(a - b) for y in range(height) for x in range(width)
                       if frame.getpixel((x, y))[3] >= 250 and reference.getpixel((x, y))[3] >= 250
                       for a, b in zip(frame.getpixel((x, y))[:3], reference.getpixel((x, y))[:3])]
        require(differences and sum(differences) / len(differences) < 2,
                "Windows ICO artwork differs from its approved master: " + str(size))

    count = struct.unpack_from("<H", source, 4)[0]
    frames = []
    for index in range(count):
        entry = source[6 + index * 16:22 + index * 16]
        length, offset = struct.unpack_from("<II", entry, 8)
        frames.append((entry[:12], source[offset:offset + length]))
    return source, sizes, frames


def verify_windows(exe, resource_group=32512):
    import pefile

    source, sizes, frames = windows_icon_source()
    count = len(frames)
    resources = {}
    with pefile.PE(str(exe), fast_load=True) as pe:
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]])
        for kind in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            if kind.id not in (3, 14):  # RT_ICON and RT_GROUP_ICON
                continue
            for name in kind.directory.entries:
                for language in name.directory.entries:
                    data = language.data.struct
                    resources[kind.id, name.id, language.id] = pe.get_data(data.OffsetToData, data.Size)
    # Tauri selects 32512; Electron's executable selects group 1. The caller
    # must name the shipping shell's group, not accept any matching image.
    groups = [(language, data) for (kind, ident, language), data in resources.items()
              if kind == 14 and ident == resource_group]
    require(groups, "Packaged Windows app icon group is missing")
    for language, group in groups:
        require(group[:6] == source[:6] and len(group) == 6 + count * 14,
                "Packaged Windows icon group differs from the selected ICO")
        for index, (header, image) in enumerate(frames):
            entry = group[6 + index * 14:20 + index * 14]
            ident = struct.unpack_from("<H", entry, 12)[0]
            # LLVM's resource compiler sets an unspecified ICO plane count
            # (0) to one. Keep every other field and the image bytes exact.
            source_planes = struct.unpack_from("<H", header, 4)[0]
            packed_planes = struct.unpack_from("<H", entry, 4)[0]
            require(entry[:4] == header[:4] and entry[6:12] == header[6:12]
                    and packed_planes in ({0, 1} if source_planes == 0 else {source_planes})
                    and resources.get((3, ident, language)) == image,
                    "Packaged Windows icon is stale: frame " + str(index))
    return {"exeSha256": digest(exe.read_bytes()), "iconSha256": digest(source),
            "verifiedSizes": sizes, "resourceGroup": resource_group, "transparentBackground": True,
            "nativeWindowsExecution": False}


def verify_android(apk, aapt2):
    def dump(*args):
        return subprocess.check_output([str(aapt2), "dump", *args, str(apk)], text=True)

    resources, ids, current = {}, {}, None
    for line in dump("resources").splitlines():
        match = re.match(r"\s+resource (0x[0-9a-f]+) (\S+)", line)
        if match:
            ident, current = match.groups()
            resources[current] = []
            ids[current] = ident
        file = re.match(r"\s+\(([^)]*)\) \(file\) (\S+) type=\w+", line)
        if current and file:
            resources[current].append(file.groups())
    report = []
    with zipfile.ZipFile(apk) as archive:
        for name in ["ic_launcher", "ic_launcher_round", "ic_launcher_foreground"]:
            entries = resources.get("mipmap/" + name, [])
            require(entries, "Missing packaged launcher resource: " + name)
            for density in ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]:
                paths = [path for config, path in entries if config == density]
                require(len(paths) == 1, "Missing or ambiguous launcher density: " + name + "/" + density)
                source = ROOT / "client/android/app/src/main/res" / ("mipmap-" + density) / (name + ".png")
                require(pixels(archive.read(paths[0])) == pixels(source.read_bytes()),
                        "Packaged Android icon is stale: " + name + "/" + density)
                report.append(name + "/" + density)
        for name in ["ic_launcher", "ic_launcher_round"]:
            for version in [26, 33]:
                paths = [path for config, path in resources["mipmap/" + name] if config == "anydpi-v" + str(version)]
                require(len(paths) == 1, "Missing adaptive icon: " + name + "/v" + str(version))
                xml = dump("xmltree", "--file", paths[0])
                layers = ["mipmap/ic_launcher_foreground", "color/ic_launcher_background"]
                if version == 33:
                    layers.append("drawable/ic_launcher_monochrome")
                for resource in layers:
                    require("@" + ids[resource] in xml, "Adaptive launcher references the wrong layer: " + name)
        manifest = dump("xmltree", "--file", "AndroidManifest.xml")
        for attribute, resource in [("icon", "mipmap/ic_launcher"), ("roundIcon", "mipmap/ic_launcher_round")]:
            require(re.search(r":" + attribute + r"\([^)]*\)=@" + ids[resource] + r"\b", manifest),
                    "Manifest does not select the expected launcher: " + attribute)
        expected = (ROOT / "client/android/app/src/main/res/values/ic_launcher_background.xml").read_text()
        color = re.search(r">\s*(#[0-9a-fA-F]{6,8})\s*</color>", expected).group(1).lower()
        color = "#ff" + color[1:] if len(color) == 7 else color
        block = dump("resources").split(" color/ic_launcher_background\n", 1)[1].split("    resource", 1)[0]
        require(color in block.lower(), "Adaptive background differs from source")
    badging = dump("badging")
    build = (ROOT / "client/android/app/build.gradle").read_text()
    version = re.search(r"tarobotVersionName'\)\.orElse\('([^']+)'", build).group(1)
    code = re.search(r"tarobotVersionCode'\)\.orElse\('([0-9]+)'", build).group(1)
    require("name='com.tarobot.client'" in badging, "Android application ID changed")
    require("versionName='" + version + "'" in badging and "versionCode='" + code + "'" in badging,
            "Android version differs from source")
    return {"version": version, "versionCode": int(code), "verifiedPngVariants": len(report),
            "adaptiveLaunchers": 4, "manifestIconsVerified": True, "apkSha256": digest(apk.read_bytes())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mac-app", type=Path)
    parser.add_argument("--windows-exe", type=Path)
    parser.add_argument("--windows-icon-group", type=int, choices=[1, 32512], default=32512,
                        help="Selected app-icon resource: 1 for Electron, 32512 for legacy Tauri")
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--aapt2", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--source", action="store_true", help="Verify generated sources without a packaged installer")
    args = parser.parse_args()
    require(args.source or args.mac_app or args.apk or args.windows_exe, "Supply --source, --mac-app, --windows-exe and/or --apk")
    require(not args.apk or args.aapt2, "--apk requires --aapt2")
    master = (ROOT / "assets/brand/tarobot-master.png").read_bytes()
    report = {"selectedMasterSha256": digest(master), "source": verify_source()}
    if args.mac_app:
        report["macOS"] = verify_mac(args.mac_app)
    if args.windows_exe:
        report["windows"] = verify_windows(args.windows_exe, args.windows_icon_group)
    if args.apk:
        report["android"] = verify_android(args.apk, args.aapt2)
    result = json.dumps(report, indent=2) + "\n"
    if args.receipt:
        args.receipt.write_text(result)
    print(result, end="")


if __name__ == "__main__":
    main()
