#!/usr/bin/env python3
"""Split the approved transparent mascot sheets; preserve their RGBA artwork.

The image editor supplies the cutout. This script only finds transparent gutters,
crops, scales and centers each sprite on a 256px transparent canvas. A tiny alpha
threshold is used for bounds only, never to recolor or remove image pixels.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]
EDGE = 256
INSET = 12
SHEET_LAYOUTS = [(3, 3)] * 10 + [(9, 6), (1, 1)]  # columns, rows; catalog reading order


def separators(image, axis, parts=3):
    alpha = image.getchannel("A")
    size = image.size[axis]
    counts = []
    for i in range(size):
        line = alpha.crop((i, 0, i + 1, image.height) if axis == 0 else (0, i, image.width, i + 1))
        counts.append(sum(line.histogram()[32:]))
    result = [0]
    for boundary in range(1, parts):
        fraction, margin = boundary / parts, .24 / parts
        low, high = int(size * (fraction - margin)), int(size * (fraction + margin))
        gaps, start = [], None
        for i in range(low, high):
            if counts[i] == 0 and start is None:
                start = i
            if start is not None and (counts[i] != 0 or i == high - 1):
                gaps.append((start, i))
                start = None
        if not gaps:
            raise ValueError("No transparent gutter: inspect the edited sheet before cropping")
        a, b = max(gaps, key=lambda pair: pair[1] - pair[0])
        result.append((a + b) // 2)
    return result + [size]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ROOT / "assets/bot-mascot-sources")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "client/src/assets/bot-mascots")
    parser.add_argument("--sheets", type=int, nargs="+", choices=range(1, len(SHEET_LAYOUTS) + 1),
                        help="Package only these sheets, preserving existing asset bytes and receipts")
    args = parser.parse_args()
    if not features.check("webp"):
        raise SystemExit("Pillow must include WebP support")
    catalog = (ROOT / "src/client-protocol/bot-avatar-catalog.ts").read_text().split("] as const;", 1)[0]
    ids = re.findall(r'\{ id: "([a-z-]+)",', catalog)
    count = sum(cols * rows for cols, rows in SHEET_LAYOUTS)
    if len(ids) != count or len(set(ids)) != count:
        raise SystemExit("Review the sheet layouts and mascot mapping before changing the catalog")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = args.source_dir / "crop-receipt.json"
    receipt = {item["id"]: item for item in json.loads(receipt_path.read_text())} if args.sheets and receipt_path.exists() else {}
    selected = set(args.sheets or range(1, len(SHEET_LAYOUTS) + 1))
    offset = 0
    packaged = []
    for sheet, (cols, rows) in enumerate(SHEET_LAYOUTS):
        names = ids[offset:offset + cols * rows]
        offset += cols * rows
        if sheet + 1 not in selected:
            continue
        source = args.source_dir / f"cutouts-{sheet + 1}.png"
        image = Image.open(source).convert("RGBA")
        if image.getchannel("A").getextrema() == (255, 255):
            raise ValueError(f"Sheet has no transparency: {source.name}")
        ys = separators(image, 1, rows)
        for row in range(rows):
            strip = image.crop((0, ys[row], image.width, ys[row + 1]))
            xs = separators(strip, 0, cols)
            for col in range(cols):
                name = names[row * cols + col]
                cell = strip.crop((xs[col], 0, xs[col + 1], strip.height))
                bounds = cell.getchannel("A").point(lambda a: 255 if a >= 32 else 0).getbbox()
                if not bounds:
                    raise ValueError(f"Empty avatar: {name}")
                left, top, right, bottom = bounds
                bounds = (max(0, left - 2), max(0, top - 2), min(cell.width, right + 2), min(cell.height, bottom + 2))
                sprite = cell.crop(bounds)
                # Dense source sheets have smaller cells than the output tile.
                # Normalize those silhouettes too; thumbnail() only shrinks and
                # would leave the 54 new mini designs tiny in the existing UI.
                if max(sprite.size) < EDGE - 2 * INSET:
                    scale = (EDGE - 2 * INSET) / max(sprite.size)
                    sprite = sprite.resize(tuple(round(side * scale) for side in sprite.size), Image.Resampling.LANCZOS)
                sprite.thumbnail((EDGE - 2 * INSET, EDGE - 2 * INSET), Image.Resampling.LANCZOS)
                tile = Image.new("RGBA", (EDGE, EDGE))
                tile.paste(sprite, ((EDGE - sprite.width) // 2, (EDGE - sprite.height) // 2))
                output = args.output_dir / f"{name}.webp"
                tile.save(output, format="WEBP", lossless=True, method=6, exact=True)
                decoded = Image.open(output).convert("RGBA")
                if decoded.tobytes() != tile.tobytes():
                    raise ValueError(f"Lossless RGBA verification failed: {name}")
                receipt[name] = {"id": name, "source": source.name, "cell": [xs[col], ys[row], xs[col + 1], ys[row + 1]], "bounds": list(bounds), "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}
                packaged.append(receipt[name])
    receipt_path.write_text(json.dumps([receipt[name] for name in ids if name in receipt], indent=2) + "\n")
    print(f"{len(packaged)} RGBA avatars, {sum(item['bytes'] for item in packaged):,} bytes; lossless pixels verified")


if __name__ == "__main__":
    main()
