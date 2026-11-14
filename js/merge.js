// Fusion à trois voies d'états JSON : base (dernier état synchronisé), local, distant.
// Sert à ne rien perdre quand les deux téléphones modifient le foyer en même temps.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function eq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => eq(a[k], b[k]));
  }
  return false;
}

// Identité d'un élément de liste : personne (id), recette cuisinée (t), pesée (d), sinon sa valeur.
const keyOf = (x) => (isObj(x) ? String(x.id && x.t ? x.t : x.id ?? x.t ?? x.d ?? JSON.stringify(x)) : `=${x}`);

function mergeArr(b, l, r) {
  const idx = (arr) => new Map(arr.map((x) => [keyOf(x), x]));
  const B = idx(b), Lm = idx(l), Rm = idx(r);
  const out = [];
  for (const [k, rv] of Rm) {
    if (Lm.has(k)) out.push(merge3(B.get(k), Lm.get(k), rv));
    else if (!B.has(k)) out.push(rv); // ajouté à distance (sinon : supprimé en local)
  }
  for (const [k, lv] of Lm) if (!Rm.has(k) && !B.has(k)) out.push(lv); // ajouté en local
  return out;
}

export function merge3(b, l, r, key = '') {
  if (eq(l, r)) return l;
  if (eq(l, b)) return r;
  if (eq(r, b)) return l;
  if (Array.isArray(l) && Array.isArray(r)) return mergeArr(Array.isArray(b) ? b : [], l, r);
  if (isObj(l) && isObj(r)) {
    const bb = isObj(b) ? b : {};
    const out = {};
    for (const k of new Set([...Object.keys(r), ...Object.keys(l)])) {
      let v;
      if (key === 'stock') {
        // Quantités : on additionne les variations des deux côtés.
        const b0 = bb[k] || 0;
        const q = b0 + ((l[k] || 0) - b0) + ((r[k] || 0) - b0);
        v = q > 1e-9 ? q : undefined;
      } else v = merge3(bb[k], l[k], r[k], k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return r; // même champ modifié des deux côtés : le serveur l'emporte
}
