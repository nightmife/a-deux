// Accès aux fonctions de l'appareil : stockage des photos (IndexedDB), réduction d'image, bip, écran allumé.

const open = () => new Promise((res, rej) => {
  const r = indexedDB.open('adeux', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('photos');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const write = async (fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction('photos', 'readwrite');
    fn(t.objectStore('photos'));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
};

// Photos du foyer : { recetteId: { ts, data (data URL JPEG) } }
export const photoDb = {
  async all() {
    const db = await open();
    return new Promise((res, rej) => {
      const out = {};
      const c = db.transaction('photos').objectStore('photos').openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (cur) { out[cur.key] = cur.value; cur.continue(); } else res(out);
      };
      c.onerror = () => rej(c.error);
    });
  },
  put: (id, v) => write((s) => s.put(v, id)),
  del: (id) => write((s) => s.delete(id)),
};

export const isPhotoData = (s) => typeof s === 'string' && s.startsWith('data:image/jpeg;base64,') && s.length < 260000;

// Recadre et compresse une photo en JPEG 800×600 (moins de 190 Ko en général).
export async function shrinkPhoto(file, w = 800, h = 600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('image'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const r = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * r, dh = img.naturalHeight * r;
    c.getContext('2d').drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    let data = c.toDataURL('image/jpeg', 0.72);
    if (data.length > 190000) data = c.toDataURL('image/jpeg', 0.5);
    if (!isPhotoData(data)) throw new Error('taille');
    return data;
  } finally { URL.revokeObjectURL(url); }
}

let audio = null;
// À appeler depuis un geste de l'utilisateur (iOS n'autorise le son qu'après un toucher).
export function primeAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch { /* pas de son disponible */ }
}

export function beep() {
  if (!audio) return;
  for (let i = 0; i < 4; i += 1) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880;
    o.connect(g); g.connect(audio.destination);
    const t = audio.currentTime + i * 0.4;
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.start(t); o.stop(t + 0.3);
  }
}

let lock = null;
export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) lock = await navigator.wakeLock.request('screen');
    else if (!on && lock) { await lock.release(); lock = null; }
  } catch { /* refusé ou non géré */ }
}
