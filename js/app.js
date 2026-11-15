import { INGREDIENTS as ING, RECIPES, RECIPE_BY_ID, CATS, EQUIPMENT, AVOID } from './data.js';
import * as L from './logic.js';
import { PHOTOS } from './photos.js';
import { SYNC } from './config.js';
import { createSync, formatCode } from './sync.js';
import { photoDb, shrinkPhoto, isPhotoData, primeAudio, beep, keepAwake } from './device.js';

// ---------- État ----------

const KEY = 'adeux.v1';
const blank = () => ({
  v: 1, onboarded: false, people: [], equip: ['pl'], avoid: [], stock: {},
  menu: [], checked: {}, history: [], disliked: [], skipped: [], current: null,
  days: {}, mult: {}, prices: {}, budget: null, spend: [], ratings: {}, photos: {},
});

function sanitize(raw) {
  const s = { ...blank(), ...raw };
  const known = (id) => !!RECIPE_BY_ID[id];
  s.menu = s.menu.filter(known);
  s.disliked = s.disliked.filter(known);
  s.skipped = s.skipped.filter(known);
  s.history = s.history.filter((h) => known(h.id));
  s.equip = s.equip.filter((e) => EQUIPMENT[e]);
  s.avoid = s.avoid.filter((a) => AVOID[a]);
  s.stock = Object.fromEntries(Object.entries(s.stock).filter(([id, q]) => ING[id] && q > 0));
  for (const k of ['days', 'mult', 'prices', 'ratings', 'photos', 'checked']) {
    if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) s[k] = {};
  }
  for (const k of ['days', 'mult']) for (const id of Object.keys(s[k])) if (!s.menu.includes(id)) delete s[k][id];
  for (const id of Object.keys(s.days)) if (!s.days[id] || !/^\d{4}-\d\d-\d\d$/.test(s.days[id].d)) delete s.days[id];
  for (const id of Object.keys(s.prices)) if (!ING[id] || !(s.prices[id] > 0)) delete s.prices[id];
  if (!Array.isArray(s.spend)) s.spend = [];
  s.budget = s.budget > 0 ? Number(s.budget) : null;
  s.people = s.people.filter((p) => p && p.id && p.weight > 0 && p.height > 0 && Array.isArray(p.weighIns));
  for (const p of s.people) {
    p.weighIns = p.weighIns.filter((x) => x && x.d && x.w > 0).sort((a, b) => a.d.localeCompare(b.d));
    if (p.weighIns.length) p.weight = p.weighIns[p.weighIns.length - 1].w;
    else p.weighIns = [{ d: L.today(), w: p.weight }];
  }
  if (!s.people.length) s.onboarded = false;
  return s;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && raw.v === 1) return sanitize(raw);
  } catch { /* stockage indisponible ou corrompu : on repart de zéro */ }
  return blank();
}

let S = load();
function storeLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* mode privé */ }
}
function save() {
  storeLocal();
  sync?.push();
}

// ---------- Synchronisation entre téléphones ----------

const SYNC_KEY = 'adeux.sync';

async function rpc(fn, body) {
  const res = await fetch(`${SYNC.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { apikey: SYNC.key, Authorization: `Bearer ${SYNC.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

// Un autre téléphone a modifié le foyer : on adopte l'état fusionné et on rafraîchit l'écran.
function applyRemote(state) {
  S = sanitize(state);
  storeLocal();
  if (S.onboarded) ui.ob = null;
  if (ui.sheet) {
    const { type, id } = ui.sheet;
    const gone = (['weigh', 'history'].includes(type) || (type === 'person' && id)) && personIndex(id) < 0;
    if (gone) closeSheet();
    else if (type === 'recipe' && !RECIPE_BY_ID[id]) closeSheet();
    else if (['recipe', 'stockEdit', 'history'].includes(type)) renderSheet();
  }
  render();
  syncPhotos();
}

const sync = SYNC.url && SYNC.key ? createSync({
  rpc,
  store: {
    load() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch { return null; } },
    save(m) {
      try {
        if (m) localStorage.setItem(SYNC_KEY, JSON.stringify(m)); else localStorage.removeItem(SYNC_KEY);
      } catch { /* mode privé */ }
    },
  },
  getState: () => S,
  setState: applyRemote,
  onStatus: () => { if (S.onboarded && ui.tab === 'settings') render(); },
}) : null;

const ui = { tab: 'ideas', ob: null, draft: null, sheet: null, sel: {}, anim: false, timers: [] };
let userPhotos = {}; // photos prises par le foyer, chargées depuis IndexedDB

// ---------- Utilitaires ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const kg = (x) => `${String(Math.round(x * 10) / 10).replace('.', ',')} kg`;
const int = (x) => Math.round(x).toLocaleString('fr-FR');
const parseNum = (v) => Number(String(v).replace(',', '.').trim());
const fmtDate = (d, opt = { day: 'numeric', month: 'short' }) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('fr-FR', opt);
};
const norm = (x) => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const personIndex = (id) => S.people.findIndex((p) => p.id === id);

const ICON = {
  ideas: '<path d="M7 3v7M4.5 3v4.5a2.5 2.5 0 0 0 5 0V3M7 10v11M17.5 21V3c-2.2 1.6-3.5 4.6-3.5 8.5h3.5"/>',
  shop: '<path d="M3 4h2.2l2.3 11h10.2L20 7.5H6.3"/><circle cx="9" cy="19" r="1.4"/><circle cx="16.5" cy="19" r="1.4"/>',
  stock: '<path d="M7.5 3h9v3h-9zM6 9.5A3.5 3.5 0 0 1 9.5 6h5A3.5 3.5 0 0 1 18 9.5V18a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3zM6 12h12"/>',
  track: '<path d="M4 4v16h16M8 15l3.5-4.5 3 2.5L19 7"/>',
  gear: '<path d="M4 7h9M18 7h2M4 17h2M11 17h9"/><circle cx="15.5" cy="7" r="2.3"/><circle cx="8.5" cy="17" r="2.3"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  next: '<path d="M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

function media(r, cls = '') {
  const mine = S.photos[r.id] && userPhotos[r.id];
  let img = '';
  if (mine) img = `<img src="${mine.data}" alt="">`;
  else if (PHOTOS[r.id]) img = `<img src="img/recipes/${r.id}.jpg" alt="" loading="lazy" onerror="this.remove()">`;
  return `<div class="media ${cls}" style="--h:${hue(r.id)}"><span class="media-emoji">${r.emoji}</span>${img}</div>`;
}

const EQ_SHORT = { pl: 'Plaques', af: 'Air fryer', fo: 'Four', mo: 'Micro-ondes', mx: 'Mixeur' };
const equipUsed = (r) => r.equip.map((g) => g.find((e) => S.equip.includes(e)) || g[0]);

// ---------- Formulaire personne ----------

const newDraft = () => ({ name: '', sex: '', age: '', height: '', weight: '', goal: '', activity: 'leger', appetite: 'normal' });

function readPerson(d, needWeight = true) {
  const err = {};
  const name = d.name.trim();
  if (!name) err.name = 'Indique un prénom';
  if (!d.sex) err.sex = 'Choisis une option';
  const n = (k, lo, hi, msg) => {
    const v = parseNum(d[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) err[k] = msg;
    return v;
  };
  const age = n('age', 14, 99, 'Entre 14 et 99 ans');
  const height = n('height', 120, 220, 'Entre 120 et 220 cm');
  const weight = needWeight ? n('weight', 30, 250, 'Entre 30 et 250 kg') : d.weightNow;
  const goal = n('goal', 30, 250, 'Entre 30 et 250 kg');
  const person = { name, sex: d.sex, age: Math.round(age), height, weight, goal, activity: d.activity, appetite: d.appetite };
  return { ok: !Object.keys(err).length, err, person };
}

function formHint(d, needWeight) {
  const { ok, person } = readPerson(d, needWeight);
  if (!ok) return '';
  const t = L.targets(person);
  const diff = Math.abs(person.goal - person.weight);
  const what = t.mode === 'loss' ? `Perdre ${kg(diff)}` : t.mode === 'gain' ? `Prendre ${kg(diff)}` : 'Garder ton poids';
  const low = L.bmi(person.goal, person.height) < 18.5;
  return `<div class="hint"><b>${what}</b> · environ ${int(t.kcal)} kcal et ${t.prot} g de protéines par jour.</div>${
    low ? '<div class="hint warn">Ce poids visé est bas pour ta taille. Parles-en à un médecin avant de te fixer cet objectif.</div>' : ''}`;
}

function field(d, k, label, attrs, unit, errs) {
  return `<label class="field ${errs[k] ? 'bad' : ''}"><span>${label}</span>
    <div class="input"><input data-f="${k}" value="${esc(d[k])}" ${attrs}>${unit ? `<i>${unit}</i>` : ''}</div>
    ${errs[k] ? `<em>${errs[k]}</em>` : ''}</label>`;
}

function seg(d, k, opts) {
  return `<div class="seg" role="group">${opts.map(([v, lab]) =>
    `<button type="button" class="${d[k] === v ? 'on' : ''}" data-a="setf" data-f="${k}" data-v="${v}">${lab}</button>`).join('')}</div>`;
}

function personForm(d, { needWeight = true, errs = {} } = {}) {
  return `
    ${field(d, 'name', 'Prénom', 'autocomplete="given-name" autocapitalize="words" maxlength="20" placeholder="Prénom"', '', errs)}
    <div class="field ${errs.sex ? 'bad' : ''}"><span>Sexe</span>${seg(d, 'sex', [['f', 'Femme'], ['m', 'Homme']])}
      ${errs.sex ? `<em>${errs.sex}</em>` : ''}</div>
    <div class="grid2">
      ${field(d, 'age', 'Âge', 'inputmode="numeric" placeholder="20"', 'ans', errs)}
      ${field(d, 'height', 'Taille', 'inputmode="numeric" placeholder="170"', 'cm', errs)}
      ${needWeight ? field(d, 'weight', 'Poids actuel', 'inputmode="decimal" placeholder="70"', 'kg', errs) : ''}
      ${field(d, 'goal', 'Poids visé', 'inputmode="decimal" placeholder="65"', 'kg', errs)}
    </div>
    <label class="field"><span>Activité</span>
      <div class="input"><select data-f="activity">${Object.entries(L.ACTIVITY).map(([k, a]) =>
    `<option value="${k}" ${d.activity === k ? 'selected' : ''}>${a.n}</option>`).join('')}</select><i>▾</i></div></label>
    <div class="field"><span>Appétit</span>${seg(d, 'appetite', [['petit', 'Petit'], ['normal', 'Normal'], ['gros', 'Gros']])}
      <small>Change le volume dans l'assiette, pas les calories.</small></div>
    <div id="form-hint">${formHint(d, needWeight)}</div>`;
}

// ---------- Onboarding ----------

const OB_STEPS = ['welcome', 'p0', 'p1', 'equip', 'prefs', 'done'];

function chipList(items, isOn, action) {
  return `<div class="chips">${items.map(([id, label]) =>
    `<button type="button" class="chip ${isOn(id) ? 'on' : ''}" data-a="${action}" data-id="${id}">${label}</button>`).join('')}</div>`;
}

const equipChips = () => chipList(Object.entries(EQUIPMENT).map(([id, e]) => [id, `${e.e} ${e.n}`]), (id) => S.equip.includes(id), 'equip');
const avoidChips = () => chipList(Object.entries(AVOID).map(([id, a]) => [id, a.n]), (id) => S.avoid.includes(id), 'avoid');

function viewOnboarding() {
  const ob = ui.ob;
  const step = OB_STEPS[ob.step];
  const dots = `<div class="dots">${OB_STEPS.slice(1).map((_, i) => `<i class="${i < ob.step ? 'on' : ''}"></i>`).join('')}</div>`;
  const nav = (label, extra = '') => `<div class="ob-foot">${extra}<button class="btn primary" data-a="ob-next">${label}</button></div>`;
  const head = (title, sub) => `<header class="ob-head">
      <button class="iconbtn" data-a="ob-back" aria-label="Retour">${icon('back')}</button>${dots}<span class="iconbtn ghost"></span>
    </header><h1>${title}</h1><p class="lead">${sub}</p>`;

  if (step === 'welcome') {
    return `<section class="ob welcome">
      <div class="hero-emoji">🍽️</div>
      <h1>À Deux</h1>
      <p class="lead">Le même plat pour tout le monde, la bonne assiette pour chacun.</p>
      <ul class="bullets">
        <li><b>🎯 Vos objectifs</b><span>Des portions calculées pour chacun.</span></li>
        <li><b>💶 Des courses malines</b><span>On réutilise ce qu'il reste au placard.</span></li>
        <li><b>🍳 Votre cuisine</b><span>Uniquement des recettes faisables chez vous.</span></li>
      </ul>
      <div class="ob-foot">
        <button class="btn primary" data-a="ob-next">Commencer</button>
        <button class="btn text" data-a="import-open">J'ai déjà un code de partage</button>
      </div></section>`;
  }
  if (step === 'p0' || step === 'p1') {
    const i = step === 'p0' ? 0 : 1;
    ui.draft = ob.persons[i];
    const skip = i === 1 ? '<button class="btn text" data-a="ob-skip">Je suis seul·e, passer</button>' : '';
    return `<section class="ob">${head(i === 0 ? 'Parle-nous de toi' : 'Et la deuxième personne ?',
      i === 0 ? 'Pour calculer tes portions.' : 'Vous mangerez le même plat, chacun sa portion.')}
      <form class="form" data-a-submit="ob-next">${personForm(ui.draft, { errs: ob.errs || {} })}</form>
      ${nav('Continuer', skip)}</section>`;
  }
  if (step === 'equip') {
    return `<section class="ob">${head('Votre cuisine', 'Coche ce que vous avez. On ne proposera que des recettes faisables avec.')}
      ${equipChips()}${nav('Continuer')}</section>`;
  }
  if (step === 'prefs') {
    const staples = Object.entries(ING).filter(([, i]) => i.staple).map(([id, i]) => [id, i.n]);
    return `<section class="ob">${head('Derniers détails', 'Tout est facultatif, et modifiable plus tard.')}
      <h3>Vous ne mangez pas de…</h3>${avoidChips()}
      <h3>Déjà dans vos placards ?</h3>
      <p class="muted">Ces produits ne seront pas ajoutés à la liste de courses.</p>
      ${chipList(staples, (id) => ob.staples.includes(id), 'ob-staple')}
      ${nav('Continuer')}</section>`;
  }
  const people = ob.persons.filter((p) => p.done).map((p) => p.done);
  return `<section class="ob">${head('Tout est prêt', 'Voici vos repères du jour. Les portions des recettes en tiennent compte.')}
    ${people.map((p, i) => {
    const t = L.targets(p);
    return `<div class="card person-sum"><span class="avatar p${i}">${esc(p.name[0].toUpperCase())}</span>
        <div><b>${esc(p.name)}</b><small>${{ loss: 'Perte de poids', gain: 'Prise de poids', keep: 'Maintien' }[t.mode]} · ${kg(p.weight)} → ${kg(p.goal)}</small></div>
        <div class="kcal"><b>${int(t.kcal)}</b><small>kcal / jour</small></div></div>`;
  }).join('')}
    <p class="muted center">Magasin : Intermarché · prix estimés</p>
    ${nav("C'est parti")}</section>`;
}

function obNext() {
  const ob = ui.ob;
  const step = OB_STEPS[ob.step];
  if (step === 'p0' || step === 'p1') {
    const d = ob.persons[step === 'p0' ? 0 : 1];
    const r = readPerson(d);
    if (!r.ok) { ob.errs = r.err; return render(); }
    d.done = r.person;
  }
  ob.errs = null;
  if (step === 'done') {
    S.people = ob.persons.filter((p) => p.done).map((p) => ({ id: uid(), ...p.done, weighIns: [{ d: L.today(), w: p.done.weight }] }));
    for (const id of ob.staples) L.addPacks(S.stock, id, 1);
    S.onboarded = true;
    ui.ob = null; ui.draft = null; ui.tab = 'ideas';
    save();
    return render(true);
  }
  ob.step += 1;
  render(true);
}

// ---------- Onglet Recettes ----------

const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  const x = new Date(y, m - 1, dd + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const slotKey = (id) => (S.days[id] ? `${S.days[id].d}${S.days[id].s === 'midi' ? 'a' : 'b'}` : '9999');
const menuSorted = () => [...S.menu].sort((a, b) => slotKey(a).localeCompare(slotKey(b)));

function dayLabel(id) {
  const s = S.days[id];
  if (!s) return 'Sans date';
  const t = L.today();
  let name = fmtDate(s.d, { weekday: 'long', day: 'numeric' });
  if (s.d === t) name = "Aujourd'hui";
  else if (s.d === addDays(t, 1)) name = 'Demain';
  else if (s.d < t) name = `En retard (${fmtDate(s.d)})`;
  return `${name} · ${s.s}`;
}

// Prochains créneaux libres du calendrier (un par jour le soir, ou midi et soir).
function freeSlots(count, perDay = 1) {
  const used = new Set(Object.values(S.days).map((s) => s.d + s.s));
  const out = [];
  for (let i = 0; out.length < count && i < 90; i += 1) {
    const d = addDays(L.today(), i);
    for (const s of perDay === 2 ? ['midi', 'soir'] : ['soir']) {
      if (!used.has(d + s) && out.length < count) out.push({ d, s });
    }
  }
  return out;
}

function dropFromMenu(id) {
  S.menu = S.menu.filter((x) => x !== id);
  delete S.days[id]; delete S.mult[id];
}

const monday = () => { const d = new Date(); return addDays(L.today(), -((d.getDay() + 6) % 7)); };
const weekSpend = () => S.spend.filter((x) => x.d >= monday()).reduce((a, x) => a + x.a, 0);
const monthSpend = () => S.spend.filter((x) => x.d.startsWith(L.today().slice(0, 7))).reduce((a, x) => a + x.a, 0);

function ensureCurrent() {
  const ok = (id) => id && RECIPE_BY_ID[id] && !S.menu.includes(id) && !S.disliked.includes(id)
    && L.recipeAllowed(RECIPE_BY_ID[id], S.equip, S.avoid);
  if (ok(S.current)) return S.current;
  const ranked = L.rankRecipes(S);
  let pick = ranked.find((id) => !S.skipped.includes(id));
  if (!pick && ranked.length) { S.skipped = []; pick = ranked[0]; }
  S.current = pick || null;
  save();
  return S.current;
}

function personLines(r) {
  return S.people.map((p, i) => {
    const po = L.portion(r, p);
    return `<div class="pline"><span class="dot p${i}"></span><b>${esc(p.name)}</b>
      <span>${int(po.kcal)} kcal · ${Math.round(po.prot)} g de protéines</span></div>`;
  }).join('');
}

function metaChips(r) {
  const cost = L.mealCost(r, S.people) / S.people.length;
  return `<div class="meta"><span>⏱ ${r.time} min</span><span>💶 ${L.euro(cost)} / pers.</span>${
    equipUsed(r).map((e) => `<span>${EQ_SHORT[e]}</span>`).join('')}</div>`;
}

function viewIdeas() {
  const id = ensureCurrent();
  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  let html = `<header class="top"><div><p class="eyebrow">${date}</p><h1>À table</h1></div>
    <button class="iconbtn" data-a="tab" data-tab="settings" aria-label="Réglages">${icon('gear')}</button></header>`;

  if (isIos() && !isStandalone() && !localStorage.getItem('adeux.install')) {
    html += `<div class="card banner"><div><b>Installe l'app sur ton iPhone</b>
      <small>Dans Safari : bouton Partager, puis « Sur l'écran d'accueil ».</small></div>
      <button class="iconbtn" data-a="hide-install" aria-label="Fermer">${icon('close')}</button></div>`;
  }

  const todays = menuSorted().filter((mid) => S.days[mid]?.d === L.today());
  for (const mid of todays) {
    html += `<button class="card today" data-a="recipe" data-id="${mid}">${media(RECIPE_BY_ID[mid], 'thumb')}
      <span class="row-main"><small>Au programme ${S.days[mid].s === 'midi' ? 'ce midi' : 'ce soir'}</small><b>${esc(RECIPE_BY_ID[mid].name)}</b></span>${icon('chev', 'muted')}</button>`;
  }
  const late = S.people.filter((p) => p.weighIns[p.weighIns.length - 1].d <= addDays(L.today(), -7));
  if (late.length && localStorage.getItem('adeux.nag') !== L.today()) {
    html += `<div class="card banner"><div><b>⚖️ Pesée de la semaine</b>
      <small>${late.map((p) => esc(p.name)).join(' et ')} : plus de 7 jours sans pesée. Les portions suivent ton poids.</small></div>
      <button class="btn primary mini" data-a="tab" data-tab="track">Peser</button>
      <button class="iconbtn" data-a="hide-nag" aria-label="Plus tard">${icon('close')}</button></div>`;
  }

  if (!id) {
    html += `<div class="empty"><div class="big">🤷</div><h2>Aucune recette à proposer</h2>
      <p>Avec ces réglages, il ne reste plus de recette. Ajoute du matériel ou retire des exclusions.</p>
      <button class="btn primary" data-a="tab" data-tab="settings">Ouvrir les réglages</button></div>`;
  } else {
    const r = RECIPE_BY_ID[id];
    const rest = L.leftovers(S.menu, S.people, S.stock, S.mult);
    const buy = L.shopping([id], S.people, rest);
    const n = Object.keys(L.needs(r, S.people)).length;
    const have = n - buy.items.length;
    const buyLine = buy.items.length
      ? `<b>${L.euro(buy.total)}</b> en caisse (paquets entiers) · ${have ? `${have} sur ${n} ingrédients déjà au placard` : `${plural(n, 'ingrédient', 'ingrédients')}`}`
      : '<b>Rien à acheter</b> · tout est déjà au placard';
    html += `<article class="card recipe ${ui.anim ? 'swap' : ''}">
        <button class="recipe-open" data-a="recipe" data-id="${id}" aria-label="Voir la recette">
          ${media(r, 'hero')}
          <div class="recipe-body"><h2>${S.ratings[id] === 1 ? '❤️ ' : ''}${esc(r.name)}</h2>${metaChips(r)}
            <div class="plines">${personLines(r)}</div>
            <p class="buy ${buy.items.length ? '' : 'ok'}">🛒 ${buyLine}</p>
            <span class="see">Voir la recette ${icon('chev')}</span></div>
        </button>
        <div class="actions">
          <button class="btn soft" data-a="next">${icon('next')} Une autre</button>
          <button class="btn primary" data-a="add" data-id="${id}">${icon('plus')} Au menu</button>
        </div></article>`;
  }

  html += '<button class="btn soft plan" data-a="browse">🔍 Chercher dans toutes les recettes</button>';
  html += `<h3 class="section" id="menu">Au menu${S.menu.length ? ` · ${plural(S.menu.length, 'repas', 'repas')}` : ''}</h3>`;
  if (id) html += `<button class="btn soft plan" data-a="plan-open">📅 Planifier plusieurs repas d'un coup</button>`;
  if (!S.menu.length) {
    html += '<p class="muted pad">Ajoute les recettes qui te plaisent, ou laisse l\'app composer le menu de la semaine : la liste de courses se remplit toute seule.</p>';
  } else {
    const shop = L.shopping(S.menu, S.people, S.stock, S.mult);
    html += `<div class="list">${menuSorted().map((mid) => {
      const r = RECIPE_BY_ID[mid];
      const miss = L.shopping([mid], S.people, S.stock, S.mult).items.length;
      const fresh = L.isFresh(r) ? ' · frais, à cuisiner en premier' : '';
      return `<button class="row" data-a="recipe" data-id="${mid}">${media(r, 'thumb')}
        <span class="row-main"><small class="day">${dayLabel(mid)}${S.mult[mid] === 2 ? ' · en double' : ''}</small><b>${esc(r.name)}</b>
        <small class="${miss ? '' : 'ok'}">${miss ? `🛒 ${plural(miss, 'ingrédient', 'ingrédients')} à acheter${fresh}` : '✓ Prêt à cuisiner'}</small></span>${icon('chev', 'muted')}</button>`;
    }).join('')}
      <button class="row" data-a="tab" data-tab="shop"><span class="row-main"><b>${shop.items.length ? `Courses pour tout le menu : ${L.euro(shop.total)}` : 'Tout est au placard'}</b>
        <small>${shop.items.length ? `${plural(shop.items.length, 'article', 'articles')} à acheter en une fois` : 'Rien à acheter pour ce menu'}</small></span>${icon('chev', 'muted')}</button></div>
      ${S.menu.length > 1 ? '<button class="btn text" data-a="menu-clear">Vider le menu</button>' : ''}`;
  }
  return html;
}

// ---------- Fiche recette ----------

function sheetRecipe({ id, who: whoRaw = 'all' }) {
  const who = whoRaw !== 'all' && personIndex(whoRaw) < 0 ? 'all' : whoRaw;
  const r = RECIPE_BY_ID[id];
  const inMenu = S.menu.includes(id);
  const portions = S.people.map((p) => L.portion(r, p));
  const k = inMenu ? (S.mult[id] || 1) : 1;
  const total = L.needs(r, S.people, k);
  const multi = S.people.length > 1;
  const mine = S.photos[id] && userPhotos[id];
  const cost = L.mealCost(r, S.people) * k;
  const buyNow = L.shopping([id], S.people, inMenu ? S.stock : L.leftovers(S.menu, S.people, S.stock, S.mult), { [id]: k });
  const priceBlock = `<p class="hint">💶 <b>${L.euro(cost)}</b> de nourriture réellement utilisée, soit ${L.euro(cost / S.people.length / k)} par personne${k > 1 ? ' et par repas' : ''}.
    ${buyNow.items.length ? `En caisse : <b>${L.euro(buyNow.total)}</b>, parce qu'on achète des paquets entiers. Ce qui n'est pas utilisé reste au placard pour d'autres recettes.` : 'Rien à acheter : tout est déjà au placard.'}</p>`;
  const day = S.days[id];
  const planBlock = !inMenu ? '' : `<div class="plan-box">
      <label class="field"><span>Prévu le</span><div class="input"><input type="date" data-c="day-date" data-id="${id}" value="${day?.d || ''}"></div></label>
      <div class="field"><span>Repas</span><div class="seg">${['midi', 'soir'].map((v) =>
    `<button class="${(day?.s || 'soir') === v ? 'on' : ''}" data-a="day-slot" data-id="${id}" data-v="${v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join('')}</div></div>
      <button class="chip ${k === 2 ? 'on' : ''}" data-a="double" data-id="${id}">Cuisiner en double, pour 2 repas</button></div>`;

  let rows;
  if (who === 'all') {
    rows = Object.keys(total).map((iid) => {
      const have = (S.stock[iid] || 0) >= total[iid] - 1e-6;
      return `<li><span>${esc(ING[iid].n)}</span><span class="q">${L.fmtQty(iid, total[iid])}</span>
        <span class="tag ${have ? 'ok' : ''}">${have ? '✓ placard' : 'à acheter'}</span></li>`;
    }).join('');
  } else {
    const po = portions[personIndex(who)];
    rows = po.items.map((it) => `<li><span>${esc(ING[it.id].n)}</span>
      <span class="q">${L.fmtQty(it.id, L.roundQty(it.id, it.q))}</span>${it.boost ? '<span class="tag boost">boost</span>' : ''}</li>`).join('');
  }

  const unitLabel = (n) => `${L.frac(n)} ${r.unit[0]}${n >= 2 ? 's' : ''}`;
  // Nombre de croques/wraps par personne : parts arrondies au demi, dont la somme fait le total.
  const unitShare = [];
  if (r.unit) {
    const all = total[r.unit[1]] / r.unit[2];
    const raw = portions.map((po) => po.items.find((it) => it.id === r.unit[1]).q);
    const sum = raw.reduce((a, b) => a + b, 0);
    let left = all;
    raw.forEach((q, i) => {
      const n = i === raw.length - 1 ? left : Math.min(left, Math.round((all * q / sum) * 2) / 2);
      unitShare.push(n); left -= n;
    });
  }
  const baseK = portions.map((po) => po.items.filter((it) => !it.boost).reduce((s, it) => s + L.kcalOf(it.id, it.q), 0));
  const sumK = baseK.reduce((a, b) => a + b, 0);
  const plates = S.people.map((p, i) => {
    const po = portions[i];
    const boosts = po.items.filter((it) => it.boost)
      .map((it) => `+ ${L.fmtQty(it.id, L.roundQty(it.id, it.q))} de ${ING[it.id].n.toLowerCase()} dans son assiette`).join('');
    const share = Math.round((baseK[i] / sumK) * 100);
    return `<div class="plate"><span class="avatar p${i}">${esc(p.name[0].toUpperCase())}</span>
      <div><b>${esc(p.name)}${multi ? ` · ${share} % du plat` : ''}</b>
      <small>${r.unit ? `${unitLabel(unitShare[i])} · ` : ''}${int(po.kcal)} kcal · ${Math.round(po.prot)} g de protéines</small>
      ${boosts ? `<small class="boostline">${boosts}</small>` : ''}</div></div>`;
  }).join('');

  const steps = [...r.steps];
  if (multi) {
    steps.push(`Sers : ${S.people.map((p, i) => `${esc(p.name)} ${Math.round((baseK[i] / sumK) * 100)} % du plat`).join(', ')}.`);
  }

  const foot = inMenu
    ? `<button class="btn primary" data-a="cook" data-id="${id}">${icon('check')} On l'a cuisinée</button>
       <div class="two"><button class="btn text" data-a="swap" data-id="${id}">Remplacer</button>
       <button class="btn text" data-a="unmenu" data-id="${id}">Retirer du menu</button></div>`
    : `<button class="btn primary" data-a="add" data-id="${id}">${icon('plus')} Ajouter au menu</button>
       <button class="btn text" data-a="dislike" data-id="${id}">Ne plus proposer cette recette</button>`;

  return `${media(r, 'cover')}
    <div class="sheet-pad">
      <h2>${S.ratings[id] === 1 ? '❤️ ' : ''}${esc(r.name)}</h2>${metaChips(r)}
      ${planBlock}${priceBlock}
      ${k > 1 ? '<p class="hint">Quantités pour <b>2 repas</b> : mange la moitié, garde le reste au frais pour le lendemain.</p>' : ''}
      ${r.unit ? `<p class="hint">Ça fait <b>${unitLabel(total[r.unit[1]] / r.unit[2])}</b> en tout.</p>` : ''}
      <h3>Dans l'assiette</h3><div class="plates">${plates}</div>
      <h3>Ingrédients</h3>
      ${multi ? `<div class="seg small">${[['all', `Pour ${S.people.length}`], ...S.people.map((p) => [p.id, esc(p.name)])].map(([v, lab]) =>
    `<button class="${who === v ? 'on' : ''}" data-a="who" data-v="${v}">${lab}</button>`).join('')}</div>` : ''}
      <ul class="ings">${rows}</ul>
      <p class="muted small">Sel, poivre et eau ne sont pas listés.</p>
      <div class="h-row"><h3>Préparation</h3><button class="btn soft mini" data-a="cookmode" data-id="${id}">👨‍🍳 Mode cuisine</button></div>
      <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <label class="btn soft filebtn">📷 ${mine ? 'Changer notre photo' : 'Mettre notre photo du plat'}<input type="file" accept="image/*" data-c="photo" data-id="${id}" hidden></label>
      ${mine ? `<button class="btn text" data-a="photo-del" data-id="${id}">Remettre la photo d'origine</button>` : ''}
      ${mine ? '<p class="muted small">Photo : la vôtre.</p>' : !PHOTOS[r.id] ? '' : `<p class="muted small">Photo d'illustration : <a href="${esc(PHOTOS[r.id].u)}" target="_blank" rel="noopener">${esc(PHOTOS[r.id].a)}</a>, ${esc(PHOTOS[r.id].l)}, via Wikimedia Commons</p>`}
    </div>
    <div class="sheet-foot">${foot}</div>`;
}

function sheetPlan({ n }) {
  const add = Math.max(0, n - S.menu.length);
  return `<div class="sheet-pad"><h2>Planifier les repas</h2>
    <p class="muted">Choisis combien de repas tu veux prévoir. L'app compose un menu varié qui réutilise les mêmes paquets, puis fait une seule liste de courses pour tout.</p>
    <div class="stepper"><button class="iconbtn big" data-a="plan-n" data-d="-1" aria-label="Moins">−</button>
      <b>${n} repas</b>
      <button class="iconbtn big" data-a="plan-n" data-d="1" aria-label="Plus">+</button></div>
    <p class="muted small center">${S.menu.length ? `${plural(S.menu.length, 'repas déjà au menu', 'repas déjà au menu')}, ${add} à ajouter.` : 'Un repas = un plat pour tout le foyer (7 = un dîner par jour, 14 = midi et soir).'}
      Tu pourras remplacer ou retirer chaque plat ensuite.${S.budget ? ` Budget pris en compte : ${L.euro(S.budget)} par semaine.` : ''}</p>
    <button class="btn primary" data-a="plan-do" ${add ? '' : 'disabled'}>${add ? `Composer ${plural(add, 'repas', 'repas')}` : 'Menu déjà complet'}</button></div>`;
}

function sheetPrice({ id, err }) {
  const ing = ING[id];
  return `<form class="sheet-pad form" data-a-submit="price-save"><h2>Prix : ${esc(ing.n)}</h2>
    <p class="muted">Indique le prix payé en magasin pour : <b>${esc(ing.pl)}</b>. L'app s'en servira pour tous ses calculs.</p>
    <label class="field ${err ? 'bad' : ''}"><span>Prix du paquet</span><div class="input">
      <input id="pr-val" inputmode="decimal" autocomplete="off" value="${L.priceOf(id).toFixed(2).replace('.', ',')}"><i>€</i></div>
      ${err ? `<em>${err}</em>` : ''}</label>
    <button class="btn primary" type="submit">Enregistrer</button>
    ${S.prices[id] ? `<button class="btn text" type="button" data-a="price-reset">Revenir au prix estimé (${L.euro(ing.pr)})</button>` : ''}</form>`;
}

function sheetBudget({ err }) {
  return `<form class="sheet-pad form" data-a-submit="budget-save"><h2>Budget courses</h2>
    <p class="muted">Un montant par semaine pour tout le foyer. La planification des repas s'arrête avant de le dépasser, et l'onglet Courses te montre où tu en es.</p>
    <label class="field ${err ? 'bad' : ''}"><span>Budget par semaine</span><div class="input">
      <input id="bu-val" inputmode="decimal" autocomplete="off" placeholder="60" value="${S.budget ? String(S.budget).replace('.', ',') : ''}"><i>€</i></div>
      ${err ? `<em>${err}</em>` : ''}</label>
    <button class="btn primary" type="submit">Enregistrer</button>
    ${S.budget ? '<button class="btn text" type="button" data-a="budget-clear">Ne plus fixer de budget</button>' : ''}</form>`;
}

function sheetRate({ id }) {
  return `<div class="sheet-pad"><h2>Alors, ce plat ?</h2><p class="muted">${esc(RECIPE_BY_ID[id].name)}</p>
    <div class="rate"><button data-a="rate" data-v="1">😍<small>On adore</small></button>
      <button data-a="rate" data-v="0">🙂<small>Correct</small></button>
      <button data-a="rate" data-v="-1">👎<small>Plus jamais</small></button></div>
    <label class="btn soft filebtn">📷 ${S.photos[id] && userPhotos[id] ? 'Photo ajoutée ✓ (changer)' : 'Ajouter notre photo du plat'}<input type="file" accept="image/*" data-c="photo" data-id="${id}" hidden></label>
    <button class="btn text" data-a="close">Passer</button></div>`;
}

function sheetSnacks({ id }) {
  const p = S.people[personIndex(id)];
  const seed = Math.floor(Date.now() / 864e5);
  const sp = L.snackPlan(p, seed);
  const row = (x) => `<div class="row static"><span class="row-main"><b>${esc(x.n)}</b>
    <small>${x.t === 'm' ? 'Petit-déjeuner' : 'Collation'} · ${x.p} g de protéines</small></span><span class="price">${x.k} kcal</span></div>`;
  return `<div class="sheet-pad"><h2>En dehors des repas</h2>
    <p class="muted">Les deux repas principaux couvrent environ 70 % des besoins de ${esc(p.name)}. Il reste à peu près <b>${int(sp.left)} kcal</b> pour le petit-déjeuner et les collations.</p>
    <h3>Exemple pour aujourd'hui · ${int(sp.kcal)} kcal</h3><div class="list">${sp.picks.map(row).join('')}</div>
    <h3>Autres idées adaptées</h3><div class="list">${sp.all.filter((x) => !sp.picks.includes(x)).map(row).join('')}</div>
    <p class="muted small">Ces idées ne sont pas ajoutées à la liste de courses.</p>
    <button class="btn primary" data-a="close">Fermer</button></div>`;
}

const FILTERS = [['fav', '❤️ Favoris'], ['rapide', '⏱ 20 min max'], ['placard', '🧺 Avec mon placard'], ['vege', '🥦 Sans viande ni poisson'], ['af', '🌬️ Air fryer']];

function sheetBrowse({ f = [], q = '' }) {
  const has = (x) => f.includes(x);
  let list = RECIPES.filter((r) => !S.disliked.includes(r.id) && L.recipeAllowed(r, S.equip, S.avoid));
  if (has('fav')) list = list.filter((r) => S.ratings[r.id] === 1);
  if (has('rapide')) list = list.filter((r) => r.time <= 20);
  if (has('vege')) list = list.filter((r) => !r.ing.some((it) => ING[it.id].kind));
  if (has('af')) list = list.filter((r) => r.equip.some((g) => g.includes('af')));
  const rows = list.map((r) => ({ r, miss: L.shopping([r.id], S.people, S.stock).items.length }));
  if (has('placard')) rows.sort((a, b) => a.miss - b.miss || a.r.name.localeCompare(b.r.name, 'fr'));
  else rows.sort((a, b) => a.r.name.localeCompare(b.r.name, 'fr'));
  const chips = FILTERS.filter(([id]) => id !== 'af' || S.equip.includes('af')).map(([id, label]) =>
    `<button class="chip ${has(id) ? 'on' : ''}" data-a="browse-f" data-id="${id}">${label}</button>`).join('');
  const nq = norm(q);
  return `<div class="sheet-pad"><h2>Toutes les recettes</h2>
    <div class="input search"><input type="search" id="bq" data-list="browse-list" value="${esc(q)}" placeholder="Un plat ou un ingrédient (poulet, riz…)" autocomplete="off"></div>
    <div class="chips scroll">${chips}</div>
    <div class="list" id="browse-list">${rows.map(({ r, miss }) => {
    const name = `${r.name} ${r.ing.map((it) => ING[it.id].n).join(' ')}`;
    return `<button class="row" data-a="recipe" data-id="${r.id}" data-name="${esc(name)}" ${nq && !norm(name).includes(nq) ? 'hidden' : ''}>${media(r, 'thumb')}
        <span class="row-main"><b>${S.ratings[r.id] === 1 ? '❤️ ' : ''}${esc(r.name)}</b>
        <small>${r.time} min · ${L.euro(L.mealCost(r, S.people) / S.people.length)} / pers. · ${S.menu.includes(r.id) ? 'déjà au menu' : miss ? `${miss} à acheter` : 'tout au placard'}</small></span>${icon('chev', 'muted')}</button>`;
  }).join('') || '<p class="muted pad">Aucune recette ne correspond à ces filtres.</p>'}</div></div>`;
}

const clock = (ms) => {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

function sheetCook({ id, i = 0 }) {
  const r = RECIPE_BY_ID[id];
  const inMenu = S.menu.includes(id);
  const total = L.needs(r, S.people, inMenu ? (S.mult[id] || 1) : 1);
  const n = r.steps.length;
  const mins = [...new Set([...r.steps[i].matchAll(/(\d+)(?:\s*à\s*\d+)?\s*min/g)].map((m) => Number(m[1])))];
  const now = Date.now();
  return `<div class="sheet-pad cook"><p class="eyebrow">${esc(r.name)}</p><h2>Étape ${i + 1} sur ${n}</h2>
    <div class="dots wide">${r.steps.map((_, j) => `<i class="${j <= i ? 'on' : ''}"></i>`).join('')}</div>
    ${ui.timers.length ? `<div class="timers">${ui.timers.map((t) => `<button class="timer" data-a="timer-stop" data-t="${t.end}" aria-label="Arrêter le minuteur">⏱ ${esc(t.label)} <b data-timer="${t.end}">${clock(t.end - now)}</b> ✕</button>`).join('')}</div>` : ''}
    <p class="bigstep">${r.steps[i]}</p>
    ${mins.length ? `<div class="chips">${mins.map((m) => `<button class="chip" data-a="timer" data-m="${m}" data-l="Étape ${i + 1}">⏱ Lancer ${m} min</button>`).join('')}</div>` : ''}
    <details class="cook-ings"><summary>Ingrédients pour ${plural(S.people.length, 'personne', 'personnes')}</summary>
      <ul class="ings">${Object.keys(total).map((iid) => `<li><span>${esc(ING[iid].n)}</span><span class="q">${L.fmtQty(iid, total[iid])}</span></li>`).join('')}</ul></details>
  </div>
  <div class="sheet-foot"><div class="actions">
    <button class="btn soft" data-a="cook-step" data-d="-1" ${i ? '' : 'disabled'}>Précédent</button>
    ${i < n - 1 ? '<button class="btn primary" data-a="cook-step" data-d="1">Suivant</button>'
    : inMenu ? `<button class="btn primary" data-a="cook" data-id="${id}">${icon('check')} C'est prêt</button>`
      : '<button class="btn primary" data-a="close">Terminé</button>'}</div></div>`;
}

// ---------- Photos du foyer ----------

const UP_KEY = 'adeux.photoup';
const photoBusy = new Set();
let photoRetryAt = 0;
const uploaded = () => { try { return JSON.parse(localStorage.getItem(UP_KEY)) || {}; } catch { return {}; } };
const markUploaded = (id, ts) => { try { localStorage.setItem(UP_KEY, JSON.stringify({ ...uploaded(), [id]: ts })); } catch { /* ignoré */ } };

// Aligne les photos locales sur l'état partagé : envoie les nôtres, récupère celles de l'autre téléphone.
function syncPhotos() {
  let changed = false;
  for (const id of Object.keys(userPhotos)) {
    if (!S.photos[id]) { delete userPhotos[id]; photoDb.del(id).catch(() => {}); changed = true; }
  }
  if (changed) { render(); if (ui.sheet?.type === 'recipe') renderSheet(); }
  const code = sync?.status().code;
  if (!code || Date.now() < photoRetryAt) return;
  const fail = () => { photoRetryAt = Date.now() + 60000; };
  const up = uploaded();
  for (const [id, ts] of Object.entries(S.photos)) {
    if (photoBusy.has(id)) continue;
    const mine = userPhotos[id];
    if (mine && mine.ts >= ts) {
      if (up[id] === mine.ts) continue;
      photoBusy.add(id);
      rpc('photo_put', { p_code: code, p_recipe: id, p_ts: mine.ts, p_data: mine.data })
        .then((res) => { if (res.ok) markUploaded(id, mine.ts); }, fail)
        .finally(() => photoBusy.delete(id));
    } else {
      photoBusy.add(id);
      rpc('photo_get', { p_code: code, p_recipe: id }).then(async (res) => {
        if (!res.found || res.ts < ts || !isPhotoData(res.data)) return;
        userPhotos[id] = { ts: res.ts, data: res.data };
        await photoDb.put(id, userPhotos[id]).catch(() => {});
        markUploaded(id, res.ts);
        render();
        if (ui.sheet?.type === 'recipe') renderSheet();
      }, fail).finally(() => photoBusy.delete(id));
    }
  }
}

// ---------- Onglet Courses ----------

function viewShop() {
  let html = '<header class="top"><div><p class="eyebrow">Intermarché</p><h1>Courses</h1></div></header>';
  if (!S.menu.length) {
    return `${html}<div class="empty"><div class="big">🛒</div><h2>Rien à acheter</h2>
      <p>Mets des recettes au menu : on calcule ce qu'il manque, en tenant compte de ton placard.</p>
      <button class="btn primary" data-a="tab" data-tab="ideas">Choisir des recettes</button></div>`;
  }
  const { items, total } = L.shopping(S.menu, S.people, S.stock, S.mult);
  if (!items.length) {
    return `${html}<div class="empty"><div class="big">✅</div><h2>Tout est au placard</h2>
      <p>Tu as tout ce qu'il faut pour ${plural(S.menu.length, 'la recette', 'les recettes')} au menu.</p>
      <button class="btn primary" data-a="tab" data-tab="ideas">Voir le menu</button></div>`;
  }
  for (const id of Object.keys(S.checked)) if (!items.some((it) => it.id === id)) delete S.checked[id];
  const nChecked = items.filter((it) => S.checked[it.id]).length;
  html += `<p class="muted pad">Pour ${plural(S.menu.length, 'recette', 'recettes')} au menu. Coche en magasin, puis range tes achats. Touche un prix pour mettre celui du magasin.</p>`;
  if (S.budget) {
    const spent = weekSpend();
    const tot = spent + total;
    html += `<div class="card budget ${tot > S.budget + 0.005 ? 'over' : ''}"><b>${L.euro(tot)} sur ${L.euro(S.budget)} cette semaine</b>
      <div class="bar"><i style="width:${Math.min(100, Math.round((tot / S.budget) * 100))}%"></i></div>
      <small>${L.euro(spent)} déjà dépensés + ${L.euro(total)} dans cette liste${tot > S.budget + 0.005 ? ` · dépassement de ${L.euro(tot - S.budget)}` : ''}</small></div>`;
  }

  let cat = null;
  for (const it of items) {
    const ing = ING[it.id];
    if (ing.cat !== cat) {
      if (cat) html += '</div>';
      cat = ing.cat;
      html += `<h3 class="section">${CATS[cat]}</h3><div class="list">`;
    }
    const unit = ing.u === 'pc' && ing.pack === 1;
    const info = `il en faut ${unit ? L.frac(it.need) : L.fmtStock(it.id, it.need)}${it.have > 0 ? ` · tu as ${L.fmtStock(it.id, it.have)}` : ''}`;
    html += `<div class="row check ${S.checked[it.id] ? 'on' : ''}"><button class="rowbtn" data-a="check" data-id="${it.id}" aria-pressed="${!!S.checked[it.id]}">
      <span class="box">${icon('check')}</span>
      <span class="row-main"><b>${esc(ing.n)}</b><small>${unit ? plural(it.packs, 'pièce', 'pièces') : `${it.packs > 1 ? `${it.packs} × ` : ''}${esc(ing.pl)}`} · ${info}</small></span>
      </button><button class="price pricebtn ${S.prices[it.id] ? 'set' : ''}" data-a="price" data-id="${it.id}" aria-label="Modifier le prix">${L.euro(it.cost)}</button></div>`;
  }
  html += `</div>
    <div class="shop-foot card">
      <div class="total"><span>Total estimé</span><b>${L.euro(total)}</b></div>
      <button class="btn primary" data-a="store">${nChecked ? `Ranger (${nChecked})` : "J'ai tout acheté"}</button>
    </div>
    <p class="muted pad small center">Ranger ajoute tes achats au placard. Les restes serviront aux prochaines recettes.</p>`;
  return html;
}

// ---------- Onglet Placard ----------

function viewStock() {
  let html = `<header class="top"><div><p class="eyebrow">Ce qu'il te reste</p><h1>Placard</h1></div>
    <button class="iconbtn" data-a="stock-add" aria-label="Ajouter un produit">${icon('plus')}</button></header>`;
  const ids = Object.keys(S.stock);
  if (!ids.length) {
    return `${html}<div class="empty"><div class="big">🫙</div><h2>Placard vide</h2>
      <p>Il se remplit quand tu ranges tes courses, et se vide quand tu cuisines. Tu peux aussi ajouter ce que tu as déjà.</p>
      <button class="btn primary" data-a="stock-add">Ajouter un produit</button></div>`;
  }
  html += '<p class="muted pad">Touche un produit pour corriger la quantité.</p>';
  for (const [cat, label] of Object.entries(CATS)) {
    const list = ids.filter((id) => ING[id].cat === cat).sort((a, b) => ING[a].n.localeCompare(ING[b].n, 'fr'));
    if (!list.length) continue;
    html += `<h3 class="section">${label}</h3><div class="list">${list.map((id) =>
      `<button class="row" data-a="stock-edit" data-id="${id}"><span class="row-main"><b>${esc(ING[id].n)}</b></span>
       <span class="price">${L.fmtStock(id, S.stock[id])}</span>${icon('chev', 'muted')}</button>`).join('')}</div>`;
  }
  return html;
}

const stockStep = (id) => (ING[id].u === 'pc' ? 1 : Math.max(5, Math.round(ING[id].pack / 40) * 10));

function sheetStockEdit({ id }) {
  const ing = ING[id];
  return `<div class="sheet-pad"><h2>${esc(ing.n)}</h2><p class="muted">Vendu par : ${esc(ing.pl)}</p>
    <div class="stepper"><button class="iconbtn big" data-a="stock-step" data-d="-1" aria-label="Moins">−</button>
      <b>${L.fmtStock(id, S.stock[id] || 0)}</b>
      <button class="iconbtn big" data-a="stock-step" data-d="1" aria-label="Plus">+</button></div>
    ${ing.u === 'pc' && ing.pack === 1 ? '' : `<button class="btn soft" data-a="stock-pack">+ 1 paquet (${esc(ing.pl)})</button>`}
    <button class="btn danger" data-a="stock-del">Il n'y en a plus</button>
    <button class="btn primary" data-a="close">Terminé</button></div>`;
}

function sheetStockAdd() {
  const rows = Object.entries(ING).sort((a, b) => a[1].n.localeCompare(b[1].n, 'fr')).map(([id, i]) =>
    `<button class="row" data-a="stock-new" data-id="${id}" data-name="${esc(i.n.toLowerCase())}">
      <span class="row-main"><b>${esc(i.n)}</b><small>${esc(i.pl)}</small></span>${icon('plus', 'muted')}</button>`).join('');
  return `<div class="sheet-pad"><h2>Ajouter au placard</h2>
    <div class="input search"><input id="search" type="search" placeholder="Rechercher un produit" autocomplete="off"></div>
    <div class="list" id="search-list">${rows}</div></div>`;
}

// ---------- Onglet Suivi ----------

function chart(p, pi) {
  const pts = p.weighIns;
  const W = 320, H = 150, padL = 8, padR = 8, padT = 22, padB = 22;
  const ws = pts.map((x) => x.w).concat(p.goal);
  const lo = Math.min(...ws) - 0.8, hi = Math.max(...ws) + 0.8;
  const t = pts.map((x) => new Date(`${x.d}T12:00:00`).getTime());
  const t0 = t[0], t1 = t[t.length - 1];
  const x = (i) => (t1 === t0 ? W / 2 : padL + 14 + ((t[i] - t0) / (t1 - t0)) * (W - padL - padR - 28));
  const y = (w) => padT + ((hi - w) / (hi - lo)) * (H - padT - padB);
  const sel = Math.min(ui.sel[p.id] ?? pts.length - 1, pts.length - 1);
  const path = pts.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(pt.w).toFixed(1)}`).join(' ');
  const gy = y(p.goal);
  const label = (i, anchor) => `<text x="${x(i).toFixed(1)}" y="${(y(pts[i].w) - 10).toFixed(1)}" text-anchor="${anchor}" class="c-val">${kg(pts[i].w)}</text>`;
  return `<figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de poids de ${esc(p.name)}">
      <line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" class="c-goal"/>
      <text x="${W - padR}" y="${gy + (gy > H - 34 ? -6 : 13)}" text-anchor="end" class="c-lab">Objectif ${kg(p.goal)}</text>
      ${pts.length > 1 ? `<path d="${path}" class="c-line p${pi}"/>` : ''}
      ${pts.map((pt, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(pt.w).toFixed(1)}" r="${i === sel ? 5.5 : 4}" class="c-pt p${pi} ${i === sel ? 'sel' : ''}"/>
        <circle cx="${x(i).toFixed(1)}" cy="${y(pt.w).toFixed(1)}" r="16" class="c-hit" data-a="pt" data-p="${p.id}" data-i="${i}"/>`).join('')}
      ${label(sel, x(sel) < 50 ? 'start' : x(sel) > W - 50 ? 'end' : 'middle')}
    </svg>
    <figcaption>${pts.length > 1 ? `${fmtDate(pts[sel].d, { day: 'numeric', month: 'long' })} · ${kg(pts[sel].w)}` : 'Ajoute une pesée chaque semaine pour voir ta courbe.'}</figcaption>
  </figure>`;
}

function viewTrack() {
  let html = '<header class="top"><div><p class="eyebrow">Vos objectifs</p><h1>Suivi</h1></div></header>';
  html += S.people.map((p, i) => {
    const t = L.targets(p);
    const pr = L.progress(p);
    const right = pr.total !== 0 && Math.sign(pr.done) === Math.sign(pr.total);
    let status;
    if (t.mode === 'keep') status = '🎉 Objectif atteint ! Tes portions passent en maintien.';
    else if (right) status = `${pr.done > 0 ? '+' : '−'}${kg(Math.abs(pr.done))} sur ${kg(Math.abs(pr.total))} · encore ${kg(Math.abs(pr.left))}`;
    else status = `Encore ${kg(Math.abs(pr.left))} à ${t.mode === 'loss' ? 'perdre' : 'prendre'}`;
    return `<section class="card track">
      <div class="track-head"><span class="avatar p${i}">${esc(p.name[0].toUpperCase())}</span>
        <div><b>${esc(p.name)}</b><small>${{ loss: 'Perte de poids', gain: 'Prise de poids', keep: 'Maintien' }[t.mode]}</small></div>
        <div class="now"><b>${kg(p.weight)}</b><small>objectif ${kg(p.goal)}</small></div></div>
      <div class="bar"><i class="p${i}" style="width:${Math.round(pr.pct * 100)}%"></i></div>
      <p class="status">${status}</p>
      ${chart(p, i)}
      <div class="stats"><div><b>${int(t.kcal)}</b><small>kcal / jour</small></div>
        <div><b>${t.prot} g</b><small>protéines / jour</small></div>
        <div><b>${int(t.meal)}</b><small>kcal / repas</small></div></div>
      <div class="actions"><button class="btn soft" data-a="history" data-id="${p.id}">Historique</button>
        <button class="btn primary" data-a="weigh" data-id="${p.id}">${icon('plus')} Pesée</button></div>
      <button class="btn text" data-a="snacks" data-id="${p.id}">🥣 Idées de petit-déjeuner et de collations</button>
    </section>`;
  }).join('');
  html += `<section class="card track"><div class="track-head"><div><b>Dépenses de courses</b><small>d'après les courses rangées au placard</small></div></div>
      <div class="stats"><div><b>${L.euro(weekSpend())}</b><small>cette semaine</small></div>
        <div><b>${L.euro(monthSpend())}</b><small>ce mois-ci</small></div>
        <div><b>${S.budget ? L.euro(S.budget) : '—'}</b><small>budget / semaine</small></div></div>
      <button class="btn soft" data-a="budget-open">${S.budget ? 'Modifier le budget' : 'Fixer un budget par semaine'}</button></section>`;
  html += `<p class="muted pad small">Chaque recette couvre environ 35 % de tes calories du jour ; le reste, c'est le petit-déjeuner et les collations.
    Ces chiffres sont des estimations, pas un avis médical. ${plural(S.history.length, 'recette cuisinée', 'recettes cuisinées')} jusqu'ici.</p>`;
  return html;
}

function sheetWeigh({ id, err }) {
  const p = S.people[personIndex(id)];
  return `<form class="sheet-pad form" data-a-submit="weigh-save"><h2>Pesée de ${esc(p.name)}</h2>
    <label class="field ${err ? 'bad' : ''}"><span>Poids</span><div class="input"><input id="w-val" inputmode="decimal" placeholder="${String(p.weight).replace('.', ',')}" autocomplete="off"><i>kg</i></div>
      ${err ? `<em>${err}</em>` : ''}</label>
    <label class="field"><span>Date</span><div class="input"><input id="w-date" type="date" value="${L.today()}" max="${L.today()}"></div></label>
    <button class="btn primary" type="submit">Enregistrer</button></form>`;
}

function sheetHistory({ id }) {
  const p = S.people[personIndex(id)];
  const rows = [...p.weighIns].reverse().map((x) => `<div class="row static"><span class="row-main"><b>${kg(x.w)}</b>
    <small>${fmtDate(x.d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</small></span>
    ${p.weighIns.length > 1 ? `<button class="iconbtn" data-a="weigh-del" data-d="${x.d}" aria-label="Supprimer">${icon('close')}</button>` : ''}</div>`).join('');
  return `<div class="sheet-pad"><h2>Pesées de ${esc(p.name)}</h2><div class="list">${rows}</div>
    <button class="btn primary" data-a="close">Fermer</button></div>`;
}

// ---------- Réglages ----------

function viewSettings() {
  return `<header class="top"><button class="iconbtn" data-a="tab" data-tab="ideas" aria-label="Retour">${icon('back')}</button>
      <h1 class="grow">Réglages</h1></header>
    <h3 class="section">Le foyer</h3>
    <div class="list">${S.people.map((p, i) => `<button class="row" data-a="person-edit" data-id="${p.id}">
        <span class="avatar p${i}">${esc(p.name[0].toUpperCase())}</span>
        <span class="row-main"><b>${esc(p.name)}</b><small>${kg(p.weight)} → ${kg(p.goal)} · appétit ${p.appetite}</small></span>${icon('chev', 'muted')}</button>`).join('')}
      ${S.people.length < 4 ? `<button class="row" data-a="person-new"><span class="avatar add">${icon('plus')}</span><span class="row-main"><b>Ajouter une personne</b></span></button>` : ''}</div>
    <h3 class="section">Matériel de cuisine</h3><div class="pad">${equipChips()}</div>
    <h3 class="section">On ne mange pas de…</h3><div class="pad">${avoidChips()}</div>
    <h3 class="section">Magasin</h3>
    <div class="list"><div class="row static"><span class="row-main"><b>Intermarché</b><small>Prix estimés, à vérifier en rayon</small></span>${icon('check', 'ok')}</div></div>
    <h3 class="section">Deux téléphones</h3>
    ${syncSection()}
    <h3 class="section">Recettes masquées</h3>
    <div class="pad stack">${S.disliked.length
    ? `<button class="btn soft" data-a="undislike">Réafficher ${plural(S.disliked.length, 'recette masquée', 'recettes masquées')}</button>`
    : '<p class="muted">Aucune recette masquée.</p>'}</div>
    <h3 class="section">Données</h3>
    <div class="pad stack"><button class="btn danger" data-a="reset">Tout effacer et recommencer</button></div>
    <p class="muted pad small center">À Deux · ${sync?.status().code ? 'données enregistrées sur cet appareil et synchronisées avec votre foyer' : 'données enregistrées uniquement sur cet appareil'}.<br>Photos : Wikimedia Commons, crédits dans chaque recette.</p>`;
}

function syncSection() {
  if (!sync) {
    return `<p class="muted pad">Copie tes données sur un autre iPhone avec un code. À refaire quand vous voulez vous resynchroniser.</p>
    <div class="pad stack"><button class="btn soft" data-a="export-open">Envoyer mes données</button>
      <button class="btn soft" data-a="import-open">Recevoir un code</button></div>`;
  }
  const st = sync.status();
  if (!st.code) {
    return `<p class="muted pad">Partagez le même foyer : recettes, menu, courses, placard et suivi se mettent à jour tout seuls sur les deux téléphones.</p>
    <div class="pad stack"><button class="btn primary" data-a="sync-create">Créer notre foyer partagé</button>
      <button class="btn soft" data-a="import-open">Rejoindre avec un code</button></div>`;
  }
  return `<button class="card sync" data-a="sync-copy" aria-label="Copier le code du foyer">
      <small>Code du foyer · touche pour copier</small><b>${formatCode(st.code)}</b>
      <small class="${st.ok ? 'ok' : 'off'}">${st.ok ? '✓ Synchronisation active' : 'Hors ligne · tes changements partiront au retour du réseau'}</small></button>
    <p class="muted pad">Sur l'autre téléphone : « J'ai déjà un code de partage » au démarrage, ou Réglages puis « Rejoindre avec un code ».</p>
    <div class="pad stack"><button class="btn primary" data-a="sync-share">Envoyer le code</button>
      <button class="btn text" data-a="sync-leave">Quitter le foyer partagé</button></div>`;
}

function sheetPerson({ id, errs }) {
  const d = ui.draft;
  return `<form class="sheet-pad form" data-a-submit="person-save"><h2>${id ? esc(d.name || 'Profil') : 'Nouvelle personne'}</h2>
    ${personForm(d, { needWeight: !id, errs: errs || {} })}
    <button class="btn primary" type="submit">Enregistrer</button>
    ${id && S.people.length > 1 ? '<button class="btn danger" type="button" data-a="person-del">Retirer du foyer</button>' : ''}</form>`;
}

// ---------- Partage entre téléphones ----------

const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function encodeState() {
  const json = JSON.stringify(S);
  if ('CompressionStream' in window) {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return `AD1.${b64(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
  }
  return `AD0.${b64(new TextEncoder().encode(json))}`;
}

async function decodeState(code) {
  const c = code.trim();
  const body = unb64(c.slice(4));
  let json;
  if (c.startsWith('AD1.')) {
    const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    json = await new Response(stream).text();
  } else if (c.startsWith('AD0.')) json = new TextDecoder().decode(body);
  else throw new Error('format');
  const raw = JSON.parse(json);
  if (!raw || raw.v !== 1 || !Array.isArray(raw.people) || !raw.people.length) throw new Error('contenu');
  return sanitize(raw);
}

function sheetExport({ code }) {
  return `<div class="sheet-pad"><h2>Envoyer mes données</h2>
    <p class="muted">Envoie ce code à l'autre téléphone (par message). Là-bas : Réglages, puis « Recevoir un code ».</p>
    <textarea id="code" class="code" readonly rows="5">${esc(code)}</textarea>
    <button class="btn primary" data-a="export-copy">Copier le code</button>
    ${navigator.share ? '<button class="btn soft" data-a="export-share">Partager…</button>' : ''}</div>`;
}

function sheetImport({ err }) {
  if (sync) {
    return `<div class="sheet-pad"><h2>Rejoindre un foyer</h2>
    <p class="muted">Entre le code du foyer affiché sur l'autre téléphone (Réglages). Vous partagerez ensuite les mêmes données, mises à jour automatiquement.</p>
    <div class="input"><input id="code" class="codein" placeholder="ABCDE-FGHJK" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="2000"></div>
    ${err ? `<p class="hint warn">${err}</p>` : ''}
    <button class="btn primary" data-a="import-do">Rejoindre</button></div>`;
  }
  return `<div class="sheet-pad"><h2>Recevoir un code</h2>
    <p class="muted">Colle ici le code envoyé depuis l'autre téléphone. Les pesées des deux téléphones sont conservées ; le reste est remplacé.</p>
    <textarea id="code" class="code" rows="5" placeholder="AD1.…" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
    ${err ? `<p class="hint warn">${err}</p>` : ''}
    <button class="btn primary" data-a="import-do">Importer</button></div>`;
}

function mergeImport(inc) {
  for (const p of inc.people) {
    const mine = S.people.find((x) => x.id === p.id);
    if (!mine) continue;
    for (const w of mine.weighIns) if (!p.weighIns.some((x) => x.d === w.d)) p.weighIns.push(w);
    p.weighIns.sort((a, b) => a.d.localeCompare(b.d));
    p.weight = p.weighIns[p.weighIns.length - 1].w;
  }
  S = inc;
  S.onboarded = true;
}

// ---------- Rendu ----------

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

const TABS = [['ideas', 'Recettes', 'ideas'], ['shop', 'Courses', 'shop'], ['stock', 'Placard', 'stock'], ['track', 'Suivi', 'track']];
const VIEWS = { ideas: viewIdeas, shop: viewShop, stock: viewStock, track: viewTrack, settings: viewSettings };
const SHEETS = {
  recipe: sheetRecipe, plan: sheetPlan, price: sheetPrice, budget: sheetBudget, rate: sheetRate,
  snacks: sheetSnacks, browse: sheetBrowse, cook: sheetCook, stockEdit: sheetStockEdit, stockAdd: sheetStockAdd, weigh: sheetWeigh,
  history: sheetHistory, person: sheetPerson, export: sheetExport, import: sheetImport,
};

function render(top = false) {
  L.setPrices(S.prices);
  const view = $('#view');
  const tabs = $('#tabs');
  const y = view.scrollTop;
  if (!S.onboarded) {
    if (!ui.ob) ui.ob = { step: 0, persons: [newDraft(), newDraft()], staples: [], errs: null };
    view.innerHTML = viewOnboarding();
    tabs.hidden = true;
  } else {
    view.innerHTML = VIEWS[ui.tab]();
    const n = S.menu.length ? L.shopping(S.menu, S.people, S.stock, S.mult).items.length : 0;
    tabs.hidden = ui.tab === 'settings';
    tabs.innerHTML = TABS.map(([id, label, ic]) => `<button class="${ui.tab === id ? 'on' : ''}" data-a="tab" data-tab="${id}">
      <span class="tab-ic">${icon(ic)}${id === 'shop' && n ? `<i class="badge">${n}</i>` : ''}</span><span>${label}</span></button>`).join('');
  }
  view.scrollTop = top ? 0 : y;
  ui.anim = false;
}

function renderSheet() {
  const el = $('#sheet');
  if (!ui.sheet) return;
  const body = el.querySelector('.sheet-body');
  const y = body ? body.scrollTop : 0;
  el.innerHTML = `<div class="backdrop" data-a="close"></div>
    <div class="sheet-panel ${['recipe', 'browse', 'cook'].includes(ui.sheet.type) ? 'tall' : ''}" role="dialog" aria-modal="true">
      <button class="iconbtn sheet-close" data-a="close" aria-label="Fermer">${icon('close')}</button>
      <div class="sheet-body">${SHEETS[ui.sheet.type](ui.sheet)}</div></div>`;
  el.querySelector('.sheet-body').scrollTop = y;
}

function openSheet(s) {
  const el = $('#sheet');
  const wasOpen = !!ui.sheet;
  ui.sheet = s;
  el.hidden = false;
  renderSheet();
  if (wasOpen) el.querySelector('.sheet-body').scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
}

function closeSheet() {
  const el = $('#sheet');
  if (!ui.sheet) return;
  if (ui.sheet.type === 'cook') keepAwake(false);
  ui.sheet = null;
  el.classList.remove('open');
  setTimeout(() => { if (!ui.sheet) { el.hidden = true; el.innerHTML = ''; } }, 280);
}

function commit({ top = false, sheet = true } = {}) {
  save();
  render(top);
  if (sheet) renderSheet();
}

// ---------- Actions ----------

const toggle = (arr, id) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

const A = {
  tab(d) { ui.tab = d.tab; render(true); },
  close() { closeSheet(); },
  'hide-install'() { try { localStorage.setItem('adeux.install', '1'); } catch { /* ignoré */ } render(); },

  // Onboarding
  'ob-next'() { obNext(); },
  'ob-back'() { ui.ob.errs = null; ui.ob.step = Math.max(0, ui.ob.step - 1); render(true); },
  'ob-skip'() { ui.ob.persons[1] = newDraft(); ui.ob.errs = null; ui.ob.step += 1; render(true); },
  'ob-staple'(d) { ui.ob.staples = toggle(ui.ob.staples, d.id); render(); },
  setf(d) {
    ui.draft[d.f] = d.v;
    const errs = ui.sheet?.errs || ui.ob?.errs;
    if (errs) delete errs[d.f];
    if (ui.sheet) renderSheet(); else render();
  },
  equip(d) {
    const next = toggle(S.equip, d.id);
    if (!next.length) return toast('Garde au moins un appareil');
    S.equip = next; S.skipped = []; commit();
  },
  avoid(d) { S.avoid = toggle(S.avoid, d.id); S.skipped = []; commit(); },

  // Recettes
  recipe(d) { openSheet({ type: 'recipe', id: d.id, who: 'all' }); },
  who(d) { ui.sheet.who = d.v; renderSheet(); },
  next() {
    if (S.current) S.skipped.push(S.current);
    S.current = null; ui.anim = true; commit({ top: true });
  },
  add(d) {
    if (!S.menu.includes(d.id)) { S.menu.push(d.id); S.days[d.id] = freeSlots(1)[0]; }
    if (S.current === d.id) S.current = null;
    ui.anim = true; closeSheet(); commit({ sheet: false });
    toast('Ajoutée au menu · liste de courses mise à jour');
  },
  'plan-open'() { openSheet({ type: 'plan', n: Math.min(14, Math.max(7, S.menu.length + 3)) }); },
  'plan-n'(d) { ui.sheet.n = Math.min(14, Math.max(2, ui.sheet.n + Number(d.d))); renderSheet(); },
  'plan-do'() {
    const before = S.menu.length;
    const old = new Set(S.menu);
    const want = ui.sheet.n;
    S.menu = L.planMenu(S, want);
    const fresh = S.menu.filter((id) => !old.has(id));
    const slots = freeSlots(fresh.length, want > 7 ? 2 : 1);
    fresh.forEach((id, i) => { S.days[id] = slots[i]; });
    if (S.menu.includes(S.current)) S.current = null;
    closeSheet(); commit({ sheet: false });
    document.getElementById('menu')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (S.menu.length === before) toast(S.budget ? 'Budget atteint : aucun repas ajouté' : 'Plus aucune recette à ajouter');
    else if (S.menu.length < want && S.budget) toast(`Budget atteint : menu de ${S.menu.length} repas`, 4000);
    else toast(`Menu de ${S.menu.length} repas prêt · liste de courses à jour`);
  },
  swap(d) {
    const i = S.menu.indexOf(d.id);
    if (i < 0) return;
    const rest = S.menu.filter((x) => x !== d.id);
    const pick = L.rankRecipes({ ...S, menu: rest }).find((x) => x !== d.id);
    if (!pick) return toast('Aucune autre recette disponible');
    S.menu[i] = pick;
    if (S.days[d.id]) S.days[pick] = S.days[d.id];
    delete S.days[d.id]; delete S.mult[d.id];
    if (S.current === pick) S.current = null;
    save(); render(); openSheet({ type: 'recipe', id: pick, who: 'all' });
  },
  'menu-clear'() {
    if (!confirm('Retirer toutes les recettes du menu ?')) return;
    S.menu = []; S.days = {}; S.mult = {}; commit({ sheet: false });
  },
  unmenu(d) { dropFromMenu(d.id); closeSheet(); commit({ sheet: false }); },
  dislike(d) {
    S.disliked.push(d.id); dropFromMenu(d.id);
    if (S.current === d.id) S.current = null;
    closeSheet(); commit({ sheet: false }); toast('On ne te la proposera plus');
  },
  undislike() { S.disliked = []; commit(); toast('Recettes réaffichées'); },
  cook(d) {
    L.cook(S.stock, RECIPE_BY_ID[d.id], S.people, S.mult[d.id] || 1);
    dropFromMenu(d.id);
    S.history.push({ id: d.id, d: L.today(), t: Date.now() });
    if (S.history.length > 200) S.history = S.history.slice(-200);
    if (ui.sheet?.type === 'cook') keepAwake(false);
    save(); render(); toast('Bon appétit ! Placard mis à jour');
    openSheet({ type: 'rate', id: d.id });
  },
  rate(d) {
    const { id } = ui.sheet;
    const v = Number(d.v);
    S.ratings[id] = v;
    if (v === -1 && !S.disliked.includes(id)) S.disliked.push(id);
    closeSheet(); commit({ sheet: false });
    toast(v === 1 ? 'Noté ❤️ : on vous la reproposera' : v === -1 ? 'On ne vous la proposera plus' : 'Merci !');
  },
  'hide-nag'() { try { localStorage.setItem('adeux.nag', L.today()); } catch { /* ignoré */ } render(); },

  // Calendrier et double portion
  'day-date'(d, el) {
    if (!el.value) delete S.days[d.id];
    else S.days[d.id] = { d: el.value, s: S.days[d.id]?.s || 'soir' };
    commit();
  },
  'day-slot'(d) { S.days[d.id] = { d: S.days[d.id]?.d || L.today(), s: d.v }; commit(); },
  double(d) { if (S.mult[d.id] === 2) delete S.mult[d.id]; else S.mult[d.id] = 2; commit(); },

  // Recherche
  browse() { openSheet({ type: 'browse', f: [], q: '' }); },
  'browse-f'(d) {
    ui.sheet.q = $('#bq')?.value || '';
    ui.sheet.f = toggle(ui.sheet.f, d.id);
    renderSheet();
  },

  // Mode cuisine et minuteurs
  cookmode(d) { primeAudio(); keepAwake(true); openSheet({ type: 'cook', id: d.id, i: 0 }); },
  'cook-step'(d) {
    ui.sheet.i = Math.min(RECIPE_BY_ID[ui.sheet.id].steps.length - 1, Math.max(0, ui.sheet.i + Number(d.d)));
    renderSheet();
    $('#sheet .sheet-body').scrollTop = 0;
  },
  timer(d) {
    primeAudio();
    ui.timers.push({ end: Date.now() + Number(d.m) * 60000, label: `${d.l}, ${d.m} min` });
    renderSheet();
  },
  'timer-stop'(d) { ui.timers = ui.timers.filter((t) => String(t.end) !== d.t); renderSheet(); },

  // Photos du foyer
  async photo(d, el) {
    const file = el.files?.[0];
    if (!file) return;
    try {
      const data = await shrinkPhoto(file);
      const ts = Date.now();
      userPhotos[d.id] = { ts, data };
      await photoDb.put(d.id, userPhotos[d.id]).catch(() => {});
      S.photos[d.id] = ts;
      commit(); syncPhotos(); toast('Photo enregistrée');
    } catch { toast("Impossible d'utiliser cette photo"); }
  },
  'photo-del'(d) { delete S.photos[d.id]; commit(); syncPhotos(); },

  // Prix réels et budget
  price(d) { openSheet({ type: 'price', id: d.id }); setTimeout(() => $('#pr-val')?.select(), 350); },
  'price-save'() {
    const v = parseNum($('#pr-val').value);
    if (!Number.isFinite(v) || v <= 0 || v > 200) { ui.sheet.err = 'Entre un prix entre 0,01 et 200 €'; return renderSheet(); }
    S.prices[ui.sheet.id] = Math.round(v * 100) / 100;
    closeSheet(); commit({ sheet: false }); toast('Prix enregistré');
  },
  'price-reset'() { delete S.prices[ui.sheet.id]; closeSheet(); commit({ sheet: false }); },
  'budget-open'() { openSheet({ type: 'budget' }); },
  'budget-save'() {
    const v = parseNum($('#bu-val').value);
    if (!Number.isFinite(v) || v < 5 || v > 2000) { ui.sheet.err = 'Entre un montant entre 5 et 2 000 €'; return renderSheet(); }
    S.budget = Math.round(v * 100) / 100;
    closeSheet(); commit({ sheet: false }); toast('Budget enregistré');
  },
  'budget-clear'() { S.budget = null; closeSheet(); commit({ sheet: false }); },
  snacks(d) { openSheet({ type: 'snacks', id: d.id }); },

  // Courses
  check(d) { if (S.checked[d.id]) delete S.checked[d.id]; else S.checked[d.id] = true; commit(); },
  store() {
    const { items } = L.shopping(S.menu, S.people, S.stock, S.mult);
    const any = items.some((it) => S.checked[it.id]);
    const bought = items.filter((it) => !any || S.checked[it.id]);
    for (const it of bought) L.addPacks(S.stock, it.id, it.packs);
    const paid = bought.reduce((a, it) => a + it.cost, 0);
    if (paid > 0) S.spend.push({ d: L.today(), t: Date.now(), a: Math.round(paid * 100) / 100 });
    if (S.spend.length > 300) S.spend = S.spend.slice(-300);
    S.checked = {};
    commit({ top: true });
    toast(`${plural(bought.length, 'article rangé', 'articles rangés')} au placard`);
  },

  // Placard
  'stock-add'() { openSheet({ type: 'stockAdd' }); },
  'stock-new'(d) { L.addPacks(S.stock, d.id, 1); save(); render(); openSheet({ type: 'stockEdit', id: d.id }); },
  'stock-edit'(d) { openSheet({ type: 'stockEdit', id: d.id }); },
  'stock-step'(d) {
    const { id } = ui.sheet;
    const q = (S.stock[id] || 0) + Number(d.d) * stockStep(id);
    if (q <= 0) { delete S.stock[id]; closeSheet(); commit({ sheet: false }); return toast('Retiré du placard'); }
    S.stock[id] = q;
    commit();
  },
  'stock-pack'() { L.addPacks(S.stock, ui.sheet.id, 1); commit(); },
  'stock-del'() { delete S.stock[ui.sheet.id]; closeSheet(); commit({ sheet: false }); },

  // Suivi
  pt(d) { ui.sel[d.p] = Number(d.i); render(); },
  weigh(d) { openSheet({ type: 'weigh', id: d.id }); setTimeout(() => $('#w-val')?.focus(), 350); },
  'weigh-save'() {
    const w = parseNum($('#w-val').value);
    const date = $('#w-date').value || L.today();
    if (!Number.isFinite(w) || w < 30 || w > 250) { ui.sheet.err = 'Entre un poids entre 30 et 250 kg'; return renderSheet(); }
    const p = S.people[personIndex(ui.sheet.id)];
    L.addWeighIn(p, Math.round(w * 10) / 10, date > L.today() ? L.today() : date);
    delete ui.sel[p.id];
    closeSheet(); commit({ sheet: false });
    toast(L.mode(p) === 'keep' ? '🎉 Objectif atteint !' : 'Pesée enregistrée · portions recalculées');
  },
  history(d) { openSheet({ type: 'history', id: d.id }); },
  'weigh-del'(d) {
    const p = S.people[personIndex(ui.sheet.id)];
    L.removeWeighIn(p, d.d); delete ui.sel[p.id]; commit();
  },

  // Foyer
  'person-edit'(d) {
    const p = S.people[personIndex(d.id)];
    ui.draft = { name: p.name, sex: p.sex, age: String(p.age), height: String(p.height), goal: String(p.goal), activity: p.activity, appetite: p.appetite, weightNow: p.weight };
    openSheet({ type: 'person', id: d.id });
  },
  'person-new'() { ui.draft = newDraft(); openSheet({ type: 'person', id: null }); },
  'person-save'() {
    const { id } = ui.sheet;
    const r = readPerson(ui.draft, !id);
    if (!r.ok) { ui.sheet.errs = r.err; return renderSheet(); }
    if (id) Object.assign(S.people[personIndex(id)], r.person);
    else S.people.push({ id: uid(), ...r.person, weighIns: [{ d: L.today(), w: r.person.weight }] });
    closeSheet(); commit({ sheet: false }); toast('Profil enregistré');
  },
  'person-del'() {
    const p = S.people[personIndex(ui.sheet.id)];
    if (!confirm(`Retirer ${p.name} du foyer ? Son suivi sera effacé.`)) return;
    S.people = S.people.filter((x) => x.id !== p.id);
    closeSheet(); commit({ sheet: false });
  },

  // Partage
  async 'export-open'() { openSheet({ type: 'export', code: await encodeState() }); },
  async 'export-copy'() {
    const ta = $('#code');
    try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
    toast('Code copié');
  },
  'export-share'() { navigator.share({ text: $('#code').value }).catch(() => {}); },
  'import-open'() { openSheet({ type: 'import' }); },
  async 'import-do'(d, el) {
    const raw = $('#code').value.trim();
    const household = sync && !/^AD[01]\./.test(raw);
    try {
      if (household) {
        if (S.onboarded && !confirm('Rejoindre ce foyer ? Les données de ce téléphone seront remplacées par celles du foyer.')) return;
        el.disabled = true;
        await sync.join(raw);
        ui.ob = null; ui.tab = 'ideas';
        closeSheet(); render(true); toast('Foyer rejoint · synchronisation active');
        return;
      }
      const inc = await decodeState(raw);
      if (S.onboarded && !confirm('Remplacer les données de ce téléphone par celles du code ?')) return;
      mergeImport(inc);
      ui.ob = null; ui.tab = 'ideas';
      closeSheet(); commit({ top: true, sheet: false }); toast('Données importées');
    } catch (e) {
      if (!ui.sheet) return;
      if (!household) ui.sheet.err = "Ce code n'est pas valide. Copie-le en entier depuis l'autre téléphone.";
      else if (e.message === 'notfound') ui.sheet.err = "Ce code ne correspond à aucun foyer. Vérifie-le sur l'autre téléphone.";
      else ui.sheet.err = 'Connexion impossible. Vérifie ta connexion internet et réessaie.';
      renderSheet();
    }
  },
  async 'sync-create'(d, el) {
    el.disabled = true;
    try {
      await sync.create();
      render(); toast("Foyer créé · envoie le code à l'autre téléphone");
    } catch { el.disabled = false; toast('Connexion impossible, réessaie'); }
  },
  async 'sync-copy'() {
    try { await navigator.clipboard.writeText(formatCode(sync.status().code)); toast('Code copié'); } catch { toast('Copie impossible, recopie le code à la main'); }
  },
  'sync-share'() {
    const text = `Rejoins notre foyer sur À Deux avec ce code : ${formatCode(sync.status().code)}`;
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else A['sync-copy']();
  },
  'sync-leave'() {
    if (!confirm("Quitter le foyer partagé ? Tes données restent sur ce téléphone, mais ne seront plus synchronisées.")) return;
    sync.leave(); render();
  },
  reset() {
    if (!confirm('Effacer tous les profils, le placard et le suivi de cet appareil ?')) return;
    sync?.leave();
    try { localStorage.removeItem(KEY); } catch { /* ignoré */ }
    S = blank(); ui.ob = null; ui.tab = 'ideas'; render(true);
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]');
  if (!el || el.tagName === 'FORM') return;
  if (el.getAttribute('type') === 'submit') return;
  const fn = A[el.dataset.a];
  if (fn) { ev.preventDefault(); fn(el.dataset, el); }
});

document.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const fn = A[ev.target.dataset.aSubmit];
  if (fn) fn(ev.target.dataset, ev.target);
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.f && ui.draft) {
    ui.draft[el.dataset.f] = el.value;
    const errs = ui.sheet?.errs || ui.ob?.errs;
    if (errs) delete errs[el.dataset.f];
    const fld = el.closest('.field');
    if (fld?.classList.contains('bad')) { fld.classList.remove('bad'); fld.querySelector('em')?.remove(); }
    const hint = el.closest('form, .form')?.querySelector('#form-hint');
    if (hint) hint.innerHTML = formHint(ui.draft, !(ui.sheet?.type === 'person' && ui.sheet.id));
  } else if (el.type === 'search') {
    const q = norm(el.value.trim());
    document.querySelectorAll(`#${el.dataset.list || 'search-list'} .row`).forEach((r) => { r.hidden = !norm(r.dataset.name).includes(q); });
  }
});

document.addEventListener('change', (ev) => {
  const fn = ev.target.dataset.c && A[ev.target.dataset.c];
  if (fn) fn(ev.target.dataset, ev.target);
});

// Minuteurs du mode cuisine : décompte chaque seconde, bip à la fin.
setInterval(() => {
  if (!ui.timers.length) return;
  const now = Date.now();
  const done = ui.timers.filter((t) => t.end <= now);
  if (done.length) {
    ui.timers = ui.timers.filter((t) => t.end > now);
    beep();
    toast(`⏰ ${done[0].label} : c'est prêt !`, 8000);
    if (ui.sheet?.type === 'cook') renderSheet();
  }
  document.querySelectorAll('[data-timer]').forEach((el) => { el.textContent = clock(Number(el.dataset.timer) - now); });
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.sheet?.type === 'cook') keepAwake(true);
});

document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); });

render(true);

photoDb.all().then((all) => {
  userPhotos = Object.fromEntries(Object.entries(all).filter(([, v]) => v && isPhotoData(v.data)));
  if (Object.keys(userPhotos).length) render();
  syncPhotos();
}).catch(() => {});

if (sync) {
  const tick = () => { if (document.visibilityState === 'visible') { sync.pull(); syncPhotos(); } };
  setInterval(tick, 4000);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', tick);
  tick();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
