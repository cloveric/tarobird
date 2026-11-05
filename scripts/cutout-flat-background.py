#!/usr/bin/env python3
"""Remove a flat, uniform background from generated flat or soft-3D artwork.

Used for the TaroBird phoenix (assets/brand/phoenix-art.png) and the
pastel-phoenix avatar cutout. Pixels near the border colour become
transparent; edge pixels get alpha by projecting between the background and
the nearest interior colour. The canvas is never rescaled or redrawn.

Usage: python3 -I scripts/cutout-flat-background.py INPUT.png OUTPUT.png
Requires Pillow and NumPy.
"""
import sys
import numpy as np
from PIL import Image

src_path, out_path = sys.argv[1], sys.argv[2]
src = np.asarray(Image.open(src_path).convert("RGB")).astype(np.float32)
H, W, _ = src.shape
edge = np.concatenate([src[:6].reshape(-1, 3), src[-6:].reshape(-1, 3), src[:, :6].reshape(-1, 3), src[:, -6:].reshape(-1, 3)])
bg = np.median(edge, axis=0)
dist = np.linalg.norm(src - bg, axis=2)
T = 9.0
background = dist < T

def shift(a, dy, dx, fill):
    out = np.full_like(a, fill)
    ys, yd = (slice(dy, None), slice(None, -dy)) if dy > 0 else ((slice(None, dy), slice(-dy, None)) if dy < 0 else (slice(None), slice(None)))
    xs, xd = (slice(dx, None), slice(None, -dx)) if dx > 0 else ((slice(None, dx), slice(-dx, None)) if dx < 0 else (slice(None), slice(None)))
    out[ys, xs] = a[yd, xd]
    return out

def dilate(mask, steps):
    m = mask.copy()
    for _ in range(steps):
        n = m.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                n |= shift(m, dy, dx, False)
        m = n
    return m

near_bg = dilate(background, 3)
solid = ~near_bg                       # well inside the bird
band = near_bg & dilate(~background, 2)  # edge pixels on both sides of the boundary

# Propagate the nearest solid colour outward into the band.
colour = np.where(solid[..., None], src, 0)
known = solid.copy()
for _ in range(8):
    acc = np.zeros_like(src); cnt = np.zeros((H, W), np.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            k = shift(known, dy, dx, False)
            acc += shift(colour, dy, dx, 0) * k[..., None]; cnt += k
    new = (~known) & (cnt > 0)
    colour[new] = acc[new] / cnt[new][:, None]
    known |= new

alpha = np.zeros((H, W), np.float32)
alpha[solid] = 1.0
vec = colour - bg
den = np.maximum((vec * vec).sum(axis=2), 1e-3)
proj = np.clip(((src - bg) * vec).sum(axis=2) / den, 0, 1)
alpha[band] = proj[band]
alpha[(band) & (alpha < 0.06)] = 0
alpha[background & ~band] = 0
rgb = np.where(solid[..., None], src, colour)
rgb[~known] = bg
out = np.dstack([np.clip(rgb, 0, 255), alpha * 255]).round().astype(np.uint8)
Image.fromarray(out, "RGBA").save(out_path, optimize=True)
ys, xs = np.nonzero(alpha > 0)
print("bg", bg.round(1).tolist(), "bbox", int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()),
      "edge-alpha-max", float(max(alpha[0].max(), alpha[-1].max(), alpha[:, 0].max(), alpha[:, -1].max())))
