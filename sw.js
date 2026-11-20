// Service Worker for CocoTrack Attendance System (v3)
// Strategy: NETWORK FIRST with a 3.5-second timeout for the app's own files.
//   - Good signal: loads the latest version from GitHub, then saves a copy.
//   - Weak / no signal: after 3.5 s it opens the saved copy instead of hanging.
// Bump CACHE_NAME only if you rename or remove files.
const CACHE_NAME = 'cocotrack-v3.2.0';
const NETWORK_TIMEOUT_MS = 3500;

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/auth.js',
  './js/api.js',
  './js/sync.js',
  './js/camera.js',
  './js/app.js',
  './manifest.json',
  './icons/logo-full.png',
  './icons/logo-emblem.png',
  './icons/favicon-64.png',
  './icons/app-icon-192.png',
  './icons/app-icon-512.png',
  './icons/app-icon-maskable-192.png',
  './icons/app-icon-maskable-512.png',
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

  // App files: NETWORK FIRST with timeout, fall back to saved copy
  event.respondWith(networkFirstWithTimeout(request));
});

function fromCache(request) {
  return caches.match(request, { ignoreSearch: true }).then((cached) => {
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match('./index.html');
    return null;
  });
}

function networkFirstWithTimeout(request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (resp) => { if (!settled && resp) { settled = true; resolve(resp); } };

    const network = fetch(request.url, { cache: 'no-cache' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return cleanResponse(networkResponse);
      });

    // Slow network: serve the saved copy (the network result still refreshes the cache)
    const timer = setTimeout(() => {
      fromCache(request).then(finish);
    }, NETWORK_TIMEOUT_MS);

    network
      .then((resp) => { clearTimeout(timer); finish(resp); })
      .catch(() => {
        clearTimeout(timer);
        fromCache(request).then((cached) => finish(cached || new Response('', { status: 504, statusText: 'Offline' })));
      });
  });
}

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
