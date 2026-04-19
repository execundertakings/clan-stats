'use strict';
// ── APES Clan Stats — Service Worker ─────────────────────────────────────────
// Strategy:
//   • App shell (index.html, icons, manifest) → Cache-first, update in background
//   • CDN assets (React, Babel, Tailwind, fonts) → Cache-first (long-lived)
//   • /api/* → Network-only (always fresh data)

const CACHE = 'apes-v1';

const PRECACHE = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

const CDN_HOSTS = [
  'unpkg.com',
  'cdn.tailwindcss.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ── Install: precache app shell ───────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { url, method } = e.request;
  const parsed = new URL(url);

  // API calls — always go to network, never cache
  if (parsed.pathname.startsWith('/api/')) {
    return; // let browser handle normally
  }

  // Only handle GET requests
  if (method !== 'GET') return;

  // CDN assets — cache-first (they're content-addressed / versioned)
  if (CDN_HOSTS.some(h => parsed.hostname.includes(h))) {
    e.respondWith(
      caches.match(e.request).then(hit => {
        if (hit) return hit;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // App shell — cache-first, revalidate in background (stale-while-revalidate)
  if (parsed.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const hit = await cache.match(e.request);
        const networkFetch = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => null);
        return hit || networkFetch;
      })
    );
  }
});
