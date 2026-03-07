// ══════════════════════════════════════════════════════════════════
//  MedTrack Service Worker  v4
//
//  KEY CAPABILITIES:
//  1. BACKGROUND POLLING — SW polls /api/medicines every 30s
//     independently of the page. Fires OS notifications even when
//     Chrome is minimised / phone screen is off.
//  2. WHATSAPP via notification ACTION BUTTON — avoids popup blocker
//     because tapping a notification action IS a user gesture.
//  3. Standard push event support for future server-push.
// ══════════════════════════════════════════════════════════════════

const SW_VERSION = 'medtrack-sw-v4';

// ── Lifecycle ─────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── State kept in SW memory (reset if SW is killed & restarted) ──
const _warned    = new Set();
const _alarmed   = new Set();
const _processed = new Set();
let   _polling   = false;

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
const toMins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const nowMin = () => { const d = new Date(); return d.getHours()*60+d.getMinutes(); };
const today  = () => new Date().toISOString().split('T')[0];
const fmt12  = t => {
  if (!t||!t.includes(':')) return t||'';
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
};
const safe = v => (v && v!=='undefined' && v!=='null') ? v : '—';

// Parse numeric dose amount from strings like "2 tablets", "1.5 ml", "2"
function parseDoseAmount(amountStr) {
  if (!amountStr) return 1;
  const m = String(amountStr).match(/^[\s]*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 1;
}

// ─────────────────────────────────────────────────────────────────
//  NOTIFICATION BUILDER
// ─────────────────────────────────────────────────────────────────
function buildOpts(body, urgent, tag, waNum, waText) {
  const opts = {
    body,
    icon:               '/static/images/logo.jpg',
    badge:              '/static/images/logo.jpg',
    tag,
    renotify:           true,
    vibrate:            urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: false,   // never lock screen
    silent:             false,
    data:               { url: '/dashboard', waNum, waText }
  };
  // Add WhatsApp action button if number provided
  if (waNum) {
    opts.actions = [
      { action: 'whatsapp', title: '📲 Alert Caregiver on WhatsApp' },
      { action: 'open',     title: '💊 Open MedTrack' }
    ];
  }
  return opts;
}

async function notify(title, body, urgent, tag, waNum='', waText='') {
  try {
    await self.registration.showNotification(title, buildOpts(body, urgent, tag, waNum, waText));
  } catch(e) {
    console.warn('[SW] showNotification failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
//  NOTIFICATION CLICK — handle action buttons
// ─────────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data   = e.notification.data || {};
  const action = e.action;

  if (action === 'whatsapp' && data.waNum && data.waText) {
    // Tapping this action IS a user gesture — no popup blocker!
    const url = `https://wa.me/${data.waNum}?text=${encodeURIComponent(data.waText)}`;
    e.waitUntil(self.clients.openWindow(url));
    return;
  }

  // Default: open/focus dashboard
  const target = data.url || '/dashboard';
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.navigate(target); return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// ─────────────────────────────────────────────────────────────────
//  BACKGROUND POLLING ENGINE
//  Polls /api/medicines every 30s. Fires OS notifications without
//  the page being open or in the foreground. This is the fix for
//  "Chrome in background / other app" scenario.
// ─────────────────────────────────────────────────────────────────
async function fetchMedicines() {
  try {
    const r = await fetch('/api/medicines', { credentials: 'include' });
    if (!r.ok) return null;
    return await r.json();
  } catch(_) { return null; }
}

function buildWaText(userName, med) {
  return (
    `🚨 *MedTrack — Missed Dose Alert* 🚨\n\n` +
    `*${userName}* has NOT taken their scheduled medicine.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💊 *Medicine:* ${safe(med.name)}\n` +
    `📦 *Type:* ${safe(med.type)}\n` +
    `📏 *Dosage:* ${safe(med.dosage)}\n` +
    `🔢 *Amount:* ${safe(med.amount)}\n` +
    `🕐 *Scheduled:* ${fmt12(med.time)}\n` +
    `📅 *Course:* ${safe(med.start_date)} → ${safe(med.finish_date)}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ Please check on ${userName}.\n— MedTrack`
  );
}

async function pollAndNotify() {
  const resp = await fetchMedicines();
  if (!resp) return;

  const meds      = Array.isArray(resp) ? resp : (resp.medicines || []);
  const caregiver = Array.isArray(resp) ? {} : (resp.caregiver  || {});
  const now       = nowMin();
  const todayStr  = today();
  const cgPhone   = (caregiver.caregiver_phone || '').replace(/\D/g,'');
  const cgName    = caregiver.caregiver_name || 'Caregiver';

  // Get user name from an open page if available
  let userName = 'Patient';
  try {
    const clients = await self.clients.matchAll({ type:'window' });
    if (clients.length > 0) {
      // Request user name from page via postMessage
      // (handled below in message listener)
    }
  } catch(_) {}

  for (const med of meds) {
    if (!med.time) continue;
    const medMin = toMins(med.time);
    const key    = `${med.id}-${todayStr}`;
    const body   = [
      `💊 ${safe(med.name)}`, `📦 ${safe(med.type)}`,
      `📏 ${safe(med.dosage)}`, `🔢 ${safe(med.amount)}`,
      `🕐 ${fmt12(med.time)}`
    ].join('\n');

    // 1 · 10-min warning
    if (med.notification_enabled === 1 && now === medMin - 10 && !_warned.has(key)) {
      _warned.add(key);
      await notify('⏰ Medicine in 10 minutes',
        `${body}\n\nGet it ready — due at ${fmt12(med.time)}!`,
        false, `warn-${med.id}`);
    }

    // 2 · Exact-time alarm
    if (now === medMin && !_alarmed.has(key)) {
      _alarmed.add(key);
      await notify('🚨 Time to take your medicine!',
        `${body}\n\nTake it RIGHT NOW!`,
        true, `alarm-${med.id}`);
    }

    // 3 · 3-min overdue → missed
    if (now === medMin + 3 && med.taken === 0 && !_processed.has(key)) {
      _processed.add(key);

      // Record in DB
      try { await fetch(`/mark_not_taken/${med.id}`, { method:'POST', credentials:'include' }); }
      catch(_) {}

      // Build WhatsApp message & pass it as notification action data
      const waText = buildWaText(userName, med);
      const waNum  = cgPhone;

      await notify(
        '❌ Missed Dose — Tap to Alert Caregiver',
        `${body}\n\nNOT taken 3 mins after scheduled time.\nTap the button below to notify ${cgName} via WhatsApp.`,
        true,
        `missed-${med.id}`,
        waNum,
        waText
      );

      // Also post message to any open pages so they can reload
      const clients = await self.clients.matchAll({ type:'window' });
      clients.forEach(c => c.postMessage({ type: 'MISSED_DOSE', medId: med.id }));
    }
  }
}

// Start background polling loop (runs in SW, survives page close)
function startPolling() {
  if (_polling) return;
  _polling = true;
  // Poll immediately, then every 30s
  pollAndNotify();
  setInterval(pollAndNotify, 30_000);
}

// ─────────────────────────────────────────────────────────────────
//  MESSAGE LISTENER — page tells SW: "start polling", "user info"
// ─────────────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data || {};

  if (msg.type === 'START_POLLING') {
    startPolling();
  }

  if (msg.type === 'USER_INFO') {
    // Store user name for WhatsApp messages
    self._userName = msg.userName || 'Patient';
  }

  if (msg.type === 'PING') {
    e.source?.postMessage({ type: 'PONG', version: SW_VERSION });
  }
});

// ── Server-push support (future use) ─────────────────────────────
self.addEventListener('push', e => {
  let d = { title:'MedTrack', body:'Medicine reminder', icon:'/static/images/logo.jpg',
             tag:'medtrack', urgent:false, url:'/dashboard' };
  try { Object.assign(d, e.data.json()); } catch(_) {}
  e.waitUntil(notify(d.title, d.body, d.urgent, d.tag));
});

// Auto-start polling as soon as SW activates (covers cases where
// the page is already open when the SW installs/updates)
self.addEventListener('activate', () => {
  // Small delay to let clients.claim() settle
  setTimeout(startPolling, 2000);
});
