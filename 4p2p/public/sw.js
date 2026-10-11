/* Minimal service worker: makes the installed app show a friendly offline page instead of a browser error.
   It caches nothing else, so game files are always fetched fresh from the server. */
const OFFLINE_URL = '/offline.html';
self.addEventListener('install', e => { e.waitUntil(caches.open('k28-offline-v1').then(c => c.add(OFFLINE_URL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE_URL)));
});
