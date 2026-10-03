// UI + live polling loop.

import { DEFAULT_SETTINGS, HISTORY_PAGE, POLL_PAGE, NEAR_ID, WNEAR, explorer } from './config.js?v=d41ccbfd';
import { normalizeAccount, shouldAlert, soundKind } from './rules.js?v=d41ccbfd';
import * as api from './api.js?v=d41ccbfd';
import * as tokens from './tokens.js?v=d41ccbfd';
import { analyzeTx } from './parser.js?v=d41ccbfd';
import { describe, tokenLinks } from './describe.js?v=d41ccbfd';
import { computePositions, periodSummary, positionCards, positionsOverview, sortPositionCards } from './positions.js?v=d41ccbfd';
import * as alerts from './alerts.js?v=d41ccbfd';
import {
  fmtNum, fmtUsd, fmtUsdCompact, fmtPct, fmtDateShort, relTime, fmtTime, fmtDateTime, dayLabel, toNumber, shortAccount,
  storageGet, storageSet, toDecimalString,
} from './util.js?v=d41ccbfd';
import { t, tp, setLang, getLang, getLocale, applyStatic } from './i18n.js?v=d41ccbfd';
import * as session from './session.js?v=d41ccbfd';
import { FollowFeed } from './following.js?v=d41ccbfd';
import { Leaderboard, WINDOWS as LB_WINDOWS } from './leaderboard.js?v=d41ccbfd';
import { track } from './track.js?v=d41ccbfd';

const $ = (sel) => document.querySelector(sel);
const SETTINGS_KEY = 'nwm.settings.v1';
const BRAND = 'Check fomo';
const AUTO_HISTORY_PAGES = 3;
// The tx API is rate-limited for anonymous clients, so it is not hammered every few seconds:
// a cheap RPC balance check runs every `pollSec` (any tx signed by the wallet burns gas, incoming
// NEAR changes the balance too) and the tx API is asked when that changes, plus a slow safety poll
// that also catches token-only transfers.
const SAFETY_POLL_MS = 15000;
const BURST_POLL_MS = 2500;
const BURST_WINDOW_MS = 9000;
const MAX_PENDING_TRIES = 15;
const BACKUP_POLL_MS = 10000; // NearBlocks allows fewer calls; poll it more gently
let txApiDownUntil = 0; // while set, history comes from the backup sources

// Account history page: FastNEAR first, NearBlocks when FastNEAR fails (no pagination there).
async function listTxs(opts) {
  if (Date.now() >= txApiDownUntil) {
    try {
      const r = await api.accountTxs(state.account, opts);
      state.source = 'fastnear';
      return r;
    } catch (e) {
      txApiDownUntil = Date.now() + 60000;
      if (opts.resumeToken) throw e;
    }
  }
  if (opts.resumeToken) throw new Error('backup source has no pagination');
  const r = await api.accountTxsBackup(state.account, { limit: opts.limit });
  state.source = 'backup';
  return r;
}

// Same as listTxs/fetchRaw for any account (used by the follow feed); never touches state.source.
// Only transactions the wallet signed itself: its trades, not the payouts it receives.
async function listTxsFor(account, limit) {
  if (Date.now() >= txApiDownUntil) {
    try {
      return await api.accountTxs(account, { limit, signerOnly: true });
    } catch {
      txApiDownUntil = Date.now() + 60000;
    }
  }
  return api.accountTxsBackup(account, { limit, signerOnly: true });
}

async function fetchRawFor(account, rows) {
  if (Date.now() >= txApiDownUntil) {
    try {
      return await api.transactions(rows.map((r) => r.transaction_hash));
    } catch {
      txApiDownUntil = Date.now() + 60000;
    }
  }
  return api.transactionsBackup(rows, account);
}

// Full transactions for history rows: FastNEAR first, RPC tx status when FastNEAR fails.
async function fetchRaw(rows) {
  if (Date.now() >= txApiDownUntil) {
    try {
      return await api.transactions(rows.map((r) => r.transaction_hash));
    } catch {
      txApiDownUntil = Date.now() + 60000;
      state.source = 'backup';
    }
  }
  return api.transactionsBackup(rows, state.account);
}

const ICONS = {
  soundOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
  bellOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 9.3-5"/><path d="M18 8c0 7 3 9 3 9H9"/><path d="M6 8c0 7-3 9-3 9h3"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 21v-5h-5"/></svg>',
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
  filter: 'all',
  search: '',
  expanded: new Set(),
  pendingNew: 0,
  followTab: 'activity',
};

const feed = new FollowFeed({
  listTxs: listTxsFor,
  fetchRaw: fetchRawFor,
  viewAccount: (acc) => api.viewAccount(acc, { spread: true }),
  analyze: (raw, acc) => analyzeTx(raw, acc),
  enrich: (analyses) => enrich(analyses),
  onUpdate: () => renderFollowPanel(),
  onNewEvent: (ev) => onFollowEvent(ev),
});

// Top meme traders (left column): loaded with the first wallet page, refreshed by the button.
const board = new Leaderboard({
  nearlyTraders: (w) => api.nearlyTraders(w),
  nearlyTrader: (acc) => api.nearlyTrader(acc),
  refTopPools: () => api.refTopPools(),
  intearTokenList: () => api.intearTokenList(),
  swapsByToken: (tok) => api.intearSwapsByToken(tok),
  swapsByTrader: (acc) => api.intearSwapsByTrader(acc),
  storageGet,
  storageSet,
}, { onUpdate: () => renderLeaderboard() });
let boardStarted = false;
let boardSig = '';

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
  f.followAlerts.checked = s.followAlerts !== false;
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
  s.followAlerts = f.followAlerts.checked;
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
  alerts.setBaseTitle(state.account ? `${state.account} · ${BRAND}` : BRAND);
  renderAuth();
  renderFollowPanel();
  renderLeaderboard(true);
  if (state.account) {
    renderAccountActions();
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
    positions: new Map(), pendingNew: 0, loadingHistory: false, polling: false, missingAccount: false,
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
  alerts.setBaseTitle(BRAND);
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
  renderAccountActions();
  loadAccountIdent(acc);
  startLeaderboard();
  const links = $('#accountLinks');
  links.replaceChildren(
    el('a', { href: explorer.account(acc), target: '_blank', rel: 'noopener noreferrer' }, 'NearBlocks'),
    el('a', { href: explorer.accountAlt(acc), target: '_blank', rel: 'noopener noreferrer' }, 'Pikespeak'),
    el('button', { class: 'link-btn', type: 'button', onclick: () => copyText(acc) }, t('copyAddress')),
  );
  alerts.setBaseTitle(`${acc} · ${BRAND}`);
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
  else if (state.source === 'backup' && !state.resumeToken) setFeedState(t('backupShown', { n, word: tp('txWord', n) }));
  else if (state.resumeToken) setFeedState(t('shownOf', { n, total: total ?? '?', word: tp('txWord', total ?? 0) }));
  else setFeedState(t('allHistory', { n, word: tp('txWord', n) }));
}

async function loadHistory(gen, first) {
  if (state.loadingHistory) return;
  state.loadingHistory = true;
  updateFooter();
  try {
    const r = await listTxs({ limit: HISTORY_PAGE, resumeToken: first ? undefined : state.resumeToken });
    if (gen !== state.generation) return;
    if (first && r.txs_count !== undefined) state.totalCount = r.txs_count;
    state.resumeToken = r.resume_token || null;
    const rows = (r.account_txs || []).filter((t) => !state.items.has(t.transaction_hash));
    await ingest(rows, { live: false, gen });
    if (gen !== state.generation) return;
    state.historyLoaded = true;
    state.historyFromBackup = state.source === 'backup';
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
    cycleStats: (token, id) => (id === undefined || id === null ? null : state.positions.get(token)?.cycles?.[id] || null),
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
  const ctx = describeCtx();
  for (const it of state.items.values()) it.d = describe(it.a, ctx);
}

async function ingest(rows, { live, gen }) {
  if (!rows.length) return [];
  const raws = await fetchRaw(rows);
  if (gen !== state.generation) return [];
  const byHash = new Map(raws.map((r) => [r.transaction?.hash, r]));
  const added = [];
  for (const row of rows) {
    const raw = byHash.get(row.transaction_hash);
    if (!raw || state.items.has(row.transaction_hash)) continue; // not served yet: the next poll retries it
    const isLive = typeof live === 'function' ? live(row) : live;
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
      live: isLive, firstSeen: Date.now(), alerted: !isLive, pendingTries: 0, fresh: isLive,
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
  const raws = await fetchRaw(items.map((i) => ({ transaction_hash: i.hash, tx_block_height: i.height, tx_block_timestamp: String(BigInt(i.a.timestampMs) * 1000000n) })));
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
    const r = await listTxs({ limit: POLL_PAGE });
    if (gen !== state.generation) return;
    if (r.txs_count !== undefined && r.txs_count > (state.totalCount ?? 0)) state.totalCount = r.txs_count;
    const fresh = (r.account_txs || []).filter((t) => !state.items.has(t.transaction_hash));
    if (fresh.length) {
      // Rows far older than what we already show (e.g. filling a gap after the backup source)
      // are history, not new events: no alerts for them.
      const known = [...state.items.values()].map((i) => i.height || 0);
      const liveCut = (known.length ? Math.max(...known) : 0) - 300; // ≈ 5 minutes of blocks
      const added = await ingest(fresh, { live: (row) => !row.tx_block_height || row.tx_block_height > liveCut, gen });
      if (added.length) {
        onNewItems(added);
        state.burstUntil = Date.now() + BURST_WINDOW_MS; // follow-up receipts and token balances
        state.nextFullAt = Date.now() + 3000;
      }
    }
    if (state.historyFromBackup && state.source === 'fastnear') {
      // FastNEAR is back: replace the short backup history with the full one (quietly).
      state.historyFromBackup = false;
      loadHistory(gen, true);
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
        : state.source === 'backup' ? BACKUP_POLL_MS
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
  renderPnlBoard();
  if (state.filter === 'summary') renderSummary();
  if (state.filter === 'positions') renderPositionsView();
}

// ---------------- ticker ----------------

function onTick() {
  const now = Date.now();
  feed.tick(now);
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
    const w = new Worker(new URL('./ticker.js?v=d41ccbfd', import.meta.url));
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
  text.textContent = t('live', { sec: state.settings.pollSec, ago, block: state.blockHeight ? state.blockHeight.toLocaleString(getLocale()) : '' })
    + (state.source === 'backup' ? ` · ${t('backupSource')}` : '');
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
  counts.positions = [...state.positions.values()].reduce((n, p) => n + p.cycles.filter((c) => c.buys || c.sells).length, 0);
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
  const summary = state.filter === 'summary';
  const positions = state.filter === 'positions';
  document.body.classList.toggle('view-summary', summary);
  document.body.classList.toggle('view-positions', positions);
  $('#summaryView').hidden = !summary;
  $('#positionsView').hidden = !positions;
  if (summary || positions) {
    renderCounts();
    if (summary) renderSummary();
    else renderPositionsView();
    return;
  }
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

// Token balance as a number, 0 when balances are loaded and the token is absent, null if unknown.
function liveBalance(t) {
  const raw = state.ftBalances.get(t);
  const dec = tokens.decimals(t);
  if (dec === null) return null;
  if (raw === undefined) return state.ftLoaded ? 0 : null;
  return toNumber(raw, dec);
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return t('dur.lt1m');
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d}${t('dur.d')} ${h}${t('dur.h')}`;
  if (h) return `${h}${t('dur.h')} ${mm}${t('dur.m')}`;
  return `${mm}${t('dur.m')}`;
}

// Market cap in USD (compact, e.g. $302K); falls back to NEAR when the NEAR price is unknown.
function mcText(mcNear) {
  if (mcNear === null || mcNear === undefined) return '—';
  const usd = tokens.getNearUsd();
  return usd ? fmtUsdCompact(mcNear * usd) : `${fmtNum(mcNear)} NEAR`;
}

function pnlCell(near, { empty = false } = {}) {
  if (empty) return { value: '—', small: '', tone: '' };
  if (near === null || near === undefined) return { value: '…', small: t('pos.priceLoading'), tone: 'muted' };
  const usd = tokens.getNearUsd();
  return {
    value: `${fmtNum(near, { sign: true })} NEAR`,
    small: usd ? `${near >= 0 ? '+' : '−'}${fmtUsd(Math.abs(near) * usd).replace(/^−?/, '')}` : '',
    tone: near > 0 ? 'up' : near < 0 ? 'down' : '',
  };
}

// Positions tab: one simple card per token, open ones first (FomoApp-style).
function renderPositionsView() {
  const box = $('#positionsView');
  if (!box) return;
  const cards = positionCards(state.positions, {
    balance: liveBalance,
    priceNear: tokens.priceNear,
    supply: (tk) => {
      const raw = tokens.supply(tk);
      const dec = tokens.decimals(tk);
      return raw !== null && dec !== null ? toNumber(raw, dec) : null;
    },
  });
  if (!cards.length) {
    box.replaceChildren(el('div', { class: 'pos-empty' }, state.historyLoaded ? t('pos.none') : t('loadingHistory')));
    return;
  }
  const o = positionsOverview(cards);
  const usd = tokens.getNearUsd();
  const usdOf = (v) => (usd ? `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v) * usd).replace(/^−?/, '')}` : '');
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const head = el('dl', { class: 'po-head' },
    el('div', {}, el('dt', {}, t('pos.realized')), el('dd', { class: tone(o.realized) }, `${fmtNum(o.realized, { sign: true })} NEAR`, el('small', {}, usdOf(o.realized)))),
    el('div', {}, el('dt', {}, t('pos.unrealized')), el('dd', { class: tone(o.unrealized) }, `${fmtNum(o.unrealized, { sign: true })} NEAR`, el('small', {}, usdOf(o.unrealized)))),
    el('div', {}, el('dt', {}, t('pos.winRate')), el('dd', {}, o.winRate !== null ? fmtPct(o.winRate, { sign: false }) : '—', el('small', {}, t('pos.counts', { o: o.open, c: o.closed })))),
    el('div', {}, el('dt', {}, t('pos.avgHold')), el('dd', {}, fmtDuration(o.avgHoldMs), el('small', {}, `${o.trades} ${tp('tradeWord', o.trades)}`))));

  const nearUsd = (near) => (usd && near !== null && near !== undefined ? fmtUsd(near * usd) : '');
  const sortBy = state.settings.posSort === 'size' ? 'size' : 'date';
  const sortDir = state.settings.posDir === 'asc' ? 'asc' : 'desc';
  const sortBar = el('div', { class: 'po-sort' },
    el('span', { class: 'muted small' }, t('pos.sort')),
    el('div', { class: 'seg seg-sm', role: 'radiogroup', 'aria-label': t('pos.sort') },
      [['date', 'pos.sortDate', 'pos.sortDateHint'], ['size', 'pos.sortSize', 'pos.sortSizeHint']].map(([key, label, hint]) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(sortBy === key), class: sortBy === key ? 'on' : '', title: t(hint),
        onclick: () => {
          // a second click on the active option flips the direction
          state.settings.posDir = sortBy === key && sortDir === 'desc' ? 'asc' : 'desc';
          state.settings.posSort = key;
          saveSettings();
          renderPositionsView();
        },
      }, `${t(label)}${sortBy === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}`))));
  const list = sortPositionCards(cards, sortBy, sortDir).map((c) => {
    const sym = tokens.meta(c.token)?.symbol || c.token;
    const real = pnlCell(c.realized, { empty: !c.sells });
    const unreal = pnlCell(c.unrealized, { empty: !c.open });
    const totalTone = c.unpriced ? 'muted' : tone(c.total);
    const foot = [
      c.open ? t('pos.holding', { q: fmtNum(c.held), v: null }) : null,
      c.payoutsNear ? t('pos.payouts', fmtNum(c.payoutsNear)) : null,
      t('pos.opened', fmtDateShort(c.firstTs)),
      (c.open ? t('pos.holdingFor', fmtDuration(c.holdMs)) : t('pos.held', fmtDuration(c.holdMs))),
      `${c.buys} ${tp('buyWord', c.buys)} · ${c.sells} ${tp('sellWord', c.sells)}`,
    ].filter(Boolean).join(' · ');
    const cell = (label, value, sub = '', cls = '') => el('div', {}, el('dt', {}, label), el('dd', { class: cls }, value, sub ? el('span', { class: 'sub' }, sub) : null));
    const size = c.open
      ? cell(t('pos.valueLbl'), c.valueNear !== null ? `${fmtNum(c.valueNear)} NEAR` : '…', c.valueNear !== null ? nearUsd(c.valueNear) : t('pos.priceLoading'))
      : cell(t('pos.returnedLbl'), `${fmtNum(c.returned)} NEAR`, nearUsd(c.returned));
    return el('article', { class: `pos-card ${c.open ? 'is-open' : 'is-closed'}` },
      el('div', { class: 'pc-head' },
        tokenIcon(c.token, 'pos-icon'),
        el('div', { class: 'pc-title' },
          el('button', { type: 'button', class: 'pc-sym', title: t('showTradesOf', sym), onclick: () => setSearch(sym) }, sym),
          el('span', { class: `pc-status ${c.open ? 'open' : 'closed'}` }, t(c.open ? 'pos.open' : 'pos.closed')),
          c.cycles > 1 ? el('span', { class: 'pc-entry' }, t('pos.entryN', c.cycle + 1)) : null),
        el('div', { class: `pc-total ${totalTone}` },
          c.unpriced ? '…' : `${fmtNum(c.total, { sign: true })} NEAR`,
          el('span', { class: 'sub' }, c.unpriced ? t('pos.priceLoading') : [usdOf(c.total), c.pct !== null ? fmtPct(c.pct) : null].filter(Boolean).join(' · ')))),
      el('dl', { class: 'pc-grid' },
        // columns: entry (invested, entry cap) · now (value or returned, cap now or at exit) · PnL
        cell(t('pos.investedLbl'), `${fmtNum(c.invested)} NEAR`, nearUsd(c.invested)),
        size,
        cell(t('pos.realized'), real.value, real.small, real.tone),
        cell(t('pos.entryMc'), mcText(c.entryMcNear)),
        c.open ? cell(t('pos.nowMc'), mcText(c.nowMcNear)) : cell(t('pos.exitMc'), mcText(c.exitMcNear)),
        cell(t('pos.unrealized'), unreal.value, unreal.small, unreal.tone)),
      el('div', { class: 'pc-foot' }, foot));
  });
  box.replaceChildren(head, sortBar, ...list, el('p', { class: 'panel-note muted small' }, t('pos.note')));
}

function renderSummary() {
  const box = $('#summaryView');
  const days = [1, 7, 30].includes(state.settings.summaryDays) ? state.settings.summaryDays : 1;
  const since = Date.now() - days * 86400000;
  const analyses = [...state.items.values()].map((i) => i.a);
  const s = periodSummary(analyses, state.positions, since, {
    decimals: tokens.decimals, balance: liveBalance, priceNear: tokens.priceNear, isOpen: positionOpen,
  });
  const usd = tokens.getNearUsd();
  const near = (v) => `${fmtNum(v, { sign: true })} NEAR`;
  const usdOf = (v) => (usd ? `≈ ${v >= 0 ? '+' : ''}${fmtUsd(v * usd)}` : '');
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const symOf = (tok) => tokens.meta(tok)?.symbol || tok;

  const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('sum.period') },
    [[1, 'sum.24h'], [7, 'sum.7d'], [30, 'sum.30d']].map(([d, key]) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(d === days), class: d === days ? 'on' : '',
      onclick: () => {
        state.settings.summaryDays = d;
        saveSettings();
        renderSummary();
      },
    }, t(key))));

  const notes = el('div', { class: 'sum-notes muted small' }, el('p', { class: 'panel-note' }, t('sum.note')));
  const loaded = analyses.map((a) => a.timestampMs);
  const oldest = loaded.length ? Math.min(...loaded) : null;
  if (state.resumeToken && oldest && oldest > since) notes.append(el('p', { class: 'panel-note' }, t('sum.partial', fmtDateTime(oldest))));
  if (s.unpriced) notes.append(el('p', { class: 'panel-note' }, t('sum.unpriced', s.unpriced)));

  if (!s.rows.length) {
    box.replaceChildren(seg, el('div', { class: 'sum-empty muted' }, t('sum.empty')), el('div', { class: 'sum-grid' },
      el('div', {}, el('dt', {}, t('sum.payouts')), el('dd', {}, `+${fmtNum(s.payoutsNear)} NEAR`, el('small', {}, `(${s.payouts})`)))), notes);
    return;
  }

  const hero = el('div', { class: 'sum-hero' },
    el('div', { class: 'sum-label muted' }, t('sum.total')),
    el('div', { class: `sum-big ${tone(s.total)}` }, near(s.total)),
    el('div', { class: 'sum-sub' }, [s.pct !== null ? fmtPct(s.pct) : null, usdOf(s.total), s.base > 0 ? t('sum.ofBase', fmtNum(s.base)) : null].filter(Boolean).join(' · ')));

  const cell = (label, value, cls = '', small = '') => el('div', {}, el('dt', {}, label), el('dd', { class: cls }, value, small ? el('small', {}, small) : null));
  const grid = el('dl', { class: 'sum-grid' },
    cell(t('sum.realized'), near(s.realized), tone(s.realized), usdOf(s.realized)),
    cell(t('sum.unrealized'), near(s.unrealized), tone(s.unrealized), usdOf(s.unrealized)),
    cell(t('sum.payouts'), `+${fmtNum(s.payoutsNear)} NEAR`, s.payoutsNear > 0 ? 'up' : '', `(${s.payouts})`),
    cell(t('sum.withPayouts'), near(s.totalWithPayouts), tone(s.totalWithPayouts), usdOf(s.totalWithPayouts)),
    cell(t('sum.bought'), `${fmtNum(s.spent)} NEAR`),
    cell(t('sum.sold'), `${fmtNum(s.received)} NEAR`),
    cell(t('sum.trades'), t('st.tradesVal', { n: s.buys + s.sells, b: s.buys, s: s.sells })),
    cell(t('sum.winrate'), s.winRate !== null ? fmtPct(s.winRate, { sign: false }) : '—', '', s.winRate !== null ? `(${s.wins}/${s.sells})` : ''),
    s.best ? cell(t('sum.best'), `${symOf(s.best.token)} ${near(s.best.total)}`, tone(s.best.total)) : null,
    s.worst ? cell(t('sum.worst'), `${symOf(s.worst.token)} ${near(s.worst.total)}`, tone(s.worst.total)) : null,
  );

  const rows = el('div', { class: 'sum-rows' });
  for (const r of s.rows) {
    const priced = !r.open || r.unrealized !== null;
    rows.append(el('div', { class: 'sum-row' },
      tokenIcon(r.token, 'pos-icon'),
      el('div', {},
        el('button', { type: 'button', class: 'link-btn pos-name', title: t('showTradesOf', symOf(r.token)), onclick: () => setSearch(symOf(r.token)) },
          symOf(r.token), el('span', { class: 'chip' }, t(r.open ? 'sum.open' : 'sum.closed'))),
        el('div', { class: 'pos-meta' }, t('sum.rowMeta', { b: fmtNum(r.spent), s: fmtNum(r.received) })),
        el('div', { class: 'pos-meta' }, t('sum.rowSplit', { r: near(r.realized), u: r.open ? (r.unrealized !== null ? near(r.unrealized) : '…') : '—' }))),
      el('div', { class: `pos-pnl ${priced ? tone(r.total) : 'muted'}` },
        priced ? near(r.total) : '…',
        el('span', { class: 'pct' }, [r.pct !== null ? fmtPct(r.pct) : null, priced ? usdOf(r.total) : null].filter(Boolean).join(' · '))),
    ));
  }

  box.replaceChildren(seg, hero, grid, el('div', { class: 'sum-section' }, t('sum.tokens')), rows, notes);
}

function renderSide() {
  renderPnlBoard();
  if (state.filter === 'positions') renderPositionsView();
}

function setSearch(q) {
  if (state.filter === 'summary' || state.filter === 'positions') {
    state.filter = 'all';
    document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.filter === 'all')));
  }
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
    track('search', acc, null, { by: session.getSession()?.accountId });
    if (acc !== state.account) switchAccount(acc);
  });

  $('#landingForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const acc = normalizeAccount($('#landingInput').value);
    if (!acc) {
      toast(t('badAddress'));
      return;
    }
    track('search', acc, null, { by: session.getSession()?.accountId });
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

// ---------------- wallet connection, profile, follows ----------------

function returnPath() {
  return location.search ? `./${location.search}` : './';
}

function connectUrl({ followAcc = null, logout = false } = {}) {
  const u = new URL('connect.html', location.href);
  u.searchParams.set('return', returnPath());
  if (followAcc) u.searchParams.set('follow', followAcc);
  if (logout) u.searchParams.set('logout', '1');
  return u.href;
}

function avatarInto(box, account, image) {
  box.replaceChildren();
  const safe = image ? tokens.safeIcon(image) : null;
  if (safe) {
    const img = el('img', { src: safe, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => {
      img.remove();
      box.textContent = (account || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2);
    });
    box.append(img);
  } else {
    box.textContent = (account || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2);
  }
}

function avatarEl(account, cls = 'avatar') {
  const box = el('span', { class: cls, 'aria-hidden': 'true' });
  avatarInto(box, account, null);
  session.nearSocialProfile(account, api.viewFunction).then((p) => p.image && avatarInto(box, account, p.image));
  return box;
}

function syncSession() {
  const s = session.getSession();
  const owner = s?.accountId || null;
  feed.setFollows(owner, owner ? session.getFollows(owner) : []);
  renderAuth();
  if (state.account) renderAccountActions();
  renderFollowPanel();
}

function renderAuth() {
  const s = session.getSession();
  $('#connectTop').hidden = !!s;
  const chip = $('#profileChip');
  chip.hidden = !s;
  if (!s) return;
  $('#profileName').textContent = shortAccount(s.accountId);
  chip.title = `${t('yourProfile')}: ${s.accountId}`;
  const box = $('#profileAvatar');
  if (box.dataset.acc !== s.accountId) {
    box.dataset.acc = s.accountId;
    avatarInto(box, s.accountId, null);
    session.nearSocialProfile(s.accountId, api.viewFunction).then((p) => {
      if (p.image && box.dataset.acc === s.accountId) avatarInto(box, s.accountId, p.image);
    });
  }
}

function renderAccountActions() {
  const box = $('#accountActions');
  const acc = state.account;
  if (!box || !acc) return;
  const s = session.getSession();
  if (s && s.accountId === acc) {
    box.replaceChildren(
      el('span', { class: 'you-badge' }, t('you')),
      el('a', { class: 'mini-btn', href: connectUrl({ logout: true }) }, t('disconnect')),
    );
    return;
  }
  const on = !!s && session.isFollowing(s.accountId, acc);
  const btn = el('button', {
    type: 'button', class: `btn follow-btn${on ? ' on' : ''}`, title: on ? t('unfollow') : '',
    onclick: () => {
      const cur = session.getSession();
      if (!cur) {
        location.href = connectUrl({ followAcc: acc });
        return;
      }
      if (session.isFollowing(cur.accountId, acc)) {
        session.unfollow(cur.accountId, acc);
        toast(t('unfollowed', shortAccount(acc)));
      } else {
        session.follow(cur.accountId, acc);
        toast(t('followed', shortAccount(acc)));
      }
    },
  }, on ? t('following') : t('follow'));
  box.replaceChildren(btn);
}

function loadAccountIdent(acc) {
  const box = $('#accountAvatar');
  const name = $('#accountName');
  box.dataset.acc = acc;
  avatarInto(box, acc, null);
  name.textContent = '';
  session.nearSocialProfile(acc, api.viewFunction).then((p) => {
    if (box.dataset.acc !== acc) return;
    if (p.image) avatarInto(box, acc, p.image);
    name.textContent = p.name || '';
  });
}

// PnL tiles for 24h / 7d / 30d on every wallet page (click opens the Summary tab).
function renderPnlBoard() {
  const box = $('#pnlBoard');
  if (!box) return;
  if (!state.account || !state.items.size) {
    box.replaceChildren();
    return;
  }
  const analyses = [...state.items.values()].map((i) => i.a);
  const usd = tokens.getNearUsd();
  const live = { decimals: tokens.decimals, balance: liveBalance, priceNear: tokens.priceNear, isOpen: positionOpen };
  const frag = document.createDocumentFragment();
  for (const [days, key] of [[1, 'sum.24h'], [7, 'sum.7d'], [30, 'sum.30d']]) {
    const s = periodSummary(analyses, state.positions, Date.now() - days * 86400000, live);
    const trades = s.buys + s.sells;
    const tone = s.total > 0 ? 'up' : s.total < 0 ? 'down' : '';
    const sub = trades
      ? [s.pct !== null ? fmtPct(s.pct) : null, usd ? `${s.total >= 0 ? '+' : ''}${fmtUsd(s.total * usd)}` : null, `${trades} ${tp('tradeWord', trades)}`].filter(Boolean).join(' · ')
      : t('noTradesShort');
    frag.append(el('button', {
      type: 'button', class: 'pnl-tile', title: t('openSummary'),
      onclick: () => {
        state.settings.summaryDays = days;
        saveSettings();
        state.filter = 'summary';
        document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.filter === 'summary')));
        renderFeed();
        $('#summaryView').scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    },
    el('span', { class: 'pt-label' }, `PnL · ${t(key)}`),
    el('span', { class: `pt-value ${tone}` }, trades ? `${fmtNum(s.total, { sign: true })} NEAR` : '—'),
    el('span', { class: 'pt-sub' }, sub)));
  }
  box.replaceChildren(frag);
}

// ---------------- leaderboard (top meme traders) ----------------

function startLeaderboard() {
  if (!boardStarted) {
    boardStarted = true;
    board.load();
  }
  renderLeaderboard();
}

// Narrow column: "+$39.2K" in every language (the Russian compact form "тыс." is too wide).
function usdShort(v) {
  const a = Math.abs(v);
  const [n, suffix] = a >= 1e6 ? [a / 1e6, 'M'] : a >= 1e3 ? [a / 1e3, 'K'] : [a, ''];
  return `$${n.toLocaleString(getLocale(), { maximumFractionDigits: suffix && n < 100 ? 1 : 0 })}${suffix}`;
}

const signedUsd = (v, compact = false) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${compact ? usdShort(v) : fmtUsd(Math.abs(v))}`;

function lbRowEl(r, i) {
  const roi = r.roi !== null ? fmtPct(r.roi * 100) : '—';
  const meta = [roi, `${r.trades} ${tp('tradeWord', r.trades)}`, r.platforms.join(', ')].filter(Boolean).join(' · ');
  const tip = [
    r.account,
    t('lb.tipPnl', { pnl: signedUsd(r.pnl), roi }),
    t('lb.tipSplit', { r: signedUsd(r.realized), u: signedUsd(r.unrealized) }),
    r.best && r.best.symbol ? t('lb.tipBest', `${r.best.symbol} ${signedUsd(r.best.pnl)}`) : null,
    t('lb.tipOpen'),
  ].filter(Boolean).join('\n');
  const avatar = el('span', { class: 'avatar', 'aria-hidden': 'true' });
  avatarInto(avatar, r.account, null);
  const current = r.account === state.account;
  return el('li', {},
    el('button', {
      type: 'button', class: `lb-row${current ? ' is-current' : ''}`, title: tip, 'aria-current': current ? 'true' : null,
      onclick: () => {
        if (r.account !== state.account) switchAccount(r.account);
        if (window.matchMedia('(max-width: 1179px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    },
    el('span', { class: `lb-rank${i < 3 ? ' top' : ''}` }, String(i + 1)),
    avatar,
    el('span', { class: 'lb-main' },
      el('span', { class: 'lb-acc' }, shortAccount(r.account)),
      el('span', { class: 'lb-meta' }, meta)),
    el('span', { class: `lb-pnl ${r.pnl > 0 ? 'up' : r.pnl < 0 ? 'down' : ''}` }, signedUsd(r.pnl, true))));
}

function renderLeaderboard(force = false) {
  const list = $('#lbList');
  if (!list) return;
  const s = state.settings;
  const w = LB_WINDOWS[s.lbWindow] ? s.lbWindow : DEFAULT_SETTINGS.lbWindow;
  const by = s.lbSort === 'roi' ? 'roi' : 'pnl';
  document.querySelectorAll('#lbPeriod button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lbw === w);
    b.setAttribute('aria-checked', String(b.dataset.lbw === w));
  });
  document.querySelectorAll('#lbSort button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lbs === by);
    b.setAttribute('aria-checked', String(b.dataset.lbs === by));
  });

  const loading = board.status === 'loading';
  const rb = $('#lbRefresh');
  rb.classList.toggle('spinning', loading);
  rb.disabled = loading;
  rb.setAttribute('aria-busy', String(loading));
  $('#lbProgress').hidden = !loading;
  $('#lbProgress').firstElementChild.style.width = `${Math.round(board.progress * 100)}%`;

  const data = board.data;
  const rows = board.rows(w, by);
  const status = $('#lbStatus');
  if (loading) {
    status.replaceChildren(t(data ? 'lb.updating' : 'lb.loading', Math.round(board.progress * 100)));
  } else if (board.status === 'error') {
    status.replaceChildren(t('lb.failed'), ' ', el('button', { type: 'button', class: 'link-btn', onclick: () => board.refresh() }, t('lb.retry')));
  } else if (data) {
    const total = board.total(w);
    status.replaceChildren(
      board.error ? `${t('lb.failedStale')} ` : '',
      `${t('lb.updated')} `,
      el('span', { class: 'rel', 'data-ts': data.at }, relTime(data.at)),
      rows.length && total ? ` · ${t('lb.count', { shown: rows.length, total: total.toLocaleString(getLocale()) })}` : '');
  } else {
    status.replaceChildren();
  }
  $('#lbPartial').hidden = !(data && data.partial && !loading);

  const sig = [data?.at, data?.partial, w, by, state.account, getLang()].join('|');
  if (!force && sig === boardSig) return;
  boardSig = sig;
  if (!data) {
    list.replaceChildren();
    return;
  }
  if (!rows.length) {
    list.replaceChildren(el('li', { class: 'lb-empty' }, t('lb.empty')));
    return;
  }
  list.replaceChildren(...rows.map(lbRowEl));
}

function bindLeaderboard() {
  $('#lbRefresh').innerHTML = ICONS.refresh;
  $('#lbRefresh').addEventListener('click', () => board.refresh());
  $('#lbPeriod').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lbw]');
    if (!b) return;
    state.settings.lbWindow = b.dataset.lbw;
    saveSettings();
    renderLeaderboard();
  });
  $('#lbSort').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lbs]');
    if (!b) return;
    state.settings.lbSort = b.dataset.lbs;
    saveSettings();
    renderLeaderboard();
  });
  // A full column on wide screens; a collapsed block above the wallet on narrower ones.
  const wrap = $('#lbWrap');
  const mq = window.matchMedia('(max-width: 1179px)');
  const apply = () => {
    wrap.open = !mq.matches;
  };
  apply();
  mq.addEventListener?.('change', apply);
}

function ctxFollow() {
  return { ...describeCtx(), positionOpen: () => null, cycleStats: () => null };
}

function renderFollowPanel() {
  const body = $('#followBody');
  if (!body) return;
  const s = session.getSession();
  const tabs = $('#followTabs');
  document.querySelectorAll('#followTabs button').forEach((b) => b.classList.toggle('on', b.dataset.ftab === state.followTab));
  const follows = s ? session.getFollows(s.accountId) : [];
  $('#followCount').textContent = follows.length ? String(follows.length) : '';
  tabs.hidden = !s;
  if (!s) {
    body.replaceChildren(el('div', { class: 'follow-empty' },
      el('span', {}, t('followConnectHint')),
      el('a', { class: 'btn follow-btn', href: connectUrl() }, t('connect'))));
    return;
  }
  if (state.followTab === 'wallets') {
    renderFollowWallets(body, s, follows);
    return;
  }
  if (!follows.length) {
    body.replaceChildren(el('div', { class: 'follow-empty' }, el('span', {}, t('followEmptyHint'))));
    return;
  }
  const events = feed.list(30);
  if (!events.length) {
    body.replaceChildren(el('div', { class: 'follow-empty' }, el('span', {}, feed.loading ? t('followLoading') : t('followNoTrades'))));
    return;
  }
  const ctx = ctxFollow();
  const list = el('div', { class: 'ff-list' });
  for (const ev of events) {
    let d;
    try {
      d = describe(ev.a, ctx);
    } catch {
      continue;
    }
    const isNew = ev.live && Date.now() - ev.seenAt < 6000;
    list.append(el('div', { class: `ff-item tone-${d.tone}${isNew ? ' is-new' : ''}` },
      d.icon.token ? tokenIcon(d.icon.token, 'pos-icon') : el('div', { class: 'pos-icon', 'aria-hidden': 'true' }, d.icon.glyph),
      el('div', {},
        el('div', { class: 'ff-head' },
          el('button', { type: 'button', class: 'ff-acc', title: ev.account, onclick: () => switchAccount(ev.account) }, shortAccount(ev.account)),
          el('span', { class: 'rel', 'data-ts': ev.a.timestampMs }, relTime(ev.a.timestampMs)),
          el('a', { class: 'ff-tx', href: explorer.tx(ev.hash), target: '_blank', rel: 'noopener noreferrer', title: 'NearBlocks' }, '↗')),
        el('div', { class: 'ff-title' }, d.title),
        d.subtitle ? el('div', { class: 'ff-sub' }, d.subtitle) : null)));
  }
  body.replaceChildren(list);
}

function renderFollowWallets(body, s, follows) {
  const rows = el('div', {});
  if (!follows.length) rows.append(el('div', { class: 'follow-empty' }, el('span', {}, t('followEmptyHint'))));
  for (const f of follows) {
    rows.append(el('div', { class: 'fw-row' },
      avatarEl(f.account, 'avatar'),
      el('div', {},
        el('button', { type: 'button', class: 'fw-name', title: f.account, onclick: () => switchAccount(f.account) }, shortAccount(f.account)),
        el('div', { class: 'fw-meta' }, t('followingSince', relTime(f.since)))),
      el('div', { class: 'fw-actions' },
        el('button', { type: 'button', class: 'mini-btn', onclick: () => session.unfollow(s.accountId, f.account) }, t('unfollow')))));
  }
  const importBtn = el('button', { type: 'button', class: 'mini-btn' }, t('importSocial'));
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    importBtn.textContent = t('importing');
    try {
      const list = await session.nearSocialFollows(s.accountId, api.viewFunction);
      const added = session.followMany(s.accountId, list);
      toast(list.length ? t('imported', { added, total: list.length }) : t('importNone'));
    } catch {
      toast(t('netErrorRetry'));
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = t('importSocial');
    }
  });
  body.replaceChildren(rows, el('div', { class: 'follow-foot' }, importBtn));
}

let lastFollowSound = 0;
function onFollowEvent(ev) {
  const st = state.settings;
  if (st.followAlerts === false || ev.a.kind !== 'trade') return;
  if (ev.account === state.account) return; // the open wallet already alerts from its own feed
  if (!shouldAlert(ev.a, { ...st, alertLevel: 'trades' })) return;
  const d = describe(ev.a, ctxFollow());
  const headline = `${shortAccount(ev.account)}: ${d.title}`;
  if (st.sound && Date.now() - lastFollowSound > 1200) {
    if (alerts.playSound(soundKind(ev.a), st.volume)) lastFollowSound = Date.now();
  }
  if (document.hidden) alerts.bumpUnread(headline);
  if (st.notify) {
    const icon = d.icon.token ? tokens.safeIcon(tokens.meta(d.icon.token)?.icon || '') : null;
    alerts.showNotification(headline, d.subtitle || '', `${ev.hash}|${ev.account}`, icon && icon.startsWith('https://') ? icon : undefined);
  }
  setTimeout(renderFollowPanel, 6500); // drop the "new" highlight
}

function bindSocial() {
  $('#connectTop').addEventListener('click', () => {
    location.href = connectUrl();
  });
  $('#profileChip').addEventListener('click', () => {
    const s = session.getSession();
    if (s) switchAccount(s.accountId);
  });
  $('#followTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ftab]');
    if (!b) return;
    state.followTab = b.dataset.ftab;
    renderFollowPanel();
  });
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
  bindSocial();
  bindLeaderboard();
  session.onChange(syncSession);
  syncSession();
  const s = session.getSession();
  if (s) track('visit', s.accountId, s.wallet); // a connected wallet came back (once per 6 hours)
  startTicker();
  route();
  window.__nwmReady = true; // seen by boot.js: the app started
  try {
    sessionStorage.removeItem('nwm.bootRetry');
  } catch {
    /* storage blocked */
  }
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
