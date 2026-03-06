// MedTrack Service Worker — handles push notifications
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

self.addEventListener('push', e => {
  let data = { title: 'MedTrack', body: 'Medicine reminder', icon: '/static/images/logo.jpg', tag: 'medtrack' };
  try { data = Object.assign(data, e.data.json()); } catch(err) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon,
      badge:   data.icon,
      tag:     data.tag || 'medtrack',
      vibrate: [200, 100, 200],
      requireInteraction: data.urgent || false,
      data:    { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if (c.url.includes('/dashboard') && 'focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(e.notification.data?.url || '/dashboard');
    })
  );
});
