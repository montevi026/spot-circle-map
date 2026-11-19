"""アプリ用アイコンを生成する（python tools/make_icons.py）"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "icons")
S = 1024  # 大きく描いて縮小することでアンチエイリアスをかける
BG = (25, 118, 210)
WHITE = (255, 255, 255)


def draw():
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img)
    c = S // 2
    # 中央 80% がマスカブルアイコンの安全領域。その内側に収める
    for r, w, alpha in [(330, 34, 110), (225, 34, 170)]:
        col = tuple(int(BG[i] + (WHITE[i] - BG[i]) * alpha / 255) for i in range(3))
        d.ellipse([c - r, c - r, c + r, c + r], outline=col, width=w)
    # ピン（円＋三角）。先端がサークルの中心を指す
    hy, pr = c - 170, 100
    d.polygon([(c - 87, hy + 50), (c + 87, hy + 50), (c, c + 5)], fill=WHITE)
    d.ellipse([c - pr, hy - pr, c + pr, hy + pr], fill=WHITE)
    d.ellipse([c - 40, hy - 40, c + 40, hy + 40], fill=BG)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    base = draw()
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512),
                       ("apple-touch-icon.png", 180), ("favicon-32.png", 32)]:
        base.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)
    print("generated in", OUT)


if __name__ == "__main__":
    main()
