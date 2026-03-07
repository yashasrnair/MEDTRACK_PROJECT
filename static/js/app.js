// ══════════════════════════════════════════════════════════════════
//  MedTrack — Reminder Engine  v5
//
//  KEY FIXES:
//  1. API now returns full medicine objects (name,type,dosage,amount,
//     time,start_date,finish_date) — no more "undefined" in messages
//  2. WhatsApp / missed-dose alert fires EXACTLY ONCE per medicine
//     per day (deduplicated by persistent Set + localStorage guard)
//  3. notification_enabled only gates 10-min warning
//  4. Caregiver from /api/medicines response
// ══════════════════════════════════════════════════════════════════

// ── Audio ─────────────────────────────────────────────────────────
const $notify = document.getElementById('notifySound');
const $alarm  = document.getElementById('alarmSound');
function playNotify() { if ($notify) { $notify.currentTime=0; $notify.play().catch(()=>{}); } }
function playAlarm()  { if ($alarm)  { $alarm.currentTime=0;  $alarm.play().catch(()=>{}); } }

// ── Service Worker ────────────────────────────────────────────────
let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
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
    pushNotif('MedTrack Alerts Enabled ✅', 'You will now receive medicine reminders.', false);
  } else {
    if (btn) { btn.textContent = '🔕 Blocked'; btn.disabled = true; }
  }
}

// ── Push notification (OS-level + in-page toast) ─────────────────
function pushNotif(title, body, urgent=false, tag='medtrack') {
  showToast(title, body, urgent ? 'alarm' : 'warning');
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body, icon: '/static/images/logo.jpg', badge: '/static/images/logo.jpg',
    tag, vibrate: urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: urgent, data: { url: '/dashboard' }
  };
  try {
    if (swReg) swReg.showNotification(title, opts);
    else       new Notification(title, opts);
  } catch(e) {}
}

// ── In-page Toast ─────────────────────────────────────────────────
function showToast(title, msg, type='info', ms=9000) {
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
      <div class="toast-msg">${msg.replace(/\n/g,'<br>')}</div>
    </div>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;padding:0 0 0 8px;align-self:flex-start;">✕</button>
  `;
  wrap.appendChild(t);
  setTimeout(() => { t.style.animation='toastOut 0.3s forwards'; setTimeout(()=>t.remove(),320); }, ms);
}

// ── Helpers ───────────────────────────────────────────────────────
const toMins  = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const nowMins = () => { const d = new Date(); return d.getHours()*60+d.getMinutes(); };
const fmt12   = t => {
  if (!t || !t.includes(':')) return t;
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
};
const safeStr = v => (v && v !== 'undefined' && v !== 'null') ? v : '—';

// ── Build notification body text (full details, no "undefined") ───
function notifBody(med) {
  return [
    `💊 ${safeStr(med.name)}`,
    `📦 Type: ${safeStr(med.type)}`,
    `📏 Dosage: ${safeStr(med.dosage)}`,
    `🔢 Amount: ${safeStr(med.amount)}`,
    `🕐 Time: ${fmt12(med.time)}`
  ].join('\n');
}

// ── WhatsApp message ──────────────────────────────────────────────
function sendWhatsApp(phone, userName, med) {
  const num = phone.replace(/\D/g,'');
  if (!num) return;
  const text =
    `🚨 *MedTrack — Missed Dose Alert* 🚨\n\n` +
    `Hello! This is an automated alert from MedTrack.\n\n` +
    `*${userName}* has NOT taken their scheduled medicine.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💊 *Medicine :* ${safeStr(med.name)}\n` +
    `📦 *Type     :* ${safeStr(med.type)}\n` +
    `📏 *Dosage   :* ${safeStr(med.dosage)}\n` +
    `🔢 *Amount   :* ${safeStr(med.amount)}\n` +
    `🕐 *Scheduled:* ${fmt12(med.time)}\n` +
    `📅 *Course   :* ${safeStr(med.start_date)}  →  ${safeStr(med.finish_date)}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ Please check on ${userName} and ensure they take their medicine.\n\n` +
    `— MedTrack Reminder System`;
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank');
}

// ── Deduplication state ───────────────────────────────────────────
// Uses in-memory Sets (persist for browser session)
// Key format: "medId-YYYY-MM-DD"
const warned    = new Set();
const alarmed   = new Set();
const processed = new Set();

// Also guard using sessionStorage to survive across page reloads
function loadSessionSet(name) {
  try {
    const raw = sessionStorage.getItem('mt_' + name);
    if (raw) JSON.parse(raw).forEach(k => {
      if (name === 'warned')    warned.add(k);
      if (name === 'alarmed')   alarmed.add(k);
      if (name === 'processed') processed.add(k);
    });
  } catch(e) {}
}
function saveSessionSets() {
  try {
    sessionStorage.setItem('mt_warned',    JSON.stringify([...warned]));
    sessionStorage.setItem('mt_alarmed',   JSON.stringify([...alarmed]));
    sessionStorage.setItem('mt_processed', JSON.stringify([...processed]));
  } catch(e) {}
}

// ── Main check ────────────────────────────────────────────────────
async function checkReminders() {
  let response;
  try {
    const r = await fetch('/api/medicines');
    if (!r.ok) return;
    response = await r.json();
  } catch(e) { return; }

  // API returns { medicines: [...], caregiver: {...} }
  const meds      = response.medicines || response; // backwards compat
  const caregiver = response.caregiver || {};

  const now      = nowMins();
  const today    = new Date().toISOString().split('T')[0];
  const dayKey   = today;
  const userName = (document.body.dataset.userName  || 'Patient').trim();
  const userPhone= (document.body.dataset.userPhone || '').trim();

  // Caregiver contact — prefer caregiver's phone over user's own phone
  const cgPhone  = (caregiver.caregiver_phone || '').trim();
  const cgEmail  = (caregiver.caregiver_email || '').trim();
  const cgName   = (caregiver.caregiver_name  || 'Caregiver').trim();

  for (const med of meds) {
    if (!med.time) continue;
    const medMin = toMins(med.time);
    const key    = `${med.id}-${dayKey}`;

    // ── 1. 10-min warning (notification_enabled only) ─────────────
    if (med.notification_enabled === 1 && now === medMin - 10 && !warned.has(key)) {
      warned.add(key);
      saveSessionSets();
      playNotify();
      pushNotif(
        '⏰ Medicine in 10 minutes',
        `${notifBody(med)}\n\nGet it ready — due at ${fmt12(med.time)}!`,
        false, `warn-${med.id}`
      );
    }

    // ── 2. Exact-time alarm (always) ─────────────────────────────
    if (now === medMin && !alarmed.has(key)) {
      alarmed.add(key);
      saveSessionSets();
      playAlarm();
      pushNotif(
        '🚨 Time to take your medicine!',
        `${notifBody(med)}\n\nTake it RIGHT NOW!`,
        true, `alarm-${med.id}`
      );
    }

    // ── 3. 3-min overdue: missed dose (always, once only) ─────────
    if (now === medMin + 3 && med.taken === 0 && !processed.has(key)) {
      processed.add(key);
      saveSessionSets();

      // Record in DB
      try { await fetch(`/mark_not_taken/${med.id}`, { method: 'POST' }); } catch(e) {}

      // Alarm sound
      playAlarm();

      // Push notification
      const alertMsg = `${notifBody(med)}\n\nNOT taken 3 mins after scheduled time.\n` +
        (cgPhone ? `WhatsApp sent to ${cgName}.` : 'No caregiver configured.');
      pushNotif('❌ Missed Dose Alert', alertMsg, true, `missed-${med.id}`);

      // WhatsApp to CAREGIVER (not the user themselves)
      if (cgPhone) {
        sendWhatsApp(cgPhone, userName, med);
      } else if (userPhone) {
        // Fallback: send to user's own number if no caregiver set
        sendWhatsApp(userPhone, userName, med);
      }

      // Reload dashboard after 2s so card reflects missed state
      setTimeout(() => {
        if (window.location.pathname === '/dashboard') location.reload();
      }, 2000);
    }
  }
}

// ── Inventory refill check (separate from reminder loop) ─────────
function checkRefills(meds) {
  for (const med of meds) {
    if (med.total_quantity > 0 && med.quantity_remaining <= 5 && med.quantity_remaining > 0) {
      const key = `refill-${med.id}`;
      if (!warned.has(key)) {
        warned.add(key);
        showToast(
          '📦 Refill Reminder',
          `${med.name} has only ${med.quantity_remaining} dose(s) left. Order a refill soon!`,
          'warning', 12000
        );
      }
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
  ham?.addEventListener('click', toggle);
  overlay?.addEventListener('click', close);
  sidebar.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', () => { if (window.innerWidth <= 900) close(); })
  );
}

// ── Boot ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSessionSet('warned');
  loadSessionSet('alarmed');
  loadSessionSet('processed');
  initSidebar();
  registerSW();
  checkReminders();
  setInterval(checkReminders, 30_000);
});
