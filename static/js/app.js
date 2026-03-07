// ══════════════════════════════════════════════════════════════════
//  MedTrack — Reminder Engine  v8
//
//  FIXES vs v6:
//  1. BACKGROUND NOTIFICATIONS: page tells SW to start polling.
//     SW polls /api/medicines every 30s independently — fires OS
//     notifications even when Chrome is in background / minimised.
//     Page engine still runs when foreground (belt + suspenders).
//
//  2. WHATSAPP POPUP BLOCKER FIX:
//     window.open() from setInterval is NOT a user gesture → blocked.
//     Fix: WhatsApp URL is embedded in the OS notification itself as
//     an action button. Tapping "Alert Caregiver on WhatsApp" IS a
//     user gesture — opens WhatsApp with no blocker.
//     The wizard also sends a test WhatsApp greeting immediately
//     so the popup permission is granted upfront, first time.
//
//  3. INVENTORY: dose amount parsed correctly (e.g. "2 tablets" → 2)
//     Handled in app.py; JS just reads the corrected values.
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
    const v = el.volume; el.volume = 0.001;
    el.play().then(() => { el.pause(); el.currentTime = 0; el.volume = v; }).catch(()=>{});
  });
}
['click','touchstart','keydown'].forEach(ev =>
  document.addEventListener(ev, unlockAudio, { once:true, passive:true })
);
function playNotify() { if($notify){$notify.currentTime=0;$notify.play().catch(()=>{});} }
function playAlarm()  { if($alarm) {$alarm.currentTime=0; $alarm.play().catch(()=>{});} }

// ─────────────────────────────────────────────────────────────────
//  PLATFORM DETECTION
// ─────────────────────────────────────────────────────────────────
const IS_IOS     = /iphone|ipad|ipod/i.test(navigator.userAgent);
const IS_MOBILE  = IS_IOS || /android/i.test(navigator.userAgent);
const IS_IOS_PWA = IS_IOS && window.matchMedia('(display-mode:standalone)').matches;
const HAS_NOTIF  = 'Notification' in window && 'serviceWorker' in navigator;

// ─────────────────────────────────────────────────────────────────
//  SERVICE WORKER  — registers once, then sends START_POLLING msg
//  so the SW can fire notifications even when page is backgrounded
// ─────────────────────────────────────────────────────────────────
let _swReg = null;

async function ensureSW() {
  if (!('serviceWorker' in navigator)) return null;
  if (_swReg?.active) return _swReg;
  try {
    _swReg = await navigator.serviceWorker.register('/sw.js', { scope:'/' });
    // Wait for activation
    const sw = _swReg.installing || _swReg.waiting;
    if (sw && !_swReg.active) {
      await new Promise((ok, fail) => {
        const t = setTimeout(() => fail(new Error('SW timeout')), 8000);
        sw.addEventListener('statechange', function h(e) {
          if (e.target.state === 'activated') { clearTimeout(t); sw.removeEventListener('statechange',h); ok(); }
          if (e.target.state === 'redundant') { clearTimeout(t); sw.removeEventListener('statechange',h); fail(new Error('SW redundant')); }
        });
      });
    }
    if (!navigator.serviceWorker.controller) {
      await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));
    }
    _swReg = await navigator.serviceWorker.ready;
    return _swReg;
  } catch(e) { console.warn('[MT] SW error:', e.message); return null; }
}

// Tell the SW to start background polling + pass user name for WA messages
function kickSWPolling() {
  if (!navigator.serviceWorker?.controller) return;
  const userName = (document.body.dataset.userName || 'Patient').trim();
  navigator.serviceWorker.controller.postMessage({ type: 'USER_INFO', userName });
  navigator.serviceWorker.controller.postMessage({ type: 'START_POLLING' });
}

// Listen for MISSED_DOSE messages from SW (reload dashboard card)
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'MISSED_DOSE' && location.pathname === '/dashboard') {
    setTimeout(() => location.reload(), 1500);
  }
});

// ─────────────────────────────────────────────────────────────────
//  OS NOTIFICATION (page-side, for foreground reinforcement)
// ─────────────────────────────────────────────────────────────────
async function showOsNotif(title, body, urgent=false, tag='medtrack', waNum='', waText='') {
  if (!HAS_NOTIF || Notification.permission !== 'granted') return;
  const opts = {
    body, icon:'/static/images/logo.jpg', badge:'/static/images/logo.jpg',
    tag, renotify:true, silent:false,
    vibrate: urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: false,
    data: { url:'/dashboard', waNum, waText }
  };
  if (waNum) {
    opts.actions = [
      { action:'whatsapp', title:'📲 Alert Caregiver on WhatsApp' },
      { action:'open',     title:'💊 Open MedTrack' }
    ];
  }
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_,r) => setTimeout(()=>r(new Error('ready timeout')), 3000))
    ]).catch(()=>null);
    if (reg?.active) { await reg.showNotification(title, opts); return; }
  } catch(e) { console.warn('[MT] SW notif failed:', e.message); }
  if (!IS_MOBILE) {
    try { const n=new Notification(title,opts); n.onclick=()=>{window.focus();n.close();}; } catch(_) {}
  }
}

// ─────────────────────────────────────────────────────────────────
//  IN-PAGE TOAST
// ─────────────────────────────────────────────────────────────────
function showToast(title, msg, type='info', ms=9000) {
  let w = document.getElementById('toast-container');
  if (!w) { w=document.createElement('div'); w.id='toast-container'; document.body.appendChild(w); }
  const icons = {alarm:'🚨',warning:'⏰',info:'💊',success:'✅',guide:'📲'};
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <div class="toast-icon">${icons[type]||'💊'}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${String(msg).replace(/\n/g,'<br>')}</div>
    </div>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:var(--muted);cursor:pointer;
             font-size:15px;padding:0 0 0 8px;align-self:flex-start;flex-shrink:0;">✕</button>`;
  w.appendChild(t);
  setTimeout(()=>{ t.style.animation='toastOut 0.3s forwards'; setTimeout(()=>t.remove(),320); },ms);
}

function pushNotif(title, body, urgent=false, tag='medtrack', waNum='', waText='') {
  showToast(title, body, urgent?'alarm':'warning');
  showOsNotif(title, body, urgent, tag, waNum, waText);
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
const toMins  = t => { const [h,m]=t.split(':').map(Number); return h*60+m; };
const nowMins = () => { const d=new Date(); return d.getHours()*60+d.getMinutes(); };
const fmt12   = t => {
  if(!t||!t.includes(':')) return t||'';
  const [h,m]=t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
};
const safeStr = v => (v&&v!=='undefined'&&v!=='null') ? v : '—';

function notifBody(med) {
  return [`💊 ${safeStr(med.name)}`,`📦 ${safeStr(med.type)}`,
          `📏 ${safeStr(med.dosage)}`,`🔢 ${safeStr(med.amount)}`,
          `🕐 ${fmt12(med.time)}`].join('\n');
}

// ─────────────────────────────────────────────────────────────────
//  WHATSAPP — builds URL, but page-side is now only used for
//  the wizard greeting test. Missed-dose alerts go through SW action.
// ─────────────────────────────────────────────────────────────────
function buildWaUrl(phone, text) {
  const num = phone.replace(/\D/g,'');
  if (!num) return '';
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

function buildWaText(userName, med) {
  return (
    `🚨 *MedTrack — Missed Dose Alert* 🚨\n\n` +
    `*${userName}* has NOT taken their medicine.\n\n` +
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

// ─────────────────────────────────────────────────────────────────
//  DEDUPLICATION (sessionStorage — survives page reload in same tab)
// ─────────────────────────────────────────────────────────────────
const warned=new Set(), alarmed=new Set(), processed=new Set();
function loadSets() {
  try {
    (JSON.parse(sessionStorage.getItem('mt_w')||'[]')).forEach(k=>warned.add(k));
    (JSON.parse(sessionStorage.getItem('mt_a')||'[]')).forEach(k=>alarmed.add(k));
    (JSON.parse(sessionStorage.getItem('mt_p')||'[]')).forEach(k=>processed.add(k));
  } catch(_) {}
}
function saveSets() {
  try {
    sessionStorage.setItem('mt_w',JSON.stringify([...warned]));
    sessionStorage.setItem('mt_a',JSON.stringify([...alarmed]));
    sessionStorage.setItem('mt_p',JSON.stringify([...processed]));
  } catch(_) {}
}

// ─────────────────────────────────────────────────────────────────
//  PAGE-SIDE REMINDER ENGINE (foreground reinforcement)
//  The SW handles background. This handles foreground sounds + toasts.
// ─────────────────────────────────────────────────────────────────
async function checkReminders() {
  let resp;
  try { const r=await fetch('/api/medicines'); if(!r.ok)return; resp=await r.json(); }
  catch(_){return;}

  const meds      = Array.isArray(resp)?resp:(resp.medicines||[]);
  const caregiver = Array.isArray(resp)?{}:(resp.caregiver||{});
  const now       = nowMins();
  const todayStr  = new Date().toISOString().split('T')[0];
  const userName  = (document.body.dataset.userName||'Patient').trim();
  const userPhone = (document.body.dataset.userPhone||'').trim();
  const cgPhone   = (caregiver.caregiver_phone||'').trim();
  const cgName    = (caregiver.caregiver_name||'Caregiver').trim();

  for (const med of meds) {
    if (!med.time) continue;
    const medMin = toMins(med.time);
    const key    = `${med.id}-${todayStr}`;

    // 1 · 10-min warning
    if (med.notification_enabled===1 && now===medMin-10 && !warned.has(key)) {
      warned.add(key); saveSets(); playNotify();
      pushNotif('⏰ Medicine in 10 minutes',
        `${notifBody(med)}\n\nGet it ready — due at ${fmt12(med.time)}!`,
        false, `warn-${med.id}`);
    }

    // 2 · Exact-time alarm
    if (now===medMin && !alarmed.has(key)) {
      alarmed.add(key); saveSets(); playAlarm();
      pushNotif('🚨 Time to take your medicine!',
        `${notifBody(med)}\n\nTake it RIGHT NOW!`,
        true, `alarm-${med.id}`);
    }

    // 3 · 3-min overdue — WhatsApp now goes through notification action (SW handles it)
    //     Page just records the miss and shows a toast. No window.open() here.
    if (now===medMin+3 && med.taken===0 && !processed.has(key)) {
      processed.add(key); saveSets();
      try { await fetch(`/mark_not_taken/${med.id}`,{method:'POST'}); } catch(_) {}
      playAlarm();

      // Build WA data for notification action button (no popup blocker)
      const waText = buildWaText(userName, med);
      const waNum  = (cgPhone||userPhone).replace(/\D/g,'');

      pushNotif('❌ Missed Dose — Tap to Alert Caregiver',
        `${notifBody(med)}\n\nNOT taken. Tap the WhatsApp button in the notification to alert ${cgName}.`,
        true, `missed-${med.id}`, waNum, waText);

      setTimeout(()=>{ if(location.pathname==='/dashboard') location.reload(); }, 2000);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  TOPBAR "ENABLE ALERTS" BUTTON — always reads real perm state
// ─────────────────────────────────────────────────────────────────
function syncAlertButton() {
  const btn = document.getElementById('notifPermBtn');
  if (!btn) return;

  if (IS_IOS && !IS_IOS_PWA) {
    btn.style.cssText='display:inline-flex;background:#f59e0b;color:#fff;border:none;';
    btn.textContent='📲 Install App'; btn.disabled=false; btn.onclick=showIosGuide; return;
  }
  if (!HAS_NOTIF) { btn.style.display='none'; return; }

  const p = Notification.permission;
  if (p==='granted') { btn.style.display='none'; }
  else if (p==='denied') {
    btn.style.cssText='display:inline-flex;background:rgba(248,113,113,0.15);color:#f87171;border:1px solid rgba(248,113,113,0.3);cursor:default;';
    btn.textContent='🔕 Blocked'; btn.disabled=true;
    btn.title='Notifications blocked. Go to browser Site Settings → Notifications to allow.';
  } else {
    btn.style.cssText='display:inline-flex;'; btn.textContent='🔔 Enable Alerts';
    btn.disabled=false; btn.onclick=handleEnableAlerts;
  }
}

async function handleEnableAlerts() {
  const btn=document.getElementById('notifPermBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳';}
  await ensureSW().catch(()=>{});
  let perm='denied';
  try{perm=await Notification.requestPermission();}catch(_){}
  if (perm==='granted') {
    await showOsNotif('✅ MedTrack Alerts Active','Medicine reminders will now appear on this device.',false,'perm-test');
    showToast('Alerts enabled ✅','OS notifications are now active.','success',5000);
    kickSWPolling();
  }
  syncAlertButton();
}

function showIosGuide() {
  if (document.getElementById('iosGuide')) { document.getElementById('iosGuide').remove(); return; }
  const d=document.createElement('div'); d.id='iosGuide';
  d.style.cssText='position:fixed;bottom:72px;left:12px;right:12px;z-index:9999;background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:18px 20px;box-shadow:0 16px 48px rgba(0,0,0,.65);animation:toastIn .3s ease;';
  d.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;"><div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:.95rem;">📲 Enable Notifications on iPhone</div><button onclick="this.closest('#iosGuide').remove()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">✕</button></div><div style="font-size:.82rem;color:var(--muted);line-height:1.75;"><b style="color:var(--text)">1.</b> Tap <b style="color:var(--blue)">Share ⬆</b> in Safari<br><b style="color:var(--text)">2.</b> Tap <b style="color:var(--blue)">"Add to Home Screen"</b><br><b style="color:var(--text)">3.</b> Open MedTrack from Home Screen<br><b style="color:var(--text)">4.</b> Tap "Enable Alerts" inside the app</div>`;
  document.body.appendChild(d);
  setTimeout(()=>{if(d.parentNode)d.remove();},18000);
}

// ─────────────────────────────────────────────────────────────────
//  FIRST-TIME PERMISSION WIZARD
//  Extra step: sends a WhatsApp greeting to the caregiver immediately
//  so that the popup-allow permission is granted once, upfront.
//  From then on, the OS notification action button handles WA opens
//  without any popup blocker issue.
// ─────────────────────────────────────────────────────────────────
function _devFP() {
  return btoa(navigator.userAgent.replace(/\s/g,'').slice(0,40)+screen.width+'x'+screen.height)
    .replace(/\W/g,'').slice(0,20);
}
function _wKey() { return `mt_perm_v3_${document.body.dataset.userId||'g'}_${_devFP()}`; }
const _wDone  = ()=>{ try{return !!localStorage.getItem(_wKey());}catch{return true;} };
const _wMark  = ()=>{ try{localStorage.setItem(_wKey(),'1');}catch(_){} };

async function runPermWizard() {
  if (_wDone()) return;
  if (IS_IOS && !IS_IOS_PWA) { _wMark(); setTimeout(showIosGuide,1500); syncAlertButton(); return; }
  if (HAS_NOTIF && Notification.permission==='granted') { _wMark(); return; }

  const ov = document.createElement('div');
  ov.id='permWizard';
  ov.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(8,12,18,0.97);display:flex;align-items:center;justify-content:center;padding:20px;animation:toastIn .35s ease;';

  // Fetch caregiver phone for greeting step
  let cgPhone='', cgName='Caregiver';
  try {
    const r=await fetch('/api/medicines'); const d=await r.json();
    cgPhone=(d.caregiver?.caregiver_phone||'').trim();
    cgName=(d.caregiver?.caregiver_name||'Caregiver').trim();
  } catch(_) {}

  const hasCaregiver = cgPhone.replace(/\D/g,'').length >= 7;

  ov.innerHTML=`
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:22px;
      padding:36px 28px;max-width:460px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.7);text-align:center;">
      <img src="/static/images/logo.jpg" style="width:60px;height:60px;border-radius:13px;margin-bottom:16px;object-fit:cover;">
      <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:1.4rem;letter-spacing:-.02em;margin-bottom:8px;">
        Allow MedTrack Permissions
      </div>
      <div style="color:var(--muted);font-size:.84rem;margin-bottom:26px;line-height:1.65;">
        Grant these once — MedTrack will handle everything automatically after this.
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px;text-align:left;">
        <div class="_pr" id="_pr-sw">
          <span class="_pi">⚙️</span><div class="_pn"><div class="_pt">Background Service</div><div class="_pd">Fires reminders even when the app is minimised</div></div>
          <span class="_ps" id="_ps-sw">⏳</span>
        </div>
        <div class="_pr" id="_pr-notif">
          <span class="_pi">🔔</span><div class="_pn"><div class="_pt">OS Notifications</div><div class="_pd">Alerts appear on your lock screen &amp; notification bar</div></div>
          <span class="_ps" id="_ps-notif">⏳</span>
        </div>
        <div class="_pr" id="_pr-sound">
          <span class="_pi">🔊</span><div class="_pn"><div class="_pt">Sound &amp; Alarm</div><div class="_pd">Audible beep and alarm tones</div></div>
          <span class="_ps" id="_ps-sound">⏳</span>
        </div>
        <div class="_pr" id="_pr-wa">
          <span class="_pi">📲</span><div class="_pn"><div class="_pt">WhatsApp Caregiver Alerts</div>
          <div class="_pd">${hasCaregiver
            ? `Sends a greeting to <b style="color:var(--text)">${cgName}</b> now to unblock pop-ups`
            : 'Set a caregiver phone in Settings to enable'}</div></div>
          <span class="_ps" id="_ps-wa">${hasCaregiver?'⏳':'—'}</span>
        </div>
      </div>

      <button id="_pwBtn" style="width:100%;padding:14px;background:linear-gradient(135deg,#60a5fa,#7c3aed);color:#fff;border:none;border-radius:12px;font-family:'Outfit',sans-serif;font-size:1rem;font-weight:700;cursor:pointer;box-shadow:0 6px 24px rgba(96,165,250,.35);">
        Allow All &amp; Send Greeting →
      </button>
      <div style="margin-top:12px;font-size:.76rem;color:var(--muted2);">
        This screen only appears once per account per device.
      </div>
    </div>
    <style>
      ._pr{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:11px;}
      ._pi{font-size:20px;flex-shrink:0;}._pn{flex:1;}
      ._pt{font-weight:700;font-size:.85rem;margin-bottom:2px;}
      ._pd{font-size:.73rem;color:var(--muted);line-height:1.35;}
      ._ps{font-size:17px;flex-shrink:0;min-width:22px;text-align:center;}
    </style>`;

  document.body.appendChild(ov);

  const setStat=(id,ico,ok)=>{
    const el=document.getElementById(id);
    const row=document.getElementById(id.replace('_ps','_pr'));
    if(el)el.textContent=ico;
    if(row)row.style.borderColor=ok?'rgba(74,222,128,.4)':'rgba(248,113,113,.4)';
  };

  document.getElementById('_pwBtn').addEventListener('click', async ()=>{
    const btn=document.getElementById('_pwBtn');
    btn.disabled=true; btn.textContent='Setting up…';

    // Step 1: Register SW
    try { await ensureSW(); setStat('_ps-sw','✅',true); }
    catch(e){ setStat('_ps-sw','⚠️',false); }

    // Step 2: Notification permission
    let perm='denied';
    if (HAS_NOTIF) {
      try{perm=await Notification.requestPermission();}catch(_){}
      setStat('_ps-notif', perm==='granted'?'✅':'🚫', perm==='granted');
    } else { setStat('_ps-notif','—',false); }

    // Step 3: Audio unlock
    unlockAudio();
    await new Promise(r=>setTimeout(r,200));
    setStat('_ps-sound','✅',true);

    // Step 4: WhatsApp greeting — send NOW so popup is pre-approved
    //   window.open() inside a click handler IS a user gesture → no blocker
    if (hasCaregiver) {
      const userName=(document.body.dataset.userName||'Patient').trim();
      const greetText=
        `👋 *Hello from MedTrack!*\n\n` +
        `This is a setup greeting from the MedTrack medicine reminder app.\n\n` +
        `*${userName}* has added you as their caregiver. ` +
        `If ${userName} misses a scheduled medicine dose, you will receive ` +
        `an automated alert here on WhatsApp.\n\n` +
        `No action needed right now — this is just a confirmation that the alerts are set up correctly. ✅\n\n` +
        `— MedTrack Reminder System`;
      const waUrl=buildWaUrl(cgPhone, greetText);
      if (waUrl) {
        // window.open here is safe — we're inside a click handler
        window.open(waUrl, '_blank');
        setStat('_ps-wa','✅',true);
      }
    } else {
      setStat('_ps-wa','—',false);
    }

    // Step 5: Test OS notification
    if (perm==='granted') {
      setTimeout(()=>showOsNotif(
        '✅ MedTrack Ready',
        'Medicine reminders will appear as notifications. Tap to open the app.',
        false,'wizard-test'
      ), 700);
    }

    // Kick SW background polling
    kickSWPolling();

    _wMark();
    btn.textContent='✅ All Set!';
    btn.style.background='linear-gradient(135deg,#4ade80,#22c55e)';

    setTimeout(()=>{
      ov.style.animation='toastOut .4s forwards';
      setTimeout(()=>{ ov.remove(); syncAlertButton(); },420);
    },1500);
  });
}

// ─────────────────────────────────────────────────────────────────
//  SIDEBAR
// ─────────────────────────────────────────────────────────────────
function initSidebar() {
  const sb=document.getElementById('sidebar');
  const ov=document.getElementById('sidebarOverlay');
  const hm=document.getElementById('hamburgerBtn');
  if (!sb) return;
  const open=()=>{sb.classList.add('open');ov?.classList.add('open');};
  const close=()=>{sb.classList.remove('open');ov?.classList.remove('open');};
  hm?.addEventListener('click',()=>sb.classList.contains('open')?close():open());
  ov?.addEventListener('click',close);
  sb.querySelectorAll('.nav-item').forEach(el=>
    el.addEventListener('click',()=>{if(window.innerWidth<=900)close();})
  );
}

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async ()=>{
  loadSets();
  initSidebar();
  syncAlertButton();

  // Register SW and start background polling
  const sw = await ensureSW().catch(()=>null);
  if (sw) kickSWPolling();

  // Show wizard (first time only)
  await runPermWizard();

  // Page-side foreground engine (sound + toast reinforcement)
  checkReminders();
  setInterval(checkReminders, 30_000);
});
