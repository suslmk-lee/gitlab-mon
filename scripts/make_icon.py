"""앱 아이콘 생성 :: build/appicon.png(1024), build/windows/icon.ico, frontend/public/favicon.png
실행: python3 scripts/make_icon.py  (Pillow 필요)

macOS 26은 본체가 시스템 아이콘 모양(약 100..924 스쿼클)을 불투명하게 덮지 않으면 회색 틀에 넣는다.
꽉 찬 정사각형, 가장자리가 반투명한 아이콘 모두 회색 틀 → 95..929, 반경 195 불투명 둥근 사각형으로 덮는다."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 4096  # 4배 슈퍼샘플링 후 1024로 축소
k = S / 1024

def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
BOX, RAD = [95 * k, 95 * k, 929 * k, 929 * k], 195 * k  # 본체

# 그림자 :: 템플릿처럼 아래로 살짝
sh = Image.new('L', (S, S), 0)
ImageDraw.Draw(sh).rounded_rectangle([BOX[0], BOX[1] + 10 * k, BOX[2], BOX[3] + 10 * k], RAD, fill=90)
img.paste((0, 0, 0, 255), (0, 0), sh.filter(ImageFilter.GaussianBlur(14 * k)))

# 본체 :: 남색 세로 그라데이션
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
top, bot = (30, 52, 102), (9, 14, 32)
for y in range(S):
    gd.line([(0, y), (S, y)], fill=lerp(top, bot, y / S) + (255,))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(BOX, RAD, fill=255)
img.paste(grad, (0, 0), mask)

# 그림 :: 별도 레이어에 그린 뒤 본체 모양으로 잘라 합성
art = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# 활동 막대(히트맵 느낌) :: 하단 반투명 막대 5개
d = ImageDraw.Draw(art)
bars = [0.35, 0.6, 0.45, 0.8, 0.55]
bw, gap, base = 92 * k, 34 * k, 800 * k
x0 = (S - (len(bars) * bw + (len(bars) - 1) * gap)) / 2
for i, h in enumerate(bars):
    x = x0 + i * (bw + gap)
    d.rounded_rectangle([x, base - h * 330 * k, x + bw, base], 18 * k, fill=(108, 182, 255, 45))

# 펄스 라인 :: 모니터링 심박선, 파랑→하늘 그라데이션 + 글로우
pts = [(210, 560), (360, 560), (430, 430), (520, 690), (610, 330), (690, 560), (814, 560)]
pts = [(x * k, y * k) for x, y in pts]
line = Image.new('L', (S, S), 0)
ImageDraw.Draw(line).line(pts, fill=255, width=round(46 * k), joint='curve')
r = 23 * k
for (x, y) in (pts[0], pts[-1]):
    ImageDraw.Draw(line).ellipse([x - r, y - r, x + r, y + r], fill=255)
glow = Image.new('RGBA', (S, S), (108, 182, 255, 0))
glow.putalpha(line.filter(ImageFilter.GaussianBlur(40 * k)).point(lambda v: v * 150 // 255))
art.alpha_composite(glow)
lg = Image.new('RGBA', (S, S))
lgd = ImageDraw.Draw(lg)
for x in range(S):
    lgd.line([(x, 0), (x, S)], fill=lerp((47, 129, 247), (125, 211, 252), x / S) + (255,))
art.paste(lg, (0, 0), line)

# 커밋 점 :: 오른쪽 끝 초록 노드
cx, cy, r = 814 * k, 560 * k, 52 * k
ImageDraw.Draw(art).ellipse([cx - r, cy - r, cx + r, cy + r], fill=(74, 222, 128, 255),
                            outline=(9, 14, 32, 255), width=round(14 * k))

art.putalpha(Image.composite(art.split()[3], Image.new('L', (S, S), 0), mask))
img.alpha_composite(art)

# 테두리 :: 템플릿처럼 얇은 밝은 선
edge = Image.new('L', (S, S), 0)
ImageDraw.Draw(edge).rounded_rectangle(BOX, RAD, outline=60, width=round(5 * k))
img.paste((255, 255, 255, 255), (0, 0), Image.composite(edge, Image.new('L', (S, S), 0), mask))

icon = img.resize((1024, 1024), Image.LANCZOS)
icon.save(ROOT / 'build/appicon.png')
icon.save(ROOT / 'build/windows/icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
(ROOT / 'frontend/public').mkdir(exist_ok=True)
icon.crop((96, 96, 928, 928)).resize((64, 64), Image.LANCZOS).save(ROOT / 'frontend/public/favicon.png')  # 파비콘은 여백 제외
print('ok')
