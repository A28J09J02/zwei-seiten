// Zwei Seiten – Service Worker: App-Dateien aus dem Cache, Nachrichten immer frisch (Netz zuerst, offline der letzte Stand).
const CACHE = "zwei-seiten-v2";
const SHELL = ["./", "index.html", "style.css?v=2", "app.js?v=2", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-180.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith("/data/feed.json")) {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put("data/feed.json", c)); return r; }).catch(() => caches.match("data/feed.json")));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
