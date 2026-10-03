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

// [frequency Hz, start offset s]. Three-note phrases, so an alert is noticeable but short.
const PATTERNS = {
  buy: [[659.25, 0], [830.61, 0.16], [987.77, 0.32]],
  sell: [[987.77, 0], [830.61, 0.16], [659.25, 0.32]],
  info: [[783.99, 0], [1046.5, 0.18]],
  follow: [[880, 0], [1108.73, 0.14], [1318.51, 0.28]],
  warn: [[880, 0], [880, 0.2], [880, 0.4]],
};
const NOTE_SEC = 0.7; // each note rings out ~0.7 s

let master = null;
function output(c) {
  if (!master) {
    // A compressor lets the tone be loud without clipping on laptop speakers.
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master = c.createGain();
    master.gain.value = 1.6;
    master.connect(comp).connect(c.destination);
  }
  return master;
}

export function playSound(kind = 'info', volume = 0.8) {
  const c = audio();
  if (!c || c.state !== 'running') return false;
  const notes = PATTERNS[kind] || PATTERNS.info;
  const t0 = c.currentTime + 0.02;
  const vol = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.9;
  if (vol < 0.001) return false; // exponential ramps cannot target 0
  const out = output(c);
  for (const [freq, offset] of notes) {
    const s = t0 + offset;
    // A sine plus a quieter triangle an octave up sounds fuller than a bare sine.
    for (const [type, mult, level] of [['sine', 1, 1], ['triangle', 2, 0.25]]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.value = freq * mult;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.exponentialRampToValueAtTime(vol * level, s + 0.012);
      gain.gain.exponentialRampToValueAtTime(vol * level * 0.35, s + 0.18);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + NOTE_SEC);
      osc.connect(gain).connect(out);
      osc.start(s);
      osc.stop(s + NOTE_SEC + 0.05);
    }
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#1c1c1e"/><path d="M5.5 12.5l4 4L18.5 7.5M14 7.5h4.5V12" fill="none" stroke="#f5f5f7" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>${dot ? '<circle cx="19.5" cy="4.5" r="4.5" fill="#d9534f" stroke="#fff" stroke-width="1.2"/>' : ''}</svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}
