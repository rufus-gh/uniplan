// Shows UniPlan's notifications and opens the home-screen app when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'UniPlan', {
    body: d.body || '',
    icon: '/static/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data.url, self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open.length) {
      await open[0].focus();
      if (open[0].url !== url) await open[0].navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
