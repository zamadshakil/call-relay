const CACHE = "call-relay-shell-v8";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/manifest.webmanifest", "/icon.svg"])));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(new Request(event.request, { cache: "reload" })));
    return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((response) => response ?? Response.error())));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Incoming Call Relay call";
  const body = typeof payload.body === "string" ? payload.body : "Open Call Relay to answer from your Android SIM.";
  const tag = typeof payload.tag === "string" ? payload.tag : "incoming-call";
  const url = typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/";
  event.waitUntil((async () => {
    if (payload.type === "call_cancelled") {
      const notifications = await self.registration.getNotifications({ tag });
      notifications.forEach((notification) => notification.close());
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      clients.forEach((client) => client.postMessage({ type: "call_cancelled", callId: payload.callId }));
    }
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction: payload.type !== "call_cancelled",
      silent: payload.type === "call_cancelled",
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  const target = new URL(path, self.location.origin).toString();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
