#!/usr/bin/env python3
"""Recolour one connected flat-colour region (such as a flame tip), edge-aware.

Flood-fills from the seed through pixels near its colour, widens the region by
3px, and moves each pixel toward the target by its share of the seed colour
(projected against the given neighbour colours), so anti-aliased edges stay
smooth. Requires Pillow and NumPy.

Usage: python3 -I scripts/recolor-flat-region.py IN OUT SEED_X SEED_Y R G B [NEIGHBOUR_R,G,B ...]
"""
import sys
import numpy as np
from PIL import Image, ImageFilter
src, out = sys.argv[1], sys.argv[2]
sx, sy = int(sys.argv[3]), int(sys.argv[4]); target = np.array([float(v) for v in sys.argv[5:8]])
im = np.asarray(Image.open(src).convert("RGB")).astype(float); H, W, _ = im.shape
Y = im[sy-3:sy+4, sx-3:sx+4].reshape(-1, 3).mean(axis=0)
near = np.linalg.norm(im - Y, axis=2) < 40
# flood fill from the seed through near-Y pixels
mask = np.zeros((H, W), bool); stack = [(sy, sx)]
while stack:
    y, x = stack.pop()
    if 0 <= y < H and 0 <= x < W and near[y, x] and not mask[y, x]:
        mask[y, x] = True; stack += [(y+1, x), (y-1, x), (y, x+1), (y, x-1)]
region = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))) > 0
# neighbour colour = median of pixels in a ring just outside the solid region (per pixel: nearest of the ring palette)
ring = region & ~mask
ring_px = im[ring & (np.linalg.norm(im - Y, axis=2) > 60)]
cands = []
for c in ring_px[np.random.default_rng(0).choice(len(ring_px), min(400, len(ring_px)), replace=False)]:
    if all(np.linalg.norm(c - d) > 30 for d in cands): cands.append(c)
cands = np.array(cands)
if len(sys.argv) > 8: cands = np.array([[float(v) for v in c.split(',')] for c in sys.argv[8:]])
outim = im.copy()
ys, xs = np.nonzero(region)
for y, x in zip(ys, xs):
    p = im[y, x]
    best = None
    for O in cands:
        d = Y - O; t = np.clip(np.dot(p - O, d) / max(np.dot(d, d), 1e-6), 0, 1)
        err = np.linalg.norm(p - (O + t * d))
        if best is None or err < best[0]: best = (err, O, t)
    err, O, t = best
    if t > 0.02: outim[y, x] = p + t * (target - Y)
Image.fromarray(np.clip(outim, 0, 255).round().astype(np.uint8)).save(out)
print("seed colour", Y.round(), "solid px", int(mask.sum()), "neighbour colours", cands.round().tolist())
