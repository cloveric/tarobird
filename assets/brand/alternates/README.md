# Archived launcher alternative

Kept at the owner's request on 2026-11-04 as a back-up App icon design, then
selected by the owner as the active launcher artwork later that day. The build
uses its byte-identical copy at `assets/brand/launcher-art.png`, pinned in
`brand-identity.json`; this archive preserves the approved source.

## `phoenix-lean.png`

- 1254 × 1254 opaque square, flat style on warm-gray paper.
- SHA-256 `52ec63cbeecf41b63740d8cfb571869a295766984faf3147cb8651c22872626c`.
- Shows the phoenix leaning up from the bottom edge: the big round head, the
  upper cream belly and a folded wing, with the crest sweeping to the top right
  and tail flames entering from the right edge.
- The lower tail flame is light purple (183, 148, 232), the same accent as the
  shipped icon, at the owner's request on 2026-11-04. This was a pixel recolour
  of that one flame of the original generation (SHA-256 `3bdda394…62fc`, in git
  history):
  `python3 -I scripts/recolor-flat-region.py ORIGINAL.png phoenix-lean.png 1220 830 183 148 232 227,220,210 237,69,24 246,135,22`.
  It reproduces byte-for-byte. The PNG re-encode drops the generator's C2PA chunk.
- Generated with GPT Image through the Codex CLI. The references were the owner's
  chosen phoenix character and the former fox icon, used only for its angle and
  framing. The original Chinese prompt follows.

> 附带两张参考图：
> - 第一张是“角色”：这只暖橙色的小凤凰就是主角（暖橙色圆胖身体、奶白色大肚子、头顶橙红和金黄两色的火焰冠羽、金黄色小尖嘴、一对黑色实心椭圆眼睛、橙红配金黄的翅膀和火焰尾羽）。角色的长相、配色和画风必须和它一致。
> - 第二张只是“图标构图参考”（现在的小狐狸 App 图标）：学它的角度和取景——角色的脸放得很大、几乎撑满画面、头歪着从画面一角斜着探进来、边缘出框裁切，缩小到 32 像素也能认出角色和表情。不要画狐狸，不要照抄狐狸的脸型和白脸颊。
>
> 画风：扁平矢量、纯色大色块、没有描边、没有渐变高光、没有 3D；暖灰色纸面背景（接近 #E5E2DC），极轻微纸张颗粒。这是 App 图标的正方形底图，铺满整张画面，不要画圆角边框、不要阴影、不要任何文字、字母、水印。1:1 方形。
>
> 构图：头加一点身体。小凤凰从画面底边斜着探上来，身体向右上方倾斜，露出圆头、奶白肚子的上半部分和一片收在身侧的小翅膀；身体下半部分在底边外。头顶火焰冠羽朝右上角飘，尾羽火苗从右侧边缘探进来一点。角色占画面约 80%，眼睛看向右上方。

## Active launcher generation

1. Copy it over `assets/brand/launcher-art.png`.
2. Update `brand-identity.json.launcher`: `sha256`, `selectedAt` and
   `background` (match the art's edge colour), and re-measure
   `android.criticalEyeBounds`.
3. Set the same background in `icons.json` and `android-foreground.svg`.
4. Run `node scripts/generate-app-icons.mjs` and
   `python3 scripts/verify-release-icons.py --source`.

Its body and tail reach the artwork edges. `android-foreground.svg` extends
the outermost source pixels into the Android motion field while preserving
the central artwork. The verifier checks all four seams and both eye bounds.
Source selection does not publish or install an App update.
