/**
 * Service Worker — Metronome Playlist
 *
 * Strategy:
 *   - On every fetch, serve from the cache immediately (cache-first).
 *   - In parallel with the page load, attempt to fetch version.json with a
 *     3-second timeout.  If the version has changed (or no cached version is
 *     stored yet), open a new versioned cache, delete the old one, and populate
 *     the new cache by re-fetching every request that was already in the old
 *     cache plus any new requests that come in.
 *   - All network responses (local files AND external CDN resources) are added
 *     to the cache automatically as they are fetched, so nothing needs to be
 *     listed explicitly.
 *   - If version.json is unreachable or the fetch times out, everything keeps
 *     being served from the existing cache without any disruption.
 */

const CACHE_PREFIX = 'metronome-playlist-';
const VERSION_URL  = '/version.json';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the name of whichever cache exists right now, or null. */
async function currentCacheName() {
  const keys = await caches.keys();
  return keys.find(k => k.startsWith(CACHE_PREFIX)) ?? null;
}

/**
 * Fetch version.json from the network with a 3-second timeout.
 * Returns the parsed object, or null on failure / timeout.
 */
async function fetchVersionWithTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(VERSION_URL, {
      signal: controller.signal,
      cache:  'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Open a new versioned cache, copy all entries from the old cache into it,
 * then delete the old cache.
 */
async function migrateCacheTo(newCacheName) {
  const oldName = await currentCacheName();
  const newCache = await caches.open(newCacheName);

  if (oldName && oldName !== newCacheName) {
    const oldCache = await caches.open(oldName);
    const requests = await oldCache.keys();
    await Promise.all(
      requests.map(async req => {
        const res = await oldCache.match(req);
        if (res) await newCache.put(req, res);
      })
    );
    await caches.delete(oldName);
  }
}

// ─── Install ─────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  // Activate the new SW immediately without waiting for old tabs to close.
  self.skipWaiting();
});

// ─── Activate ────────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Take control of all open clients immediately.
      await clients.claim();

      // Bootstrap: fetch version.json to establish the initial cache name.
      const versionData = await fetchVersionWithTimeout();
      if (versionData?.version) {
        const desired = CACHE_PREFIX + versionData.version;
        const current = await currentCacheName();
        if (current !== desired) {
          await migrateCacheTo(desired);
        }
      }
    })()
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  // Only handle GET requests.
  if (event.request.method !== 'GET') return;

  // Never cache the version check itself, so we always get the latest.
  if (new URL(event.request.url).pathname === VERSION_URL) return;

  event.respondWith(
    (async () => {
      const cacheName = (await currentCacheName()) ?? (CACHE_PREFIX + 'default');
      const cache     = await caches.open(cacheName);
      const cached    = await cache.match(event.request);

      if (cached) {
        // Serve from cache, then re-fetch in the background to stay fresh.
        event.waitUntil(
          fetch(event.request)
            .then(res => { if (res && res.ok) cache.put(event.request, res); })
            .catch(() => {/* offline — ignore */})
        );
        return cached;
      }

      // Not in cache yet — fetch from network, cache, and return.
      try {
        const res = await fetch(event.request);
        if (res && res.ok) {
          cache.put(event.request, res.clone());
        }
        return res;
      } catch {
        // No network and no cache — nothing we can do.
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })()
  );
});

// ─── Version-check message ───────────────────────────────────────────────────

/**
 * Periodically (when the page sends a 'CHECK_VERSION' message), check whether
 * the remote version.json has changed and, if so, refresh the cache so the
 * next page load picks up the new assets.
 */
self.addEventListener('message', event => {
  if (event.data?.type !== 'CHECK_VERSION') return;

  event.waitUntil(
    (async () => {
      const versionData = await fetchVersionWithTimeout();
      if (!versionData?.version) return;

      const desired = CACHE_PREFIX + versionData.version;
      const current = await currentCacheName();
      if (current === desired) return;

      await migrateCacheTo(desired);

      // Notify all open clients that a new version is available.
      const allClients = await clients.matchAll({ includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage({ type: 'NEW_VERSION', ...versionData });
      }
    })()
  );
});
