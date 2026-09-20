/*
 * InboxOS service worker: makes the app installable and quick to open on phones.
 *
 * It caches only the app shell (index.html) and the hashed, immutable files under
 * /assets/. It never caches the API, webhooks, MCP or unsubscribe pages, so no mail
 * content is ever stored on the device. Notifications shown by the page go through
 * here too (Android and iOS only allow notifications from a service worker).
 */
const CACHE = "inboxos-shell-v1";
const SHELL = "/index.html";
const NEVER = [/^\/api\//, /^\/webhooks\//, /^\/mcp/, /^\/unsubscribe/, /^\/manifest\.webmanifest$/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(new Request(SHELL, { cache: "reload" }))).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  // Signing out clears the shell cache too, so a shared phone keeps nothing.
  if (event.data === "CLEAR_CACHE") event.waitUntil(caches.delete(CACHE));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER.some((re) => re.test(url.pathname))) return;

  // Pages: always try the network (fresh deploys, auth redirects), fall back to the shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && url.pathname !== "/sw.js") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(SHELL)) ?? Response.error()),
    );
    return;
  }

  // Hashed build files never change: cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

// Tapping a notification opens (or focuses) the app at the right place.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const win of windows) {
        if (new URL(win.url).origin === self.location.origin) {
          await win.focus();
          if ("navigate" in win) await win.navigate(target).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// New mail pushed from the server (Web Push). The payload is already end-to-end
// encrypted to this device; it carries only what the lock screen shows.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "New mail", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "New mail";
  event.waitUntil(
    (async () => {
      if (typeof data.badge === "number" && "setAppBadge" in self.navigator) {
        await (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined);
      }
      await self.registration.showNotification(title, {
        body: data.body || "",
        tag: data.tag || "inboxos-new-mail",
        renotify: true,
        icon: "/api/brand/icons/icon-192.png",
        badge: "/api/brand/icons/icon-192.png",
        data: { url: data.url || "/" },
      });
    })(),
  );
});

// Browsers occasionally rotate a subscription: re-register it so mail keeps arriving.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const { publicKey } = await fetch("/api/push/key", { credentials: "same-origin" }).then((r) => r.json());
      if (!publicKey) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
    })().catch(() => undefined),
  );
});
