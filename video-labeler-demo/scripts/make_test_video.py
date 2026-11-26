"""
Generates animated test clips of the pen assembly for the assembly monitor.

The clips are simple top-down drawings of the table, not real footage. They
exist so the whole chain (video -> AI -> checklist -> alerts) can be tested
without a camera, and so the same input can be replayed after every change.

  python scripts/make_test_video.py

writes two files into public/test-videos/:
  pen-assembly-correct.webm         every step in order
  pen-assembly-spring-skipped.webm  the spring is left on the table
"""
import math
import os
import sys
from collections import defaultdict

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 720, 10
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "test-videos")

TABLE = (226, 221, 210)
BARREL = (38, 96, 190)
BARREL_EDGE = (20, 52, 110)
REFILL = (245, 245, 245)
INK = (25, 25, 25)
METAL = (120, 124, 130)
SKIN = (233, 190, 160)
SLEEVE = (70, 110, 90)
TEXT = (60, 60, 60)

# where things lie on the table after kitting
HOME = {
    "lower": (220, 170),
    "upper": (220, 270),
    "refill": (250, 370),
    "spring": (200, 470),
}
LABELS = {
    "lower": "lower barrel",
    "upper": "upper barrel",
    "refill": "ink refill",
    "spring": "spring",
}
SPRING_ON_REFILL = -98  # spring centre relative to refill centre
LOWER_ASM = (560, 330)
REFILL_PRE = (820, 330)
REFILL_IN = (587, 330)
UPPER_PRE = (980, 330)
UPPER_ON = (760, 330)
PEN_CENTRE = (657, 330)
SHOW = (640, 320)
OUTPUT_BOX = (770, 570, 1250, 690)
OUTPUT_POS = (1010, 630)


def font(size):
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


FONT = font(20)
FONT_SMALL = font(16)


def ease(u):
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def value_at(track, t):
    """Value of a keyframed track at time t (eased between keyframes)."""
    if t <= track[0][0]:
        return track[0][1]
    for (t0, v0), (t1, v1) in zip(track, track[1:]):
        if t0 <= t <= t1:
            u = ease((t - t0) / (t1 - t0)) if t1 > t0 else 1.0
            if isinstance(v0, tuple):
                return tuple(a + (b - a) * u for a, b in zip(v0, v1))
            return v0 + (v1 - v0) * u
    return track[-1][1]


class Scene:
    """Keyframes for every part, built step by step along a time cursor."""

    def __init__(self):
        self.tracks = defaultdict(list)
        self.t = 0.0
        self.last = {}

    def set(self, name, value, at=None):
        at = self.t if at is None else at
        self.tracks[name].append((at, value))
        self.last[name] = value

    def move(self, name, value, start, duration):
        """Hold the current value until `start`, then glide to `value`."""
        self.set(name, self.last[name], self.t + start)
        self.set(name, value, self.t + start + duration)

    def hand_follow(self, name, start, duration, target):
        """The hand goes to a part, carries it to `target`, then lets go."""
        x, y = self.last[name]
        self.set("hand", self.last["hand"], self.t + start - 0.8)
        self.set("hand", (x, y + 26), self.t + start)
        self.move(name, target, start, duration)
        self.set("hand", (target[0], target[1] + 26), self.t + start + duration)

    def hand_away(self, at):
        self.set("hand", self.last["hand"], self.t + at)
        self.set("hand", (640, 860), self.t + at + 0.8)

    def advance(self, seconds):
        self.t += seconds


def build(skip_spring):
    s = Scene()
    for name, (x, _) in HOME.items():
        s.set(name, (x, 860))
    s.set("hand", (640, 860))
    s.set("labels", 1.0)
    s.set("extend", 0.0)   # how far the tip is pushed out
    s.set("press", 0.0)    # how far the clicker is pressed
    s.set("screw", 0.0)    # > 0 while the barrel is being screwed
    s.set("group", (PEN_CENTRE[0], PEN_CENTRE[1], 1.0))
    s.advance(1.5)

    # S1 kitting: the four parts are laid out one by one
    for i, name in enumerate(["lower", "upper", "refill", "spring"]):
        s.hand_follow(name, 0.8 + i * 1.5, 1.0, HOME[name])
    s.hand_away(6.6)
    s.advance(11.0)

    # S2 spring onto the tip end of the refill
    attach_time = None
    if not skip_spring:
        attach_time = s.t + 3.0
        rx, ry = HOME["refill"]
        s.set("labels", 1.0)
        s.hand_follow("spring", 1.0, 2.0, (rx + SPRING_ON_REFILL, ry))
        s.hand_away(3.4)
        s.advance(7.5)
    s.set("labels", 1.0)
    s.set("labels", 0.0, s.t + 0.5)

    # S3 refill into the lower barrel
    s.hand_follow("lower", 0.8, 1.4, LOWER_ASM)
    s.hand_follow("refill", 3.2, 1.6, REFILL_PRE)
    s.move("refill", REFILL_IN, 5.2, 1.6)
    s.set("hand", (REFILL_PRE[0], REFILL_PRE[1] + 26), s.t + 5.2)
    s.set("hand", (REFILL_IN[0] + 120, REFILL_IN[1] + 26), s.t + 6.8)
    s.hand_away(7.0)
    s.advance(11.0)

    # S4 upper barrel screwed on
    s.hand_follow("upper", 0.8, 1.6, UPPER_PRE)
    s.move("upper", UPPER_ON, 2.8, 1.4)
    s.set("hand", (UPPER_PRE[0], UPPER_PRE[1] + 26), s.t + 2.8)
    s.set("hand", (UPPER_ON[0] + 30, UPPER_ON[1] + 26), s.t + 4.2)
    s.set("screw", 0.0, s.t + 4.2)
    s.set("screw", 1.0, s.t + 4.3)
    s.set("screw", 1.0, s.t + 6.0)
    s.set("screw", 0.0, s.t + 6.1)
    s.hand_away(6.3)
    s.advance(10.5)

    # S5 function test: two presses, tip out and back in
    click_x, click_y = UPPER_ON[0] + 150, UPPER_ON[1]
    s.set("hand", s.last["hand"], s.t + 0.2)
    s.set("hand", (click_x, click_y + 26), s.t + 1.0)
    for start, tip in ((1.6, 1.0), (4.0, 0.0)):
        s.set("press", 0.0, s.t + start)
        s.set("press", 1.0, s.t + start + 0.3)
        s.set("press", 1.0, s.t + start + 0.7)
        s.set("press", 0.0, s.t + start + 1.0)
        s.set("extend", s.last["extend"], s.t + start)
        s.set("extend", tip, s.t + start + 0.4)
    s.hand_away(5.6)
    s.advance(9.5)

    # S6 show the pen to the camera, then put it in the output tray
    px, py = PEN_CENTRE
    s.set("hand", s.last["hand"], s.t + 0.2)
    s.set("hand", (px, py + 26), s.t + 1.0)
    s.set("group", (px, py, 1.0), s.t + 1.0)
    s.set("group", (SHOW[0], SHOW[1], 1.7), s.t + 2.4)
    s.set("hand", (SHOW[0], SHOW[1] + 50), s.t + 2.4)
    s.set("group", (SHOW[0], SHOW[1], 1.7), s.t + 4.6)
    s.set("hand", (SHOW[0], SHOW[1] + 50), s.t + 4.6)
    s.set("group", (OUTPUT_POS[0], OUTPUT_POS[1], 1.0), s.t + 6.6)
    s.set("hand", (OUTPUT_POS[0], OUTPUT_POS[1] + 26), s.t + 6.6)
    s.hand_away(6.8)
    s.advance(12.0)

    meta = {"grouped_from": s.t - 12.0 + 1.0, "attach_time": attach_time}
    return s.tracks, s.t, meta


def draw_barrel(layer, cx, cy, k, lower):
    d = ImageDraw.Draw(layer)
    half, h = 100 * k, 15 * k
    body = [cx - half, cy - h, cx + half, cy + h]
    d.rectangle(body, fill=BARREL + (150,), outline=BARREL_EDGE + (255,), width=2)
    if lower:
        cone = [(cx - half, cy - h), (cx - half - 30 * k, cy - 5 * k),
                (cx - half - 30 * k, cy + 5 * k), (cx - half, cy + h)]
        d.polygon(cone, fill=BARREL + (150,), outline=BARREL_EDGE + (255,))
        # thread ring at the open end
        d.rectangle([cx + half - 10 * k, cy - h, cx + half, cy + h],
                    fill=BARREL_EDGE + (200,))
    else:
        # pocket clip
        d.rectangle([cx - 20 * k, cy - h - 7 * k, cx + half - 12 * k, cy - h - 2 * k],
                    fill=METAL + (255,))


def draw_clicker(layer, cx, cy, k, press):
    d = ImageDraw.Draw(layer)
    x0 = cx + 100 * k
    length = (24 - 10 * press) * k
    d.rectangle([x0, cy - 7 * k, x0 + length, cy + 7 * k],
                fill=METAL + (255,), outline=(60, 60, 60, 255))


def draw_refill(layer, cx, cy, k):
    d = ImageDraw.Draw(layer)
    half, h = 145 * k, 4 * k
    d.rectangle([cx - half + 14 * k, cy - h, cx + half, cy + h],
                fill=REFILL + (255,), outline=(90, 90, 90, 255))
    d.rectangle([cx - half + 40 * k, cy - h + 1, cx + half - 30 * k, cy + h - 1],
                fill=INK + (255,))
    d.polygon([(cx - half, cy), (cx - half + 14 * k, cy - h), (cx - half + 14 * k, cy + h)],
              fill=METAL + (255,))


def draw_spring(layer, cx, cy, k):
    d = ImageDraw.Draw(layer)
    half, h, turns = 27 * k, 7 * k, 9
    pts = []
    for i in range(turns * 2 + 1):
        x = cx - half + (2 * half) * i / (turns * 2)
        pts.append((x, cy - h if i % 2 == 0 else cy + h))
    d.line(pts, fill=(70, 72, 78, 255), width=max(2, int(3 * k)), joint="curve")


def draw_hand(layer, x, y):
    if y > H + 60:
        return
    d = ImageDraw.Draw(layer)
    d.polygon([(x - 34, y + 40), (x + 34, y + 40), (x + 70, H + 40), (x - 70, H + 40)],
              fill=SLEEVE + (255,))
    d.ellipse([x - 46, y - 6, x + 46, y + 70], fill=SKIN + (255,), outline=(170, 130, 105, 255))
    for dx in (-30, -10, 10, 30):
        d.ellipse([x + dx - 9, y - 22, x + dx + 9, y + 20], fill=SKIN + (255,),
                  outline=(170, 130, 105, 255))


def render(tracks, t, meta):
    img = Image.new("RGBA", (W, H), TABLE + (255,))
    d = ImageDraw.Draw(img)
    # output tray
    d.rectangle(OUTPUT_BOX, outline=(120, 120, 120), width=3)
    d.text((OUTPUT_BOX[0] + 10, OUTPUT_BOX[1] - 26), "OUTPUT", font=FONT, fill=TEXT)

    pos = {n: value_at(tracks[n], t) for n in ("lower", "upper", "refill", "spring")}
    labels = value_at(tracks["labels"], t)
    extend = value_at(tracks["extend"], t)
    press = value_at(tracks["press"], t)
    screw = value_at(tracks["screw"], t)
    gx, gy, k = value_at(tracks["group"], t)
    grouped = t >= meta["grouped_from"]

    # once fitted, the spring travels with the refill
    spring_attached = meta["attach_time"] is not None and t >= meta["attach_time"]
    if spring_attached:
        pos["spring"] = (pos["refill"][0] + SPRING_ON_REFILL, pos["refill"][1])

    def place(name):
        x, y = pos[name]
        if name == "refill" or (name == "spring" and spring_attached):
            x -= 16 * extend
        if grouped and (name != "spring" or spring_attached):
            return gx + k * (x - PEN_CENTRE[0]), gy + k * (y - PEN_CENTRE[1]), k
        return x, y, 1.0

    if labels > 0.5:
        for name, text in LABELS.items():
            x, y = pos[name]
            if abs(y - HOME[name][1]) < 1 and abs(x - HOME[name][0]) < 1:
                d.text((x - 60, y + 26), text, font=FONT_SMALL, fill=TEXT)

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw_refill(layer, *place("refill"))
    draw_spring(layer, *place("spring"))
    img = Image.alpha_composite(img, layer)

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    lx, ly, lk = place("lower")
    ux, uy, uk = place("upper")
    draw_barrel(layer, lx, ly, lk, lower=True)
    draw_barrel(layer, ux, uy, uk, lower=False)
    draw_clicker(layer, ux, uy, uk, press)
    if screw > 0.5:
        # turning arrows over the joint while the halves are screwed together
        ld = ImageDraw.Draw(layer)
        jx, jy = lx + 100, ly
        phase = (t * 3) % 1
        for r in (30, 38):
            start = 200 + 360 * phase
            ld.arc([jx - r, jy - r - 6, jx + r, jy + r - 6], start, start + 120,
                   fill=(200, 60, 30, 255), width=4)
    img = Image.alpha_composite(img, layer)

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw_hand(layer, *value_at(tracks["hand"], t))
    img = Image.alpha_composite(img, layer)
    return img.convert("RGB")


def write_video(path, skip_spring):
    tracks, duration, meta = build(skip_spring)
    writer = None
    for codec in ("VP90", "VP80"):
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*codec), FPS, (W, H))
        if writer.isOpened():
            break
        writer.release()
        writer = None
    if writer is None:
        sys.exit("OpenCV could not open a WebM encoder (VP9 or VP8).")
    frames = int(math.ceil(duration * FPS))
    for i in range(frames):
        frame = render(tracks, i / FPS, meta)
        writer.write(cv2.cvtColor(np.asarray(frame), cv2.COLOR_RGB2BGR))
    writer.release()
    print(f"{os.path.basename(path)}: {duration:.0f}s, {os.path.getsize(path) // 1024} KB")
    return tracks, duration, meta


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, skip in (("pen-assembly-correct.webm", False),
                       ("pen-assembly-spring-skipped.webm", True)):
        tracks, duration, meta = write_video(os.path.join(OUT_DIR, name), skip)
        if "--frames" in sys.argv:
            # one JPEG per second, as the app would send them to the AI
            base = sys.argv[sys.argv.index("--frames") + 1]
            frame_dir = os.path.join(base, name.replace(".webm", ""))
            os.makedirs(frame_dir, exist_ok=True)
            for sec in range(int(duration)):
                render(tracks, float(sec), meta).resize((1024, 576)).save(
                    os.path.join(frame_dir, f"frame_{sec:04d}.jpg"), quality=80)
        if "--stills" in sys.argv:
            still_dir = sys.argv[sys.argv.index("--stills") + 1]
            os.makedirs(still_dir, exist_ok=True)
            n = 8
            sheet = Image.new("RGB", (W // 2 * 4, H // 2 * 2))
            for j in range(n):
                t = duration * (j + 0.85) / n
                tile = render(tracks, t, meta).resize((W // 2, H // 2))
                sheet.paste(tile, ((j % 4) * W // 2, (j // 4) * H // 2))
            sheet.save(os.path.join(still_dir, name.replace(".webm", ".jpg")), quality=80)


if __name__ == "__main__":
    main()
