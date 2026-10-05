// Leaderboard of meme-coin traders on NEAR: who made the most on memes in the last 24h / 7d / 30d.
//
// Two sources, so nothing is counted twice:
//  - Nearly launchpad tokens (*.nearlytrade.near): Nearly's own ranking (top 100 per period) and,
//    for wallets outside it, Nearly's per-wallet stats;
//  - every other meme (Hoot, Shore, Meme Cooking, tkn.near, Token0 … and the classic memes on Rhea):
//    computed here from on-chain swaps indexed by Intear.
// Periods work like Nearly's: a period holds the positions opened in it, each with its full result
// (realized + unrealized at the current price), in USD. Only profitable wallets make the board.

import { toNumber } from './util.js?v=b7d0b915';
import { normalizeAccount } from './rules.js?v=b7d0b915';

export const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 }; // days
export const TOP_N = 100;
const DAY_MS = 86400000;
const CACHE_KEY = 'cf.leaderboard.v1';
export const FRESH_MS = 10 * 60 * 1000; // older cached boards refresh on load
const TOKENS_TO_SCAN = 20; // most traded non-Nearly memes (by 24h pool volume) whose swaps are read
const MIN_TOKEN_VOLUME_USD = 300;
const TRADERS_TO_SCAN = 60; // their own latest swaps are read as well
const DETAILS_MAX = 60; // Nearly stats for wallets found on other launchpads
const MIN_ROI_BASIS_USD = 25; // ROI ranking ignores dust positions

// Meme launchpads by token account suffix, with the name shown on the board.
const PLATFORMS = [
  ['.nearlytrade.near', 'Nearly'],
  ['.launchpad.justhoot.near', 'Hoot'],
  ['.hootpad.near', 'Hoot'],
  ['.hootlaunch.near', 'Hoot'],
  ['.near_hoot.near', 'Hoot'],
  ['.meme-cooking.near', 'Meme Cooking'],
  ['.shoremarkets.near', 'Shore'],
  ['.nearpadfamily.near', 'NearPad'],
  ['.nearafun.near', 'Neara'],
  ['.nearbased.near', 'NearBased'],
  ['.tkn.near', 'tkn.near'],
  ['.token0.near', 'Token0'],
  ['.token0forge.near', 'Token0'],
  ['.token0nova.near', 'Token0'],
  ['.launch.intear.near', 'Intear'],
  ['.aidols.near', 'AIdols'],
  ['.gra-fun.near', 'GraFun'],
  ['.cookinglabs.near', 'CookingLabs'],
  ['.shardsmarket.near', 'Shards'],
  ['.gaypad.j1-racing.near', 'GayPad'],
  ['.meme-launchpad.near', 'Meme Launchpad'],
  ['.umbrafun.near', 'Umbra'],
  ['.nearrr-fun.near', 'Nearrr'],
  ['.prismpad.near', 'Prism'],
  ['.prismpadfun.near', 'Prism'],
  ['.nearfunio.near', 'NearFun'],
  ['.onetokenengine.near', 'OneToken'],
  ['.tknport.near', 'tknport'],
];
// Memes deployed straight to Rhea (no launchpad).
const RHEA_MEMES = new Set([
  'token.0xshitzu.near', 'ftv2.nekotoken.near', 'token.lonkingnearbackto2024.near', 'gear.enleap.near',
  'usmeme.tg', 'dd.tg', 'benthedog.near',
]);
const NOT_MEMES = new Set(['intel.tkn.near']); // Intear's utility token

// Platform name of a meme token, null for anything else (NEAR, stablecoins, bridged assets…).
export function memePlatform(token) {
  if (!token || NOT_MEMES.has(token)) return null;
  if (RHEA_MEMES.has(token)) return 'Rhea';
  const hit = PLATFORMS.find(([suffix]) => token.endsWith(suffix));
  return hit ? hit[1] : null;
}

export const isMeme = (token) => memePlatform(token) !== null;
export const isNearlyToken = (token) => memePlatform(token) === 'Nearly';

// Protocol accounts that show up as "traders" in swap logs: intents solvers, routers, launchpad
// contracts and token contracts themselves. Anything that is not a valid NEAR account id (data
// from outside APIs) is dropped before it reaches the page.
const NOT_TRADERS = /^(intents\.near|.*\.ref-finance\.near|.*\.ref-labs\.near|router\.[a-z0-9_-]+\.near|lock\d*\.[a-z0-9_-]+\.near|intearbots\.near|.+\.aurabot\.near)$/;
export function isTraderAccount(acc) {
  if (!acc || typeof acc !== 'string' || normalizeAccount(acc) !== acc || NOT_TRADERS.test(acc)) return false;
  if (memePlatform(acc)) return false;
  return !PLATFORMS.some(([suffix]) => acc === suffix.slice(1));
}

// ---------- prices ----------

// Intear's list: { token: { price (USD per whole token), symbol, decimal } }.
export function priceBook(list) {
  const map = list && typeof list === 'object' ? list : {};
  const nearUsd = Number(map['wrap.near']?.price) || null;
  const decimals = (token) => {
    if (token === 'wrap.near') return 24;
    const d = Number(map[token]?.decimal);
    return Number.isInteger(d) && d >= 0 && d <= 64 ? d : null;
  };
  const priceNear = (token) => {
    if (token === 'wrap.near') return 1;
    const usd = Number(map[token]?.price);
    return nearUsd && Number.isFinite(usd) && usd > 0 ? usd / nearUsd : null;
  };
  const symbol = (token) => {
    const s = map[token]?.symbol;
    return typeof s === 'string' && s.trim() ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) : token.split('.')[0].slice(0, 12).toUpperCase();
  };
  return { nearUsd, decimals, priceNear, symbol };
}

// ---------- swaps -> trades -> positions ----------

// One Intear swap -> { trader, ts, token, side, qty, near } for a meme bought or sold for anything
// else (NEAR, RHEA, USDC…, valued in NEAR at the current price). null for swaps that are not a
// single meme trade or cannot be priced: meme-for-meme, unknown decimals, unpriced quote.
export function parseSwap(s, book) {
  const changes = s && s.balance_changes;
  if (!changes || typeof changes !== 'object' || typeof s.trader !== 'string') return null;
  let meme = null;
  let memes = 0;
  let quoteNear = 0; // signed: negative = paid
  let quotes = 0;
  for (const [token, raw] of Object.entries(changes)) {
    const dec = book.decimals(token);
    if (dec === null) return null;
    const amt = toNumber(raw, dec);
    if (!amt || !Number.isFinite(amt)) continue;
    if (isMeme(token)) {
      memes += 1;
      meme = { token, amt };
    } else {
      const p = book.priceNear(token);
      if (p === null) return null;
      quotes += 1;
      quoteNear += amt * p;
    }
  }
  if (memes !== 1 || !quotes || !quoteNear || Math.sign(quoteNear) === Math.sign(meme.amt)) return null;
  const ns = String(s.block_timestamp_nanosec || '');
  const ts = /^\d+$/.test(ns) ? Number(BigInt(ns) / 1000000n) : NaN;
  if (!Number.isFinite(ts)) return null;
  return {
    id: `${s.receipt_id || s.transaction_id || ns}|${s.trader}|${meme.token}`,
    trader: s.trader, ts, height: Number(s.block_height) || 0,
    token: meme.token, side: meme.amt > 0 ? 'buy' : 'sell', qty: Math.abs(meme.amt), near: Math.abs(quoteNear),
  };
}

// Position cycles of one wallet (like the Positions tab): a position opens with a buy from zero
// and closes when sold out; buying again later opens a new one. A sell with no known buy before
// it (bought before the swaps we have, or received) is ignored: its cost is unknown.
export function buildCycles(trades) {
  const list = trades.slice().sort((a, b) => a.ts - b.ts || a.height - b.height);
  const open = new Map();
  const cycles = [];
  for (const t of list) {
    let c = open.get(t.token);
    if (t.side === 'buy') {
      if (!c) {
        c = { token: t.token, opened: t.ts, buys: 0, sells: 0, qty: 0, bought: 0, cost: 0, invested: 0, returned: 0, realized: 0, closed: false };
        open.set(t.token, c);
        cycles.push(c);
      }
      c.buys += 1;
      c.qty += t.qty;
      c.bought += t.qty;
      c.cost += t.near;
      c.invested += t.near;
    } else if (c && c.qty > 0) {
      const known = Math.min(t.qty, c.qty);
      const avg = c.cost / c.qty;
      const proceeds = t.near * (known / t.qty);
      c.sells += 1;
      c.returned += proceeds;
      c.realized += proceeds - avg * known;
      c.cost = Math.max(0, c.cost - avg * known);
      c.qty -= known;
      if (c.qty <= c.bought * 1e-6) {
        c.qty = 0;
        c.cost = 0;
        c.closed = true;
        open.delete(t.token);
      }
    }
  }
  return cycles;
}

const emptyPart = () => ({ pnl: 0, realized: 0, unrealized: 0, basis: 0, trades: 0, tokens: 0, open: 0, best: null, platforms: new Set() });

// Positions opened since `since`, in USD: full result of each (realized + unrealized now).
export function cyclesWindow(cycles, since, book) {
  const o = emptyPart();
  const byToken = new Map();
  for (const c of cycles) {
    if (c.opened < since) continue;
    let unreal = 0;
    if (!c.closed && c.qty > 0) {
      o.open += 1;
      const p = book.priceNear(c.token);
      if (p !== null) unreal = c.qty * p - c.cost;
    }
    const usd = book.nearUsd || 0;
    o.realized += c.realized * usd;
    o.unrealized += unreal * usd;
    o.basis += c.invested * usd;
    o.trades += c.buys + c.sells;
    o.platforms.add(memePlatform(c.token));
    byToken.set(c.token, (byToken.get(c.token) || 0) + (c.realized + unreal) * usd);
  }
  o.pnl = o.realized + o.unrealized;
  o.tokens = byToken.size;
  for (const [token, pnl] of byToken) if (!o.best || pnl > o.best.pnl) o.best = { token, symbol: book.symbol(token), pnl };
  return o;
}

// Nearly's per-wallet stats -> the same window rule (tokens first bought since `since`).
export function nearlyDetailWindow(detail, since) {
  const o = emptyPart();
  for (const tk of Array.isArray(detail?.tokens) ? detail.tokens : []) {
    if (!(Number(tk.first_ts) >= since)) continue;
    const pnl = Number(tk.pnl_usd) || 0;
    o.pnl += pnl;
    o.realized += Number(tk.realized_usd) || 0;
    o.unrealized += Number(tk.unrealized_usd) || 0;
    o.basis += Number(tk.basis_usd) || 0;
    o.trades += (Number(tk.buys) || 0) + (Number(tk.sells) || 0);
    o.tokens += 1;
    if (tk.open) o.open += 1;
    if (!o.best || pnl > o.best.pnl) o.best = { token: tk.token, symbol: String(tk.symbol || '').slice(0, 16), pnl };
  }
  if (o.tokens) o.platforms.add('Nearly');
  return o;
}

function nearlyRowPart(r) {
  const o = emptyPart();
  o.pnl = Number(r.pnl_usd) || 0;
  o.realized = Number(r.realized_usd) || 0;
  o.unrealized = Number(r.unrealized_usd) || 0;
  o.basis = Number(r.basis_usd) || 0;
  o.trades = Number(r.trades) || 0;
  o.tokens = Number(r.tokens) || 0;
  o.open = Number(r.open) || 0;
  if (r.best) o.best = { token: r.best.token, symbol: String(r.best.symbol || '').slice(0, 16), pnl: Number(r.best.pnl_usd) || 0 };
  o.platforms.add('Nearly');
  return o;
}

// One period: Nearly part (ranking row, or per-wallet stats, or nothing) + other launchpads.
// listRows: Nearly ranking rows; others: Map acc -> cyclesWindow result; details: Map acc -> Nearly stats.
export function mergeWindow({ listRows = [], others = new Map(), details = new Map() }, since) {
  const listed = new Map(listRows.filter((r) => r && typeof r.account === 'string').map((r) => [r.account, r]));
  const rows = [];
  for (const account of new Set([...listed.keys(), ...others.keys()])) {
    if (!isTraderAccount(account)) continue;
    const parts = [];
    if (listed.has(account)) parts.push(nearlyRowPart(listed.get(account)));
    else if (details.has(account)) parts.push(nearlyDetailWindow(details.get(account), since));
    const other = others.get(account);
    if (other && other.trades) parts.push(other);
    if (!parts.length) continue;
    const row = { account, pnl: 0, realized: 0, unrealized: 0, basis: 0, trades: 0, tokens: 0, open: 0, best: null, platforms: [] };
    const platforms = new Set();
    for (const p of parts) {
      for (const k of ['pnl', 'realized', 'unrealized', 'basis', 'trades', 'tokens', 'open']) row[k] += p[k];
      if (p.best && (!row.best || p.best.pnl > row.best.pnl)) row.best = p.best;
      p.platforms.forEach((x) => platforms.add(x));
    }
    if (!row.trades) continue;
    row.platforms = [...platforms];
    row.roi = row.basis > 0 ? row.pnl / row.basis : null;
    rows.push(row);
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  return rows;
}

// Top of the board: profitable wallets only, by PnL (USD) or by ROI (positions of $25+ in total).
export function rankRows(rows, by = 'pnl', n = TOP_N) {
  const profitable = (rows || []).filter((r) => r.pnl > 0);
  if (by === 'roi') {
    return profitable.filter((r) => r.roi !== null && r.basis >= MIN_ROI_BASIS_USD).sort((a, b) => b.roi - a.roi || b.pnl - a.pnl).slice(0, n);
  }
  return profitable.sort((a, b) => b.pnl - a.pnl).slice(0, n);
}

// Non-Nearly memes worth scanning: the most traded ones in Rhea's pool list.
export function activeMemeTokens(pools, n = TOKENS_TO_SCAN, minVolume = MIN_TOKEN_VOLUME_USD) {
  const vol = new Map();
  for (const p of Array.isArray(pools) ? pools : []) {
    const v = Number(p?.volume_24h) || 0;
    for (const token of Array.isArray(p?.token_account_ids) ? p.token_account_ids : []) {
      if (isMeme(token) && !isNearlyToken(token)) vol.set(token, (vol.get(token) || 0) + v);
    }
  }
  return [...vol].filter(([, v]) => v >= minVolume).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}

async function pool(items, limit, fn, onDone) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      try {
        out[k] = await fn(items[k]);
      } catch {
        out[k] = undefined; // one failed request only leaves a gap
      }
      onDone?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class Leaderboard {
  // deps: { nearlyTraders(w), nearlyTrader(acc), refTopPools(), intearTokenList(), swapsByToken(token),
  //         swapsByTrader(acc), storageGet(key, fallback), storageSet(key, value), now() }
  constructor(deps, { onUpdate } = {}) {
    this.deps = { now: () => Date.now(), storageGet: () => null, storageSet: () => {}, ...deps };
    this.onUpdate = onUpdate || (() => {});
    this.status = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
    this.progress = 0;
    this.error = null;
    this.data = null; // { at, partial, windows: { '24h': { rows, total } … } }
    this.inflight = null;
    const cached = this.deps.storageGet(CACHE_KEY, null);
    if (cached && cached.windows && Number.isFinite(cached.at)) {
      this.data = cached;
      this.status = 'ready';
    }
  }

  get updatedAt() {
    return this.data?.at ?? null;
  }

  isStale() {
    return !this.data || this.deps.now() - this.data.at > FRESH_MS;
  }

  // window: '24h' | '7d' | '30d'; by: 'pnl' | 'roi'
  rows(window, by = 'pnl') {
    return rankRows(this.data?.windows?.[window]?.rows || [], by);
  }

  total(window) {
    return this.data?.windows?.[window]?.total ?? null;
  }

  // Shows the cached board and refreshes it when it is old.
  load() {
    if (this.isStale()) return this.refresh();
    return Promise.resolve();
  }

  refresh() {
    if (!this.inflight) {
      this.inflight = this.run().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  setProgress(p) {
    this.progress = Math.max(this.progress, Math.min(1, p));
    this.onUpdate();
  }

  async run() {
    const d = this.deps;
    this.status = 'loading';
    this.error = null;
    this.progress = 0;
    this.onUpdate();
    const now = d.now();
    const keys = Object.keys(WINDOWS);
    try {
      // 1. Nearly's ranking for every period, Rhea's busiest pools and Intear's price list.
      const [lists, pools, priceList] = await Promise.all([
        Promise.all(keys.map((w) => d.nearlyTraders(w).catch(() => null))),
        d.refTopPools().catch(() => []),
        d.intearTokenList().catch(() => null),
      ]);
      const listBy = Object.fromEntries(keys.map((w, i) => [w, Array.isArray(lists[i]?.rows) ? lists[i].rows : null]));
      const nearlyOk = keys.some((w) => listBy[w]);
      const book = priceBook(priceList);
      const othersOk = !!book.nearUsd;
      if (!nearlyOk && !othersOk) throw new Error('sources unavailable');
      this.setProgress(0.1);
      if (!this.data) this.publish(now, keys, listBy, lists, new Map(), new Map(), true); // something to look at early

      const othersBy = Object.fromEntries(keys.map((w) => [w, new Map()]));
      const details = new Map();
      if (othersOk) {
        // 2. Latest swaps of the busiest non-Nearly memes -> who trades them.
        const tokens = activeMemeTokens(pools);
        const steps = tokens.length + TRADERS_TO_SCAN + 1;
        let done = 0;
        const tick = () => this.setProgress(0.1 + 0.8 * (++done / steps));
        const tokenSwaps = await pool(tokens, 4, (t) => d.swapsByToken(t), tick);
        const trades = new Map(); // id -> parsed trade
        const addSwaps = (list) => {
          for (const s of Array.isArray(list) ? list : []) {
            const tr = parseSwap(s, book);
            // Nearly tokens come from Nearly's own stats: counting their swaps here would double them.
            if (tr && !isNearlyToken(tr.token) && isTraderAccount(tr.trader)) trades.set(tr.id, tr);
          }
        };
        tokenSwaps.forEach(addSwaps);

        // 3. The most active of them: their own latest swaps too (deeper history for their positions).
        const since30 = now - 30 * DAY_MS;
        const volume = new Map();
        for (const tr of trades.values()) if (tr.ts >= since30) volume.set(tr.trader, (volume.get(tr.trader) || 0) + tr.near);
        const scan = [...volume].sort((a, b) => b[1] - a[1]).slice(0, TRADERS_TO_SCAN).map(([a]) => a);
        const traderSwaps = await pool(scan, 4, (a) => d.swapsByTrader(a), tick);
        traderSwaps.forEach(addSwaps);

        // 4. Positions per wallet -> PnL per period.
        const byTrader = new Map();
        for (const tr of trades.values()) {
          if (!byTrader.has(tr.trader)) byTrader.set(tr.trader, []);
          byTrader.get(tr.trader).push(tr);
        }
        for (const [acc, list] of byTrader) {
          const cycles = buildCycles(list);
          for (const w of keys) {
            const part = cyclesWindow(cycles, now - WINDOWS[w] * DAY_MS, book);
            if (part.trades) othersBy[w].set(acc, part);
          }
        }

        // 5. Wallets that made money elsewhere but are not in Nearly's top: their Nearly result too,
        //    so a loss on Nearly is not left out.
        if (nearlyOk) {
          const need = new Map();
          for (const w of keys) {
            const listed = new Set((listBy[w] || []).map((r) => r.account));
            for (const [acc, part] of othersBy[w]) if (part.pnl > 0 && !listed.has(acc)) need.set(acc, Math.max(need.get(acc) || 0, part.pnl));
          }
          const accs = [...need].sort((a, b) => b[1] - a[1]).slice(0, DETAILS_MAX).map(([a]) => a);
          const got = await pool(accs, 3, (a) => d.nearlyTrader(a));
          accs.forEach((a, i) => got[i] && details.set(a, got[i]));
        }
        this.setProgress(0.97);
      }
      this.publish(now, keys, listBy, lists, othersBy, details, !(nearlyOk && othersOk));
      this.status = 'ready';
      this.progress = 1;
      d.storageSet(CACHE_KEY, this.data);
    } catch (e) {
      this.error = e;
      this.status = this.data ? 'ready' : 'error';
    } finally {
      this.onUpdate();
    }
  }

  publish(now, keys, listBy, lists, othersBy, details, partial) {
    const windows = {};
    keys.forEach((w, i) => {
      const since = now - WINDOWS[w] * DAY_MS;
      const rows = mergeWindow({ listRows: listBy[w] || [], others: othersBy[w] || new Map(), details }, since);
      const listed = new Set((listBy[w] || []).map((r) => r.account));
      const extra = [...(othersBy[w] || new Map()).keys()].filter((a) => !listed.has(a)).length;
      const nearlyTotal = Number(lists[i]?.traders) || listed.size;
      // Keep the board small in storage: everything that can reach the top by PnL or by ROI.
      const keep = new Set([...rankRows(rows, 'pnl', TOP_N * 2), ...rankRows(rows, 'roi', TOP_N * 2)]);
      windows[w] = { rows: rows.filter((r) => keep.has(r)), total: nearlyTotal + extra };
    });
    this.data = { at: now, partial: !!partial, windows };
    this.onUpdate();
  }
}
