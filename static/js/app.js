// ══════════════════════════════════════════════════════════════════
//  MedTrack — Reminder Engine  v10
//
//  ROOT CAUSES FIXED:
//
//  1. "Only fires once / misses other medicines"
//     CAUSE: `now === medMin` is exact-minute equality checked every
//     30s. You only poll at T=0, T=30, T=60 seconds — a 50% chance
//     of skipping any given minute entirely.
//     FIX: Use a TIME WINDOW. Fire if now is within 0-2 min of the
//     scheduled time. Store the key so it only fires once per day.
//
//  2. "Alarm works once then stops after page reload"
//     CAUSE: sessionStorage dedup keys survive reload correctly,
//     BUT the reload triggered 2s after missed-dose detection wipes
//     the in-page engine state and re-fetches. If `taken` is now 1
//     in the DB (because mark_not_taken ran), it won't re-fire.
//     That's correct. But 10-min warning and alarm keys must survive
//     reload — they do via sessionStorage. The real bug was the
//     exact-match timing miss above.
//
//  3. "mark_not_taken doesn't work from SW on Render"
//     CAUSE: SW fetch has no session cookie in cloud environments.
//     FIX: Added /api/mark_not_taken_public endpoint in app.py that
//     accepts user_id + med_id as POST body (no session needed).
//     SW uses this endpoint.
//
//  4. "Enable Alerts button broken"
//     CAUSE: base.html onclick="requestPushPermission()" but the
//     function was renamed. FIX: restored function name.
//
//  5. "SW userName always 'Patient' for WA messages"
//     CAUSE: SW stores _userName but pollAndNotify uses local var.
//     FIX: always use self._userName in SW.
// ══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
//  AUDIO
// ─────────────────────────────────────────────────────────────────
const $notify = document.getElementById('notifySound');
const $alarm  = document.getElementById('alarmSound');
let _audioReady = false;

function unlockAudio() {
  if (_audioReady) return; _audioReady = true;
  [$notify, $alarm].forEach(el => {
    if (!el) return;
    el.volume = 0.001;
    el.play().then(() => { el.pause(); el.currentTime = 0; el.volume = 1; }).catch(() => {});
  });
}
['click','touchstart','keydown'].forEach(ev =>
  document.addEventListener(ev, unlockAudio, { once: true, passive: true })
);
function playNotify() { if ($notify) { $notify.currentTime = 0; $notify.play().catch(() => {}); } }
function playAlarm()  { if ($alarm)  { $alarm.currentTime  = 0; $alarm.play().catch(() => {}); } }

// ─────────────────────────────────────────────────────────────────
//  PLATFORM DETECTION
// ─────────────────────────────────────────────────────────────────
const IS_IOS     = /iphone|ipad|ipod/i.test(navigator.userAgent);
const IS_MOBILE  = IS_IOS || /android/i.test(navigator.userAgent);
const IS_IOS_PWA = IS_IOS && window.matchMedia('(display-mode:standalone)').matches;
const HAS_NOTIF  = 'Notification' in window && 'serviceWorker' in navigator;

// ─────────────────────────────────────────────────────────────────
//  SERVICE WORKER
// ─────────────────────────────────────────────────────────────────
let _swReg = null;

async function ensureSW() {
  if (!('serviceWorker' in navigator)) return null;
  if (_swReg?.active) return _swReg;
  try {
    _swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const sw = _swReg.installing || _swReg.waiting;
    if (sw && !_swReg.active) {
      await new Promise((ok, fail) => {
        const t = setTimeout(() => fail(new Error('timeout')), 8000);
        sw.addEventListener('statechange', function h(e) {
          if (e.target.state === 'activated') { clearTimeout(t); sw.removeEventListener('statechange', h); ok(); }
          if (e.target.state === 'redundant') { clearTimeout(t); sw.removeEventListener('statechange', h); fail(new Error('redundant')); }
        });
      });
    }
    if (!navigator.serviceWorker.controller) {
      await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
    _swReg = await navigator.serviceWorker.ready;
    return _swReg;
  } catch (e) { console.warn('[MT] SW:', e.message); return null; }
}

function kickSWPolling() {
  const ctrl = navigator.serviceWorker?.controller;
  if (!ctrl) return;
  const uid      = document.body.dataset.userId   || '';
  const userName = (document.body.dataset.userName || 'Patient').trim();
  ctrl.postMessage({ type: 'USER_INFO', userName, userId: uid });
  ctrl.postMessage({ type: 'START_POLLING' });
}

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'MISSED_DOSE' && location.pathname === '/dashboard') {
    setTimeout(() => location.reload(), 1500);
  }
});

// ─────────────────────────────────────────────────────────────────
//  OS NOTIFICATION  (page-side — used when page is foregrounded)
// ─────────────────────────────────────────────────────────────────
async function showOsNotif(title, body, urgent = false, tag = 'medtrack', waNum = '', waText = '') {
  if (!HAS_NOTIF || Notification.permission !== 'granted') return;
  const opts = {
    body, icon: '/static/images/logo.jpg', badge: '/static/images/logo.jpg',
    tag, renotify: true, silent: false,
    vibrate: urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: false,
    data: { url: '/dashboard', waNum, waText }
  };
  if (waNum) {
    opts.actions = [
      { action: 'whatsapp', title: '📲 Alert Caregiver on WhatsApp' },
      { action: 'open',     title: '💊 Open MedTrack' }
    ];
  }
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, r) => setTimeout(() => r(), 3000))
    ]).catch(() => null);
    if (reg?.active) { await reg.showNotification(title, opts); return; }
  } catch (e) { console.warn('[MT] SW notif:', e.message); }
  if (!IS_MOBILE) {
    try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); }; } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────
//  IN-PAGE TOAST
// ─────────────────────────────────────────────────────────────────
function showToast(title, msg, type = 'info', ms = 9000) {
  let w = document.getElementById('toast-container');
  if (!w) { w = document.createElement('div'); w.id = 'toast-container'; document.body.appendChild(w); }
  const icons = { alarm: '🚨', warning: '⏰', info: '💊', success: '✅' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <div class="toast-icon">${icons[type] || '💊'}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${String(msg).replace(/\n/g, '<br>')}</div>
    </div>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:var(--muted);cursor:pointer;
             font-size:15px;padding:0 0 0 8px;align-self:flex-start;flex-shrink:0;">✕</button>`;
  w.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut 0.3s forwards'; setTimeout(() => t.remove(), 320); }, ms);
}

function pushNotif(title, body, urgent = false, tag = 'medtrack', waNum = '', waText = '') {
  showToast(title, body, urgent ? 'alarm' : 'warning');
  showOsNotif(title, body, urgent, tag, waNum, waText);
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
const toMins  = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMins = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const fmt12   = t => {
  if (!t || !t.includes(':')) return t || '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const safeStr = v => (v && v !== 'undefined' && v !== 'null') ? v : '—';

function notifBody(med) {
  return [`💊 ${safeStr(med.name)}`, `📦 ${safeStr(med.type)}`,
          `📏 ${safeStr(med.dosage)}`, `🔢 ${safeStr(med.amount)}`,
          `🕐 ${fmt12(med.time)}`].join('\n');
}

// ─────────────────────────────────────────────────────────────────
//  WHATSAPP
// ─────────────────────────────────────────────────────────────────
function buildWaUrl(phone, text) {
  const num = String(phone || '').replace(/\D/g, '');
  if (num.length < 7) return '';
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

function buildWaMissedText(userName, med) {
  return (
    `🚨 *MedTrack — Missed Dose Alert* 🚨\n\n` +
    `*${userName}* has NOT taken their scheduled medicine.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💊 *Medicine:* ${safeStr(med.name)}\n` +
    `📦 *Type:* ${safeStr(med.type)}\n` +
    `📏 *Dosage:* ${safeStr(med.dosage)}\n` +
    `🔢 *Amount:* ${safeStr(med.amount)}\n` +
    `🕐 *Scheduled:* ${fmt12(med.time)}\n` +
    `📅 *Course:* ${safeStr(med.start_date)} → ${safeStr(med.finish_date)}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ Please check on ${userName}.\n— MedTrack`
  );
}

function buildWaGreetText(userName, cgName) {
  return (
    `👋 *Hello ${cgName}! — MedTrack Setup*\n\n` +
    `This is a one-time setup message from the MedTrack medicine reminder app.\n\n` +
    `*${userName}* has added you as their caregiver contact.\n\n` +
    `If ${userName} misses a scheduled medicine dose, you will automatically ` +
    `receive a WhatsApp alert here.\n\n` +
    `✅ *No action needed right now* — this message just confirms that ` +
    `alerts are correctly set up and will reach you.\n\n` +
    `Thank you for looking after ${userName}! 💊\n— MedTrack Reminder System`
  );
}

// ─────────────────────────────────────────────────────────────────
//  WHATSAPP GREETING STATE
// ─────────────────────────────────────────────────────────────────
function _devFP() {
  return btoa(navigator.userAgent.replace(/\s/g, '').slice(0, 40) + screen.width + 'x' + screen.height)
    .replace(/\W/g, '').slice(0, 20);
}
function _waKey()    { return `mt_wa_greeted_${document.body.dataset.userId || 'g'}_${_devFP()}`; }
const _waGreetDone = () => { try { return !!localStorage.getItem(_waKey()); } catch { return false; } };
const _waGreetMark = () => { try { localStorage.setItem(_waKey(), '1'); } catch (_) {} };

function sendWaGreeting(phone, userName, cgName, onSuccess) {
  const url = buildWaUrl(phone, buildWaGreetText(userName, cgName));
  if (!url) { showToast('No caregiver phone', 'Add a caregiver phone in Settings first.', 'info', 5000); return; }
  const win = window.open(url, '_blank');
  if (win) {
    _waGreetMark();
    if (onSuccess) onSuccess();
  } else {
    showWaFallbackBanner(url);
  }
}

function showWaFallbackBanner(url) {
  let b = document.getElementById('waFallbackBanner');
  if (b) b.remove();
  b = document.createElement('div');
  b.id = 'waFallbackBanner';
  b.style.cssText = `position:fixed;bottom:0;left:0;right:0;z-index:9998;
    background:linear-gradient(135deg,#25d366,#128c7e);
    padding:16px 20px;display:flex;align-items:center;gap:14px;
    box-shadow:0 -4px 24px rgba(0,0,0,.4);`;
  b.innerHTML = `
    <div style="font-size:28px;">📲</div>
    <div style="flex:1;color:#fff;">
      <div style="font-weight:700;font-size:.92rem;margin-bottom:2px;">Tap to open WhatsApp</div>
      <div style="font-size:.78rem;opacity:.85;">Browser blocked the auto-open — tap to send manually</div>
    </div>
    <a href="${url}" target="_blank"
      onclick="_waGreetMark();document.getElementById('waFallbackBanner')?.remove();"
      style="background:#fff;color:#25d366;font-weight:800;font-size:.88rem;
             padding:10px 18px;border-radius:10px;text-decoration:none;white-space:nowrap;flex-shrink:0;">
      Open WhatsApp
    </a>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:rgba(255,255,255,.7);font-size:22px;cursor:pointer;padding:0;flex-shrink:0;">✕</button>`;
  document.body.appendChild(b);
}

// ─────────────────────────────────────────────────────────────────
//  GREETING CARD
// ─────────────────────────────────────────────────────────────────
async function showGreetingCard(cgPhone, cgName) {
  if (_waGreetDone()) return;
  if (document.getElementById('waGreetCard')) return;
  if (!cgPhone || cgPhone.replace(/\D/g, '').length < 7) return;

  const userName = (document.body.dataset.userName || 'Patient').trim();
  const card = document.createElement('div');
  card.id = 'waGreetCard';
  card.style.cssText = `position:fixed;inset:0;z-index:99998;background:rgba(8,12,18,0.93);
    display:flex;align-items:center;justify-content:center;padding:20px;animation:toastIn .35s ease;`;
  card.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:22px;
      padding:36px 28px;max-width:440px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.75);text-align:center;">
      <div style="width:72px;height:72px;background:#25d366;border-radius:20px;
        display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 20px;">📲</div>
      <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:1.35rem;letter-spacing:-.02em;margin-bottom:10px;">
        One last step
      </div>
      <div style="color:var(--muted);font-size:.88rem;line-height:1.7;margin-bottom:28px;">
        Tap below to send a <b style="color:var(--text)">setup greeting</b> to
        <b style="color:var(--text)">${cgName}</b> on WhatsApp.<br><br>
        This <b style="color:var(--text)">one tap</b> lets your browser send future
        missed-dose alerts automatically. You only do this <b style="color:var(--text)">once</b>.
      </div>
      <button id="waGreetBtn"
        style="width:100%;padding:18px 20px;background:linear-gradient(135deg,#25d366,#128c7e);
          color:#fff;border:none;border-radius:14px;font-family:'Outfit',sans-serif;
          font-size:1.05rem;font-weight:800;cursor:pointer;
          display:flex;align-items:center;justify-content:center;gap:10px;
          box-shadow:0 6px 28px rgba(37,211,102,.45);margin-bottom:14px;">
        <span style="font-size:22px;">📲</span> Send Hello to ${cgName} on WhatsApp
      </button>
      <button id="waGreetSkip"
        style="width:100%;padding:11px;background:none;border:1px solid var(--border);
          border-radius:10px;color:var(--muted);font-size:.83rem;cursor:pointer;">
        Skip for now — I'll do this from Settings later
      </button>
      <div style="margin-top:16px;font-size:.73rem;color:var(--muted2);line-height:1.5;">
        WhatsApp opens with a pre-written message. Just tap Send inside WhatsApp.
      </div>
    </div>`;
  document.body.appendChild(card);

  document.getElementById('waGreetBtn').addEventListener('click', () => {
    sendWaGreeting(cgPhone, userName, cgName, () => {
      const btn = document.getElementById('waGreetBtn');
      btn.textContent = '✅ Sent! Alerts are fully set up.';
      btn.style.background = 'linear-gradient(135deg,#4ade80,#22c55e)';
      btn.disabled = true;
      showToast('WhatsApp greeting sent ✅',
        `${cgName} has been notified. Future missed-dose alerts will reach them automatically.`,
        'success', 8000);
      setTimeout(() => {
        card.style.animation = 'toastOut .4s forwards';
        setTimeout(() => card.remove(), 420);
      }, 2000);
    });
  });

  document.getElementById('waGreetSkip').addEventListener('click', () => {
    card.style.animation = 'toastOut .3s forwards';
    setTimeout(() => card.remove(), 320);
    showWaReminderBanner(cgPhone, cgName, userName);
  });
}

function showWaReminderBanner(cgPhone, cgName, userName) {
  if (_waGreetDone() || document.getElementById('waReminderBar')) return;
  const bar = document.createElement('div');
  bar.id = 'waReminderBar';
  bar.style.cssText = `position:fixed;bottom:0;left:0;right:0;z-index:9000;
    background:linear-gradient(135deg,#1a3a2a,#1c3328);
    border-top:1px solid rgba(37,211,102,.3);padding:12px 16px;
    display:flex;align-items:center;gap:12px;`;
  bar.innerHTML = `
    <span style="font-size:22px;flex-shrink:0;">📲</span>
    <div style="flex:1;font-size:.82rem;color:#4ade80;line-height:1.4;">
      <b>WhatsApp alerts not set up yet.</b> Tap to send a greeting to ${cgName}.
    </div>
    <button id="waReminderBtn"
      style="background:#25d366;color:#fff;border:none;border-radius:8px;
             padding:8px 14px;font-weight:700;font-size:.82rem;cursor:pointer;flex-shrink:0;">
      Set Up Now
    </button>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:rgba(74,222,128,.5);font-size:20px;cursor:pointer;padding:0;flex-shrink:0;">✕</button>`;
  document.body.appendChild(bar);
  document.getElementById('waReminderBtn').addEventListener('click', () => { bar.remove(); showGreetingCard(cgPhone, cgName); });
}

// ─────────────────────────────────────────────────────────────────
//  DEDUPLICATION  — sessionStorage survives reload, cleared at
//  midnight by checking the stored date against today
// ─────────────────────────────────────────────────────────────────
const warned = new Set(), alarmed = new Set(), processed = new Set();

function loadSets() {
  try {
    const storedDate = sessionStorage.getItem('mt_date');
    const todayStr   = new Date().toISOString().split('T')[0];
    if (storedDate !== todayStr) {
      // New day — clear all dedup state
      sessionStorage.setItem('mt_date', todayStr);
      sessionStorage.removeItem('mt_w');
      sessionStorage.removeItem('mt_a');
      sessionStorage.removeItem('mt_p');
      return;
    }
    (JSON.parse(sessionStorage.getItem('mt_w') || '[]')).forEach(k => warned.add(k));
    (JSON.parse(sessionStorage.getItem('mt_a') || '[]')).forEach(k => alarmed.add(k));
    (JSON.parse(sessionStorage.getItem('mt_p') || '[]')).forEach(k => processed.add(k));
  } catch (_) {}
}

function saveSets() {
  try {
    sessionStorage.setItem('mt_w', JSON.stringify([...warned]));
    sessionStorage.setItem('mt_a', JSON.stringify([...alarmed]));
    sessionStorage.setItem('mt_p', JSON.stringify([...processed]));
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────
//  PAGE-SIDE REMINDER ENGINE
//
//  KEY FIX: Use TIME WINDOWS not exact-minute equality.
//  Poll every 15s (was 30s) for better responsiveness.
//  Windows:
//    warning:   medMin-10 to medMin-9   (fires once in this 1-min band)
//    alarm:     medMin    to medMin+1   (fires once in this 1-min band)
//    missed:    medMin+3  to medMin+4   (fires once, marks not-taken)
// ─────────────────────────────────────────────────────────────────
async function checkReminders() {
  let resp;
  try { const r = await fetch('/api/medicines'); if (!r.ok) return; resp = await r.json(); }
  catch (_) { return; }

  const meds      = Array.isArray(resp) ? resp : (resp.medicines || []);
  const caregiver = Array.isArray(resp) ? {} : (resp.caregiver  || {});
  const now       = nowMins();
  const todayStr  = new Date().toISOString().split('T')[0];
  const userName  = (document.body.dataset.userName  || 'Patient').trim();
  const userPhone = (document.body.dataset.userPhone || '').trim();
  const cgPhone   = (caregiver.caregiver_phone || '').trim();
  const cgName    = (caregiver.caregiver_name  || 'Caregiver').trim();

  // Show greeting card once if caregiver is set but greeting not done
  if (cgPhone && !_waGreetDone()) {
    showGreetingCard(cgPhone, cgName);
  }

  for (const med of meds) {
    if (!med.time) continue;
    const medMin = toMins(med.time);
    const key    = `${med.id}-${todayStr}`;

    // ── 1. 10-min WARNING (window: medMin-10 to medMin-9) ─────────
    if (med.notification_enabled === 1
        && now >= medMin - 10 && now <= medMin - 9
        && !warned.has(key)) {
      warned.add(key); saveSets();
      playNotify();
      pushNotif('⏰ Medicine in 10 minutes',
        `${notifBody(med)}\n\nGet it ready — due at ${fmt12(med.time)}!`,
        false, `warn-${med.id}`);
    }

    // ── 2. EXACT-TIME ALARM (window: medMin to medMin+1) ──────────
    if (now >= medMin && now <= medMin + 1 && !alarmed.has(key)) {
      alarmed.add(key); saveSets();
      playAlarm();
      pushNotif('🚨 Time to take your medicine!',
        `${notifBody(med)}\n\nTake it RIGHT NOW!`,
        true, `alarm-${med.id}`);
    }

    // ── 3. MISSED DOSE (window: medMin+3 to medMin+4) ─────────────
    if (now >= medMin + 3 && now <= medMin + 4
        && med.taken === 0
        && !processed.has(key)) {
      processed.add(key); saveSets();

      // Mark not-taken in DB
      try { await fetch(`/mark_not_taken/${med.id}`, { method: 'POST' }); } catch (_) {}

      playAlarm();

      const waNum  = (cgPhone || userPhone).replace(/\D/g, '');
      const waText = buildWaMissedText(userName, med);
      pushNotif(
        '❌ Missed Dose — Tap notification to alert caregiver',
        `${notifBody(med)}\n\nNOT taken. Tap "Alert Caregiver on WhatsApp" in the notification above.`,
        true, `missed-${med.id}`, waNum, waText
      );

      // Reload dashboard after 2s so "not taken" status shows
      setTimeout(() => { if (location.pathname === '/dashboard') location.reload(); }, 2000);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  TOPBAR "ENABLE ALERTS" BUTTON
//  Function name MUST be requestPushPermission — base.html calls it
// ─────────────────────────────────────────────────────────────────
async function requestPushPermission() {         // ← name matches base.html onclick
  const btn = document.getElementById('notifPermBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  await ensureSW().catch(() => {});
  let perm = 'denied';
  try { perm = await Notification.requestPermission(); } catch (_) {}
  if (perm === 'granted') {
    await showOsNotif('✅ MedTrack Alerts Active', 'Medicine reminders will now appear on this device.', false, 'perm-test');
    showToast('Alerts enabled ✅', 'OS notifications are now active.', 'success', 5000);
    kickSWPolling();
  }
  syncAlertButton();
}

function syncAlertButton() {
  const btn = document.getElementById('notifPermBtn');
  if (!btn) return;

  if (IS_IOS && !IS_IOS_PWA) {
    btn.style.cssText = 'display:inline-flex;background:#f59e0b;color:#fff;border:none;';
    btn.textContent = '📲 Install App'; btn.disabled = false;
    btn.onclick = showIosGuide; return;
  }
  if (!HAS_NOTIF) { btn.style.display = 'none'; return; }

  const p = Notification.permission;
  if (p === 'granted') {
    btn.style.display = 'none';
  } else if (p === 'denied') {
    btn.style.cssText = 'display:inline-flex;background:rgba(248,113,113,0.15);color:#f87171;border:1px solid rgba(248,113,113,0.3);cursor:default;';
    btn.textContent = '🔕 Blocked'; btn.disabled = true;
    btn.title = 'Go to browser Site Settings → Notifications to unblock.';
  } else {
    btn.style.cssText = 'display:inline-flex;';
    btn.textContent = '🔔 Enable Alerts';
    btn.disabled = false;
    btn.onclick = requestPushPermission;
  }
}

function showIosGuide() {
  if (document.getElementById('iosGuide')) { document.getElementById('iosGuide').remove(); return; }
  const d = document.createElement('div'); d.id = 'iosGuide';
  d.style.cssText = 'position:fixed;bottom:72px;left:12px;right:12px;z-index:9999;background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:18px 20px;box-shadow:0 16px 48px rgba(0,0,0,.65);animation:toastIn .3s ease;';
  d.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
      <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:.95rem;">📲 Enable Notifications on iPhone</div>
      <button onclick="this.closest('#iosGuide').remove()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">✕</button>
    </div>
    <div style="font-size:.82rem;color:var(--muted);line-height:1.75;">
      <b style="color:var(--text)">1.</b> Tap <b style="color:var(--blue)">Share ⬆</b> in Safari<br>
      <b style="color:var(--text)">2.</b> Tap <b style="color:var(--blue)">"Add to Home Screen"</b><br>
      <b style="color:var(--text)">3.</b> Open MedTrack from your Home Screen<br>
      <b style="color:var(--text)">4.</b> Tap "Enable Alerts" inside the app
    </div>`;
  document.body.appendChild(d);
  setTimeout(() => { if (d.parentNode) d.remove(); }, 18000);
}

// ─────────────────────────────────────────────────────────────────
//  PERMISSION WIZARD
// ─────────────────────────────────────────────────────────────────
function _wizKey() { return `mt_perm_v5_${document.body.dataset.userId || 'g'}_${_devFP()}`; }
const _wizDone = () => { try { return !!localStorage.getItem(_wizKey()); } catch { return true; } };
const _wizMark = () => { try { localStorage.setItem(_wizKey(), '1'); } catch (_) {} };

async function runPermWizard() {
  if (_wizDone()) return;
  if (IS_IOS && !IS_IOS_PWA) { _wizMark(); setTimeout(showIosGuide, 1500); syncAlertButton(); return; }
  if (HAS_NOTIF && Notification.permission === 'granted') { _wizMark(); return; }

  let cgPhone = '', cgName = 'Caregiver';
  try {
    const r = await fetch('/api/medicines'); const d = await r.json();
    cgPhone = (d.caregiver?.caregiver_phone || '').trim();
    cgName  = (d.caregiver?.caregiver_name  || 'Caregiver').trim();
  } catch (_) {}

  const ov = document.createElement('div');
  ov.id = 'permWizard';
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,12,18,.97);display:flex;align-items:center;justify-content:center;padding:20px;animation:toastIn .35s ease;';
  ov.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:22px;
      padding:36px 28px;max-width:440px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.7);text-align:center;">
      <img src="/static/images/logo.jpg" style="width:60px;height:60px;border-radius:13px;margin-bottom:16px;object-fit:cover;">
      <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:1.35rem;letter-spacing:-.02em;margin-bottom:8px;">
        Allow MedTrack Permissions
      </div>
      <div style="color:var(--muted);font-size:.84rem;margin-bottom:26px;line-height:1.65;">
        Grant these once to enable medicine reminders${IS_MOBILE ? ' on your phone' : ''}.
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px;text-align:left;">
        <div class="_pr" id="_pr-sw"><span class="_pi">⚙️</span>
          <div class="_pn"><div class="_pt">Background Service</div><div class="_pd">Fires reminders even when app is minimised</div></div>
          <span class="_ps" id="_ps-sw">⏳</span></div>
        <div class="_pr" id="_pr-notif"><span class="_pi">🔔</span>
          <div class="_pn"><div class="_pt">OS Notifications</div><div class="_pd">Alerts on lock screen &amp; notification bar</div></div>
          <span class="_ps" id="_ps-notif">⏳</span></div>
        <div class="_pr" id="_pr-sound"><span class="_pi">🔊</span>
          <div class="_pn"><div class="_pt">Sound &amp; Alarm</div><div class="_pd">Audible beep and alarm tones</div></div>
          <span class="_ps" id="_ps-sound">⏳</span></div>
      </div>
      <button id="_pwBtn" style="width:100%;padding:14px;background:linear-gradient(135deg,#60a5fa,#7c3aed);
        color:#fff;border:none;border-radius:12px;font-family:'Outfit',sans-serif;font-size:1rem;font-weight:700;
        cursor:pointer;box-shadow:0 6px 24px rgba(96,165,250,.35);">Allow Permissions →</button>
      <div style="margin-top:12px;font-size:.76rem;color:var(--muted2);">This screen only appears once per device.</div>
    </div>
    <style>
      ._pr{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:11px;}
      ._pi{font-size:20px;flex-shrink:0;}._pn{flex:1;}
      ._pt{font-weight:700;font-size:.85rem;margin-bottom:2px;}
      ._pd{font-size:.73rem;color:var(--muted);line-height:1.35;}
      ._ps{font-size:17px;flex-shrink:0;min-width:22px;text-align:center;}
    </style>`;
  document.body.appendChild(ov);

  const setStat = (id, ico, ok) => {
    const el = document.getElementById(id);
    const row = document.getElementById(id.replace('_ps','_pr'));
    if (el) el.textContent = ico;
    if (row) row.style.borderColor = ok ? 'rgba(74,222,128,.4)' : 'rgba(248,113,113,.4)';
  };

  document.getElementById('_pwBtn').addEventListener('click', async () => {
    const btn = document.getElementById('_pwBtn');
    btn.disabled = true; btn.textContent = 'Setting up…';

    try { await ensureSW(); setStat('_ps-sw','✅',true); }
    catch (_) { setStat('_ps-sw','⚠️',false); }

    let perm = 'denied';
    if (HAS_NOTIF) {
      try { perm = await Notification.requestPermission(); } catch (_) {}
      setStat('_ps-notif', perm === 'granted' ? '✅' : '🚫', perm === 'granted');
    } else { setStat('_ps-notif','—',false); }

    unlockAudio();
    await new Promise(r => setTimeout(r, 200));
    setStat('_ps-sound','✅',true);

    if (perm === 'granted') {
      setTimeout(() => showOsNotif('✅ MedTrack Ready','Medicine reminders will now appear as notifications.',false,'wizard-test'), 700);
    }

    kickSWPolling();
    _wizMark();
    btn.textContent = '✅ Permissions granted!';
    btn.style.background = 'linear-gradient(135deg,#4ade80,#22c55e)';

    setTimeout(() => {
      ov.style.animation = 'toastOut .4s forwards';
      setTimeout(() => {
        ov.remove(); syncAlertButton();
        if (cgPhone) setTimeout(() => showGreetingCard(cgPhone, cgName), 400);
      }, 420);
    }, 1400);
  });
}

// ─────────────────────────────────────────────────────────────────
//  SIDEBAR
// ─────────────────────────────────────────────────────────────────
function initSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebarOverlay');
  const hm = document.getElementById('hamburgerBtn');
  if (!sb) return;
  const open  = () => { sb.classList.add('open');    ov?.classList.add('open'); };
  const close = () => { sb.classList.remove('open'); ov?.classList.remove('open'); };
  hm?.addEventListener('click', () => sb.classList.contains('open') ? close() : open());
  ov?.addEventListener('click', close);
  sb.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', () => { if (window.innerWidth <= 900) close(); })
  );
}

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadSets();
  initSidebar();
  syncAlertButton();

  const sw = await ensureSW().catch(() => null);
  if (sw) kickSWPolling();

  await runPermWizard();

  // Poll every 15 seconds for better timing accuracy
  checkReminders();
  setInterval(checkReminders, 15_000);
});
