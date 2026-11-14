// Hors-ligne : réseau d'abord pour le code (mises à jour immédiates), cache d'abord pour les images.
const CACHE = 'adeux-v3';
const CORE = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/logic.js', 'js/data.js', 'js/photos.js', 'js/config.js', 'js/sync.js', 'js/merge.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const put = (res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  };
  if (/\.(jpg|png|webp)$/.test(new URL(req.url).pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(put)));
  } else {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || caches.match('index.html'))));
  }
});
