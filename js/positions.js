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
