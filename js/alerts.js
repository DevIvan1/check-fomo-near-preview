// Sound (Web Audio, no files), desktop notifications, tab title and favicon badge.

let ctx = null;
let unlocked = false;
const listeners = new Set();

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

export function audioState() {
  const c = ctx;
  return c ? c.state : 'suspended';
}

export function onAudioStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Browsers only allow audio after a user gesture; call this from any click/keydown.
export async function unlockAudio() {
  const c = audio();
  if (!c) return false;
  try {
    if (c.state !== 'running') await c.resume();
  } catch {
    /* still locked */
  }
  const ok = c.state === 'running';
  if (ok !== unlocked) {
    unlocked = ok;
    listeners.forEach((fn) => fn(ok));
  }
  return ok;
}

const PATTERNS = {
  buy: [[659.25, 0], [987.77, 0.13]],
  sell: [[987.77, 0], [659.25, 0.13]],
  info: [[783.99, 0]],
  warn: [[880, 0], [880, 0.16], [880, 0.32]],
};

export function playSound(kind = 'info', volume = 0.6) {
  const c = audio();
  if (!c || c.state !== 'running') return false;
  const notes = PATTERNS[kind] || PATTERNS.info;
  const t0 = c.currentTime + 0.02;
  const vol = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.35;
  if (vol < 0.001) return false; // exponential ramps cannot target 0
  for (const [freq, offset] of notes) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const s = t0 + offset;
    gain.gain.setValueAtTime(0.0001, s);
    gain.gain.exponentialRampToValueAtTime(vol, s + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.32);
    osc.connect(gain).connect(c.destination);
    osc.start(s);
    osc.stop(s + 0.35);
  }
  return true;
}

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showNotification(title, body, tag, iconUrl) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, icon: iconUrl || undefined, silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some browsers require a service worker for notifications */
  }
}

// ---- Tab title + favicon badge ----

const baseTitle = { text: document.title };
let unread = 0;
let lastHeadline = '';

export function setBaseTitle(t) {
  baseTitle.text = t;
  renderTitle();
}

export function bumpUnread(headline) {
  unread += 1;
  lastHeadline = headline || lastHeadline;
  renderTitle();
}

export function clearUnread() {
  unread = 0;
  renderTitle();
}

function renderTitle() {
  document.title = unread > 0 ? `(${unread}) ${lastHeadline} · ${baseTitle.text}` : baseTitle.text;
  setFavicon(unread > 0);
}

function setFavicon(dot) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#1c1c1e"/><path d="M5 12.5h3l2.2-5 3.6 9.5 2.2-4.5H19" fill="none" stroke="#f5f5f7" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>${dot ? '<circle cx="19.5" cy="4.5" r="4.5" fill="#d9534f" stroke="#fff" stroke-width="1.2"/>' : ''}</svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}
