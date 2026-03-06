// ══════════════════════════════════════════════════════════════════
//  MedTrack — Reminder Engine  v4
//
//  RULES:
//  1. notification_enabled = 0  →  skip ONLY the 10-min warning
//     Exact-time alarm + missed-dose alert ALWAYS fire
//  2. 3 minutes after scheduled time → check if taken
//     If NOT taken → save to history (POST /mark_not_taken)
//                  → show push notification with full details
//                  → open WhatsApp with full medicine info
//                  → reload dashboard (card disappears)
//  3. All sounds from local WAV files
//  4. Real OS push notifications via Service Worker
// ══════════════════════════════════════════════════════════════════

// ── Audio (local files, no internet) ─────────────────────────────
const $notify = document.getElementById('notifySound');
const $alarm  = document.getElementById('alarmSound');

function playNotify() { if (!$notify) return; $notify.currentTime = 0; $notify.play().catch(()=>{}); }
function playAlarm()  { if (!$alarm)  return; $alarm.currentTime  = 0; $alarm.play().catch(()=>{});  }

// ── Service Worker Registration ───────────────────────────────────
let swReg = null;

async function registerSW() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Show "Enable Alerts" button if permission not yet decided
    if (Notification.permission === 'default') {
      const btn = document.getElementById('notifPermBtn');
      if (btn) btn.style.display = 'inline-flex';
    }
  } catch(e) { console.warn('SW registration failed', e); }
}

async function requestPushPermission() {
  const perm = await Notification.requestPermission();
  const btn  = document.getElementById('notifPermBtn');
  if (perm === 'granted') {
    if (btn) btn.style.display = 'none';
    pushNotif('MedTrack Alerts Enabled ✅',
      'You\'ll now receive medicine reminders on this device.', false);
  } else {
    if (btn) { btn.textContent = '🔕 Blocked'; btn.disabled = true; }
  }
}

// ── Push Notification (real OS notification) ──────────────────────
function pushNotif(title, body, urgent = false, tag = 'medtrack') {
  // Always show the in-page toast as a fallback
  showToast(title, body, urgent ? 'alarm' : 'warning');

  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const opts = {
    body,
    icon:    '/static/images/logo.jpg',
    badge:   '/static/images/logo.jpg',
    tag,
    vibrate: urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: urgent,
    data: { url: '/dashboard' }
  };
  try {
    if (swReg) swReg.showNotification(title, opts);
    else       new Notification(title, opts);
  } catch(e) {}
}

// ── In-page Toast ─────────────────────────────────────────────────
function showToast(title, msg, type = 'info', ms = 9000) {
  let wrap = document.getElementById('toast-container');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-container';
    document.body.appendChild(wrap);
  }
  const icons = { alarm:'🚨', warning:'⏰', info:'💊', success:'✅' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <div class="toast-icon">${icons[type]||'💊'}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;padding:0 0 0 8px;align-self:flex-start;">✕</button>
  `;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut 0.3s forwards';
    setTimeout(() => t.remove(), 320);
  }, ms);
}

// ── Helpers ───────────────────────────────────────────────────────
const toMins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const nowMins = () => { const d = new Date(); return d.getHours()*60 + d.getMinutes(); };
const fmt12 = t => {
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
};

// ── Notification body builder (full medicine info) ────────────────
function notifBody(med) {
  return [
    `💊 ${med.name}`,
    `📦 Type: ${med.type}`,
    `📏 Dosage: ${med.dosage}`,
    `🔢 Amount: ${med.amount}`,
    `🕐 Time: ${fmt12(med.time)}`
  ].join('\n');
}

// ── WhatsApp message builder ──────────────────────────────────────
function sendWhatsApp(phone, userName, med) {
  const num = phone.replace(/\D/g,'');
  if (!num) return;

  const text =
    `🚨 *MedTrack — Missed Dose Alert* 🚨\n\n` +
    `Hello! This is an automated alert from MedTrack.\n\n` +
    `*${userName}* has NOT taken their scheduled medicine.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💊 *Medicine :* ${med.name}\n` +
    `📦 *Type     :* ${med.type}\n` +
    `📏 *Dosage   :* ${med.dosage}\n` +
    `🔢 *Amount   :* ${med.amount}\n` +
    `🕐 *Scheduled:* ${fmt12(med.time)}\n` +
    `📅 *Course   :* ${med.start_date}  →  ${med.finish_date}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ Please check on ${userName} and make sure they take their medicine.\n\n` +
    `— MedTrack Reminder System`;

  window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank');
}

// ── Per-session state (avoids duplicate alerts) ───────────────────
const warned    = new Set(); // key = medId-dayString  → 10-min warning sent
const alarmed   = new Set(); // → exact-time alarm sent
const processed = new Set(); // → missed-dose processed

// ── Main check ────────────────────────────────────────────────────
async function checkReminders() {
  let meds;
  try {
    const r = await fetch('/api/medicines');
    if (!r.ok) return;
    meds = await r.json();
  } catch(e) { return; }

  const now      = nowMins();
  const dayKey   = new Date().toDateString();
  const userName = (document.body.dataset.userName  || 'Patient').trim();
  const phone    = (document.body.dataset.userPhone || '').trim();

  for (const med of meds) {
    const medMin = toMins(med.time);
    const key    = `${med.id}-${dayKey}`;

    // ── 10-min advance warning ──────────────────────────────────
    // ONLY when notification_enabled = 1
    if (med.notification_enabled === 1 && now === medMin - 10 && !warned.has(key)) {
      warned.add(key);
      playNotify();
      pushNotif(
        '⏰ Medicine in 10 minutes',
        `${notifBody(med)}\n\nGet it ready — due at ${fmt12(med.time)}!`,
        false,
        `warn-${med.id}`
      );
    }

    // ── Exact-time alarm ─────────────────────────────────────────
    // ALWAYS fires (regardless of notification_enabled)
    if (now === medMin && !alarmed.has(key)) {
      alarmed.add(key);
      playAlarm();
      pushNotif(
        '🚨 Time to take your medicine!',
        `${notifBody(med)}\n\nTake it RIGHT NOW!`,
        true,
        `alarm-${med.id}`
      );
    }

    // ── 3-min overdue: missed dose ────────────────────────────────
    // ALWAYS fires (regardless of notification_enabled)
    if (now === medMin + 3 && med.taken === 0 && !processed.has(key)) {
      processed.add(key);

      // 1. Record as not-taken in DB (adds to history)
      try { await fetch(`/mark_not_taken/${med.id}`, { method: 'POST' }); } catch(e) {}

      // 2. Alarm sound
      playAlarm();

      // 3. Push notification with all details
      pushNotif(
        '❌ Missed Dose — Alerting Guardian',
        `${notifBody(med)}\n\nNOT taken 3 mins after scheduled time.\nNotifying emergency contact via WhatsApp.`,
        true,
        `missed-${med.id}`
      );

      // 4. WhatsApp to guardian
      if (phone) sendWhatsApp(phone, userName, med);

      // 5. Reload dashboard so card moves to history
      setTimeout(() => { if (document.querySelector('.med-grid')) location.reload(); }, 1800);
    }
  }
}

// ── Sidebar / Hamburger ───────────────────────────────────────────
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const ham     = document.getElementById('hamburgerBtn');
  if (!sidebar) return;

  const open  = () => { sidebar.classList.add('open');    overlay.classList.add('open'); };
  const close = () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); };
  const toggle= () => sidebar.classList.contains('open') ? close() : open();

  // Hamburger click
  ham?.addEventListener('click', toggle);
  // Overlay click closes sidebar
  overlay?.addEventListener('click', close);
  // Nav link tap on mobile → close sidebar
  sidebar.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', () => { if (window.innerWidth <= 900) close(); })
  );
}

// ── Boot ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSidebar();
  registerSW();
  checkReminders();
  setInterval(checkReminders, 30_000);
});
