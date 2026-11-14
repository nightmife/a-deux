// Logique pure (sans DOM) : besoins caloriques, portions, placard, courses, suggestions.
import { INGREDIENTS as ING, RECIPES, RECIPE_BY_ID, AVOID, BOOST_CAP, CATS } from './data.js';

export const ACTIVITY = {
  sed: { n: 'Sédentaire (peu de marche)', f: 1.2 },
  leger: { n: 'Un peu actif (1-2 sports/sem.)', f: 1.375 },
  modere: { n: 'Actif (3-5 sports/sem.)', f: 1.55 },
  intense: { n: 'Très actif (sport quotidien)', f: 1.725 },
};

export const MEAL_SHARE = 0.35; // part des calories du jour dans un repas principal

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function mode(p) {
  const d = p.goal - p.weight;
  return d < -0.5 ? 'loss' : d > 0.5 ? 'gain' : 'keep';
}

// Mifflin-St Jeor + facteur d'activité.
export function targets(p) {
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'm' ? 5 : -161);
  const tdee = bmr * (ACTIVITY[p.activity] || ACTIVITY.leger).f;
  const m = mode(p);
  let kcal = tdee;
  if (m === 'loss') kcal = Math.max(tdee * 0.8, p.sex === 'm' ? 1500 : 1200);
  if (m === 'gain') kcal = tdee + 350;
  kcal = Math.round(kcal / 10) * 10;
  const prot = Math.round(p.weight * { loss: 1.8, gain: 1.6, keep: 1.4 }[m]);
  return { mode: m, kcal, prot, meal: kcal * MEAL_SHARE, tdee: Math.round(tdee) };
}

export function bmi(weight, heightCm) {
  const h = heightCm / 100;
  return weight / (h * h);
}

export const kcalOf = (id, q) => (ING[id].u === 'pc' ? ING[id].k * q : (ING[id].k * q) / 100);
export const protOf = (id, q) => (ING[id].u === 'pc' ? ING[id].p * q : (ING[id].p * q) / 100);

const sumKcal = (items) => items.reduce((s, it) => s + kcalOf(it.id, it.q), 0);

const MULT = {
  loss: { p: 1.2, f: 0.7, o: 1, v: { petit: 1.1, normal: 1.4, gros: 1.8 } },
  gain: { p: 1, f: 1.25, o: 1, v: { petit: 0.7, normal: 0.9, gros: 1.1 } },
  keep: { p: 1, f: 1, o: 1, v: { petit: 0.9, normal: 1, gros: 1.3 } },
};

// Portion d'une personne pour une recette : même plat, quantités adaptées à son objectif.
// L'appétit joue sur le volume (légumes), pas sur les calories.
export function portion(recipe, person) {
  const t = targets(person);
  const mu = MULT[t.mode];
  const app = person.appetite || 'normal';
  const T = t.meal;

  let items = recipe.ing.map(({ id, q, role }) => {
    let f = 1;
    if (role === 'v') f = mu.v[app];
    else if (recipe.whole) f = 1;
    else if (role === 'f') f = t.mode === 'gain' && app === 'petit' ? 1.4 : mu.f;
    else if (role !== 'c') f = mu[role] ?? 1;
    return { id, role, q: q * f };
  });

  // Les féculents comblent l'écart avec la cible.
  const carbs = items.filter((it) => it.role === 'c');
  const carbK = sumKcal(carbs);
  if (carbK > 0 && !recipe.whole) {
    const fixed = sumKcal(items) - carbK;
    const cf = clamp((T - fixed) / carbK, 0.5, 1.7);
    carbs.forEach((it) => { it.q *= cf; });
  }

  let total = sumKcal(items);
  if (total > T * 1.03) {
    const s = Math.max(0.6, T / total);
    items.forEach((it) => { it.q *= s; });
  } else if (total < T * 0.97) {
    let boostK = 0;
    if (t.mode === 'gain' && recipe.boost) {
      const b = recipe.boost;
      const dens = kcalOf(b, 1);
      const q = Math.min(BOOST_CAP[b] ?? 15, (T - total) / dens);
      if (q * dens >= 25) {
        items.push({ id: b, role: 'f', q, boost: true });
        boostK = q * dens;
      }
    }
    if (total + boostK < T * 0.97) {
      const s = Math.min(recipe.whole ? 2 : 1.6, (T - boostK) / total);
      items.forEach((it) => { if (!it.boost) it.q *= s; });
    }
  }

  return {
    items,
    kcal: sumKcal(items),
    prot: items.reduce((s, it) => s + protOf(it.id, it.q), 0),
    target: T,
  };
}

// Arrondi "cuisine" d'une quantité.
export function roundQty(id, q) {
  const ing = ING[id];
  if (ing.u === 'pc') {
    const step = ing.step || 0.5;
    return Math.max(step, Math.round(q / step) * step);
  }
  if (ing.sp) return Math.max(1, Math.round(q));
  if (q < 50) return Math.max(5, Math.round(q / 5) * 5);
  return Math.round(q / 10) * 10;
}

// Quantités totales à cuisiner pour tout le foyer : { id: quantité }.
export function needs(recipe, people) {
  const raw = {};
  for (const p of people) {
    for (const it of portion(recipe, p).items) raw[it.id] = (raw[it.id] || 0) + it.q;
  }
  const out = {};
  for (const id of Object.keys(raw)) {
    let q = roundQty(id, raw[id]);
    // Si on dépasse de peu un nombre entier de paquets, on s'y limite : pas de paquet entamé pour 50 g.
    const { u, sp, pack } = ING[id];
    const k = Math.floor(q / pack);
    if (u !== 'pc' && !sp && k >= 1 && q - k * pack <= pack * 0.12) q = k * pack;
    out[id] = q;
  }
  return out;
}

export function menuNeeds(menuIds, people) {
  const total = {};
  for (const rid of menuIds) {
    const r = RECIPE_BY_ID[rid];
    if (!r) continue;
    const n = needs(r, people);
    for (const id of Object.keys(n)) total[id] = (total[id] || 0) + n[id];
  }
  return total;
}

const EPS = 1e-6;
const CAT_ORDER = Object.keys(CATS);

// Liste de courses : ce qui manque au placard, converti en paquets vendus.
export function shopping(menuIds, people, stock) {
  const need = menuNeeds(menuIds, people);
  const items = [];
  for (const id of Object.keys(need)) {
    const have = stock[id] || 0;
    const miss = need[id] - have;
    if (miss <= EPS) continue;
    const ing = ING[id];
    const packs = Math.ceil(miss / ing.pack - EPS);
    items.push({
      id, need: need[id], have, packs,
      cost: packs * ing.pr,
      left: have + packs * ing.pack - need[id],
    });
  }
  items.sort((a, b) => CAT_ORDER.indexOf(ING[a.id].cat) - CAT_ORDER.indexOf(ING[b.id].cat)
    || ING[a.id].n.localeCompare(ING[b.id].n, 'fr'));
  return { items, total: items.reduce((s, it) => s + it.cost, 0) };
}

// Ce qu'il restera au placard une fois le menu acheté et cuisiné.
export function leftovers(menuIds, people, stock) {
  const need = menuNeeds(menuIds, people);
  const out = { ...stock };
  for (const id of Object.keys(need)) {
    const have = stock[id] || 0;
    const miss = need[id] - have;
    const packs = miss > EPS ? Math.ceil(miss / ING[id].pack - EPS) : 0;
    out[id] = have + packs * ING[id].pack - need[id];
  }
  return out;
}

// Coût réel du repas (au prorata de ce qui est utilisé), pour tout le foyer.
export function mealCost(recipe, people) {
  const n = needs(recipe, people);
  return Object.keys(n).reduce((s, id) => s + (n[id] / ING[id].pack) * ING[id].pr, 0);
}

export function addPacks(stock, id, packs = 1) {
  stock[id] = (stock[id] || 0) + packs * ING[id].pack;
}

// Retire du placard ce que la recette consomme ; un ingrédient fini disparaît.
export function cook(stock, recipe, people) {
  const n = needs(recipe, people);
  for (const id of Object.keys(n)) {
    if (!(id in stock)) continue;
    const rest = stock[id] - n[id];
    if (rest <= ING[id].pack * 0.02) delete stock[id];
    else stock[id] = rest;
  }
}

export function recipeAllowed(recipe, equip, avoid) {
  if (!recipe.equip.every((g) => g.some((e) => equip.includes(e)))) return false;
  const banned = new Set(avoid.flatMap((a) => AVOID[a]?.kinds || []));
  return !recipe.ing.some((it) => banned.has(ING[it.id].kind));
}

const mainProtein = (r) => (r.ing.find((it) => it.role === 'p') || r.ing[0]).id;

// Recettes proposables, de la plus intéressante à la moins intéressante :
// peu à acheter, utilise les restes du placard, pas cuisinée récemment.
export function rankRecipes(state, rng = Math.random) {
  const { people, equip, avoid, stock, menu, history, disliked } = state;
  const rest = leftovers(menu, people, stock);
  const menuProteins = menu.map((id) => RECIPE_BY_ID[id]).filter(Boolean).map(mainProtein);
  const recent = history.slice(-8).map((h) => h.id).reverse();

  return RECIPES
    .filter((r) => !menu.includes(r.id) && !disliked.includes(r.id) && recipeAllowed(r, equip, avoid))
    .map((r) => {
      const n = needs(r, people);
      const buy = shopping([r.id], people, rest).total;
      const reused = Object.keys(n).filter((id) => !ING[id].staple && (rest[id] || 0) >= n[id]).length;
      const ri = recent.indexOf(r.id);
      const score = buy
        + 0.5 * (mealCost(r, people) / people.length)
        - 0.4 * reused
        + (ri >= 0 ? 4 - 0.4 * ri : 0)
        + 1.5 * menuProteins.filter((p) => p === mainProtein(r)).length
        + rng() * 1.5;
      return { id: r.id, score };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.id);
}

// Viande et poisson frais : à cuisiner dans les premiers jours après les courses.
const FRESH = new Set(['poulet', 'dinde', 'hache', 'saumon', 'chipo']);
export const isFresh = (recipe) => recipe.ing.some((it) => FRESH.has(it.id));

// Complète le menu jusqu'à n repas : plats variés, qui réutilisent les mêmes paquets. Les plats frais en premier.
export function planMenu(state, n, rng = Math.random) {
  const menu = [...state.menu];
  while (menu.length < n) {
    const pick = rankRecipes({ ...state, menu }, rng)[0];
    if (!pick) break;
    menu.push(pick);
  }
  const fresh = (id) => (RECIPE_BY_ID[id] && isFresh(RECIPE_BY_ID[id]) ? 0 : 1);
  return menu.map((id, i) => [id, i]).sort((a, b) => fresh(a[0]) - fresh(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

// ---------- Suivi du poids ----------

export function addWeighIn(person, w, d) {
  const i = person.weighIns.findIndex((x) => x.d === d);
  if (i >= 0) person.weighIns[i].w = w;
  else person.weighIns.push({ d, w });
  person.weighIns.sort((a, b) => a.d.localeCompare(b.d));
  person.weight = person.weighIns[person.weighIns.length - 1].w;
}

export function removeWeighIn(person, d) {
  if (person.weighIns.length <= 1) return;
  person.weighIns = person.weighIns.filter((x) => x.d !== d);
  person.weight = person.weighIns[person.weighIns.length - 1].w;
}

export function progress(person) {
  const start = person.weighIns[0]?.w ?? person.weight;
  const total = person.goal - start;
  const done = person.weight - start;
  const pct = Math.abs(total) < 0.05 ? 1 : clamp(done / total, 0, 1);
  return { start, total, done, pct, left: person.goal - person.weight };
}

// ---------- Affichage des quantités ----------

const FRAC = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
export function frac(x) {
  const r = Math.round(x * 4) / 4;
  const whole = Math.floor(r);
  const f = FRAC[r - whole] || '';
  if (!f) return String(whole);
  return whole ? `${whole}${f}` : f;
}

const num = (x) => String(Math.round(x * 10) / 10).replace('.', ',');

function metric(u, q) {
  if (q >= 1000) return `${num(q / 1000)} ${u === 'g' ? 'kg' : 'L'}`;
  return `${Math.round(q)} ${u}`;
}

// Quantité dans une recette ("2 gousses", "1 c. à s.", "150 g").
export function fmtQty(id, q) {
  const ing = ING[id];
  if (ing.u === 'pc') {
    const r = Math.max(0.25, Math.round(q * 4) / 4);
    return ing.un ? `${frac(r)} ${ing.un}${r >= 2 ? 's' : ''}` : frac(r);
  }
  if (ing.sp && q <= 60) {
    const tsp = q / ing.sp;
    if (tsp >= 2.5) return `${frac(Math.max(1, Math.round((tsp / 3) * 2) / 2))} c. à s.`;
    return `${frac(Math.max(0.5, Math.round(tsp * 2) / 2))} c. à c.`;
  }
  return metric(ing.u, q);
}

// Quantité au placard ("≈ 600 g", "6 pièces").
export function fmtStock(id, q) {
  const ing = ING[id];
  if (ing.u === 'pc') {
    const r = Math.round(q * 2) / 2;
    const un = ing.un || 'pièce';
    return `${frac(r)} ${un}${r >= 2 ? 's' : ''}`;
  }
  return metric(ing.u, q);
}

export const euro = (x) => `${x.toFixed(2).replace('.', ',')} €`;

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
