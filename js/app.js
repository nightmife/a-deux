import { INGREDIENTS as ING, RECIPE_BY_ID, CATS, EQUIPMENT, AVOID } from './data.js';
import * as L from './logic.js';
import { PHOTOS } from './photos.js';
import { SYNC } from './config.js';
import { createSync, formatCode } from './sync.js';

// ---------- État ----------

const KEY = 'adeux.v1';
const blank = () => ({
  v: 1, onboarded: false, people: [], equip: ['pl'], avoid: [], stock: {},
  menu: [], checked: {}, history: [], disliked: [], skipped: [], current: null,
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
    else if (['recipe', 'stockEdit', 'history'].includes(type)) renderSheet();
  }
  render();
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

const ui = { tab: 'ideas', ob: null, draft: null, sheet: null, sel: {}, anim: false };

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

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function media(r, cls = '') {
  const img = PHOTOS[r.id]
    ? `<img src="img/recipes/${r.id}.jpg" alt="" loading="lazy" onerror="this.remove()">` : '';
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

  if (!id) {
    html += `<div class="empty"><div class="big">🤷</div><h2>Aucune recette à proposer</h2>
      <p>Avec ces réglages, il ne reste plus de recette. Ajoute du matériel ou retire des exclusions.</p>
      <button class="btn primary" data-a="tab" data-tab="settings">Ouvrir les réglages</button></div>`;
  } else {
    const r = RECIPE_BY_ID[id];
    const rest = L.leftovers(S.menu, S.people, S.stock);
    const buy = L.shopping([id], S.people, rest);
    const n = Object.keys(L.needs(r, S.people)).length;
    const have = n - buy.items.length;
    const buyLine = buy.items.length
      ? `<b>${L.euro(buy.total)}</b> à acheter · ${have ? `${have} sur ${n} ingrédients déjà au placard` : `${plural(n, 'ingrédient', 'ingrédients')}`}`
      : '<b>Rien à acheter</b> · tout est déjà au placard';
    html += `<article class="card recipe ${ui.anim ? 'swap' : ''}">
        <button class="recipe-open" data-a="recipe" data-id="${id}" aria-label="Voir la recette">
          ${media(r, 'hero')}
          <div class="recipe-body"><h2>${esc(r.name)}</h2>${metaChips(r)}
            <div class="plines">${personLines(r)}</div>
            <p class="buy ${buy.items.length ? '' : 'ok'}">🛒 ${buyLine}</p>
            <span class="see">Voir la recette ${icon('chev')}</span></div>
        </button>
        <div class="actions">
          <button class="btn soft" data-a="next">${icon('next')} Une autre</button>
          <button class="btn primary" data-a="add" data-id="${id}">${icon('plus')} Au menu</button>
        </div></article>`;
  }

  html += '<h3 class="section">Au menu</h3>';
  if (!S.menu.length) {
    html += '<p class="muted pad">Ajoute les recettes qui te plaisent : la liste de courses se remplit toute seule.</p>';
  } else {
    html += `<div class="list">${S.menu.map((mid) => {
      const r = RECIPE_BY_ID[mid];
      const miss = L.shopping([mid], S.people, S.stock).items.length;
      return `<button class="row" data-a="recipe" data-id="${mid}">${media(r, 'thumb')}
        <span class="row-main"><b>${esc(r.name)}</b>
        <small class="${miss ? '' : 'ok'}">${miss ? `🛒 ${plural(miss, 'ingrédient', 'ingrédients')} à acheter` : '✓ Prêt à cuisiner'}</small></span>${icon('chev', 'muted')}</button>`;
    }).join('')}</div>`;
  }
  return html;
}

// ---------- Fiche recette ----------

function sheetRecipe({ id, who: whoRaw = 'all' }) {
  const who = whoRaw !== 'all' && personIndex(whoRaw) < 0 ? 'all' : whoRaw;
  const r = RECIPE_BY_ID[id];
  const inMenu = S.menu.includes(id);
  const portions = S.people.map((p) => L.portion(r, p));
  const total = L.needs(r, S.people);
  const multi = S.people.length > 1;

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

  const baseK = portions.map((po) => po.items.filter((it) => !it.boost).reduce((s, it) => s + L.kcalOf(it.id, it.q), 0));
  const sumK = baseK.reduce((a, b) => a + b, 0);
  const plates = S.people.map((p, i) => {
    const po = portions[i];
    const boosts = po.items.filter((it) => it.boost)
      .map((it) => `+ ${L.fmtQty(it.id, L.roundQty(it.id, it.q))} de ${ING[it.id].n.toLowerCase()} dans son assiette`).join('');
    const share = Math.round((baseK[i] / sumK) * 100);
    return `<div class="plate"><span class="avatar p${i}">${esc(p.name[0].toUpperCase())}</span>
      <div><b>${esc(p.name)}${multi ? ` · ${share} % du plat` : ''}</b>
      <small>${int(po.kcal)} kcal · ${Math.round(po.prot)} g de protéines</small>
      ${boosts ? `<small class="boostline">${boosts}</small>` : ''}</div></div>`;
  }).join('');

  const steps = [...r.steps];
  if (multi) {
    steps.push(`Sers : ${S.people.map((p, i) => `${esc(p.name)} ${Math.round((baseK[i] / sumK) * 100)} % du plat`).join(', ')}.`);
  }

  const foot = inMenu
    ? `<button class="btn primary" data-a="cook" data-id="${id}">${icon('check')} On l'a cuisinée</button>
       <button class="btn text" data-a="unmenu" data-id="${id}">Retirer du menu</button>`
    : `<button class="btn primary" data-a="add" data-id="${id}">${icon('plus')} Ajouter au menu</button>
       <button class="btn text" data-a="dislike" data-id="${id}">Ne plus proposer cette recette</button>`;

  return `${media(r, 'cover')}
    <div class="sheet-pad">
      <h2>${esc(r.name)}</h2>${metaChips(r)}
      <h3>Dans l'assiette</h3><div class="plates">${plates}</div>
      <h3>Ingrédients</h3>
      ${multi ? `<div class="seg small">${[['all', `Pour ${S.people.length}`], ...S.people.map((p) => [p.id, esc(p.name)])].map(([v, lab]) =>
    `<button class="${who === v ? 'on' : ''}" data-a="who" data-v="${v}">${lab}</button>`).join('')}</div>` : ''}
      <ul class="ings">${rows}</ul>
      <p class="muted small">Sel, poivre et eau ne sont pas listés.</p>
      <h3>Préparation</h3>
      <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      ${PHOTOS[r.id] ? `<p class="muted small">Photo d'illustration : <a href="${esc(PHOTOS[r.id].u)}" target="_blank" rel="noopener">${esc(PHOTOS[r.id].a)}</a>, ${esc(PHOTOS[r.id].l)}, via Wikimedia Commons</p>` : ''}
    </div>
    <div class="sheet-foot">${foot}</div>`;
}

// ---------- Onglet Courses ----------

function viewShop() {
  let html = '<header class="top"><div><p class="eyebrow">Intermarché</p><h1>Courses</h1></div></header>';
  if (!S.menu.length) {
    return `${html}<div class="empty"><div class="big">🛒</div><h2>Rien à acheter</h2>
      <p>Mets des recettes au menu : on calcule ce qu'il manque, en tenant compte de ton placard.</p>
      <button class="btn primary" data-a="tab" data-tab="ideas">Choisir des recettes</button></div>`;
  }
  const { items, total } = L.shopping(S.menu, S.people, S.stock);
  if (!items.length) {
    return `${html}<div class="empty"><div class="big">✅</div><h2>Tout est au placard</h2>
      <p>Tu as tout ce qu'il faut pour ${plural(S.menu.length, 'la recette', 'les recettes')} au menu.</p>
      <button class="btn primary" data-a="tab" data-tab="ideas">Voir le menu</button></div>`;
  }
  for (const id of Object.keys(S.checked)) if (!items.some((it) => it.id === id)) delete S.checked[id];
  const nChecked = items.filter((it) => S.checked[it.id]).length;
  html += `<p class="muted pad">Pour ${plural(S.menu.length, 'recette', 'recettes')} au menu. Coche en magasin, puis range tes achats.</p>`;

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
    html += `<button class="row check ${S.checked[it.id] ? 'on' : ''}" data-a="check" data-id="${it.id}" aria-pressed="${!!S.checked[it.id]}">
      <span class="box">${icon('check')}</span>
      <span class="row-main"><b>${esc(ing.n)}</b><small>${unit ? plural(it.packs, 'pièce', 'pièces') : `${it.packs > 1 ? `${it.packs} × ` : ''}${esc(ing.pl)}`} · ${info}</small></span>
      <span class="price">${L.euro(it.cost)}</span></button>`;
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
    </section>`;
  }).join('');
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
  recipe: sheetRecipe, stockEdit: sheetStockEdit, stockAdd: sheetStockAdd, weigh: sheetWeigh,
  history: sheetHistory, person: sheetPerson, export: sheetExport, import: sheetImport,
};

function render(top = false) {
  const view = $('#view');
  const tabs = $('#tabs');
  const y = view.scrollTop;
  if (!S.onboarded) {
    if (!ui.ob) ui.ob = { step: 0, persons: [newDraft(), newDraft()], staples: [], errs: null };
    view.innerHTML = viewOnboarding();
    tabs.hidden = true;
  } else {
    view.innerHTML = VIEWS[ui.tab]();
    const n = S.menu.length ? L.shopping(S.menu, S.people, S.stock).items.length : 0;
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
    <div class="sheet-panel ${ui.sheet.type === 'recipe' ? 'tall' : ''}" role="dialog" aria-modal="true">
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
    if (!S.menu.includes(d.id)) S.menu.push(d.id);
    if (S.current === d.id) S.current = null;
    ui.anim = true; closeSheet(); commit({ sheet: false });
    toast('Ajoutée au menu · liste de courses mise à jour');
  },
  unmenu(d) { S.menu = S.menu.filter((x) => x !== d.id); closeSheet(); commit({ sheet: false }); },
  dislike(d) {
    S.disliked.push(d.id);
    if (S.current === d.id) S.current = null;
    closeSheet(); commit({ sheet: false }); toast('On ne te la proposera plus');
  },
  undislike() { S.disliked = []; commit(); toast('Recettes réaffichées'); },
  cook(d) {
    L.cook(S.stock, RECIPE_BY_ID[d.id], S.people);
    S.menu = S.menu.filter((x) => x !== d.id);
    S.history.push({ id: d.id, d: L.today(), t: Date.now() });
    if (S.history.length > 200) S.history = S.history.slice(-200);
    closeSheet(); commit({ sheet: false }); toast('Bon appétit ! Placard mis à jour');
  },

  // Courses
  check(d) { if (S.checked[d.id]) delete S.checked[d.id]; else S.checked[d.id] = true; commit(); },
  store() {
    const { items } = L.shopping(S.menu, S.people, S.stock);
    const any = items.some((it) => S.checked[it.id]);
    const bought = items.filter((it) => !any || S.checked[it.id]);
    for (const it of bought) L.addPacks(S.stock, it.id, it.packs);
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
  } else if (el.id === 'search') {
    const q = el.value.trim().toLowerCase();
    document.querySelectorAll('#search-list .row').forEach((r) => { r.hidden = !r.dataset.name.includes(q); });
  }
});

document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); });

render(true);

if (sync) {
  const tick = () => { if (document.visibilityState === 'visible') sync.pull(); };
  setInterval(tick, 4000);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', tick);
  tick();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
