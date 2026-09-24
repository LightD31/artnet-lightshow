// The app shell, kept so the page opens even while the server does not answer
// — a tablet reloading at the moment the show machine restarts gets the page
// and its "reconnecting" notice, and is back the moment the server is, rather
// than a browser error page that stays up until someone reloads it by hand.
//
// Network first, always: the server is on the same network, so the cached
// copy is only for when it cannot be reached, and a new build shows on the
// next load. Nothing under /api or /socket.io is ever cached — that is live
// state, and a stale answer from it would be worse than none.

const CACHE = 'lightshow-shell-v1';
const SHELL = [
  '/',
  '/style.css',
  '/app.bundle.js',
  '/theme.js',
  '/auth.js',
  '/toast.js',
  '/fonts/InterVariable.woff2',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(SHELL))
    .catch(() => { /* a missing file must not stop the worker installing */ })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  event.respondWith(fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Any page of the app is the app.
    if (request.mode === 'navigate') return (await caches.match('/')) || Response.error();
    return Response.error();
  }));
});
