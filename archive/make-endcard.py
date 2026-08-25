#!/usr/bin/env python3
"""Builds the closing card that gets appended to every reel.

The logo and the call to action are composited here rather than generated, because a
video model cannot draw either accurately. The background is the clip's own last frame,
blurred and darkened, so the card reads as part of the post instead of a bolt-on.

Usage: make-endcard.py <background.png> <logo.png> <out.png> ["Book your trips now"]
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

bg_path, logo_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
cta = sys.argv[4] if len(sys.argv) > 4 else "Book your trips now"

bg = Image.open(bg_path).convert("RGB").resize((W, H), Image.LANCZOS)
bg = bg.filter(ImageFilter.GaussianBlur(28))
# Darken enough that white type sits comfortably on any footage.
bg = Image.blend(bg, Image.new("RGB", (W, H), (10, 16, 20)), 0.68)

card = bg.convert("RGBA")

logo = Image.open(logo_path).convert("RGBA")
target_w = int(W * 0.52)
logo = logo.resize((target_w, round(logo.height * target_w / logo.width)), Image.LANCZOS)
logo_y = H // 2 - logo.height
card.alpha_composite(logo, ((W - logo.width) // 2, logo_y))

draw = ImageDraw.Draw(card)
font = ImageFont.truetype(FONT_BOLD, 58)
tw = draw.textbbox((0, 0), cta, font=font)[2]
text_y = logo_y + logo.height + 70
draw.text(((W - tw) // 2, text_y), cta, font=font, fill=(255, 255, 255, 255))

# A short accent rule in the brand teal. Sampled from the full-colour logo even when
# the white variant is composited, otherwise the "accent" comes back white.
mark = Image.open("assets/travafa-logo.png").convert("RGBA")
px = mark.load()
accent = next(
    (px[x, y][:3] for y in range(0, mark.height, 2) for x in range(0, mark.width // 4, 2)
     if px[x, y][3] > 200),
    (60, 200, 170),
)
rule_w, rule_h = 120, 6
draw.rounded_rectangle(
    [(W - rule_w) // 2, text_y + 110, (W + rule_w) // 2, text_y + 110 + rule_h],
    radius=rule_h // 2, fill=accent + (255,),
)

card.convert("RGB").save(out_path)
print(f"end card → {out_path}  accent {accent}")
