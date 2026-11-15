#!/usr/bin/env python3
"""Récupère des photos libres (Wikimedia Commons) pour illustrer les recettes.

  python3 tools/photos.py candidates <dossier_cache>   # télécharge 4 candidats par recette + planches contact
  python3 tools/photos.py build <dossier_cache>        # applique tools/photo_choices.json -> img/recipes + js/photos.js
"""
import io, json, re, sys, time, html, urllib.parse, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
UA = {'User-Agent': 'RecipePhotoFetcher/1.0 (personal recipe app; python-urllib)'}
API = 'https://commons.wikimedia.org/w/api.php'
N = 4

QUERIES = {
    'curry-poulet': 'chicken curry rice', 'chili': 'chili con carne', 'bolo': 'spaghetti bolognese',
    'carbo': 'spaghetti carbonara', 'riz-cantonais': 'egg fried rice', 'dahl': 'masoor dal',
    'saucisses-lentilles': 'saucisses lentilles', 'tortilla-esp': 'tortilla de patatas',
    'poulet-brocoli': 'chicken broccoli stir fry', 'nouilles-poulet': 'chicken chow mein',
    'nouilles-satay': 'peanut noodles', 'pates-thon': 'pasta tuna tomato', 'pates-pesto': 'pesto pasta',
    'pates-champi': 'pasta mushrooms cream', 'gnocchi-poulet': 'gnocchi spinach', 'shakshuka': 'shakshuka',
    'couscous': 'couscous chicken vegetables', 'curry-poischiches': 'chana masala',
    'poulet-moutarde': 'chicken mustard sauce', 'steak-puree': 'steak mashed potatoes green beans',
    'bowl-thon': 'poke bowl tuna avocado', 'salade-pates': 'pasta salad', 'bowl-patate-douce': 'buddha bowl',
    'kebab-dinde': 'chicken wrap', 'fajitas': 'chicken fajitas', 'quesadillas': 'quesadilla',
    'burger': 'cheeseburger fries', 'nuggets': 'chicken tenders fries', 'saumon-riz': 'teriyaki salmon rice',
    'poisson-pane': 'breaded fish potatoes', 'poulet-marine': 'grilled chicken couscous',
    'patates-oeufs': 'fried eggs potatoes', 'legumes-rotis': 'roasted vegetables feta',
    'pizza-tortilla': 'tortilla pizza', 'croque': 'croque-monsieur', 'boulettes': 'spaghetti meatballs',
    'veloute': 'sweet potato soup', 'minestrone': 'minestrone', 'omelette-champi': 'mushroom omelette',
    'riz-dinde': 'jambalaya', 'dinde-champi': 'chicken mushroom cream sauce', 'tofu-croustillant': 'fried tofu rice',
    'curry-colin': 'fish curry', 'pates-saumon': 'salmon pasta', 'nicoise': 'salade niçoise',
    'salade-lentilles': 'lentil salad', 'taboule': 'taboulé', 'patate-farcie': 'stuffed sweet potato',
    'pdt-farcie': 'jacket potato tuna', 'saucisses-ecrase': 'bangers and mash',
    'poulet-roti': 'roast chicken potatoes carrots', 'curry-tofu': 'tofu curry',
    'brunch': 'scrambled eggs avocado toast', 'riz-haricots': 'rice beans fried egg',
    'pates-chevre': 'pasta zucchini', 'poelee-montagnarde': 'tartiflette',
    'pates-poulet-paprika': 'creamy chicken pasta', 'poulet-basquaise': 'poulet basquaise',
    'parmentier-poele': 'hachis parmentier', 'wrap-thon': 'tuna wrap', 'salade-riz-poulet': 'rice salad',
    'lentilles-curry-oeuf': 'lentil curry egg', 'gnocchi-tomate-mozza': 'gnocchi tomato sauce',
    'saumon-patate-douce': 'salmon sweet potato', 'dinde-curry-legumes': 'turkey curry',
    'frittata-courgette': 'frittata', 'tacos-boeuf': 'beef tacos', 'riz-chipo-poivron': 'sausage rice peppers',
    'nouilles-boeuf-brocoli': 'beef broccoli noodles', 'poulet-cacahuete': 'chicken satay rice',
    'colin-tomate': 'fish tomato sauce', 'pates-brocoli-lardons': 'pasta broccoli', 'tartines-chevre': 'goat cheese toast',
}

def get(url, tries=7):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.read()
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(15 * (i + 1))

def clean(s):
    return html.unescape(re.sub(r'<[^>]+>', '', s or '')).strip()

def search(q, limit=12):
    p = {'action': 'query', 'format': 'json', 'generator': 'search', 'gsrnamespace': 6, 'gsrlimit': limit,
         'gsrsearch': q + ' filetype:bitmap', 'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata',
         'iiurlwidth': 960}
    data = json.loads(get(API + '?' + urllib.parse.urlencode(p)))
    pages = sorted(data.get('query', {}).get('pages', {}).values(), key=lambda x: x.get('index', 99))
    out = []
    for pg in pages:
        ii = pg['imageinfo'][0]
        if ii['mime'] != 'image/jpeg' or ii['width'] < 900 or ii['height'] > ii['width'] * 1.15: continue
        m = ii.get('extmetadata', {})
        lic = clean(m.get('LicenseShortName', {}).get('value'))
        if not lic: continue
        out.append({'title': pg['title'], 'thumb': ii['thumburl'], 'page': ii['descriptionurl'],
                    'a': clean(m.get('Artist', {}).get('value')).split('\n')[0][:50].strip() or 'Wikimedia Commons', 'l': lic})
    return out

def crop(im, w, h):
    im = im.convert('RGB')
    r = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * r), round(im.height * r)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))

def candidates(cache):
    choices = load_choices()
    meta_p = cache / 'meta.json'
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
    for rid, q in QUERIES.items():
        q = choices.get(rid, {}).get('q', q)
        if meta.get(rid, {}).get('q') == q: continue
        c = search(q)[:N]
        for i, x in enumerate(c):
            (cache / f'{rid}-{i}.jpg').write_bytes(get(x['thumb']))
            time.sleep(1.5)
        meta[rid] = {'q': q, 'c': c}
        meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        print(rid, len(c), flush=True)
    ids = list(QUERIES)
    only = sys.argv[3].split(',') if len(sys.argv) > 3 else None
    if only: ids = [i for i in ids if i in only]
    per = 10
    for s in range(0, len(ids), per):
        sheet = Image.new('RGB', (4 * 250, per * 205), 'white')
        d = ImageDraw.Draw(sheet)
        for row, rid in enumerate(ids[s:s + per]):
            for i in range(len(meta[rid]['c'])):
                sheet.paste(crop(Image.open(cache / f'{rid}-{i}.jpg'), 246, 185), (i * 250 + 2, row * 205 + 18))
            d.text((4, row * 205 + 3), f'{rid}  [{meta[rid]["q"]}]', fill='black')
        sheet.save(cache / f'sheet-{s // per}.jpg', quality=80)
    print('planches:', (len(ids) + per - 1) // per)

def load_choices():
    p = ROOT / 'tools' / 'photo_choices.json'
    return json.loads(p.read_text()) if p.exists() else {}

def build(cache):
    choices = load_choices()
    meta = json.loads((cache / 'meta.json').read_text())
    out = {}
    dest = ROOT / 'img' / 'recipes'
    for f in dest.glob('*.jpg'): f.unlink()
    for rid in QUERIES:
        i = choices.get(rid, {}).get('i', 0)
        if i is None or i >= len(meta[rid]['c']): continue
        c = meta[rid]['c'][i]
        crop(Image.open(cache / f'{rid}-{i}.jpg'), 900, 675).save(dest / f'{rid}.jpg', quality=78, optimize=True, progressive=True)
        out[rid] = {'a': c['a'], 'l': c['l'], 'u': c['page']}
    js = '// Généré par tools/photos.py : photos disponibles et leurs crédits.\nexport const PHOTOS = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';\n'
    (ROOT / 'js' / 'photos.js').write_text(js)
    print(len(out), 'photos')

if __name__ == '__main__':
    cache = Path(sys.argv[2]); cache.mkdir(parents=True, exist_ok=True)
    {'candidates': candidates, 'build': build}[sys.argv[1]](cache)
