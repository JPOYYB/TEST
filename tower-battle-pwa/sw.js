// Simple cache-first service worker for Tower Battle (PWA)
const CACHE_NAME = 'towerbattle-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './config/config.json',
  './config/assets.json',
  './js/main.js',
  './js/loader.js',
  './js/ranking.js',
  './js/util.js',
  './js/outline.js',
  './js/towerbattle.js',
  './assets/ui/title_logo.png',
  './assets/ui/title_bg.png',
  './assets/ui/icon-192.png',
  './assets/ui/icon-512.png',
];

// On install, cache core. Animals are cached lazily on fetch.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_NAME) ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try{
      const res = await fetch(req);
      // Cache successful same-origin responses
      const url = new URL(req.url);
      if (res.ok && url.origin === location.origin){
        cache.put(req, res.clone());
      }
      return res;
    }catch(err){
      // Offline fallback to cached shell
      const fallback = await cache.match('./index.html');
      return fallback || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' }});
    }
  })());
});
