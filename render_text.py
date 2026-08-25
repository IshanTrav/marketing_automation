#!/usr/bin/env python3
"""Renders the composited layers: per-beat captions and the closing card.

Text is drawn here rather than generated because a video model cannot spell. The same
reason the logo and the interface are composited: anything that must be *correct* is
made in post, and only the footage is generated.

Sub-commands:
  beat <out.png> <text> [--width N] [--top FRAC]
  card <bg.png> <logo.png> <out.png> <headline> <button> [kicker] [footnote]
  cta  <logo.png> <out.png> <headline> <button> [kicker] [footnote]
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
ACCENT = (9, 207, 183)      # #09CFB7, sampled from the app's own FAB
INK = (16, 24, 28)


def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if draw.textbbox((0, 0), trial, font=font)[2] <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def fitted_font(draw, text, max_w, start, min_size, max_lines):
    """Shrinks until the line count and width both behave. Long text must not overflow
    the safe zone, and it must never become a paragraph."""
    size = start
    while size > min_size:
        f = ImageFont.truetype(BOLD, size)
        lines = wrap(draw, text, f, max_w)
        if len(lines) <= max_lines:
            return f, lines
        size -= 4
    f = ImageFont.truetype(BOLD, min_size)
    return f, wrap(draw, text, f, max_w)


def draw_block(card, lines, font, top, fill=(255, 255, 255), shadow=True, line_gap=14):
    """Centred lines with a soft shadow, which is what keeps white type readable over
    footage whose brightness we do not control."""
    draw = ImageDraw.Draw(card)
    if shadow:
        shadow_layer = Image.new("RGBA", card.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow_layer)
        y = top
        for ln in lines:
            w_ = sd.textbbox((0, 0), ln, font=font)[2]
            sd.text(((W - w_) // 2 + 3, y + 4), ln, font=font, fill=(0, 0, 0, 190))
            y += font.size + line_gap
        card.alpha_composite(shadow_layer.filter(ImageFilter.GaussianBlur(9)))
    y = top
    for ln in lines:
        w_ = draw.textbbox((0, 0), ln, font=font)[2]
        draw.text(((W - w_) // 2, y), ln, font=font, fill=fill + (255,))
        y += font.size + line_gap
    return y


def beat_overlay(out_path, text, top_frac=0.15):
    """A transparent layer holding one beat's caption.

    Sits high: clear of the platform's chrome at the very top, clear of its caption tray
    at the bottom, and above the middle of the frame where a held phone usually is. A
    caption drawn over the phone competes with the one thing the ad is selling.

    A gradient scrim sits behind it. A shadow alone is not enough over a bright
    background - the demo beat is a white app screen, and white type vanished on it.
    """
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(card)
    font, lines = fitted_font(draw, text, int(W * 0.82), 76, 46, 2)
    top = int(H * top_frac)
    block_h = len(lines) * (font.size + 14)

    scrim_top = max(0, top - 70)
    scrim_bottom = min(H, top + block_h + 70)
    scrim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scrim)
    span = scrim_bottom - scrim_top
    for i in range(span):
        # Strongest behind the text, fading to nothing at both edges, so it reads as
        # light falling off rather than a box pasted on.
        t = i / span
        a = int(150 * (1 - abs(t - 0.5) * 2) ** 0.6)
        sd.line([(0, scrim_top + i), (W, scrim_top + i)], fill=(0, 0, 0, a))
    card.alpha_composite(scrim.filter(ImageFilter.GaussianBlur(6)))

    draw_block(card, lines, font, top)
    card.save(out_path)
    print(f"beat overlay → {out_path}  ({len(lines)} line{'s' if len(lines) > 1 else ''}, {font.size}px)")


def end_card(bg_path, logo_path, out_path, headline, button, kicker="", footnote=""):
    """The closing card.

    Everything on it is composited rather than generated, because everything on it has to
    be exactly right: the mark, the words, the call to action. A video model gets none of
    those reliably, and a misspelt brand on the last frame is the one error a viewer
    definitely reads.

    Five layers, top to bottom: kicker, logo badge, headline, button, footnote. Any of the
    optional ones can be empty and the rest re-centre around the gap.
    """
    bg = Image.open(bg_path).convert("RGB").resize((W, H), Image.LANCZOS)
    # Light enough that the place behind still reads. The payoff frame is part of the sell.
    bg = bg.filter(ImageFilter.GaussianBlur(20))
    bg = Image.blend(bg, Image.new("RGB", (W, H), (10, 18, 24)), 0.58)
    card = bg.convert("RGBA")
    draw = ImageDraw.Draw(card)

    logo = Image.open(logo_path).convert("RGBA")
    lw = 290
    logo = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    pad_x, pad_y = 52, 42
    bw, bh = lw + pad_x * 2, logo.height + pad_y * 2

    # Measure everything first so the whole stack can be centred as one block.
    kfont = ImageFont.truetype(BOLD, 34)
    hfont, hlines = fitted_font(draw, headline, int(W * 0.80), 68, 44, 2)
    bfont = ImageFont.truetype(BOLD, 46)
    ffont = ImageFont.truetype(BOLD, 30)

    gap_k, gap_h, gap_b, gap_f = 30, 74, 58, 40
    btn_h = 104
    block = (
        (kfont.size + gap_k if kicker else 0)
        + bh + gap_h
        + len(hlines) * (hfont.size + 14) + gap_b
        + btn_h
        + (gap_f + ffont.size if footnote else 0)
    )
    y = (H - block) // 2

    if kicker:
        # A kicker in the brand accent names the trip, so the card belongs to this film
        # rather than being a generic sign-off.
        kw = draw.textbbox((0, 0), kicker.upper(), font=kfont)[2]
        draw.text(((W - kw) // 2, y), kicker.upper(), font=kfont, fill=ACCENT + (255,),
                  stroke_width=0)
        y += kfont.size + gap_k

    bx = (W - bw) // 2
    shadow = Image.new("RGBA", (bw + 44, bh + 44), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([22, 22, bw + 22, bh + 22], radius=44, fill=(0, 0, 0, 150))
    card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(16)), (bx - 22, y - 10))
    ImageDraw.Draw(card).rounded_rectangle([bx, y, bx + bw, y + bh], radius=44, fill=(255, 255, 255, 255))
    card.alpha_composite(logo, (bx + pad_x, y + pad_y))
    y += bh + gap_h

    y = draw_block(card, hlines, hfont, y) - 14 + gap_b

    tw = draw.textbbox((0, 0), button, font=bfont)[2]
    pw = tw + 118
    px = (W - pw) // 2
    glow = Image.new("RGBA", (pw + 60, btn_h + 60), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle([30, 30, pw + 30, btn_h + 30], radius=btn_h // 2,
                                           fill=ACCENT + (110,))
    card.alpha_composite(glow.filter(ImageFilter.GaussianBlur(22)), (px - 30, y - 30))
    ImageDraw.Draw(card).rounded_rectangle([px, y, px + pw, y + btn_h], radius=btn_h // 2,
                                           fill=ACCENT + (255,))
    draw.text((px + (pw - tw) // 2, y + (btn_h - bfont.size) // 2 - 6), button, font=bfont,
              fill=INK + (255,))
    y += btn_h

    if footnote:
        y += gap_f
        fw = draw.textbbox((0, 0), footnote, font=ffont)[2]
        draw.text(((W - fw) // 2, y), footnote, font=ffont, fill=(228, 236, 238, 235))

    card.convert("RGB").save(out_path)
    print(f"end card → {out_path}")


def cta_overlay(logo_path, out_path, headline, button, kicker="", footnote=""):
    """The CTA, composited over the *last* generated part's own footage rather than a
    still card appended after it - the video ends on the shot, not on a separate slide.

    Same stack as end_card (kicker / logo badge / headline / button / footnote) but
    transparent and anchored to the bottom third, because it sits over moving footage
    the system prompt was told to keep calm and open there, not over a background we
    control. A scrim behind the block is what keeps it readable regardless of what the
    footage underneath is doing.
    """
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(card)

    logo = Image.open(logo_path).convert("RGBA")
    lw = 230
    logo = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    pad_x, pad_y = 40, 32
    bw, bh = lw + pad_x * 2, logo.height + pad_y * 2

    kfont = ImageFont.truetype(BOLD, 30)
    hfont, hlines = fitted_font(draw, headline, int(W * 0.82), 62, 42, 2)
    bfont = ImageFont.truetype(BOLD, 42)
    ffont = ImageFont.truetype(BOLD, 27)

    gap_k, gap_h, gap_b, gap_f = 26, 54, 46, 32
    btn_h = 92
    block = (
        (kfont.size + gap_k if kicker else 0)
        + bh + gap_h
        + len(hlines) * (hfont.size + 14) + gap_b
        + btn_h
        + (gap_f + ffont.size if footnote else 0)
    )
    # Anchored from the bottom safe margin upward, which is the "lower third stays open"
    # zone the prompt reserves - not vertically centred like the old standalone card.
    bottom_margin = 140
    y = H - bottom_margin - block

    scrim_top = max(0, y - 80)
    scrim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scrim)
    for i in range(scrim_top, H):
        t = (i - scrim_top) / max(1, H - scrim_top)
        sd.line([(0, i), (W, i)], fill=(0, 0, 0, int(200 * t)))
    card.alpha_composite(scrim.filter(ImageFilter.GaussianBlur(10)))

    if kicker:
        kw = draw.textbbox((0, 0), kicker.upper(), font=kfont)[2]
        draw.text(((W - kw) // 2, y), kicker.upper(), font=kfont, fill=ACCENT + (255,))
        y += kfont.size + gap_k

    bx = (W - bw) // 2
    shadow = Image.new("RGBA", (bw + 44, bh + 44), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([22, 22, bw + 22, bh + 22], radius=40, fill=(0, 0, 0, 150))
    card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(16)), (bx - 22, y - 10))
    ImageDraw.Draw(card).rounded_rectangle([bx, y, bx + bw, y + bh], radius=40, fill=(255, 255, 255, 255))
    card.alpha_composite(logo, (bx + pad_x, y + pad_y))
    y += bh + gap_h

    y = draw_block(card, hlines, hfont, y) - 14 + gap_b

    tw = draw.textbbox((0, 0), button, font=bfont)[2]
    pw = tw + 108
    px = (W - pw) // 2
    glow = Image.new("RGBA", (pw + 60, btn_h + 60), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle([30, 30, pw + 30, btn_h + 30], radius=btn_h // 2, fill=ACCENT + (110,))
    card.alpha_composite(glow.filter(ImageFilter.GaussianBlur(22)), (px - 30, y - 30))
    ImageDraw.Draw(card).rounded_rectangle([px, y, px + pw, y + btn_h], radius=btn_h // 2, fill=ACCENT + (255,))
    draw.text((px + (pw - tw) // 2, y + (btn_h - bfont.size) // 2 - 5), button, font=bfont, fill=INK + (255,))
    y += btn_h

    if footnote:
        y += gap_f
        fw = draw.textbbox((0, 0), footnote, font=ffont)[2]
        draw.text(((W - fw) // 2, y), footnote, font=ffont, fill=(228, 236, 238, 235))

    card.save(out_path)
    print(f"cta overlay → {out_path}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "beat":
        top = 0.15
        args = sys.argv[2:]
        if "--top" in args:
            i = args.index("--top"); top = float(args[i + 1]); args = args[:i] + args[i + 2:]
        beat_overlay(args[0], args[1], top)
    elif cmd == "card":
        # card <bg> <logo> <out> <headline> <button> [kicker] [footnote]
        end_card(*sys.argv[2:9])
    elif cmd == "cta":
        # cta <logo> <out> <headline> <button> [kicker] [footnote]
        cta_overlay(*sys.argv[2:8])
    else:
        print(__doc__); sys.exit(1)
