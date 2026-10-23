// v4.12: the cache name carries the app version (a test checks it equals the VERSION file); old caches are
// deleted on activate. Only the offline page and its icon are precached: nothing else is cached by this worker,
// so API responses, sign-in pages and anything user-specific always come from the network.
const CACHE_NAME = "fantasy-manager-v4.12.1";
const PRECACHE = ["/offline.html", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  // No skipWaiting() here: a new worker waits until the person taps "Reload" in the update prompt (main.jsx),
  // so an update never swaps the page in the middle of a form.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
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

  // Never touch API calls, the Android link file, other origins or anything that isn't a GET: the whole point
  // of this app is fresh data, and a stale roster/lineup response would be actively misleading.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/")) return;

  // Page loads: network first; when the network is down, show the offline page.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.open(CACHE_NAME).then((cache) => cache.match("/offline.html")))
    );
  }
  // Everything else (scripts, styles, images) goes straight to the network and the browser's own HTTP cache.
});
