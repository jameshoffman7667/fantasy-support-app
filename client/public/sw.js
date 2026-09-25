const CACHE_NAME = "fantasy-manager-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — the whole point of this app is fresh data,
  // and a stale-served roster/injury/lineup response would be actively
  // misleading, not just a minor inconvenience.
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      // Stale-while-revalidate: instant load from cache if we have it,
      // silently refreshed in the background for next time.
      return cached || networkFetch;
    })
  );
});
