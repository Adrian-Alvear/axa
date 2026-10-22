// AXA console service worker: keeps the page shell (the page, its styles and scripts, the design system
// and the terminal library) so the console opens even when it can't reach the server, and the page
// then says so. Live data is never cached: /api/, /events, /roster and the terminals' /pty sockets
// always go to the network. Network first, so a running console always serves the newest files.
const CACHE = "axa-shell-v2";
const UI = ["app.css", "icons.js", "design.js", "state.js", "map.js", "panel.js", "sessions.js", "diff.js", "nav.js", "home.js", "runs.js", "cost.js", "palette.js", "phone.js", "demo.js", "terminals.js", "main.js", "manifest.webmanifest", "icon.svg"];
const SHELL = ["/", ...UI.map((f) => "/ui/" + f), "/shared/theme.mjs", "/shared/look.mjs",
  "/vendor/xterm.js", "/vendor/xterm.css", "/vendor/addon-fit.js", "/vendor/addon-search.js", "/vendor/addon-web-links.js", "/vendor/addon-webgl.js"];
const LIVE = /^\/(api\/|events$|roster$|pty\/|sw\.js$)/;
const STATIC = /^\/(ui|shared|vendor)\//;

self.addEventListener("install", (ev) => {
  // each file on its own: one missing (e.g. terminals not installed) doesn't stop the rest
  ev.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "no-cache" })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("axa-shell-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (ev) => {
  const req = ev.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || LIVE.test(url.pathname) || url.searchParams.has("t")) return;
  const page = req.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html");
  if (!page && !STATIC.test(url.pathname)) return;
  const key = page ? "/" : url.pathname;
  ev.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}); }
      return res;
    } catch (e) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw e;
    }
  })());
});
