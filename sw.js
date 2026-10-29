// Service Worker for Employee Attendance Monitoring System
// Strategy: NETWORK FIRST for the app's own files.
//   - Online: always loads the latest version from GitHub, then saves a copy.
//   - Offline: falls back to the saved copy.
// You no longer need to change the version number for updates to show up.
const CACHE_NAME = 'attendance-app-v2.0.0';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/auth.js',
  './js/sync.js',
  './js/app.js',
  './manifest.json',
  './icons/logo-full.png',
  './icons/logo-emblem.png',
  './icons/favicon-64.png',
  './icons/app-icon-192.png',
  './icons/apple-touch-icon-v2.png'
];

// Install: save core files one by one, so a single missing file
// (e.g. an icon) doesn't stop the whole update from installing.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS_TO_CACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[SW] Could not cache', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// Activate: delete old caches and take control right away
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Removing old cache:', name);
            return caches.delete(name);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// Some browsers (Safari) refuse redirected responses for page loads,
// so copy them into a clean response.
function cleanResponse(response) {
  if (!response.redirected) return Promise.resolve(response);
  return response.blob().then((body) =>
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);

  // Google Apps Script / Google APIs: network only, with offline JSON fallback
  if (requestUrl.hostname.includes('script.google.com') || requestUrl.hostname.includes('googleapis.com')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({
          success: false,
          offline: true,
          error: 'Offline: Network request to Google Apps Script failed. Stored locally.'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Other outside sites: leave alone
  if (requestUrl.origin !== self.location.origin) return;

  // App files: NETWORK FIRST, fall back to saved copy when offline
  event.respondWith(
    fetch(request.url, { cache: 'no-cache' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return cleanResponse(networkResponse);
      })
      .catch(() =>
        caches.match(request, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 504, statusText: 'Offline' });
        })
      )
  );
});

// Background Sync (when connection resumes and browser supports it)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-attendance') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'TRIGGER_AUTO_SYNC' });
        });
      })
    );
  }
});
