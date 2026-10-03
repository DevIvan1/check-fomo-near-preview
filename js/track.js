// Usage log: which wallets connect to the site or are searched on it (the address only, no IP,
// no cookies). Sent to the Vercel function api/track.py; the GitHub Pages copy sends to the
// Vercel URL. Local development (http://localhost) is not logged.

import { TRACK_URL } from './config.js?v=4f17072b';
import { normalizeAccount } from './rules.js?v=4f17072b';

const SENT_KEY = 'cf.tracked.v1';
const RESEND_MS = 6 * 3600 * 1000; // the same wallet and kind is sent at most once per 6 hours
export const TRACK_KINDS = ['connect', 'manual', 'visit', 'search'];

export function trackEndpoint(loc = location) {
  if (loc.protocol !== 'https:') return null;
  if (loc.hostname.endsWith('.github.io')) return TRACK_URL;
  return '/api/track'; // the Vercel deployment (or a custom domain on it)
}

function beacon(url, body) {
  try {
    // text/plain keeps it a simple request: no CORS preflight, survives a page change
    if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return true;
  } catch {
    /* fall back to fetch */
  }
  fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }).catch(() => {});
  return true;
}

// kind: 'connect' (wallet connected) | 'manual' (signed in by typing an account) |
//       'visit' (a connected wallet opened the site) | 'search' (an address typed into search)
export function track(kind, account, wallet = null, { send = beacon, loc = location, now = Date.now(), storage = localStorage } = {}) {
  const acc = normalizeAccount(account);
  const url = trackEndpoint(loc);
  if (!acc || !TRACK_KINDS.includes(kind) || !url) return false;
  let sent = {};
  try {
    sent = JSON.parse(storage.getItem(SENT_KEY) || '{}') || {};
  } catch {
    sent = {};
  }
  const key = `${kind}|${acc}`;
  if (sent[key] && now - sent[key] < RESEND_MS) return false;
  for (const k of Object.keys(sent)) if (!(now - sent[k] < RESEND_MS)) delete sent[k];
  sent[key] = now;
  try {
    storage.setItem(SENT_KEY, JSON.stringify(sent));
  } catch {
    /* storage blocked: still send */
  }
  const name = typeof wallet === 'string' ? wallet.replace(/[^A-Za-z0-9 ._()-]/g, '').slice(0, 40) : '';
  return send(url, JSON.stringify({ kind, account: acc, wallet: name }));
}
