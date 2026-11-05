# Selected TaroBot icon — 2026-10-12

Windows now uses the existing transparent coloured cutout instead of the opaque
master; see [the Windows icon update](windows-transparent-icon-2026-10-19.md).
The following records the original selection and validation.

The owner selected the violet taro mascot. The exact supplied PNG is retained
in `assets/brand/tarobot-master.png`, with its SHA-256 and generation command
in that directory's README. Its pixels match the previously selected in-app
candidate; this change completes the other product surfaces.

The sidebar, pairing, welcome and loading screens use a 256px derivative
(52,796 bytes instead of the former 1,345,671-byte master). The browser favicon
and touch icon now use the same artwork instead of the old lion; the unused
blue-T public SVG is removed. Vite hashes and offline-precaches these files.
Bot avatars and existing custom pictures retain their separate identities.

The same master generates the Windows ICO, desktop PNGs, macOS ICNS, Tauri
mobile assets, and the actual Capacitor Android/iOS resources. Android's
adaptive layer insets the original image within its safe area; macOS gets a
rounded outer tile and transparent margin. These are mechanical platform
wrappers, with no regenerated artwork or changes to the mascot's colors.
The macOS menu bar now uses the separate transparent mascot cutout documented
in `assets/brand/README.md`; other desktop trays inherit the default window icon.

## Validation

- Exact source hash; byte-identical regeneration with the pinned local Tauri
  CLI; Tauri/Capacitor Android copies and iOS AppIcon bytes match.
- iOS catalog icon is opaque and 1024 × 1024. Favicon, touch icon and in-app
  asset sizes are 64, 180 and 256 pixels, respectively; built HTML and the
  offline cache reference the new hashed assets.
- Production client build and root standalone build passed. Full repository
  gate: 216 test files passed, 2,841 tests passed, one existing skip.
- Existing pairing-design and palettes journeys: three Chromium and three
  WebKit cases passed, covering language, narrow layouts and dark/light themes.
- Visually checked the 16/32/64/128px variants and Android circular-mask preview,
  plus actual production desktop and phone pairing pages. Image and favicon
  requests succeeded with no horizontal page overflow.
- Built a separate `com.tarocub.icon-preview` macOS App. Its packaged ICNS is
  byte-identical to the generated icon; `codesign --verify --deep --strict`
  passed with local ad-hoc signing. No Apple notarization is claimed.

No installed production App or running host was changed, and no installer was
published. Physical Android/iOS launcher acceptance remains a release check.
Windows assets were generated, but a Windows installer was not built here.

## Transparent menu bar follow-up

This earlier coloured-cutout design is superseded by the owner's flat,
monochrome requirement; see [the template icon correction](flat-tray-2026-10-13.md).

The menu bar formerly reused the opaque desktop PNG, so its square background
was visible against the macOS wallpaper tint. macOS now embeds a dedicated 36px
RGBA mascot cutout at the tray library's 18pt display size, with template mode
disabled to retain the purple color. Dock, launcher and other-platform icons
are unchanged. `generate-app-icons.mjs` regenerates the cutout too.

The master and edit prompt are retained in `assets/brand/`. Master SHA-256:
`c2c976d8b0f1393e97788ea1f61baa114a50f0eeab3b80c51cede77bc6608be1`;
shipping PNG SHA-256:
`ee0d48abbbfd3a07fd496527ca1eac5115a05dcd8c55697b408c1f7767aa0280`.
The PNG has both fully opaque and fully transparent pixels, transparent corners,
and 698 fully transparent pixels out of 1,296. Regenerating all icons changed no
existing launcher assets. Root/client production builds and macOS
`cargo check --locked --bin tarocub-client` passed.

A temporary AppKit status item displayed the exact shipping PNG at the same
18pt size and color mode as the tray library. The native menu-bar crop below
shows the current wallpaper tint through the surrounding pixels. This checks
native rendering of the asset, not startup of a newly packaged Tauri App.
The preview exited and removed its status item. No installed App, Hub or Bot
process was replaced or restarted, and no release was published.

Transparent mascot in the macOS menu bar (historical image omitted from this clean snapshot)

## Generation detail

The [Tauri icon implementation](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/icon.rs)
resizes adaptive foregrounds directly; its `android_fg_scale` applies to a
different composition path. The explicit SVG inset is therefore used for the
adaptive foreground. The generated PNG was inspected inside the circular
launcher viewport, rather than relying on that unused scale option.
