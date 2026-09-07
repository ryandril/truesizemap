#!/usr/bin/env python3
"""Render public/og-card.png (1200x630): the dark Mercator map with Greenland dropped on Africa.
Pure Python (Pillow) so it needs no browser. Run: python3 scripts/og-card.py"""
import json, math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
topo = json.loads((ROOT / 'src/assets/world.json').read_text())
W, H = 1200, 630
SS = 2  # supersample
w, h = W * SS, H * SS

# ---------- topojson decode ----------
sx, sy = topo['transform']['scale']; tx, ty = topo['transform']['translate']
arcs = []
for arc in topo['arcs']:
    pts, x, y = [], 0, 0
    for dx, dy in arc:
        x += dx; y += dy
        pts.append((x * sx + tx, y * sy + ty))
    arcs.append(pts)

def ring(idx_list):
    out = []
    for i in idx_list:
        a = arcs[i] if i >= 0 else list(reversed(arcs[~i]))
        out.extend(a if not out else a[1:])
    return out

def polygons(geom):
    if geom['type'] == 'Polygon': return [[ring(r) for r in geom['arcs']]]
    return [[ring(r) for r in poly] for poly in geom['arcs']]

countries = {g['properties']['n']: g for g in topo['objects']['countries']['geometries']}
continents = {g['properties']['n']: g for g in topo['objects']['continents']['geometries']}

# ---------- mercator, landscape fill, centred ~12°N ----------
pad = 8 * SS
scale = (w - 2 * pad) / (2 * math.pi)
def merc(lon, lat):
    lat = max(-85, min(85, lat))
    x = scale * math.radians(lon) + w / 2
    y = -scale * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y
y12 = merc(0, 12)[1]
def proj(lon, lat):
    x, y = merc(lon, lat)
    return x, y - y12 + h / 2 + 40 * SS  # nudge down a little to leave room for the title

# ---------- spherical move (same three rotations as the app) ----------
def to_xyz(lon, lat):
    lo, la = math.radians(lon), math.radians(lat)
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))
def to_ll(x, y, z):
    return math.degrees(math.atan2(y, x)), math.degrees(math.asin(max(-1, min(1, z))))
def rot_z(p, a):
    x, y, z = p; c, s = math.cos(a), math.sin(a); return (c * x - s * y, s * x + c * y, z)
def rot_y(p, a):
    x, y, z = p; c, s = math.cos(a), math.sin(a); return (c * x + s * z, y, -s * x + c * z)
def move(pt, frm, to):
    p = to_xyz(*pt)
    p = rot_z(p, -math.radians(frm[0]))           # spin onto prime meridian
    p = rot_y(p, -math.radians(to[1] - frm[1]))   # slide along it (positive = north)
    p = rot_z(p, math.radians(to[0]))             # spin to target longitude
    return to_ll(*p)

def centroid(geom):  # good-enough planar centroid of the largest ring, matches the app closely
    best = max((r[0] for r in polygons(geom)), key=len)
    return (sum(p[0] for p in best) / len(best), sum(p[1] for p in best) / len(best))

# ---------- draw ----------
img = Image.new('RGB', (w, h), '#0D1119')
d = ImageDraw.Draw(img)
# graticule
for lon in range(-180, 181, 10):
    x = proj(lon, 0)[0]; d.line([(x, 0), (x, h)], fill='#141924', width=1)
for lat in range(-80, 81, 10):
    y = proj(0, lat)[1]; d.line([(0, y), (w, y)], fill='#141924', width=1)

def draw_geom(geom, fill, outline, width, dash=False, shadow=False):
    for poly in polygons(geom):
        for k, r in enumerate(poly):
            pts = [proj(*p) for p in r]
            if len(pts) < 3: continue
            if k == 0:
                d.polygon(pts, fill=fill, outline=None)
                if outline: d.line(pts + [pts[0]], fill=outline, width=width, joint='curve')
            else:
                d.polygon(pts, fill='#0D1119')

for name, g in countries.items():
    if name == 'Alaska': continue
    draw_geom(g, '#242B38', None, 0)
for name, g in continents.items():
    draw_geom(g, None, (233, 228, 216, 90), 2)
# continent outlines need a translucent layer; redo them properly
ov = Image.new('RGBA', (w, h), (0, 0, 0, 0)); od = ImageDraw.Draw(ov)
for name, g in continents.items():
    for poly in polygons(g):
        pts = [proj(*p) for p in poly[0]]
        if len(pts) > 2: od.line(pts + [pts[0]], fill=(233, 228, 216, 80), width=2)
img = Image.alpha_composite(img.convert('RGBA'), ov)

# Greenland → Africa ghost (the app's preset anchor)
grl = countries['Greenland']; africa = continents['Africa']
c0 = centroid(grl); c1 = (18.73, 6.52)
ghost = Image.new('RGBA', (w, h), (0, 0, 0, 0)); gd = ImageDraw.Draw(ghost)
shadow = Image.new('RGBA', (w, h), (0, 0, 0, 0)); sd = ImageDraw.Draw(shadow)
for poly in polygons(grl):
    pts = [proj(*move(p, c0, c1)) for p in poly[0]]
    if len(pts) < 3: continue
    sd.polygon([(x, y + 14 * SS) for x, y in pts], fill=(0, 0, 0, 150))
    gd.polygon(pts, fill=(232, 163, 61, 150), outline=(232, 163, 61, 255), width=2 * SS)
# dashed source outline
for poly in polygons(grl):
    pts = [proj(*p) for p in poly[0]]
    for i in range(0, len(pts) - 1, 2):
        gd.line([pts[i], pts[i + 1]], fill=(232, 163, 61, 160), width=1 * SS)
shadow = shadow.filter(ImageFilter.GaussianBlur(18 * SS))
img = Image.alpha_composite(img, shadow)
img = Image.alpha_composite(img, ghost)

# ---------- type ----------
img = img.resize((W, H), Image.LANCZOS)
d = ImageDraw.Draw(img)
def font(path, size):
    try: return ImageFont.truetype(path, size)
    except Exception: return ImageFont.load_default(size)
serif = font('/System/Library/Fonts/NewYork.ttf', 54)
mono = font('/System/Library/Fonts/SFNSMono.ttf', 20)
mono_b = font('/System/Library/Fonts/SFNSMono.ttf', 22)
# soft dark band behind the text so it reads over Canada
band = Image.new('RGBA', (W, H), (0, 0, 0, 0)); bd = ImageDraw.Draw(band)
bd.rounded_rectangle([36, 36, 700, 214], radius=22, fill=(11, 13, 18, 242))
img = Image.alpha_composite(img, band); d = ImageDraw.Draw(img)
d.text((60, 56), 'The True Size Map', font=serif, fill='#E9E4D8')
d.text((62, 128), 'Drag a country. See its real size.', font=mono, fill='#9BA0AC')
d.text((62, 160), 'Then flip to Equal Earth, the map the UN voted for, 164–1.', font=mono, fill='#9BA0AC')
# ratio label near the ghost
lx, ly = proj(*c1); lx, ly = lx / SS, ly / SS - 70
label = 'Greenland · 7.2% of Africa'
tw = d.textlength(label, font=mono_b)
d.rounded_rectangle([lx - tw / 2 - 16, ly - 20, lx + tw / 2 + 16, ly + 22], radius=10, fill=(11, 13, 18, 225), outline=(232, 163, 61, 255), width=2)
d.text((lx - tw / 2, ly - 12), label, font=mono_b, fill='#E9E4D8')
url = 'truesizemap.ryandrilowell.com'; uw = d.textlength(url, font=mono)
d.rounded_rectangle([W - uw - 56, H - 56, W - 24, H - 20], radius=10, fill=(11, 13, 18, 230))
d.text((W - uw - 40, H - 47), url, font=mono, fill='#9BA0AC')
img.convert('RGB').save(ROOT / 'public/og-card.png', optimize=True)
print('wrote public/og-card.png')
