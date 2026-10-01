import json
from collections import Counter
from pathlib import Path

FIGMA_JSON = Path(__file__).with_name('figma_master_design.json')

with FIGMA_JSON.open(encoding='utf-8') as f:
    data = json.load(f)

node = next(iter(data['nodes'].values()))['document']

colors = Counter()
fonts = {}
radii = set()
shadows = set()
padding_sets = set()
spacing_values = Counter()


def rgba(color, opacity=1):
    r = round(color['r'] * 255)
    g = round(color['g'] * 255)
    b = round(color['b'] * 255)
    a = opacity if opacity != 1 else color.get('a', 1)
    return f"#{r:02X}{g:02X}{b:02X}", round(a, 3)


def traverse(n):
    if 'absoluteBoundingBox' in n:
        box = n['absoluteBoundingBox']
        spacing_values[box.get('width')] += 1
        spacing_values[box.get('height')] += 1

    for fill in n.get('fills', []):
        if fill.get('type') == 'SOLID':
            key = rgba(fill['color'], fill.get('opacity', 1))
            colors[key] += 1

    if n.get('type') == 'TEXT':
        style = n.get('style', {})
        family = style.get('fontFamily')
        size = style.get('fontSize')
        if family:
            fonts.setdefault(family, set()).add(size)

    if 'cornerRadius' in n and n['cornerRadius'] not in (-1, None):
        radii.add(n['cornerRadius'])
    if 'rectangleCornerRadii' in n:
        radii.update([r for r in n['rectangleCornerRadii'] if r not in (-1, None)])

    for effect in n.get('effects', []):
        if effect.get('type') == 'DROP_SHADOW':
            color = rgba(effect['color'], effect['color'].get('a', 1))[0]
            offset = effect.get('offset', {})
            shadows.add((color, effect.get('radius'), offset.get('x', 0), offset.get('y', 0)))

    if all(k in n for k in ('paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom')):
        padding_sets.add((n['paddingTop'], n['paddingRight'], n['paddingBottom'], n['paddingLeft']))

    for child in n.get('children', []) or []:
        traverse(child)


traverse(node)

print('== Colors ==')
for (hex_color, alpha), count in colors.most_common(30):
    print(f'{hex_color} alpha={alpha} count={count}')

print('\n== Fonts & Sizes ==')
for family, sizes in fonts.items():
    print(f'{family}: {sorted(sizes)}')

print('\n== Corner Radii ==')
print(sorted(radii))

print('\n== Padding Sets (top,right,bottom,left) ==')
for pads in list(padding_sets)[:10]:
    print(pads)

print('\n== Shadows ==')
for shadow in shadows:
    print(shadow)

print('\n== Frequent width/height values ==')
for value, count in spacing_values.most_common(15):
    print(f'{value}: {count}')

