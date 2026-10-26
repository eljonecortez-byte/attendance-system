// Service Worker for Employee Attendance Monitoring System
const CACHE_NAME = 'attendance-app-v1.1.0';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/auth.js',
  './js/sync.js',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg'
];

// Install Event - Pre-cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching offline assets');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up obsolete caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[SW] Removing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Cache-first strategy for local assets, Network-first for Google Apps Script API
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // If request is to Google Apps Script or external API, use network directly
  if (requestUrl.hostname.includes('script.google.com') || requestUrl.hostname.includes('googleapis.com')) {
    event.respondWith(
      fetch(event.request).catch((err) => {
        // Return a JSON offline error fallback
        return new Response(JSON.stringify({
          success: false,
          offline: true,
          error: 'Offline: Network request to Google Apps Script failed. Stored locally.'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Local assets: Stale-While-Revalidate / Cache First
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Optionally fetch updated version in background
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => { /* ignore background fetch errors when offline */ });

        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      }).catch(() => {
        // Fallback for HTML navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// Background Sync event (when connection resumes and browser supports Background Sync)
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
