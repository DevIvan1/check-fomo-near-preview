// Pure helpers: encoding, BigInt math, number and time formatting.

export function b64ToText(b64) {
  if (typeof b64 !== 'string') return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function tryJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function big(x) {
  if (typeof x === 'bigint') return x;
  if (x === null || x === undefined || x === '') return 0n;
  try {
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) return 0n;
      return BigInt(Math.trunc(x));
    }
    const s = String(x).trim();
    return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
}

export const absBig = (v) => (v < 0n ? -v : v);

// Exact decimal string of an integer amount with `decimals` places, trailing zeros trimmed.
export function toDecimalString(amount, decimals) {
  const v = big(amount);
  const neg = v < 0n;
  let s = absBig(v).toString();
  const d = Number(decimals) || 0;
  if (d > 0) {
    s = s.padStart(d + 1, '0');
    const int = s.slice(0, -d);
    const frac = s.slice(-d).replace(/0+$/, '');
    s = frac ? `${int}.${frac}` : int;
  }
  return (neg ? '-' : '') + s;
}

export function toNumber(amount, decimals) {
  return Number(toDecimalString(amount, decimals));
}

const LOCALE = 'ru-RU';
const cache = new Map();
function nf(key, opts) {
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, opts);
    cache.set(key, f);
  }
  return f;
}

// Human formatting of a plain number. Large values become compact ("7,7 млн").
export function fmtNum(v, { compact = true, sign = false } = {}) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  let out;
  if (a === 0) out = '0';
  else if (compact && a >= 1e6) out = nf('c2', { notation: 'compact', maximumFractionDigits: 2 }).format(a);
  else if (a >= 1e4) out = nf('i0', { maximumFractionDigits: 0 }).format(a);
  else if (a >= 1) out = nf('f2', { maximumFractionDigits: 2 }).format(a);
  else if (a >= 1e-12) out = nf('s4', { maximumSignificantDigits: 4 }).format(a);
  else out = nf('e', { notation: 'scientific', maximumSignificantDigits: 3 }).format(a);
  const prefix = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return prefix + out;
}

export function fmtFull(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return nf('full', { maximumFractionDigits: 6 }).format(v);
}

export function fmtUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const a = Math.abs(v);
  const s = a >= 1e6
    ? nf('usdc', { notation: 'compact', maximumFractionDigits: 2 }).format(a)
    : a >= 1000
      ? nf('usd0', { maximumFractionDigits: 0 }).format(a)
      : a >= 1
        ? nf('usd2', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(a)
        : nf('usds', { maximumSignificantDigits: 3 }).format(a);
  return (v < 0 ? '−$' : '$') + s;
}

// Russian plural: plural(5, ['сделка', 'сделки', 'сделок']) -> 'сделок'
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export function fmtPct(v, { sign = true } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const digits = Math.abs(v) < 10 ? 1 : 0;
  const s = nf(`pct${digits}`, { maximumFractionDigits: digits }).format(Math.abs(v));
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + s + '%';
}

export function shortHash(h, head = 6, tail = 4) {
  if (!h) return '';
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function isImplicit(id) {
  return /^[0-9a-f]{64}$/.test(id || '') || /^0x[0-9a-f]{40}$/.test(id || '');
}

export function shortAccount(id) {
  if (!id) return '';
  if (isImplicit(id)) return shortHash(id, 6, 4);
  return id.length > 32 ? shortHash(id, 16, 10) : id;
}

export function relTime(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(ms) {
  return new Date(ms).toLocaleString(LOCALE, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function dayLabel(ms, now = Date.now()) {
  const d = new Date(ms);
  const today = new Date(now);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be full or blocked */
  }
}
