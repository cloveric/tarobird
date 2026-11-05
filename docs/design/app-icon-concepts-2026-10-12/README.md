# TaroBot app icon concepts — 2026-10-12

Two original concept masters generated with the built-in GPT Image tool.
These are design candidates, not the packaged app icon.

Update: the owner has selected candidate A. The exact supplied master now
drives all shipping icon resources; see [the selected-icon validation](../../client/selected-icon-2026-10-12.md).
The exploration and its original acceptance scope below are retained as history.

## Reference findings

The installed TaroBot app and repository still use a blue letter T as the launcher
icon, while the in-app wordmark uses a Layers glyph. The two identities differ.
The locally installed Grok Bot icon uses a simple face and strong silhouette;
Claude uses a single recognizable symbol. These were inspected for shape,
contrast and small-size legibility. No reference brand artwork is included here.

## Candidates

- **A — Taro Bot mascot (recommended):** a violet assistant with a folded taro
  shoot, a compact body and two eyes. It gives TaroBot a recognizable character
  related to its name and complements the existing animal Bot avatar library.
- **B — Conversation T:** a warm white T with a conversation-tail detail on
  petrol blue. A quieter typographic direction.

Both masters are opaque, full-bleed PNGs, 1254 × 1254 pixels, without a baked-in
launcher corner mask. `preview.html` applies display-only masks and shows both
assets at 32, 48 and 64 CSS pixels and in light/dark interface contexts.

## Scope and acceptance

The masters, exact prompts and a responsive preview are included. Candidate A
is now used by the shared in-app wordmark; see [the integration and native
checks](../../client/brand-mark-2026-10-12.md). App launchers, favicons and
existing Bot avatars have not been replaced.
Native launcher masks, monochrome tray assets, Android adaptive layers and
packaged app acceptance still need to be completed for the selected direction.
No application behavior changed; there is no release associated with this
design-only checkpoint.

Open [the preview](preview.html) to compare both candidates.

The rendered browser preview was visually checked at 32, 48 and 64 CSS pixels
in light and dark interface rows. Both silhouettes and the mascot eyes remain
recognizable. [Saved comparison](comparison.png). This is a design preview,
not native Dock or Android launcher validation.

## Exact generation prompts

### A — Taro Bot mascot

```text
Use case: logo-brand.
Asset type: a finished square app icon master for TaroBot, an independent desktop and mobile AI assistant chat application.
Design ONE original, memorable brand mascot: a softly rounded taro-purple little assistant, a single compact domed body with two upright dark pill eyes, and one short asymmetric folded tuft on top that subtly suggests a taro shoot. Extremely simple, confident silhouette, warm intelligent expression. The mascot should feel like a premium useful desktop companion, not a children's toy or a food delivery app. No limbs, ears, mouth, cheeks, nose, accessories or extra decorations. The tuft must be one bold shape, not a detailed leaf.
Composition: one large centered symbol, front facing, filling approximately 62 percent of the square, comfortable clear safety margins on all sides. Full-bleed opaque extremely pale lavender background. Do NOT draw a smaller app tile inside the square and do NOT round the outer image corners; the operating system supplies its own mask.
Style: exceptional polished app icon design with restrained soft molded depth, crisp silhouette, matte ceramic surface, broad gentle shading and a subtle grounding shadow. Rich muted violet body with lilac highlights, almost-black eyes. Design the overall silhouette as a recognizable logo first, not a 3D character scene. Looks clear at 32 pixels. Quiet, sophisticated, friendly, visually balanced.
No text, no letters, no border, no watermark, no sparkle, no galaxy, no glossy plastic, no multicolor gradient background, no detailed texture, no scene, no mockup, no grids. Do not imitate any existing app mascot.
```

### B — Conversation T

```text
Use case: logo-brand.
Asset type: a finished square app icon master for TaroBot, an independent desktop and mobile AI assistant chat application.
Design ONE original elegant geometric symbol that seamlessly fuses a bold uppercase T with a conversation bubble. The T is a single warm white soft-edged sculpted form with a broad rounded horizontal top and a short centered vertical stem, and the lower-right edge of its top gently extends into a small speech-tail cut. Prioritize a beautiful distinctive clear silhouette over literal illustrative detail. It should read as a compact conversational T, not a stock font letter, and remain recognizable at 32 pixels.
Composition: one large centered mark occupying about 62 percent of the square, generous balanced margins, perfectly front facing. Full-bleed opaque deep desaturated petrol blue background with only the gentlest tonal light falloff. Do NOT draw a smaller tile inside the square and do NOT round the outer image corners; the operating system supplies its own mask.
Style: premium macOS and mobile app identity, carefully crafted rounded geometry, matte porcelain white mark, very subtle shallow relief and soft shadow. Restrained and professional, a cohesive polished companion to a minimal modern IM interface. Just one symbol and one background.
No text label, no small second glyph, no extra objects, no watermark, no shiny bevel, no metallic chrome, no clutter, no ornamental glow, no rainbow gradient, no mockup, no grid. Do not copy any existing brand mark.
```
