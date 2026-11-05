#!/usr/bin/env python3
"""Crop the owner's original sheets without generating or redrawing artwork.

Requires Pillow with WebP support. Run from any directory; defaults are relative
to this repository. The catalog order is the existing v1 Bot identity contract.
"""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, features


ROOT = Path(__file__).resolve().parents[1]
EDGE = 256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ROOT / "assets/bot-avatar-sources")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "client/src/assets/bot-avatars")
    parser.add_argument("--preview", type=Path, help="Optional contact sheet, outside shipped assets")
    args = parser.parse_args()
    if not features.check("webp"):
        raise SystemExit("Pillow must include WebP support")
    catalog = json.loads((args.source_dir / "catalog-v1.json").read_text())
    ids = [avatar["id"] for avatar in catalog]
    if len(ids) != 63 or len(set(ids)) != 63:
        raise SystemExit("Expected the 63-entry v1 catalog; review source mapping before expanding it")
    # These are the same source rectangles previously used by the runtime's
    # clipped image view. Changing packaging must not change a Bot's portrait.
    crops = []
    original_bytes = 0
    for sheet in range(7):
        source = args.source_dir / f"animals-{sheet + 1}.jpeg"
        original_bytes += source.stat().st_size
        square = sheet == 6
        expected = (2048, 2048) if square else (2752, 1536)
        xs = [122, 775, 1430] if square else [672, 1174, 1677]
        ys = [124, 776, 1430] if square else [90, 568, 1048]
        edge = 498 if square else 404
        with Image.open(source) as image:
            if image.size != expected:
                raise SystemExit(f"Unexpected source dimensions: {source.name}: {image.size}, wanted {expected}")
            for row, y in enumerate(ys):
                for col, x in enumerate(xs):
                    name = ids[sheet * 9 + row * 3 + col]
                    cropped = image.crop((x, y, x + edge, y + edge)).convert("RGB")
                    # Resize once for 256px avatar uploads; lossless WebP adds no
                    # further quantization, metadata or generative alterations.
                    crops.append((name, cropped.resize((EDGE, EDGE), Image.Resampling.LANCZOS)))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, tile in crops:
        output = args.output_dir / f"{name}.webp"
        tile.save(output, format="WEBP", lossless=True, method=6, exact=True)
        with Image.open(output) as decoded:
            if decoded.size != (EDGE, EDGE) or decoded.convert("RGB").tobytes() != tile.tobytes():
                raise SystemExit(f"Lossless verification failed: {output}")
    total = sum((args.output_dir / f"{name}.webp").stat().st_size for name, _ in crops)
    digest = hashlib.sha256(b"".join((args.output_dir / f"{name}.webp").read_bytes() for name, _ in crops)).hexdigest()
    print(f"63 portraits: {original_bytes:,} -> {total:,} bytes ({(1 - total / original_bytes) * 100:.1f}% smaller)")
    print(f"Ordered output SHA-256: {digest}")
    if args.preview:
        cell = 132
        preview = Image.new("RGB", (9 * cell, 7 * cell), "#f5f5f5")
        draw = ImageDraw.Draw(preview)
        for index, (name, tile) in enumerate(crops):
            x, y = index % 9 * cell, index // 9 * cell
            preview.paste(tile.resize((112, 112), Image.Resampling.LANCZOS), (x + 10, y + 3))
            draw.text((x + 8, y + 116), name, fill="#222222")
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        preview.save(args.preview)


if __name__ == "__main__":
    main()
