// ══════════════════════════════════════════════════════════════════
//  MedTrack Service Worker  v5
//
//  BUGS FIXED vs v4:
//  1. Timing: exact-minute match → 2-minute window (same as page)
//  2. _userName scoping: pollAndNotify now reads self._userName
//  3. userId stored from USER_INFO message for mark_not_taken
//  4. Dedup sets cleared on new day (date stored in set key prefix)
// ══════════════════════════════════════════════════════════════════

const SW_VER = 'medtrack-sw-v5';

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// SW-scoped state
self._userName = 'Patient';
self._userId   = '';
let _polling   = false;

// Dedup sets — keyed as "YYYY-MM-DD:medId" so they auto-expire per day
const _warned    = new Set();
const _alarmed   = new Set();
const _processed = new Set();
let   _lastDate  = '';

function _todayStr() { return new Date().toISOString().split('T')[0]; }
function _clearIfNewDay() {
  const d = _todayStr();
  if (d !== _lastDate) {
    _lastDate = d;
    _warned.clear(); _alarmed.clear(); _processed.clear();
  }
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
const toMins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const nowMin = () => { const d = new Date(); return d.getHours()*60+d.getMinutes(); };
const fmt12  = t => {
  if (!t || !t.includes(':')) return t || '';
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
};
const safe = v => (v && v !== 'undefined' && v !== 'null') ? v : '—';

// ─────────────────────────────────────────────────────────────────
//  NOTIFICATION BUILDER
// ─────────────────────────────────────────────────────────────────
function buildOpts(body, urgent, tag, waNum, waText) {
  const opts = {
    body,
    icon:               '/static/images/logo.jpg',
    badge:              '/static/images/logo.jpg',
    tag, renotify: true,
    vibrate:            urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: false,
    silent:             false,
    data:               { url: '/dashboard', waNum: waNum||'', waText: waText||'' }
  };
  if (waNum) {
    opts.actions = [
      { action: 'whatsapp', title: '📲 Alert Caregiver on WhatsApp' },
      { action: 'open',     title: '💊 Open MedTrack' }
    ];
  }
  return opts;
}

async function swNotify(title, body, urgent, tag, waNum, waText) {
  try { await self.registration.showNotification(title, buildOpts(body, urgent, tag, waNum, waText)); }
  catch(e) { console.warn('[SW] notify failed:', e.message); }
}

// ─────────────────────────────────────────────────────────────────
//  NOTIFICATION CLICK
// ─────────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};

  if (e.action === 'whatsapp' && data.waNum && data.waText) {
    const url = `https://wa.me/${data.waNum}?text=${encodeURIComponent(data.waText)}`;
    e.waitUntil(self.clients.openWindow(url));
    return;
  }
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
//  WA MESSAGE BUILDER
// ─────────────────────────────────────────────────────────────────
function buildWaText(med) {
  const userName = self._userName || 'Patient';
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

// ─────────────────────────────────────────────────────────────────
//  BACKGROUND POLLING
// ─────────────────────────────────────────────────────────────────
async function pollAndNotify() {
  _clearIfNewDay();

  let resp;
  try {
    const r = await fetch('/api/medicines', { credentials: 'include' });
    if (!r.ok) return;
    resp = await r.json();
  } catch(_) { return; }

  const meds      = Array.isArray(resp) ? resp : (resp.medicines || []);
  const caregiver = Array.isArray(resp) ? {} : (resp.caregiver  || {});
  const now       = nowMin();
  const todayStr  = _todayStr();
  const cgPhone   = (caregiver.caregiver_phone || '').replace(/\D/g, '');
  const cgName    = caregiver.caregiver_name || 'Caregiver';

  for (const med of meds) {
    if (!med.time) continue;
    const medMin = toMins(med.time);
    const key    = `${todayStr}:${med.id}`;
    const body   = [
      `💊 ${safe(med.name)}`, `📦 ${safe(med.type)}`,
      `📏 ${safe(med.dosage)}`, `🔢 ${safe(med.amount)}`,
      `🕐 ${fmt12(med.time)}`
    ].join('\n');

    // ── 1. 10-min WARNING window ──────────────────────────────────
    if (med.notification_enabled === 1
        && now >= medMin - 10 && now <= medMin - 9
        && !_warned.has(key)) {
      _warned.add(key);
      await swNotify('⏰ Medicine in 10 minutes',
        `${body}\n\nGet it ready — due at ${fmt12(med.time)}!`,
        false, `warn-${med.id}`);
    }

    // ── 2. ALARM window ───────────────────────────────────────────
    if (now >= medMin && now <= medMin + 1 && !_alarmed.has(key)) {
      _alarmed.add(key);
      await swNotify('🚨 Time to take your medicine!',
        `${body}\n\nTake it RIGHT NOW!`,
        true, `alarm-${med.id}`);
    }

    // ── 3. MISSED DOSE window ─────────────────────────────────────
    if (now >= medMin + 3 && now <= medMin + 4
        && med.taken === 0
        && !_processed.has(key)) {
      _processed.add(key);

      // Mark not-taken — try with session first, fallback to public API
      try {
        const res = await fetch(`/mark_not_taken/${med.id}`, { method:'POST', credentials:'include' });
        if (!res.ok) throw new Error('session expired');
      } catch(_) {
        // Fallback: public endpoint (no session needed)
        try { await fetch(`/api/mark_missed`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ med_id: med.id, user_id: self._userId })
        }); } catch(_2) {}
      }

      const waNum  = cgPhone;
      const waText = buildWaText(med);

      await swNotify(
        '❌ Missed Dose — Tap to Alert Caregiver',
        `${body}\n\nNOT taken 3 min after schedule.\nTap "Alert Caregiver on WhatsApp" below.`,
        true, `missed-${med.id}`, waNum, waText
      );

      // Tell open pages to reload
      const clients = await self.clients.matchAll({ type:'window' });
      clients.forEach(c => c.postMessage({ type: 'MISSED_DOSE', medId: med.id }));
    }
  }
}

function startPolling() {
  if (_polling) return;
  _polling = true;
  pollAndNotify();
  setInterval(pollAndNotify, 15_000);   // every 15s — matches page engine
}

// ─────────────────────────────────────────────────────────────────
//  MESSAGE LISTENER
// ─────────────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'USER_INFO') {
    self._userName = msg.userName || 'Patient';
    self._userId   = msg.userId   || '';
  }
  if (msg.type === 'START_POLLING') { startPolling(); }
  if (msg.type === 'PING') { e.source?.postMessage({ type:'PONG', version:SW_VER }); }
});

// Auto-start on activate
self.addEventListener('activate', () => { setTimeout(startPolling, 2000); });

// Server-push (future)
self.addEventListener('push', e => {
  let d = { title:'MedTrack', body:'Medicine reminder', icon:'/static/images/logo.jpg', tag:'medtrack', urgent:false };
  try { Object.assign(d, e.data.json()); } catch(_) {}
  e.waitUntil(swNotify(d.title, d.body, d.urgent, d.tag));
});
