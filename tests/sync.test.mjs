import test from 'node:test';
import assert from 'node:assert/strict';
import { merge3, eq } from '../js/merge.js';
import { createSync, genCode, normalizeCode, formatCode } from '../js/sync.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('merge3 : changements indépendants des deux côtés', () => {
  const b = { menu: ['a'], stock: { oignon: 8, riz: 1000 }, current: 'x', people: [{ id: 'p1', goal: 70, weighIns: [{ d: '1', w: 80 }] }] };
  const l = clone(b); l.menu.push('b'); l.stock.oignon = 6; l.people[0].weighIns.push({ d: '2', w: 79 });
  const r = clone(b); r.menu.push('c'); r.stock.oignon = 7; r.stock.pates = 500; r.current = 'y'; r.people[0].goal = 68;
  const m = merge3(b, l, r);
  assert.deepEqual(m.menu, ['a', 'c', 'b']);
  assert.equal(m.stock.oignon, 5); // -2 et -1 cumulés
  assert.equal(m.stock.pates, 500);
  assert.equal(m.current, 'y');
  assert.equal(m.people[0].goal, 68);
  assert.equal(m.people[0].weighIns.length, 2);
});

test('merge3 : suppressions et conflits', () => {
  const b = { menu: ['a', 'b'], stock: { coco: 100 }, checked: { x: true }, current: 'x' };
  const l = { menu: ['b'], stock: {}, checked: { x: true, y: true }, current: 'l' };
  const r = { menu: ['a', 'b', 'c'], stock: { coco: 100 }, checked: {}, current: 'r' };
  const m = merge3(b, l, r);
  assert.deepEqual(m.menu, ['b', 'c']);
  assert.deepEqual(m.stock, {});
  assert.deepEqual(m.checked, { y: true });
  assert.equal(m.current, 'r'); // conflit : le serveur l'emporte
  assert.ok(eq(merge3(b, b, r), r) && eq(merge3(b, l, b), l) && eq(merge3(b, l, l), l));
});

test('merge3 : une recette cuisinée deux fois le même jour reste deux entrées', () => {
  const b = { history: [] };
  const l = { history: [{ id: 'chili', d: '2026-11-15', t: 1 }] };
  const r = { history: [{ id: 'chili', d: '2026-11-15', t: 2 }] };
  assert.equal(merge3(b, l, r).history.length, 2);
});

// Faux serveur reproduisant supabase/schema.sql
function fakeServer() {
  const rows = new Map();
  let down = false;
  return {
    rows,
    setDown(v) { down = v; },
    rpc: async (fn, a) => {
      if (down) throw new Error('offline');
      const h = rows.get(a.p_code);
      if (fn === 'household_get') {
        if (!h) return { found: false };
        return h.rev <= a.p_rev ? { found: true, rev: h.rev } : { found: true, rev: h.rev, data: clone(h.data) };
      }
      if (a.p_rev === 0) {
        if (!h) { rows.set(a.p_code, { rev: 1, data: clone(a.p_data) }); return { ok: true, rev: 1 }; }
      } else if (h && h.rev === a.p_rev) { h.rev += 1; h.data = clone(a.p_data); return { ok: true, rev: h.rev }; }
      return h ? { ok: false, found: true, rev: h.rev, data: clone(h.data) } : { ok: false, found: false };
    },
  };
}

function phone(server, initial) {
  const dev = { S: clone(initial), meta: null };
  dev.sync = createSync({
    rpc: server.rpc,
    store: { load: () => dev.meta, save: (m) => { dev.meta = m && clone(m); } },
    getState: () => dev.S,
    setState: (s) => { dev.S = s; },
  });
  return dev;
}

const base = { menu: [], stock: {}, checked: {}, history: [], current: 'a', people: [{ id: 'p1', weighIns: [{ d: '1', w: 80 }] }] };

test('deux téléphones : création, adhésion, propagation', async () => {
  const srv = fakeServer();
  const A = phone(srv, base), B = phone(srv, { menu: [], stock: {}, people: [] });
  const code = await A.sync.create();
  assert.equal(code.length, 10);
  await B.sync.join(formatCode(code).toLowerCase());
  assert.deepEqual(B.S, A.S);

  A.S.current = 'b'; A.S.menu.push('chili');
  await A.sync.pushNow();
  await B.sync.pull();
  assert.equal(B.S.current, 'b');
  assert.deepEqual(B.S.menu, ['chili']);

  await assert.rejects(phone(srv, base).sync.join('ZZZZZZZZZZ'), /notfound/);
});

test('deux téléphones : modifications simultanées fusionnées sans perte', async () => {
  const srv = fakeServer();
  const A = phone(srv, base), B = phone(srv, {});
  await B.sync.join(await A.sync.create());
  A.S.menu.push('chili'); A.S.stock.oignon = 8;
  B.S.menu.push('carbo'); B.S.people[0].weighIns.push({ d: '2', w: 79 });
  await A.sync.pushNow();
  await B.sync.pushNow(); // conflit -> fusion -> nouvel envoi
  await A.sync.pull();
  assert.deepEqual(A.S, B.S);
  assert.deepEqual([...A.S.menu].sort(), ['carbo', 'chili']);
  assert.equal(A.S.stock.oignon, 8);
  assert.equal(A.S.people[0].weighIns.length, 2);
});

test('hors ligne : les changements partent au retour du réseau', async () => {
  const srv = fakeServer();
  const A = phone(srv, base), B = phone(srv, {});
  await B.sync.join(await A.sync.create());
  srv.setDown(true);
  A.S.menu.push('dahl');
  await A.sync.pushNow();
  assert.equal(A.sync.status().ok, false);
  B.S.menu.push('bolo');
  await B.sync.pushNow();
  srv.setDown(false);
  await A.sync.pull();
  await B.sync.pull();
  await A.sync.pull();
  assert.equal(A.sync.status().ok, true);
  assert.deepEqual(A.S, B.S);
  assert.deepEqual([...A.S.menu].sort(), ['bolo', 'dahl']);
});

test('quitter le foyer arrête la synchro, les données restent', async () => {
  const srv = fakeServer();
  const A = phone(srv, base);
  await A.sync.create();
  A.sync.leave();
  A.S.menu.push('x');
  await A.sync.pushNow();
  assert.equal(A.sync.status().code, null);
  assert.deepEqual([...srv.rows.values()][0].data.menu, []);
});

test('codes', () => {
  assert.match(genCode(), /^[A-HJKMNP-Z2-9]{10}$/);
  assert.equal(normalizeCode('abcde-fghjk '), 'ABCDEFGHJK');
  assert.equal(formatCode('ABCDEFGHJK'), 'ABCDE-FGHJK');
});
