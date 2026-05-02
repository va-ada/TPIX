// Minimal service worker — caches the app shell so the dashboard loads
// when offline. API calls always go to network (no stale data shown).

const CACHE = "tpix-shell-v1";
const SHELL = ["/web/", "/web/index.html", "/web/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))),
    ),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // App-shell only — never cache API responses
  if (SHELL.some((p) => url.pathname === p || url.pathname === p.replace(/\/$/, ""))) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request)),
    );
  }
});
