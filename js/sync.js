// Moteur de synchronisation : pousse l'état local, récupère l'état distant, fusionne en cas de conflit.
// Indépendant du DOM et du réseau (rpc et store sont injectés) pour pouvoir être testé.
import { eq, merge3 } from './merge.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const clone = (x) => JSON.parse(JSON.stringify(x));

export const normalizeCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (c) => (c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c);
export function genCode(rand = (n) => crypto.getRandomValues(new Uint32Array(n))) {
  return [...rand(10)].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}

export function createSync({ rpc, store, getState, setState, onStatus = () => {} }) {
  let meta = store.load(); // { code, rev, base } ou null
  let chain = Promise.resolve();
  let ok = true;
  let debounce = null;

  const persist = () => store.save(meta);
  const run = (fn) => {
    const p = chain.then(() => fn());
    chain = p.catch(() => {});
    return p;
  };
  const report = (state) => { if (ok !== state) { ok = state; onStatus(); } };
  const tracked = (fn) => run(fn).then(() => report(true), () => report(false));

  // Intègre un état distant ; renvoie true s'il reste des changements locaux à pousser.
  function reconcile(data, rev) {
    const local = getState();
    const merged = merge3(meta.base, local, data);
    meta.base = clone(data);
    meta.rev = rev;
    persist();
    if (!eq(merged, local)) setState(clone(merged));
    return !eq(getState(), data);
  }

  async function pushOnce(depth = 0) {
    if (!meta) return;
    const local = clone(getState());
    if (eq(local, meta.base)) return;
    const res = await rpc('household_put', { p_code: meta.code, p_data: local, p_rev: meta.rev });
    if (!meta) return;
    if (res.ok) { meta.rev = res.rev; meta.base = local; persist(); return; }
    if (!res.found) { // foyer supprimé côté serveur : on le recrée
      const c = await rpc('household_put', { p_code: meta.code, p_data: local, p_rev: 0 });
      if (c.ok && meta) { meta.rev = c.rev; meta.base = local; persist(); }
      return;
    }
    if (reconcile(res.data, res.rev) && depth < 5) await pushOnce(depth + 1);
  }

  async function pullOnce() {
    if (!meta) return;
    const res = await rpc('household_get', { p_code: meta.code, p_rev: meta.rev });
    if (!meta) return;
    if (!res.found) { meta.rev = 0; meta.base = null; await pushOnce(); return; }
    if (res.data ? reconcile(res.data, res.rev) : !eq(getState(), meta.base)) await pushOnce();
  }

  return {
    status: () => ({ code: meta?.code || null, ok }),
    // Crée un foyer partagé à partir de l'état local.
    create: () => run(async () => {
      const local = clone(getState());
      for (let i = 0; i < 3; i += 1) {
        const code = genCode();
        const res = await rpc('household_put', { p_code: code, p_data: local, p_rev: 0 });
        if (res.ok) { meta = { code, rev: res.rev, base: local }; persist(); report(true); onStatus(); return code; }
      }
      throw new Error('create');
    }),
    // Rejoint un foyer existant : l'état distant remplace l'état local.
    join: (raw) => run(async () => {
      const code = normalizeCode(raw);
      if (code.length < 8) throw new Error('notfound');
      const res = await rpc('household_get', { p_code: code, p_rev: 0 });
      if (!res.found) throw new Error('notfound');
      meta = { code, rev: res.rev, base: clone(res.data) };
      persist();
      setState(clone(res.data));
      report(true); onStatus();
      return code;
    }),
    leave() { meta = null; clearTimeout(debounce); persist(); onStatus(); },
    // À appeler après chaque changement local.
    push() {
      if (!meta) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => tracked(pushOnce), 300);
    },
    pushNow: () => tracked(pushOnce),
    pull: () => (meta ? tracked(pullOnce) : Promise.resolve()),
  };
}
