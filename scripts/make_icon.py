"""앱 아이콘 생성 :: build/appicon.png(1024), build/windows/icon.ico, frontend/public/favicon.png
실행: python3 scripts/make_icon.py  (Pillow 필요)"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 4096  # 4배 슈퍼샘플링 후 1024로 축소
k = S / 1024


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# 배경 :: macOS 아이콘 그리드(824px 본체, 100px 여백) 둥근 사각형 + 남색 세로 그라데이션
pad, rad = 100 * k, 185 * k
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
top, bot = (30, 52, 102), (9, 14, 32)
for y in range(S):
    gd.line([(0, y), (S, y)], fill=lerp(top, bot, y / S) + (255,))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - pad, S - pad], rad, fill=255)
img.paste(grad, (0, 0), mask)

# 유리 테두리
ImageDraw.Draw(img).rounded_rectangle([pad, pad, S - pad, S - pad], rad,
                                      outline=(255, 255, 255, 40), width=round(6 * k))

# 활동 막대(히트맵 느낌) :: 하단 반투명 막대 5개
ov = Image.new('RGBA', (S, S), (0, 0, 0, 0))  # 반투명은 draw가 픽셀을 덮어쓰므로 오버레이 후 합성
d = ImageDraw.Draw(ov)
bars = [0.35, 0.6, 0.45, 0.8, 0.55]
bw, gap, base = 92 * k, 34 * k, 800 * k
x0 = (S - (len(bars) * bw + (len(bars) - 1) * gap)) / 2
for i, h in enumerate(bars):
    x = x0 + i * (bw + gap)
    d.rounded_rectangle([x, base - h * 330 * k, x + bw, base], 18 * k, fill=(108, 182, 255, 45))
img.alpha_composite(ov)

# 펄스 라인 :: 모니터링 심박선, 파랑→하늘 그라데이션 + 글로우
pts = [(210, 560), (360, 560), (430, 430), (520, 690), (610, 330), (690, 560), (814, 560)]
pts = [(x * k, y * k) for x, y in pts]
line = Image.new('L', (S, S), 0)
ImageDraw.Draw(line).line(pts, fill=255, width=round(46 * k), joint='curve')
for (x, y) in (pts[0], pts[-1]):
    r = 23 * k
    ImageDraw.Draw(line).ellipse([x - r, y - r, x + r, y + r], fill=255)
glow = line.filter(ImageFilter.GaussianBlur(40 * k))
lg = Image.new('RGBA', (S, S))
lgd = ImageDraw.Draw(lg)
for x in range(S):
    lgd.line([(x, 0), (x, S)], fill=lerp((47, 129, 247), (125, 211, 252), x / S) + (255,))
img.paste(Image.new('RGBA', (S, S), (108, 182, 255, 150)), (0, 0), glow)
img.paste(lg, (0, 0), line)

# 커밋 점 :: 오른쪽 끝 초록 노드
cx, cy, r = 814 * k, 560 * k, 52 * k
d = ImageDraw.Draw(img)
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(74, 222, 128, 255), outline=(9, 14, 32, 255), width=round(14 * k))

icon = img.resize((1024, 1024), Image.LANCZOS)
icon.save(ROOT / 'build/appicon.png')
icon.save(ROOT / 'build/windows/icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
(ROOT / 'frontend/public').mkdir(exist_ok=True)
icon.resize((64, 64), Image.LANCZOS).save(ROOT / 'frontend/public/favicon.png')
print('ok')
