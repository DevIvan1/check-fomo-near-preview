// Limit orders on Rhea DCL (where Nearly tokens and many other memes trade): at what price and
// market cap an order waits, how far that is from the current price, how much of it is filled.
// Works for an order from DCL's `list_active_orders` and for the order in an `order_*` event.

import { WNEAR } from './config.js?v=9489111f';
import { toNumber } from './util.js?v=9489111f';
import { isMeme } from './leaderboard.js?v=9489111f';

export const DCL_ORDERS_METHOD = 'list_active_orders';

// Price of token_x in token_y (whole units) at a DCL point: 1.0001^point scaled by decimals.
export function pointPrice(point, decX, decY) {
  return 1.0001 ** Number(point) * 10 ** (decX - decY);
}

// The traded token of a pool "x|y|fee" and the quote it is priced in: wNEAR is always the quote;
// otherwise the meme side is the token (DIARHEA in DIARHEA|RHEA, ZECTARDIO in ZEC|ZECTARDIO).
export function orderTokens(poolId) {
  const [x, y] = String(poolId || '').split('|');
  if (!x || !y) return null;
  let token = x;
  if (x === WNEAR) token = y;
  else if (y !== WNEAR && isMeme(y) && !isMeme(x)) token = y;
  return { x, y, token, quote: token === x ? y : x };
}

const toMs = (ns) => {
  const s = String(ns ?? '');
  return /^\d+$/.test(s) ? Number(BigInt(s) / 1000000n) : null;
};

// ctx: { decimals(t) -> number|null, priceNear(t) -> number|null (1 for wNEAR),
//        supply(t) -> raw total supply (BigInt|string)|null }
// -> null when the order cannot be read (unknown pool or decimals).
export function orderView(order, ctx) {
  const pt = orderTokens(order?.pool_id);
  if (!pt || !Number.isFinite(Number(order.point))) return null;
  const dec = (t) => (t === WNEAR ? 24 : ctx.decimals(t));
  const decX = dec(pt.x);
  const decY = dec(pt.y);
  const sellDec = dec(order.sell_token);
  const buyDec = dec(order.buy_token);
  if ([decX, decY, sellDec, buyDec].some((d) => d === null || d === undefined)) return null;

  const pxy = pointPrice(order.point, decX, decY);
  const priceQuote = pt.token === pt.x ? pxy : 1 / pxy; // one token in quote units
  const quoteNear = pt.quote === WNEAR ? 1 : ctx.priceNear(pt.quote);
  const priceNear = quoteNear !== null && quoteNear !== undefined ? priceQuote * quoteNear : null;
  const side = order.sell_token === pt.token ? 'sell' : 'buy';

  const original = toNumber(order.original_amount ?? order.original_deposit_amount ?? '0', sellDec);
  const remain = order.remain_amount !== undefined && order.remain_amount !== null ? toNumber(order.remain_amount, sellDec) : null;
  const cancelled = order.cancel_amount ? toNumber(order.cancel_amount, sellDec) : 0;
  const bought = order.bought_amount !== undefined && order.bought_amount !== null ? toNumber(order.bought_amount, buyDec) : null;
  const filled = remain !== null ? Math.max(0, original - remain - cancelled) : null;

  const tokenDec = dec(pt.token);
  const supplyRaw = ctx.supply(pt.token);
  const supply = supplyRaw !== null && supplyRaw !== undefined ? toNumber(supplyRaw, tokenDec) : null;
  const nowNear = ctx.priceNear(pt.token);
  const left = remain ?? original; // what is still waiting
  return {
    id: order.order_id || null,
    poolId: order.pool_id,
    token: pt.token,
    quote: pt.quote,
    side,
    point: Number(order.point),
    priceQuote,
    priceNear,
    mcNear: priceNear !== null && supply ? priceNear * supply : null,
    nowNear: nowNear ?? null,
    nowMcNear: nowNear && supply ? nowNear * supply : null,
    // how far the price has to move for the order to fill: + up (sells), − down (buys)
    distancePct: priceNear !== null && nowNear ? (priceNear / nowNear - 1) * 100 : null,
    original,
    remain,
    left,
    bought,
    filledPct: filled !== null && original > 0 ? Math.min(100, (filled / original) * 100) : null,
    // size in NEAR: tokens on sale at the limit price, or the quote put up for a buy
    sizeNear: side === 'sell' ? (priceNear !== null ? left * priceNear : null) : quoteNear !== null && quoteNear !== undefined ? left * quoteNear : null,
    sellToken: order.sell_token,
    buyToken: order.buy_token,
    createdMs: toMs(order.created_at),
  };
}

// Open orders, newest first.
export function sortOrders(views) {
  return views.filter(Boolean).slice().sort((a, b) => (b.createdMs ?? 0) - (a.createdMs ?? 0));
}

// The state an order event describes, strongest first: a cancel also emits "order_completed".
export function orderEventKind(events) {
  const names = new Set((events || []).map((e) => e.event));
  if (names.has('order_cancelled')) return 'cancelled';
  if (names.has('order_completed')) return 'filled';
  if (names.has('order_added')) return 'placed';
  return null;
}
