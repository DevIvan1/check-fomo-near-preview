// Small pure rules shared by the app and the tests.

import { toNumber } from './util.js?v=a142e7bf';

export function normalizeAccount(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase().replace(/^@/, '');
  if (v.length < 2 || v.length > 64) return null;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v) ? v : null;
}

// Trade size in NEAR (buy: spent, sell: received); null for non-trades and token↔token swaps.
export function nearSize(a) {
  if (a.kind !== 'trade') return null;
  const t = a.trade;
  if (t.side === 'buy') return toNumber(t.amountIn, 24);
  if (t.side === 'sell') return toNumber(t.amountOut, 24);
  return null;
}

export function shouldAlert(a, s) {
  if (s.alertLevel === 'trades' && a.category !== 'trades') return false;
  if (s.alertLevel === 'normal' && a.importance === 'minor') return false;
  const n = nearSize(a);
  if (n !== null && s.alertMinNear > 0 && n < s.alertMinNear) return false;
  return true;
}

export function soundKind(a) {
  if (a.kind === 'trade') return a.trade.side === 'sell' ? 'sell' : 'buy';
  if (a.kind === 'trade_failed' || ['key_add', 'key_delete', 'deploy', 'account_deleted'].includes(a.kind)) return 'warn';
  if (a.kind === 'transfer_out' || a.kind === 'ft_out') return 'sell';
  if (a.kind === 'transfer_in' || a.kind === 'ft_in') return 'buy';
  return 'info';
}
