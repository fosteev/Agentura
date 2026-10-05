#!/usr/bin/env python3
"""Montage/crop helper for run.mjs: python3 montage.py spec.json (see run.mjs for the spec)."""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS = ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf']


def font(size):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def load(f):
    im = Image.open(f['src']).convert('RGB')
    if 'crop' in f:  # [x, y, w, h] in 2x pixels
        x, y, w, h = f['crop']
        im = im.crop((x, y, x + w, y + h))
    return im


def main():
    spec = json.load(open(sys.argv[1]))
    frames = [(load(f), f.get('label')) for f in spec['frames']]
    if spec.get('single'):
        out = frames[0][0]
    else:
        pad = spec.get('pad', 48)
        cols = spec['cols']
        rows = -(-len(frames) // cols)
        cw = max(im.width for im, _ in frames)
        ch = max(im.height for im, _ in frames)
        fnt = font(26)
        lab_h = 26 + 18
        W = pad + cols * (cw + pad)
        H = pad + rows * (lab_h + ch + pad)
        out = Image.new('RGB', (W, H), spec['bg'])
        d = ImageDraw.Draw(out)
        for i, (im, label) in enumerate(frames):
            x = pad + (i % cols) * (cw + pad)
            y = pad + (i // cols) * (lab_h + ch + pad)
            if label:
                d.text((x, y), label, font=fnt, fill=spec['fg'])
            out.paste(im, (x, y + lab_h))
    mw = spec.get('max_width')
    if mw and out.width > mw:
        out = out.resize((mw, round(out.height * mw / out.width)), Image.LANCZOS)
    out.save(spec['out'], 'PNG', optimize=True)
    print(f"{spec['out']}  {out.width}x{out.height}")


main()
