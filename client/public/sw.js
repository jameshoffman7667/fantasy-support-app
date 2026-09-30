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

// Pre-kickoff alerts (v2): the server sends a Web Push message (see
// server/push.js) whose payload is JSON { title, body }. This is what
// actually displays it as a system notification, including when the app
// isn't open — the whole point of "push," not just an in-app banner.
self.addEventListener("push", (event) => {
  let data = { title: "Fantasy Manager", body: "New alert." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payload — fall back to the generic message above rather than fail silently.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow("/");
    })
  );
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
