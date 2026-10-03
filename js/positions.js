// Per-token position tracking (average-cost method) and account-level stats.

import { NEAR_ID, WNEAR } from './config.js';
import { toNumber } from './util.js';

const byChainOrder = (x, y) => (x.blockHeight ?? 0) - (y.blockHeight ?? 0) || (x.txIndex ?? 0) - (y.txIndex ?? 0);

// ctx: { decimals(token) -> number|null, launchToken(launchId) -> token|null }
// Side effect: attaches `realized` to sell analyses.
export function computePositions(analyses, ctx) {
  const list = analyses.filter((a) => a && a.kind).slice().sort(byChainOrder);
  const pos = new Map();
  const get = (token) => {
    if (!pos.has(token)) {
      pos.set(token, {
        token, buys: 0, sells: 0, nearIn: 0, nearOut: 0, bought: 0, sold: 0,
        qty: 0, cost: 0, realized: 0, payoutsNear: 0, payoutsToken: 0, firstTs: null, lastTs: null,
      });
    }
    return pos.get(token);
  };

  for (const a of list) {
    if (a.kind === 'trade' && a.trade.side !== 'swap') {
      const t = a.trade;
      const dec = ctx.decimals(t.token);
      if (dec === null || dec === undefined) continue;
      const p = get(t.token);
      p.firstTs ??= a.timestampMs;
      p.lastTs = a.timestampMs;
      if (t.side === 'buy') {
        const n = toNumber(t.amountIn, 24);
        const q = toNumber(t.amountOut, dec);
        p.buys += 1;
        p.nearIn += n;
        p.bought += q;
        p.qty += q;
        p.cost += n;
        a.realized = null;
      } else {
        const n = toNumber(t.amountOut, 24);
        const q = toNumber(t.amountIn, dec);
        p.sells += 1;
        p.nearOut += n;
        p.sold += q;
        const avg = p.qty > 0 ? p.cost / p.qty : 0;
        const costSold = avg * Math.min(q, p.qty); // tokens beyond the tracked qty carry zero cost
        const pnl = n - costSold;
        p.realized += pnl;
        p.cost = Math.max(0, p.cost - costSold);
        p.qty = Math.max(0, p.qty - q);
        if (p.qty <= p.bought * 1e-6) {
          p.qty = 0;
          p.cost = 0;
        }
        a.realized = { pnl, pct: costSold > 0 ? (pnl / costSold) * 100 : null, closed: p.qty === 0, costNear: costSold };
      }
    } else if (a.kind === 'payout') {
      const token = ctx.launchToken(a.launchId);
      if (!token) continue;
      const p = get(token);
      if (a.nearDelta > 0n) p.payoutsNear += toNumber(a.nearDelta, 24);
      const v = a.deltas[token];
      const dec = ctx.decimals(token);
      if (v && v > 0n && dec !== null && dec !== undefined) p.payoutsToken += toNumber(v, dec);
    }
  }
  return pos;
}

// Merges tracked positions with live balances/prices into display rows.
// live: { balance(token) -> number|null, priceNear(token) -> number|null }
export function positionRows(pos, live) {
  const rows = [];
  for (const p of pos.values()) {
    const balance = live.balance(p.token);
    const price = live.priceNear(p.token);
    const held = balance ?? p.qty;
    const valueNear = price !== null && price !== undefined ? held * price : null;
    const unpriced = valueNear === null && held > 0;
    // Without a price an open position's result is unknown, not "−100%".
    const pnlTotal = unpriced ? null : p.nearOut + p.payoutsNear + (valueNear ?? 0) - p.nearIn;
    rows.push({
      ...p,
      held,
      price,
      valueNear,
      pnlTotal,
      pnlPct: pnlTotal !== null && p.nearIn > 0 ? (pnlTotal / p.nearIn) * 100 : null,
      open: held > 0 && (valueNear === null || valueNear > 0.0001),
      unpriced,
    });
  }
  rows.sort((x, y) => (y.open - x.open) || (y.lastTs ?? 0) - (x.lastTs ?? 0));
  return rows;
}

export function accountStats(analyses, now = Date.now()) {
  const s = {
    total: analyses.length, trades: 0, buys: 0, sells: 0, volumeNear: 0, trades24: 0, volume24: 0,
    fundedNear: 0, fundedFrom: new Map(), sentNear: 0, payoutsNear: 0, payouts: 0, failed: 0,
    firstTs: null, lastTs: null,
  };
  for (const a of analyses) {
    if (!a.kind) continue;
    s.firstTs = s.firstTs === null ? a.timestampMs : Math.min(s.firstTs, a.timestampMs);
    s.lastTs = s.lastTs === null ? a.timestampMs : Math.max(s.lastTs, a.timestampMs);
    if (a.kind === 'trade') {
      s.trades += 1;
      const t = a.trade;
      const nearAmt = t.side === 'buy' ? t.amountIn : t.side === 'sell' ? t.amountOut : 0n;
      const n = toNumber(nearAmt, 24);
      if (t.side === 'buy') s.buys += 1;
      if (t.side === 'sell') s.sells += 1;
      s.volumeNear += n;
      if (now - a.timestampMs < 86400000) {
        s.trades24 += 1;
        s.volume24 += n;
      }
    } else if (a.kind === 'trade_failed') {
      s.failed += 1;
    } else if (a.kind === 'transfer_in') {
      const n = toNumber(a.amount, 24);
      s.fundedNear += n;
      s.fundedFrom.set(a.counterparty, (s.fundedFrom.get(a.counterparty) || 0) + n);
    } else if (a.kind === 'transfer_out') {
      s.sentNear += toNumber(a.amount, 24);
    } else if (a.kind === 'payout') {
      s.payouts += 1;
      if (a.nearDelta > 0n) s.payoutsNear += toNumber(a.nearDelta, 24);
    }
  }
  return s;
}

export const isNearToken = (t) => t === NEAR_ID || t === WNEAR;

// PnL summary for trades made since `since` (ms): realized PnL of sells in the period
// (average-cost, cost basis from the whole loaded history) plus the current unrealized PnL
// of positions in those tokens that are still open, valued at the live price.
// live: { decimals(t), balance(t) -> number|null, priceNear(t) -> number|null, isOpen(t) -> bool|null }
export function periodSummary(analyses, pos, since, live) {
  const rows = new Map();
  const row = (token) => {
    if (!rows.has(token)) {
      rows.set(token, {
        token, buys: 0, sells: 0, spent: 0, received: 0, realized: 0, realizedCost: 0, wins: 0,
        open: false, openCost: 0, value: null, unrealized: null, total: 0, pct: null, lastTs: 0,
      });
    }
    return rows.get(token);
  };
  const s = { buys: 0, sells: 0, wins: 0, spent: 0, received: 0, realized: 0, unrealized: 0, payoutsNear: 0, payouts: 0, unpriced: 0 };

  for (const a of analyses) {
    if (!a || a.timestampMs < since) continue;
    if (a.kind === 'trade' && a.trade.side !== 'swap') {
      const tr = a.trade;
      if (live.decimals(tr.token) === null || live.decimals(tr.token) === undefined) continue;
      const r = row(tr.token);
      r.lastTs = Math.max(r.lastTs, a.timestampMs);
      if (tr.side === 'buy') {
        r.buys += 1;
        r.spent += toNumber(tr.amountIn, 24);
      } else {
        r.sells += 1;
        r.received += toNumber(tr.amountOut, 24);
        if (a.realized) {
          r.realized += a.realized.pnl;
          r.realizedCost += a.realized.costNear;
          if (a.realized.pnl > 0) r.wins += 1;
        }
      }
    } else if (a.kind === 'payout') {
      s.payouts += 1;
      if (a.nearDelta > 0n) s.payoutsNear += toNumber(a.nearDelta, 24);
    }
  }

  for (const r of rows.values()) {
    const p = pos.get(r.token);
    if (live.isOpen(r.token) && p) {
      r.open = true;
      r.openCost = p.cost;
      const bal = live.balance(r.token);
      const held = bal ?? p.qty;
      const price = live.priceNear(r.token);
      if (price !== null && price !== undefined) {
        r.value = held * price;
        r.unrealized = r.value - p.cost;
      } else {
        s.unpriced += 1;
      }
    }
    r.total = r.realized + (r.unrealized ?? 0);
    const base = r.realizedCost + (r.open && r.unrealized !== null ? r.openCost : 0);
    r.base = base;
    r.pct = base > 0 ? (r.total / base) * 100 : null;
    s.buys += r.buys;
    s.sells += r.sells;
    s.wins += r.wins;
    s.spent += r.spent;
    s.received += r.received;
    s.realized += r.realized;
    s.unrealized += r.unrealized ?? 0;
  }

  const list = [...rows.values()].sort((x, y) => y.lastTs - x.lastTs);
  s.total = s.realized + s.unrealized;
  s.base = list.reduce((acc, r) => acc + r.base, 0);
  s.pct = s.base > 0 ? (s.total / s.base) * 100 : null;
  s.totalWithPayouts = s.total + s.payoutsNear;
  s.winRate = s.sells > 0 ? (s.wins / s.sells) * 100 : null;
  const ranked = list.filter((r) => r.unrealized !== null || !r.open).slice().sort((x, y) => y.total - x.total);
  s.best = ranked.length ? ranked[0] : null;
  s.worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  s.rows = list;
  return s;
}
