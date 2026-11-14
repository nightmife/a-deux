import test from 'node:test';
import assert from 'node:assert/strict';
import { INGREDIENTS as ING, RECIPES, RECIPE_BY_ID, CATS, EQUIPMENT, BOOST_CAP } from '../js/data.js';
import * as L from '../js/logic.js';

const lui = { id: 'a', name: 'Lui', sex: 'm', age: 20, height: 180, weight: 90, goal: 78, activity: 'leger', appetite: 'gros', weighIns: [{ d: '2026-11-01', w: 90 }] };
const elle = { id: 'b', name: 'Elle', sex: 'f', age: 20, height: 165, weight: 50, goal: 56, activity: 'leger', appetite: 'petit', weighIns: [{ d: '2026-11-01', w: 50 }] };
const people = [lui, elle];

test('données cohérentes', () => {
  const ids = new Set();
  for (const r of RECIPES) {
    assert.ok(!ids.has(r.id), `id en double ${r.id}`);
    ids.add(r.id);
    assert.ok(r.steps.length >= 3, r.id);
    assert.ok(ING[r.boost] && BOOST_CAP[r.boost], `boost ${r.id}`);
    for (const g of r.equip) for (const e of g) assert.ok(EQUIPMENT[e], `équipement ${e} (${r.id})`);
  }
  for (const [id, i] of Object.entries(ING)) {
    assert.ok(CATS[i.cat], id);
    assert.ok(i.pack > 0 && i.pr > 0, id);
  }
  const used = new Set(RECIPES.flatMap((r) => [...r.ing.map((i) => i.id), r.boost]));
  for (const id of Object.keys(ING)) assert.ok(used.has(id), `ingrédient inutilisé ${id}`);
});

test('objectifs : déficit pour lui, surplus pour elle', () => {
  const a = L.targets(lui), b = L.targets(elle);
  assert.equal(a.mode, 'loss');
  assert.equal(b.mode, 'gain');
  assert.ok(a.kcal < a.tdee && a.kcal >= 1500);
  assert.ok(b.kcal > b.tdee);
});

test('chaque recette colle à la cible calorique de chacun', () => {
  const bad = [];
  for (const r of RECIPES) {
    for (const p of people) {
      const po = L.portion(r, p);
      const ecart = po.kcal / po.target - 1;
      if (Math.abs(ecart) > 0.08) bad.push(`${r.id} ${p.name} ${Math.round(po.kcal)}/${Math.round(po.target)}`);
      for (const it of po.items) assert.ok(it.q > 0 && Number.isFinite(it.q));
    }
  }
  assert.deepEqual(bad, []);
});

test('protéines suffisantes par repas (perte de poids)', () => {
  const low = RECIPES.filter((r) => L.portion(r, lui).prot < 25).map((r) => `${r.id} ${Math.round(L.portion(r, lui).prot)}`);
  assert.deepEqual(low, []);
});

test('placard : les oignons achetés servent aux recettes suivantes', () => {
  const stock = {};
  const menu = ['curry-poulet'];
  const s1 = L.shopping(menu, people, stock);
  const o = s1.items.find((i) => i.id === 'oignon');
  assert.equal(o.packs, 1);
  for (const it of s1.items) L.addPacks(stock, it.id, it.packs);
  assert.equal(stock.oignon, 8);
  assert.equal(L.shopping(menu, people, stock).items.length, 0);

  L.cook(stock, RECIPE_BY_ID['curry-poulet'], people);
  assert.ok(stock.oignon < 8 && stock.oignon > 0);
  assert.ok(!('poulet' in stock) || stock.poulet < 500);

  const s2 = L.shopping(['chili'], people, stock);
  assert.ok(!s2.items.some((i) => i.id === 'oignon'), 'oignons déjà au placard');
  assert.ok(!s2.items.some((i) => i.id === 'riz'), 'riz déjà au placard');
});

test('un ingrédient fini disparaît du placard', () => {
  const r = RECIPE_BY_ID['curry-poulet'];
  const n = L.needs(r, people);
  const stock = { coco: n.coco };
  L.cook(stock, r, people);
  assert.ok(!('coco' in stock));
});

test('matériel et exclusions respectés', () => {
  const base = { people, stock: {}, menu: [], history: [], disliked: [] };
  const sansFour = L.rankRecipes({ ...base, equip: ['pl'], avoid: [] }, () => 0);
  assert.ok(!sansFour.includes('legumes-rotis'));
  assert.ok(sansFour.includes('curry-poulet'));
  const airfryer = L.rankRecipes({ ...base, equip: ['pl', 'af'], avoid: ['porc'] }, () => 0);
  assert.ok(airfryer.includes('legumes-rotis'));
  assert.ok(!airfryer.includes('carbo'));
  const vege = L.rankRecipes({ ...base, equip: ['pl', 'af'], avoid: ['viande', 'poisson'] }, () => 0);
  assert.ok(vege.length >= 8 && !vege.includes('curry-poulet') && !vege.includes('pates-thon'));
});

test('les restes du menu font remonter les recettes qui les utilisent', () => {
  const base = { people, equip: ['pl', 'af'], avoid: [], history: [], disliked: [] };
  const vide = L.rankRecipes({ ...base, stock: {}, menu: [] }, () => 0);
  const avec = L.rankRecipes({ ...base, stock: {}, menu: ['curry-poulet'] }, () => 0);
  assert.ok(avec.indexOf('curry-colin') < vide.indexOf('curry-colin'));
});

test('pesées et progression', () => {
  const p = structuredClone(lui);
  L.addWeighIn(p, 88, '2026-11-10');
  assert.equal(p.weight, 88);
  const pr = L.progress(p);
  assert.ok(Math.abs(pr.pct - 2 / 12) < 1e-9);
  L.addWeighIn(p, 87.5, '2026-11-10');
  assert.equal(p.weighIns.length, 2);
  L.removeWeighIn(p, '2026-11-10');
  assert.equal(p.weight, 90);
});

test('formatage', () => {
  assert.equal(L.fmtQty('oignon', 1.5), '1½');
  assert.equal(L.fmtQty('ail', 2), '2 gousses');
  assert.equal(L.fmtQty('huile', 15), '1 c. à s.');
  assert.equal(L.fmtQty('curry', 2.5), '1 c. à c.');
  assert.equal(L.fmtQty('riz', 150), '150 g');
  assert.equal(L.fmtStock('pdt', 2500), '2,5 kg');
  assert.equal(L.euro(2.5), '2,50 €');
});

test('menu de la semaine : varié, sans doublon, frais en premier, moins cher que des recettes prises au hasard', () => {
  const state = { people, equip: ['pl', 'af', 'mo'], avoid: [], stock: {}, menu: ['carbo'], history: [], disliked: ['chili'] };
  const menu = L.planMenu(state, 7, () => 0.5);
  assert.equal(menu.length, 7);
  assert.equal(new Set(menu).size, 7);
  assert.ok(menu.includes('carbo') && !menu.includes('chili'));
  const fresh = menu.map((id) => L.isFresh(RECIPE_BY_ID[id]));
  assert.ok(fresh.indexOf(false) === -1 || fresh.lastIndexOf(true) < fresh.indexOf(false));
  for (const id of menu) assert.ok(L.recipeAllowed(RECIPE_BY_ID[id], state.equip, state.avoid));
  const proteins = menu.map((id) => RECIPE_BY_ID[id].ing.find((i) => i.role === 'p')?.id);
  assert.ok(Math.max(...Object.values(Object.groupBy(proteins, (p) => p)).map((g) => g.length)) <= 3);
  const cost = L.shopping(menu, people, {}).total;
  const naive = L.shopping(RECIPES.filter((r) => L.recipeAllowed(r, state.equip, [])).slice(0, 7).map((r) => r.id), people, {}).total;
  assert.ok(cost < naive, `${cost} < ${naive}`);
  assert.equal(L.planMenu({ ...state, avoid: ['viande', 'poisson'] }, 14, () => 0.5).length, 14);
});

test('plats assemblés : proportions gardées (2 tranches de pain par croque)', () => {
  const n = L.needs(RECIPE_BY_ID.croque, people);
  assert.equal(n.painmie, 2 * n.jambon);
  assert.equal(n.jambon, n.cheddar);
  assert.ok(n.painmie <= 10);
  const b = L.needs(RECIPE_BY_ID.burger, people);
  assert.equal(b.painburger, 2);
});
