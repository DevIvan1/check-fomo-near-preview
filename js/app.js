// UI + live polling loop.

import { DEFAULT_SETTINGS, HISTORY_PAGE, POLL_PAGE, NEAR_ID, WNEAR, explorer } from './config.js';
import { normalizeAccount, shouldAlert, soundKind } from './rules.js';
import * as api from './api.js';
import * as tokens from './tokens.js';
import { analyzeTx } from './parser.js';
import { describe, tokenLinks } from './describe.js';
import { computePositions, positionRows, accountStats } from './positions.js';
import * as alerts from './alerts.js';
import {
  fmtNum, fmtUsd, fmtPct, relTime, fmtTime, fmtDateTime, dayLabel, toNumber, shortAccount,
  storageGet, storageSet, toDecimalString,
} from './util.js';
import { t, tp, setLang, getLocale, applyStatic } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const SETTINGS_KEY = 'nwm.settings.v1';
const AUTO_HISTORY_PAGES = 3;
// The tx API is rate-limited for anonymous clients, so it is not hammered every few seconds:
// a cheap RPC balance check runs every `pollSec` (any tx signed by the wallet burns gas, incoming
// NEAR changes the balance too) and the tx API is asked when that changes, plus a slow safety poll
// that also catches token-only transfers.
const SAFETY_POLL_MS = 15000;
const BURST_POLL_MS = 2500;
const BURST_WINDOW_MS = 9000;
const MAX_PENDING_TRIES = 15;

const ICONS = {
  soundOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
  bellOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 9.3-5"/><path d="M18 8c0 7 3 9 3 9H9"/><path d="M6 8c0 7-3 9-3 9h3"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
};

const state = {
  account: null,
  settings: { ...DEFAULT_SETTINGS, ...storageGet(SETTINGS_KEY, {}) },
  items: new Map(),
  generation: 0,
  resumeToken: null,
  totalCount: null,
  loadingHistory: false,
  initialDone: false,
  historyLoaded: false,
  polling: false,
  lastOkAt: 0,
  errStreak: 0,
  lastErr: null,
  nextPollAt: 0,
  nextFullAt: 0,
  nextDetectAt: 0,
  detecting: false,
  detectErr: 0,
  acctSig: null,
  burstUntil: 0,
  historyRetryMs: 5000,
  nextLiveAt: 0,
  liveBusy: false,
  liveTicks: 0,
  nextPriceAt: 0,
  balance: null,
  blockHeight: null,
  ftBalances: new Map(),
  ftLoaded: false,
  positions: new Map(),
  stats: null,
  filter: 'all',
  search: '',
  expanded: new Set(),
  pendingNew: 0,
};

// ---------------- DOM helpers ----------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { class: 'offscreen', 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(t('copied'));
}

function copyBtn(text) {
  const b = el('button', { class: 'copy-btn', type: 'button', title: t('copy'), 'aria-label': t('copy') });
  b.innerHTML = ICONS.copy;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    copyText(text);
  });
  return b;
}

function tokenIcon(id, cls = 'post-icon') {
  const box = el('div', { class: cls, 'aria-hidden': 'true' });
  const m = tokens.meta(id);
  const src = id === NEAR_ID || id === WNEAR ? null : m?.icon ? tokens.safeIcon(m.icon) : null;
  if (src) {
    const img = el('img', { src, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => {
      img.remove();
      box.textContent = (m?.symbol || '?').slice(0, 2);
    });
    box.append(img);
  } else {
    box.textContent = id === NEAR_ID || id === WNEAR ? 'Ⓝ' : (m?.symbol || id || '?').slice(0, 2);
  }
  return box;
}

// ---------------- settings ----------------

function saveSettings() {
  storageSet(SETTINGS_KEY, state.settings);
  renderTopButtons();
}

function renderTopButtons() {
  const s = state.settings;
  const sb = $('#soundBtn');
  sb.innerHTML = s.sound ? ICONS.soundOn : ICONS.soundOff;
  sb.setAttribute('aria-pressed', String(s.sound));
  sb.title = t(s.sound ? 'soundOn' : 'soundOff');
  const nb = $('#notifyBtn');
  const granted = alerts.notificationsSupported() && Notification.permission === 'granted';
  const on = s.notify && granted;
  nb.innerHTML = on ? ICONS.bellOn : ICONS.bellOff;
  nb.setAttribute('aria-pressed', String(on));
  nb.title = t(on ? 'notifyOn' : 'notifyOff');
  updateAudioHint();
}

function updateAudioHint() {
  $('#audioHint').hidden = !(state.account && state.settings.sound && alerts.audioState() !== 'running');
}

async function setNotify(on) {
  if (on) {
    const p = await alerts.requestNotifications();
    if (p !== 'granted') {
      toast(t(p === 'unsupported' ? 'notifyUnsupported' : 'notifyDenied'));
      on = false;
    }
  }
  state.settings.notify = on;
  saveSettings();
  const cb = $('#settingsForm').elements.notify;
  if (cb) cb.checked = on;
}

function fillSettingsForm() {
  const f = $('#settingsForm').elements;
  const s = state.settings;
  f.lang.value = s.lang === 'ru' ? 'ru' : 'en';
  f.theme.value = s.theme || 'auto';
  f.sound.checked = s.sound;
  f.volume.value = s.volume;
  f.alertLevel.value = s.alertLevel;
  f.alertMinNear.value = s.alertMinNear;
  f.notify.checked = s.notify && alerts.notificationsSupported() && Notification.permission === 'granted';
  f.pollSec.value = s.pollSec;
  f.showPayouts.checked = s.showPayouts;
  f.showMentions.checked = s.showMentions;
}

function onSettingsChange(e) {
  const f = $('#settingsForm').elements;
  const s = state.settings;
  const name = e.target.name;
  if (name === 'notify') {
    setNotify(f.notify.checked);
    return;
  }
  const langChanged = (f.lang.value === 'ru' ? 'ru' : 'en') !== s.lang;
  s.lang = f.lang.value === 'ru' ? 'ru' : 'en';
  s.theme = ['light', 'dark'].includes(f.theme.value) ? f.theme.value : 'auto';
  applyTheme(s.theme);
  s.sound = f.sound.checked;
  s.volume = Math.min(1, Math.max(0, Number(f.volume.value) || 0));
  s.alertLevel = f.alertLevel.value;
  s.alertMinNear = Math.max(0, Number(f.alertMinNear.value) || 0);
  s.pollSec = Math.min(60, Math.max(2, Math.round(Number(f.pollSec.value) || DEFAULT_SETTINGS.pollSec)));
  const feedChanged = s.showPayouts !== f.showPayouts.checked || s.showMentions !== f.showMentions.checked;
  s.showPayouts = f.showPayouts.checked;
  s.showMentions = f.showMentions.checked;
  saveSettings();
  if (langChanged) applyLanguage();
  else if (feedChanged) renderFeed();
}

// Switches every visible text to the selected language.
function applyLanguage() {
  setLang(state.settings.lang);
  applyStatic();
  renderTopButtons();
  alerts.setBaseTitle(state.account ? `${state.account} · Wallet Monitor` : 'Wallet Monitor');
  if (state.account) {
    $('#accountLinks').querySelector('.link-btn').textContent = t('copyAddress');
    recompute();
    renderFeed();
    renderSide();
    renderLive();
    updateFooter();
  }
}

// ---------------- account switching ----------------

function resetAccountState(acc) {
  state.generation += 1; // drops results of requests still in flight for the previous account
  Object.assign(state, {
    account: acc, items: new Map(), resumeToken: null, totalCount: null, initialDone: false, historyLoaded: false,
    lastOkAt: 0, errStreak: 0, lastErr: null, balance: null, blockHeight: null, ftBalances: new Map(), ftLoaded: false,
    positions: new Map(), stats: null, pendingNew: 0, loadingHistory: false, polling: false, missingAccount: false,
    detecting: false, detectErr: 0, acctSig: null, burstUntil: 0, historyRetryMs: 5000,
    nextLiveAt: 0, liveBusy: false, liveTicks: 0,
  });
  $('#newBanner').hidden = true;
}

function setUrl(acc, push) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (acc) url.searchParams.set('account', acc);
  if (url.href === location.href) return;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

function showLanding({ push = false } = {}) {
  resetAccountState(null);
  setUrl(null, push);
  document.body.classList.add('is-landing');
  $('#app').hidden = true;
  $('#landing').hidden = false;
  $('#feed').replaceChildren();
  alerts.setBaseTitle('Wallet Monitor');
  alerts.clearUnread();
  const input = $('#landingInput');
  input.value = '';
  input.focus();
}

async function switchAccount(acc, { push = true } = {}) {
  resetAccountState(acc);
  const gen = state.generation;
  setUrl(acc, push);
  document.body.classList.remove('is-landing');
  $('#landing').hidden = true;
  $('#app').hidden = false;
  updateAudioHint();
  $('#accountInput').value = acc;
  $('#accountId').textContent = acc;
  const links = $('#accountLinks');
  links.replaceChildren(
    el('a', { href: explorer.account(acc), target: '_blank', rel: 'noopener noreferrer' }, 'NearBlocks'),
    el('a', { href: explorer.accountAlt(acc), target: '_blank', rel: 'noopener noreferrer' }, 'Pikespeak'),
    el('button', { class: 'link-btn', type: 'button', onclick: () => copyText(acc) }, t('copyAddress')),
  );
  alerts.setBaseTitle(`${acc} · Wallet Monitor`);
  alerts.clearUnread();
  $('#feed').replaceChildren();
  $('#balanceNear').textContent = '—';
  $('#balanceUsd').textContent = '';
  setFeedState(t('loadingHistory'));
  renderSide();
  renderLive();

  state.nextFullAt = Date.now() + 60000;
  state.nextPriceAt = Number.MAX_SAFE_INTEGER;
  tokens.refreshNearUsd().then(() => gen === state.generation && renderHeader());
  refreshBalances(gen, true);
  await loadHistory(gen, true);
  if (gen !== state.generation) return;
  let pages = 1;
  // Small accounts get their whole history (for exact PnL); huge ones just the latest page.
  while (state.resumeToken && pages < AUTO_HISTORY_PAGES && (state.totalCount ?? 0) <= 1000 && gen === state.generation) {
    await loadHistory(gen, false);
    pages += 1;
  }
  state.initialDone = true;
  state.nextPollAt = Date.now() + SAFETY_POLL_MS;
  state.nextDetectAt = Date.now() + 1000;
  state.nextLiveAt = Date.now() + 1500;
  state.nextPriceAt = Date.now() + 60000;
  refreshPricesAndRender();
}

// ---------------- data flow ----------------

function setFeedState(text) {
  $('#feedState').textContent = text;
}

function updateFooter() {
  const n = state.items.size;
  const total = state.totalCount;
  const more = $('#moreBtn');
  more.hidden = !state.resumeToken;
  more.disabled = state.loadingHistory;
  if (!n && !state.loadingHistory) setFeedState(t(state.lastErr ? 'historyFailed' : 'noTxs'));
  else if (state.loadingHistory) setFeedState(t('loadingCount', { n, total }));
  else if (state.resumeToken) setFeedState(t('shownOf', { n, total: total ?? '?', word: tp('txWord', total ?? 0) }));
  else setFeedState(t('allHistory', { n, word: tp('txWord', n) }));
}

async function loadHistory(gen, first) {
  if (state.loadingHistory) return;
  state.loadingHistory = true;
  updateFooter();
  try {
    const r = await api.accountTxs(state.account, { limit: HISTORY_PAGE, resumeToken: first ? undefined : state.resumeToken });
    if (gen !== state.generation) return;
    if (first && r.txs_count !== undefined) state.totalCount = r.txs_count;
    state.resumeToken = r.resume_token || null;
    const rows = (r.account_txs || []).filter((t) => !state.items.has(t.transaction_hash));
    await ingest(rows, { live: false, gen });
    if (gen !== state.generation) return;
    state.historyLoaded = true;
    state.historyRetryMs = 5000;
    state.lastErr = null;
  } catch (e) {
    if (gen !== state.generation) return;
    state.lastErr = e;
    toast(t('historyError', e.message || String(e)));
  } finally {
    if (gen === state.generation) {
      state.loadingHistory = false;
      updateFooter();
    }
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
}

async function enrich(analyses) {
  const ids = new Set();
  const launches = new Set();
  for (const a of analyses) {
    a.tokens.forEach((t) => ids.add(t));
    if (a.launchId !== undefined && a.launchId !== null) launches.add(a.launchId);
  }
  await withTimeout(Promise.all([tokens.ensureMeta(ids), tokens.ensureLaunches(launches)]), 12000);
  const extra = new Set([...launches].map((l) => tokens.launchToken(l)).filter(Boolean));
  if (extra.size) await withTimeout(tokens.ensureMeta(extra), 8000);
}

function describeCtx() {
  return {
    meta: tokens.meta,
    nearUsd: tokens.getNearUsd(),
    priceNear: (t) => (t === NEAR_ID || t === WNEAR ? 1 : tokens.priceNear(t)),
    launchToken: tokens.launchToken,
    supply: tokens.supply,
    positionOpen,
  };
}

// true while the wallet still holds the token (tracked from trades or seen in balances),
// false once both say it is gone, null when unknown.
function positionOpen(token) {
  const p = state.positions.get(token);
  const raw = state.ftBalances.get(token);
  if ((p && p.qty > 0) || (raw && raw !== '0')) return true;
  return p || state.ftLoaded ? false : null;
}

function recompute() {
  const analyses = [...state.items.values()].map((i) => i.a);
  state.positions = computePositions(analyses, { decimals: tokens.decimals, launchToken: tokens.launchToken });
  state.stats = accountStats(analyses);
  const ctx = describeCtx();
  for (const it of state.items.values()) it.d = describe(it.a, ctx);
}

async function ingest(rows, { live, gen }) {
  if (!rows.length) return [];
  const raws = await api.transactions(rows.map((r) => r.transaction_hash));
  if (gen !== state.generation) return [];
  const byHash = new Map(raws.map((r) => [r.transaction?.hash, r]));
  const added = [];
  for (const row of rows) {
    const raw = byHash.get(row.transaction_hash);
    if (!raw || state.items.has(row.transaction_hash)) continue; // not served yet: the next poll retries it
    let a;
    try {
      a = analyzeTx(raw, state.account);
    } catch (e) {
      console.error('analyze failed', row.transaction_hash, e);
      continue;
    }
    const item = {
      hash: row.transaction_hash, a, d: null, el: null, sig: null,
      height: row.tx_block_height ?? a.blockHeight, index: row.tx_index ?? a.txIndex,
      live, firstSeen: Date.now(), alerted: !live, pendingTries: 0, fresh: live,
    };
    state.items.set(item.hash, item);
    added.push(item);
  }
  await enrich(added.map((i) => i.a));
  if (gen !== state.generation) return [];
  recompute();
  renderFeed();
  renderSide();
  return added;
}

async function refreshPending(items, gen) {
  const raws = await api.transactions(items.map((i) => i.hash));
  if (gen !== state.generation) return;
  const byHash = new Map(raws.map((r) => [r.transaction?.hash, r]));
  const changed = [];
  for (const it of items) {
    it.pendingTries += 1;
    const raw = byHash.get(it.hash);
    if (!raw) continue;
    try {
      it.a = analyzeTx(raw, state.account);
      changed.push(it.a);
    } catch (e) {
      console.error('re-analyze failed', it.hash, e);
    }
  }
  if (!changed.length) return;
  await enrich(changed);
  if (gen !== state.generation) return;
  recompute();
  renderFeed();
  renderSide();
}

async function poll() {
  if (state.polling || !state.account || !state.initialDone || !state.historyLoaded) return;
  state.polling = true;
  const gen = state.generation;
  let failed = false;
  try {
    const r = await api.accountTxs(state.account, { limit: POLL_PAGE });
    if (gen !== state.generation) return;
    if (r.txs_count !== undefined && r.txs_count > (state.totalCount ?? 0)) state.totalCount = r.txs_count;
    const fresh = (r.account_txs || []).filter((t) => !state.items.has(t.transaction_hash));
    if (fresh.length) {
      const added = await ingest(fresh, { live: true, gen });
      if (added.length) {
        onNewItems(added);
        state.burstUntil = Date.now() + BURST_WINDOW_MS; // follow-up receipts and token balances
        state.nextFullAt = Date.now() + 3000;
      }
    }
    const pending = [...state.items.values()].filter((i) => i.a.pending && i.pendingTries < MAX_PENDING_TRIES);
    if (pending.length) await refreshPending(pending, gen);
    processAlerts();
    state.lastOkAt = Date.now();
    state.errStreak = 0;
    state.lastErr = null;
  } catch (e) {
    failed = true;
    state.errStreak += 1;
    state.lastErr = e;
    console.warn('poll failed', e);
  } finally {
    if (gen === state.generation) {
      state.polling = false;
      const now = Date.now();
      const hasPending = [...state.items.values()].some((i) => i.a.pending && i.pendingTries < MAX_PENDING_TRIES);
      state.nextPollAt = now + (failed
        ? Math.min(60000, 3000 * 2 ** Math.min(state.errStreak, 5))
        : now < state.burstUntil || hasPending ? BURST_POLL_MS : SAFETY_POLL_MS);
      renderLive();
      updateFooter();
    }
  }
}

function onNewItems(added) {
  const scrolledAway = window.scrollY > 400;
  if (scrolledAway) {
    state.pendingNew += added.filter((i) => passesFilter(i)).length;
    if (state.pendingNew > 0) {
      $('#newCount').textContent = String(state.pendingNew);
      $('#newBanner').hidden = false;
    }
  }
  setTimeout(() => {
    for (const it of added) {
      it.fresh = false;
      it.el?.classList.remove('is-new');
    }
    document.querySelectorAll('.post-group.is-new').forEach((n) => n.classList.remove('is-new'));
  }, 6000);
}

function processAlerts() {
  const now = Date.now();
  const due = [...state.items.values()]
    .filter((it) => it.live && !it.alerted && (!it.a.pending || now - it.firstSeen > 15000))
    .sort((x, y) => x.height - y.height || x.index - y.index);
  let soundPlayed = false;
  for (const it of due) {
    it.alerted = true;
    if (!shouldAlert(it.a, state.settings)) continue;
    const s = state.settings;
    if (s.sound && !soundPlayed) soundPlayed = alerts.playSound(soundKind(it.a), s.volume);
    if (document.hidden) alerts.bumpUnread(it.d.title);
    if (s.notify) {
      const icon = it.d.icon.token ? tokens.safeIcon(tokens.meta(it.d.icon.token)?.icon || '') : null;
      alerts.showNotification(`${shortAccount(state.account)}: ${it.d.title}`, it.d.subtitle || '', it.hash, icon && icon.startsWith('https://') ? icon : undefined);
    }
  }
}

// Cheap change detector: one RPC call; a changed balance/storage means new activity.
async function detect() {
  if (state.detecting || !state.account) return;
  state.detecting = true;
  const gen = state.generation;
  let failed = false;
  try {
    const v = await api.viewAccount(state.account, { spread: true });
    if (gen !== state.generation) return;
    const sig = `${v.amount}|${v.locked}|${v.storage_usage}`;
    state.balance = BigInt(v.amount);
    state.blockHeight = v.block_height;
    if (state.acctSig && sig !== state.acctSig) {
      state.burstUntil = Date.now() + BURST_WINDOW_MS;
      state.nextPollAt = Math.min(state.nextPollAt, Date.now());
    }
    state.acctSig = sig;
    state.detectErr = 0;
    state.lastOkAt = Date.now();
    renderHeader();
    renderHoldings();
  } catch {
    failed = true;
    state.detectErr += 1;
  } finally {
    if (gen === state.generation) {
      state.detecting = false;
      state.nextDetectAt = Date.now() + (failed ? Math.min(30000, 2000 * 2 ** Math.min(state.detectErr, 4)) : state.settings.pollSec * 1000);
    }
  }
}

async function refreshBalances(gen, full) {
  const acc = state.account;
  try {
    const v = await api.viewAccount(acc);
    if (gen !== state.generation) return;
    state.balance = BigInt(v.amount);
    state.blockHeight = v.block_height;
    state.acctSig ??= `${v.amount}|${v.locked}|${v.storage_usage}`;
  } catch (e) {
    if (gen !== state.generation) return;
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(String(e.message)) && !state.missingAccount) {
      state.missingAccount = true;
      state.balance = null;
      toast(t('accountMissing'));
    }
  }
  if (full) {
    try {
      const f = await api.accountFull(acc);
      if (gen !== state.generation) return;
      state.ftBalances = new Map((f.tokens || []).filter((t) => t.balance && t.balance !== '0').map((t) => [t.contract_id, t.balance]));
      state.ftLoaded = true;
      await withTimeout(tokens.ensureMeta(new Set(state.ftBalances.keys())), 10000);
    } catch {
      /* keep previous */
    }
  }
  if (gen !== state.generation) return;
  renderHeader();
  renderSide();
}

async function refreshPricesAndRender() {
  const gen = state.generation;
  const set = new Set([...state.positions.keys(), ...state.ftBalances.keys()]);
  await tokens.refreshNearUsd();
  await withTimeout(tokens.refreshPrices(set), 15000);
  if (gen !== state.generation) return;
  recompute();
  renderHeader();
  renderFeed();
  renderSide();
}

// ---------------- live PnL ----------------

// Every pollSec: read the pools of tokens the wallet still holds and refresh those posts' PnL.
async function livePnlTick() {
  if (state.liveBusy || !state.account || !state.historyLoaded) return;
  state.liveBusy = true;
  const gen = state.generation;
  try {
    const tokenPools = new Map();
    const other = new Set();
    for (const it of state.items.values()) {
      const a = it.a;
      if (a.kind !== 'trade' || a.trade.side === 'swap') continue;
      const tok = a.trade.token;
      if (positionOpen(tok) === false) continue;
      const pools = a.trade.pools.filter((id) => id.split('|').length === 3);
      if (pools.length) tokenPools.set(tok, [...new Set([...(tokenPools.get(tok) || []), ...pools])]);
      else other.add(tok);
    }
    for (const tok of tokenPools.keys()) other.delete(tok);
    if (tokenPools.size) await tokens.refreshPoolPrices(tokenPools, api.viewFunction);
    if (other.size && state.liveTicks % 5 === 0) await withTimeout(tokens.refreshPrices(other), 8000);
    state.liveTicks += 1;
    if (gen !== state.generation) return;
    if (tokenPools.size || other.size) refreshLiveLines(new Set([...tokenPools.keys(), ...other]));
  } catch (e) {
    console.warn('live pnl failed', e);
  } finally {
    if (gen === state.generation) state.liveBusy = false;
  }
}

// Re-describes only the trade posts of the given tokens and swaps changed ones in place.
function refreshLiveLines(tokenSet) {
  const ctx = describeCtx();
  for (const it of state.items.values()) {
    if (it.a.kind !== 'trade' || !tokenSet.has(it.a.trade.token)) continue;
    const d = describe(it.a, ctx);
    const sig = JSON.stringify(d);
    if (sig === it.sig) continue;
    it.d = d;
    const old = it.el;
    it.el = buildPost(it);
    it.sig = sig;
    if (old && old.isConnected) old.replaceWith(it.el);
  }
  renderPositions();
  renderHoldings();
}

// ---------------- ticker ----------------

function onTick() {
  const now = Date.now();
  if (state.initialDone && !state.historyLoaded) {
    if (!state.loadingHistory && now >= state.nextPollAt) {
      // The first history page failed: retry it (with growing pauses) instead of polling,
      // so old transactions never alert as new ones.
      state.nextPollAt = now + state.historyRetryMs;
      state.historyRetryMs = Math.min(60000, state.historyRetryMs * 2);
      loadHistory(state.generation, true);
    }
  } else if (state.initialDone) {
    if (now >= state.nextDetectAt && !state.detecting) detect();
    if (now >= state.nextPollAt && !state.polling) poll();
    if (now >= state.nextLiveAt && !state.liveBusy) {
      state.nextLiveAt = now + state.settings.pollSec * 1000;
      livePnlTick();
    }
  }
  if (state.account && state.initialDone && now >= state.nextFullAt) {
    state.nextFullAt = now + 60000;
    refreshBalances(state.generation, true);
  }
  if (state.initialDone && now >= state.nextPriceAt) {
    state.nextPriceAt = now + 60000;
    refreshPricesAndRender();
  }
  renderLive();
}

function startTicker() {
  try {
    const w = new Worker(new URL('./ticker.js', import.meta.url));
    w.onmessage = onTick;
    w.postMessage({ cmd: 'start', ms: 500 });
  } catch {
    setInterval(onTick, 500);
  }
}

// ---------------- rendering ----------------

function renderLive() {
  const box = $('#liveStatus');
  const text = box.querySelector('.live-text');
  box.classList.remove('ok', 'err');
  if (!state.initialDone) {
    text.textContent = state.lastErr ? t('netErrorRetry') : t('loadingHistory');
    if (state.lastErr) box.classList.add('err');
    return;
  }
  const wait = Math.max(0, Math.round((state.nextPollAt - Date.now()) / 1000));
  if (!state.historyLoaded) {
    box.classList.add('err');
    text.textContent = t('apiDown', wait);
    return;
  }
  if (state.lastErr && state.errStreak > 0) {
    box.classList.add('err');
    text.textContent = t('apiDown', wait);
    return;
  }
  box.classList.add('ok');
  const ago = state.lastOkAt ? Math.max(0, Math.round((Date.now() - state.lastOkAt) / 1000)) : null;
  text.textContent = t('live', { sec: state.settings.pollSec, ago, block: state.blockHeight ? state.blockHeight.toLocaleString(getLocale()) : '' });
}

function renderHeader() {
  if (state.balance === null) return;
  const n = toNumber(state.balance, 24);
  $('#balanceNear').textContent = `${fmtNum(n, { compact: false })} NEAR`;
  $('#balanceNear').title = `${toDecimalString(state.balance, 24)} NEAR`;
  const usd = tokens.getNearUsd();
  $('#balanceUsd').textContent = usd ? `≈ ${fmtUsd(n * usd)} · NEAR ${fmtUsd(usd)}` : '';
}

function sortedItems() {
  return [...state.items.values()].sort((x, y) => (y.height ?? 0) - (x.height ?? 0) || (y.index ?? 0) - (x.index ?? 0));
}

function haystack(it) {
  const a = it.a;
  const parts = [a.hash, it.d?.title, it.d?.subtitle, a.signer, a.receiver, a.counterparty, a.kind];
  for (const t of a.tokens) parts.push(t, tokens.meta(t)?.symbol, tokens.meta(t)?.name);
  if (a.launchId !== undefined) {
    const lt = tokens.launchToken(a.launchId);
    parts.push(lt, lt && tokens.meta(lt)?.symbol);
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function passesFilter(it) {
  const a = it.a;
  const s = state.settings;
  if (state.filter === 'all') {
    if (a.kind === 'payout' && !s.showPayouts) return false;
    if (a.kind === 'mention' && !s.showMentions) return false;
  } else if (a.category !== state.filter) {
    return false;
  }
  if (state.search) {
    const terms = state.search.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = haystack(it);
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}

function renderCounts() {
  const counts = { all: 0, trades: 0, transfers: 0, payouts: 0, other: 0 };
  const s = state.settings;
  for (const it of state.items.values()) {
    const a = it.a;
    counts[a.category] = (counts[a.category] || 0) + 1;
    if (!((a.kind === 'payout' && !s.showPayouts) || (a.kind === 'mention' && !s.showMentions))) counts.all += 1;
  }
  document.querySelectorAll('[data-count]').forEach((n) => {
    const v = counts[n.dataset.count] || 0;
    n.textContent = v ? String(v) : '';
  });
}

function buildPost(it) {
  const { a, d } = it;
  const li = el('li', { class: `post tone-${d.tone}${it.fresh ? ' is-new' : ''}`, 'data-hash': a.hash });
  li.append(d.icon.token ? tokenIcon(d.icon.token) : el('div', { class: 'post-icon', 'aria-hidden': 'true' }, d.icon.glyph));

  const body = el('div', { class: 'post-body' });
  const head = el('div', { class: 'post-head' },
    el('span', { class: 'post-author' }, shortAccount(state.account)),
    el('span', {}, '·'),
    el('time', { datetime: new Date(a.timestampMs).toISOString(), title: fmtDateTime(a.timestampMs) }, fmtTime(a.timestampMs)),
    el('span', {}, '·'),
    el('span', { class: 'rel', 'data-ts': a.timestampMs }, relTime(a.timestampMs)),
  );
  d.tags.forEach((t, i) => head.append(el('span', { class: `tag${i === 0 ? ' tag-main' : ''}` }, t)));
  body.append(head, el('div', { class: 'post-title' }, d.title));
  if (d.subtitle) body.append(el('div', { class: 'post-sub' }, d.subtitle));
  body.append(kvList(d.lines));
  if (d.details.length) {
    const det = el('details', { class: 'more' }, el('summary', {}, t('details')), kvList(d.details));
    if (state.expanded.has(a.hash)) det.open = true;
    det.addEventListener('toggle', () => (det.open ? state.expanded.add(a.hash) : state.expanded.delete(a.hash)));
    body.append(det);
  }
  li.append(body);
  return li;
}

function kvList(lines) {
  const dl = el('dl', { class: 'kv' });
  for (const line of lines) {
    const multi = typeof line.value === 'string' && line.value.includes('\n');
    const dd = el('dd', { class: multi ? 'pre' : '' });
    if (line.live) dd.append(el('span', { class: `live-mark${line.tone ? ' ' + line.tone : ''}`, 'aria-hidden': 'true' }));
    dd.append(el('span', { class: `v${line.mono ? ' mono' : ''}${line.tone ? ' ' + line.tone : ''}`, title: line.title }, line.value));
    if (line.copy) dd.append(copyBtn(line.copy));
    if (line.note) dd.append(el('span', { class: `note${line.dyn && line.tone ? ' ' + line.tone : ''}` }, line.note));
    if (line.links?.length) {
      const s = el('span', { class: 'links' });
      for (const l of line.links) s.append(el('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.text));
      dd.append(s);
    }
    dl.append(el('div', { class: 'kv-row' }, el('dt', {}, line.label), dd));
  }
  return dl;
}

function postEl(it) {
  const sig = JSON.stringify(it.d);
  if (!it.el || it.sig !== sig) {
    it.el = buildPost(it);
    it.sig = sig;
  }
  return it.el;
}

// Runs of holder payouts are frequent and tiny; fold 2+ consecutive ones into one card.
function buildPayoutGroup(items) {
  const key = 'group:' + items[items.length - 1].hash;
  let near = 0n;
  const tokenSums = new Map();
  const symbols = new Set();
  for (const it of items) {
    if (it.a.nearDelta > 0n) near += it.a.nearDelta;
    for (const [t, v] of Object.entries(it.a.deltas)) {
      if (t !== NEAR_ID && t !== WNEAR && v > 0n) tokenSums.set(t, (tokenSums.get(t) || 0n) + v);
    }
    const lt = tokens.launchToken(it.a.launchId);
    if (lt) symbols.add(tokens.meta(lt)?.symbol || lt);
  }
  const parts = [];
  if (near > 0n) parts.push(`+${fmtNum(toNumber(near, 24))} NEAR`);
  for (const [t, v] of tokenSums) {
    const dec = tokens.decimals(t);
    if (dec !== null) parts.push(`+${fmtNum(toNumber(v, dec))} ${tokens.meta(t)?.symbol || t}`);
  }
  const newest = items[0].a.timestampMs;
  const oldest = items[items.length - 1].a.timestampMs;
  const fresh = items.some((it) => it.fresh);
  const li = el('li', { class: `post post-group tone-buy${fresh ? ' is-new' : ''}` });
  li.append(el('div', { class: 'post-icon', 'aria-hidden': 'true' }, '＋'));
  const body = el('div', { class: 'post-body' });
  body.append(
    el('div', { class: 'post-head' },
      el('span', { class: 'post-author' }, shortAccount(state.account)),
      el('span', {}, '·'),
      el('time', { title: `${fmtDateTime(oldest)} — ${fmtDateTime(newest)}` }, `${fmtTime(oldest).slice(0, 5)}–${fmtTime(newest).slice(0, 5)}`),
      el('span', {}, '·'),
      el('span', { class: 'rel', 'data-ts': newest }, relTime(newest)),
      el('span', { class: 'tag tag-main' }, t('payoutsTag')),
    ),
    el('div', { class: 'post-title' }, t('payoutGroup', { n: items.length, word: tp('payoutWord', items.length), parts: parts.join(', ') || '—' })),
    el('div', { class: 'post-sub' }, `Nearly${symbols.size ? ' · ' + [...symbols].join(', ') : ''}`),
  );
  const det = el('details', { class: 'more' }, el('summary', {}, t('showEach')));
  const inner = el('ol', { class: 'group-list' });
  if (state.expanded.has(key)) {
    det.open = true;
    items.forEach((it) => inner.append(postEl(it)));
  }
  det.addEventListener('toggle', () => {
    if (det.open) {
      state.expanded.add(key);
      if (!inner.childNodes.length) items.forEach((it) => inner.append(postEl(it)));
    } else {
      state.expanded.delete(key);
    }
  });
  det.append(inner);
  body.append(det);
  li.append(body);
  return li;
}

function renderFeed() {
  const feed = $('#feed');
  const frag = document.createDocumentFragment();
  const list = sortedItems().filter((it) => it.d && passesFilter(it));
  const grouping = state.filter === 'all' && !state.search;
  let lastDay = null;
  for (let i = 0; i < list.length;) {
    const it = list[i];
    const day = dayLabel(it.a.timestampMs);
    if (day !== lastDay) {
      frag.append(el('li', { class: 'day-sep' }, day));
      lastDay = day;
    }
    if (grouping && it.a.kind === 'payout') {
      let j = i;
      while (j < list.length && list[j].a.kind === 'payout' && dayLabel(list[j].a.timestampMs) === day) j += 1;
      if (j - i >= 2) {
        frag.append(buildPayoutGroup(list.slice(i, j)));
        i = j;
        continue;
      }
    }
    frag.append(postEl(it));
    i += 1;
  }
  feed.replaceChildren(frag);
  renderCounts();
  if (!list.length && state.items.size) setFeedState(t('noFilterMatch'));
  else updateFooter();
}

function updateRelativeTimes() {
  const now = Date.now();
  document.querySelectorAll('.rel[data-ts]').forEach((n) => {
    n.textContent = relTime(Number(n.dataset.ts), now);
  });
}

function renderSide() {
  renderPositions();
  renderHoldings();
  renderStats();
}

function renderPositions() {
  const box = $('#positions');
  const live = {
    balance: (t) => {
      const raw = state.ftBalances.get(t);
      const dec = tokens.decimals(t);
      if (dec === null) return null;
      if (raw === undefined) return state.ftLoaded ? 0 : null;
      return toNumber(raw, dec);
    },
    priceNear: (t) => tokens.priceNear(t),
  };
  const rows = positionRows(state.positions, live);
  if (!rows.length) {
    box.replaceChildren(el('div', { class: 'muted small' }, t('noTrades')));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const m = tokens.meta(r.token);
    const sym = m?.symbol || r.token;
    const pnlCls = r.pnlTotal === null ? 'muted' : r.pnlTotal >= 0 ? 'up' : 'down';
    const metaLine = [
      t('invested', fmtNum(r.nearIn)),
      r.nearOut ? t('withdrawn', fmtNum(r.nearOut)) : null,
      r.payoutsNear ? t('payoutsShort', fmtNum(r.payoutsNear)) : null,
    ].filter(Boolean).join(' · ') + ' NEAR';
    const holdLine = r.open
      ? t('holds', { q: fmtNum(r.held), value: r.valueNear !== null ? fmtNum(r.valueNear) : null })
      : t('closed');
    const btn = el('button', { type: 'button', title: t('showTradesOf', sym), onclick: () => setSearch(sym) },
      el('div', { class: 'pos-name' }, sym, el('span', { class: 'state' }, `${r.buys}↑ ${r.sells}↓`)));
    frag.append(el('div', { class: 'pos' },
      tokenIcon(r.token, 'pos-icon'),
      el('div', {}, btn, el('div', { class: 'pos-meta' }, metaLine), el('div', { class: 'pos-meta' }, holdLine)),
      el('div', { class: `pos-pnl ${pnlCls}`, title: t(r.unpriced ? 'priceLoading' : 'pnlFormula') },
        r.pnlTotal === null ? '…' : `${fmtNum(r.pnlTotal, { sign: true })} NEAR`, el('span', { class: 'pct' }, r.pnlPct !== null ? fmtPct(r.pnlPct) : '')),
    ));
  }
  box.replaceChildren(frag);
}

function renderHoldings() {
  const box = $('#holdings');
  const frag = document.createDocumentFragment();
  const usd = tokens.getNearUsd();
  if (state.balance !== null) {
    const n = toNumber(state.balance, 24);
    frag.append(el('div', { class: 'holding' }, el('span', { class: 'h-name' }, 'NEAR'),
      el('span', { class: 'h-val' }, fmtNum(n, { compact: false }), usd ? el('small', {}, fmtUsd(n * usd)) : null)));
  }
  const rows = [];
  for (const [t, raw] of state.ftBalances) {
    const m = tokens.meta(t);
    if (m?.decimals === null || m?.decimals === undefined) continue;
    const q = toNumber(raw, m.decimals);
    const p = t === WNEAR ? 1 : tokens.priceNear(t);
    rows.push({ t, m, q, valueNear: p !== null ? q * p : null });
  }
  rows.sort((x, y) => (y.valueNear ?? -1) - (x.valueNear ?? -1));
  for (const r of rows) {
    const small = r.valueNear !== null ? `${fmtNum(r.valueNear)} NEAR${usd ? ' · ' + fmtUsd(r.valueNear * usd) : ''}` : t('priceUnknown');
    const name = el('span', { class: 'h-name', title: r.t }, r.m.symbol);
    const links = tokenLinks(r.t);
    if (links[0]) name.append(' ', el('a', { href: links[0].href, target: '_blank', rel: 'noopener noreferrer', class: 'muted small' }, '↗'));
    frag.append(el('div', { class: 'holding' }, name, el('span', { class: 'h-val' }, fmtNum(r.q), el('small', {}, small))));
  }
  if (!frag.childNodes.length) frag.append(el('div', { class: 'muted small' }, '—'));
  box.replaceChildren(frag);
}

function renderStats() {
  const s = state.stats;
  const dl = $('#stats');
  if (!s) {
    dl.replaceChildren();
    return;
  }
  const rows = [
    [t('st.txs'), `${s.total}${state.totalCount && state.totalCount > s.total ? ` ${t('of')} ${state.totalCount}` : ''}`],
    [t('st.trades'), t('st.tradesVal', { n: s.trades, b: s.buys, s: s.sells })],
    [t('st.volume'), `${fmtNum(s.volumeNear)} NEAR`],
    [t('st.24h'), t('st.24hVal', { n: s.trades24, word: tp('tradeWord', s.trades24), v: fmtNum(s.volume24) })],
    [t('st.payouts'), `${s.payouts} · ${fmtNum(s.payoutsNear)} NEAR`],
    [t('st.funded'), `${fmtNum(s.fundedNear)} NEAR`],
  ];
  if (s.sentNear) rows.push([t('st.sent'), `${fmtNum(s.sentNear)} NEAR`]);
  if (s.failed) rows.push([t('st.failed'), String(s.failed)]);
  const top = [...s.fundedFrom.entries()].sort((x, y) => y[1] - x[1])[0];
  if (top) rows.push([t('st.source'), shortAccount(top[0]), top[0]]);
  if (s.firstTs) rows.push([t('st.first'), fmtDateTime(s.firstTs)]);
  if (s.lastTs) rows.push([t('st.last'), relTime(s.lastTs)]);
  const frag = document.createDocumentFragment();
  for (const [k, v, title] of rows) frag.append(el('dt', {}, k), el('dd', { title }, v));
  dl.replaceChildren(frag);
}

function setSearch(q) {
  $('#searchInput').value = q;
  state.search = q;
  renderFeed();
  $('#feed').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- CSV ----------------

function exportCsv() {
  const cols = ['time', 'kind', 'title', 'side', 'token', 'in', 'out', 'nearDelta', 'hash'];
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    // Keep spreadsheets from evaluating formulas, but leave plain numbers like -500.5 intact.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [cols.join(',')];
  for (const it of sortedItems()) {
    if (!it.d) continue;
    lines.push(cols.map((c) => esc(it.d.csv[c])).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${state.account}-activity-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// ---------------- wiring ----------------

function bindUI() {
  $('#settingsBtn').innerHTML = ICONS.gear;
  renderTopButtons();

  const unlock = async () => {
    await alerts.unlockAudio();
    updateAudioHint();
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));
  alerts.onAudioStateChange(updateAudioHint);
  $('#audioHintBtn').addEventListener('click', async () => {
    await unlock();
    if (alerts.audioState() === 'running') alerts.playSound('info', state.settings.volume);
  });

  $('#accountForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const acc = normalizeAccount($('#accountInput').value);
    if (!acc) {
      toast(t('badAccount'));
      return;
    }
    if (acc !== state.account) switchAccount(acc);
  });

  $('#landingForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const acc = normalizeAccount($('#landingInput').value);
    if (!acc) {
      toast(t('badAddress'));
      return;
    }
    switchAccount(acc);
  });

  $('#homeLink').addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work
    e.preventDefault();
    if (state.account) showLanding({ push: true });
  });
  window.addEventListener('popstate', route);

  $('#soundBtn').addEventListener('click', async () => {
    state.settings.sound = !state.settings.sound;
    saveSettings();
    if (state.settings.sound) {
      await unlock();
      alerts.playSound('info', state.settings.volume);
    }
  });
  $('#notifyBtn').addEventListener('click', () => {
    const on = state.settings.notify && alerts.notificationsSupported() && Notification.permission === 'granted';
    setNotify(!on);
  });

  const dlg = $('#settingsDialog');
  $('#settingsBtn').addEventListener('click', () => {
    fillSettingsForm();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  });
  $('#settingsForm').addEventListener('change', onSettingsChange);
  $('#settingsForm').addEventListener('input', (e) => {
    if (e.target.name === 'volume') onSettingsChange(e);
  });
  $('#testSoundBtn').addEventListener('click', async () => {
    await unlock();
    if (!alerts.playSound('buy', state.settings.volume)) toast(t('soundBlocked'));
  });

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderFeed();
  });

  let searchTimer = null;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      renderFeed();
    }, 150);
  });

  $('#exportBtn').addEventListener('click', exportCsv);
  $('#moreBtn').addEventListener('click', () => loadHistory(state.generation, false));
  $('#newBannerBtn').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    state.pendingNew = 0;
    $('#newBanner').hidden = true;
  });
  window.addEventListener('scroll', () => {
    if (window.scrollY < 200 && state.pendingNew) {
      state.pendingNew = 0;
      $('#newBanner').hidden = true;
    }
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) alerts.clearUnread();
  });
  window.addEventListener('focus', () => alerts.clearUnread());
  setInterval(updateRelativeTimes, 15000);
}

function setupSidePanel() {
  // Collapsed on phones (so the feed comes first), always open on wide screens.
  const wrap = $('#sideWrap');
  const mq = window.matchMedia('(max-width: 900px)');
  const apply = () => {
    wrap.open = !mq.matches;
  };
  apply();
  mq.addEventListener?.('change', apply);
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

function accountFromUrl() {
  const params = new URLSearchParams(location.search);
  return normalizeAccount(params.get('account') || params.get('a') || location.hash.replace(/^#/, ''));
}

// The page opens a wallet only when its address is in the URL; otherwise it shows the search box.
function route() {
  const acc = accountFromUrl();
  if (acc) {
    if (acc !== state.account) switchAccount(acc, { push: false });
  } else if (state.account || $('#landing').hidden) {
    showLanding({ push: false });
  }
}

function init() {
  setLang(state.settings.lang);
  applyStatic();
  applyTheme(state.settings.theme);
  try {
    localStorage.removeItem('nwm.account.v1'); // older versions remembered the last wallet; we no longer do
  } catch {
    /* storage blocked */
  }
  const debug = new URLSearchParams(location.search).has('debug'); // read before routing rewrites the URL
  setupSidePanel();
  bindUI();
  startTicker();
  route();
  if (debug) {
    // Test hook: forget the newest N events so the next poll re-detects them as live ones.
    window.__nwm = {
      state,
      replay(n = 1) {
        const gone = sortedItems().slice(0, n);
        gone.forEach((it) => state.items.delete(it.hash));
        recompute();
        renderFeed();
        renderSide();
        state.nextPollAt = 0;
        return gone.map((it) => it.hash);
      },
    };
  }
}

init();
