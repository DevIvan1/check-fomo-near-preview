// Builds the human-readable post for an analysed transaction (texts come from i18n).
// Pure apart from the current language: everything external comes through `ctx`.

import { NEAR_ID, WNEAR, contractName, tokenFamily, explorer } from './config.js?v=90330b4f';
import { toNumber, toDecimalString, fmtNum, fmtUsd, fmtPct, shortAccount, shortHash, absBig, isImplicit } from './util.js?v=90330b4f';
import { t, tp, getLocale } from './i18n.js?v=90330b4f';

const GLYPHS = {
  transfer_in: '↓', transfer_out: '↑', ft_in: '↓', ft_out: '↑', receive_multi: '↓', debit: '↑',
  dex_deposit: '→', dex_withdraw: '←', wrap: '⇄', unwrap: '⇄', payout: '＋', claim: '◎',
  storage: '▢', register: '▢', stake: '◆', unstake: '◇', withdraw_stake: '◇',
  key_add: '!', key_delete: '!', deploy: '!', account_created: '★', account_deleted: '✕',
  contract_call: '·', mention: '@', order: '≡', liquidity: '≈', trade_failed: '✕', trade_pending: '…',
};

export function makeFmt(ctx) {
  const meta = (id) => ctx.meta(id);
  const sym = (id) => {
    if (!id || id === NEAR_ID) return 'NEAR';
    if (id === WNEAR) return 'wNEAR';
    return meta(id)?.symbol || shortAccount(id);
  };
  const dec = (id) => (!id || id === NEAR_ID || id === WNEAR ? 24 : meta(id)?.decimals ?? null);
  const num = (amount, id) => {
    const d = dec(id);
    return d === null ? null : toNumber(amount, d);
  };
  const amt = (amount, id, { sign = false } = {}) => {
    const d = dec(id);
    if (d === null) return `${sign && amount > 0n ? '+' : ''}${amount.toString()} (${t('raw')}) ${sym(id)}`;
    return `${fmtNum(toNumber(amount, d), { sign })} ${sym(id)}`;
  };
  const full = (amount, id) => {
    const d = dec(id);
    return d === null ? `${amount} ${sym(id)}` : `${toDecimalString(amount, d)} ${sym(id)}`;
  };
  const usd = (nearAmount) => {
    if (!ctx.nearUsd) return '';
    const v = toNumber(nearAmount, 24) * ctx.nearUsd;
    return `≈ ${fmtUsd(v)}`;
  };
  return { sym, dec, num, amt, full, usd };
}

function venueText(venues) {
  return venues.map(contractName).join(' + ');
}

function poolFee(pool) {
  const parts = (pool || '').split('|');
  const fee = Number(parts[2]);
  return Number.isFinite(fee) && parts.length === 3 ? `${fmtNum(fee / 10000)}%` : null;
}

function familyText(token) {
  const f = tokenFamily(token);
  return f ? t('family', f.name) : '';
}

export function tokenLinks(id) {
  if (!id || id === NEAR_ID) return [];
  const links = [];
  const f = tokenFamily(id);
  if (f?.site) links.push({ text: f.name, href: f.site(id) });
  links.push({ text: 'NearBlocks', href: explorer.token(id) });
  return links;
}

function txLine(a) {
  return {
    label: t('l.transaction'), value: shortHash(a.hash, 8, 6), title: a.hash, mono: true, copy: a.hash,
    links: [{ text: 'NearBlocks', href: explorer.tx(a.hash) }, { text: 'Pikespeak', href: explorer.txAlt(a.hash) }],
  };
}

function tokenLine(id, f) {
  return { label: t('l.token'), value: id, mono: true, copy: id, links: tokenLinks(id), title: f.sym(id) };
}

function accountLine(label, id) {
  return { label, value: shortAccount(id), title: id, mono: true, copy: id, links: [{ text: 'NearBlocks', href: explorer.account(id) }] };
}

// 1-yocto deposits on ft_transfer/ft_transfer_call are protocol noise, not balance changes.
const NEAR_DUST = 1_000_000_000_000_000_000n; // 0.000001 NEAR

export function deltaParts(a, f) {
  const parts = [];
  const near = a.nearDelta;
  if (absBig(near) >= NEAR_DUST) parts.push({ token: NEAR_ID, amount: near, text: f.amt(near, NEAR_ID, { sign: true }), title: f.full(near, NEAR_ID) });
  for (const [token, amount] of Object.entries(a.deltas)) {
    if (token === NEAR_ID || token === WNEAR) continue;
    const id = token.startsWith('mt:') ? token.split(':').slice(2).join(':').replace(/^nep141:/, '') : token;
    const label = token.startsWith('mt:') ? ' (Intents)' : '';
    parts.push({ token: id, amount, text: f.amt(amount, id, { sign: true }) + label, title: f.full(amount, id) });
  }
  return parts;
}

function priceInfo(a, f, ctx) {
  const tr = a.trade;
  if (!tr || tr.side === 'swap') return null;
  const nearAmt = tr.side === 'buy' ? tr.amountIn : tr.amountOut;
  const tokAmt = tr.side === 'buy' ? tr.amountOut + (tr.taxAmount || 0n) : tr.amountIn;
  const nearN = f.num(nearAmt, NEAR_ID);
  const tokN = f.num(tokAmt, tr.token);
  if (!nearN || !tokN) return null;
  const price = nearN / tokN;
  const supply = ctx.supply ? ctx.supply(tr.token) : null;
  const supplyN = supply ? f.num(supply, tr.token) : null;
  return { price, fdv: supplyN ? price * supplyN : null };
}

function usdText(near, ctx) {
  return ctx.nearUsd ? `≈ ${near >= 0 ? '+' : ''}${fmtUsd(near * ctx.nearUsd)}` : '';
}

function pnlValue(pct, near) {
  return pct === null || pct === undefined ? `${fmtNum(near, { sign: true })} NEAR` : `${fmtPct(pct)} (${fmtNum(near, { sign: true })} NEAR)`;
}

// PnL of a buy: live (tokens valued at the current pool price) while the wallet holds the token,
// the realized result of the whole position once it is closed.
function pnlLine(tr, now, f, ctx) {
  if (ctx.positionOpen && ctx.positionOpen(tr.token) === false) {
    const p = ctx.positionStats ? ctx.positionStats(tr.token) : null;
    if (!p || !(p.nearIn > 0)) return { label: t('l.pnl'), value: t('closed') };
    const pct = (p.realized / p.nearIn) * 100;
    return {
      label: t('l.pnl'), value: pnlValue(pct, p.realized), note: [usdText(p.realized, ctx), t('closed')].filter(Boolean).join(' · '),
      tone: p.realized >= 0 ? 'up' : 'down',
    };
  }
  if (!now) return null;
  const spent = f.num(tr.amountIn, NEAR_ID);
  const value = f.num(tr.amountOut, tr.token) * now;
  const pnl = value - spent;
  const pct = spent ? (pnl / spent) * 100 : null;
  return { label: t('l.pnl'), value: pnlValue(pct, pnl), note: usdText(pnl, ctx), tone: pnl >= 0 ? 'up' : 'down', dyn: true, live: true };
}

export function describe(a, ctx) {
  const f = makeFmt(ctx);
  const out = {
    tone: 'neutral', icon: { glyph: GLYPHS[a.kind] || '·' }, title: '', subtitle: '',
    lines: [], details: [], tags: [], csv: {},
  };
  const main = out.lines;
  const sub = [];

  switch (a.kind) {
    case 'trade': {
      const tr = a.trade;
      out.icon = { token: tr.token };
      const fam = familyText(tr.token);
      sub.push(t('via', venueText(tr.venues)));
      if (tr.internal) sub.push(t('internal'));
      if (fam) sub.push(fam);
      const pi = priceInfo(a, f, ctx);
      if (tr.side === 'buy') {
        out.tone = 'buy';
        out.title = t('t.buy', { sym: f.sym(tr.token), amt: f.amt(tr.amountIn, NEAR_ID) });
        main.push({ label: t('l.spent'), value: f.amt(tr.amountIn, NEAR_ID), title: f.full(tr.amountIn, NEAR_ID), note: f.usd(tr.amountIn) });
        main.push({ label: t('l.received'), value: f.amt(tr.amountOut, tr.token), title: f.full(tr.amountOut, tr.token) });
        if (tr.taxAmount > 0n) {
          const pct = (f.num(tr.taxAmount, tr.token) / f.num(tr.amountOut + tr.taxAmount, tr.token)) * 100;
          main.push({ label: t('l.tokenTax'), value: `${f.amt(tr.taxAmount, tr.token)} (${fmtPct(pct, { sign: false })})`, title: f.full(tr.taxAmount, tr.token) });
        }
      } else if (tr.side === 'sell') {
        out.tone = 'sell';
        out.title = t('t.sell', { sym: f.sym(tr.token), amt: f.amt(tr.amountOut, NEAR_ID) });
        main.push({ label: t('l.gave'), value: f.amt(tr.amountIn, tr.token), title: f.full(tr.amountIn, tr.token) });
        if (tr.taxAmount > 0n) {
          const pct = (f.num(tr.taxAmount, tr.token) / f.num(tr.amountIn, tr.token)) * 100;
          main.push({ label: t('l.tokenTax'), value: `${f.amt(tr.taxAmount, tr.token)} (${fmtPct(pct, { sign: false })})`, title: f.full(tr.taxAmount, tr.token) });
        }
        main.push({ label: t('l.received'), value: f.amt(tr.amountOut, NEAR_ID), title: f.full(tr.amountOut, NEAR_ID), note: f.usd(tr.amountOut) });
      } else {
        out.title = t('t.swap', { a: f.amt(tr.amountIn, tr.tokenIn), b: f.amt(tr.amountOut, tr.tokenOut) });
        main.push({ label: t('l.gave'), value: f.amt(tr.amountIn, tr.tokenIn), title: f.full(tr.amountIn, tr.tokenIn) });
        main.push({ label: t('l.received'), value: f.amt(tr.amountOut, tr.tokenOut), title: f.full(tr.amountOut, tr.tokenOut) });
      }
      if (pi) {
        const priceUsd = ctx.nearUsd ? `≈ ${fmtUsd(pi.price * ctx.nearUsd)}` : '';
        main.push({ label: t('l.price'), value: t('priceVal', { p: fmtNum(pi.price, { compact: false }), sym: f.sym(tr.token) }), note: priceUsd });
        if (pi.fdv) main.push({ label: t('l.fdv'), value: `${fmtNum(pi.fdv)} NEAR`, note: f.usd(BigInt(Math.round(pi.fdv)) * 10n ** 24n) });
        out.entryPrice = pi.price;
        const now = ctx.priceNear ? ctx.priceNear(tr.token) : null;
        if (now && pi.price) {
          const ch = (now / pi.price - 1) * 100;
          const fdvNow = pi.fdv ? (pi.fdv / pi.price) * now : null;
          const nowNote = [fdvNow ? t('fdvNow', fmtNum(fdvNow)) : null, t('sinceTrade', fmtPct(ch))].filter(Boolean).join(' · ');
          main.push({ label: t('l.now'), value: `${fmtNum(now, { compact: false })} NEAR`, note: nowNote, tone: ch >= 0 ? 'up' : 'down', dyn: true });
        }
      }
      if (tr.side === 'buy') {
        const line = pnlLine(tr, ctx.priceNear ? ctx.priceNear(tr.token) : null, f, ctx);
        if (line) main.push(line);
      }
      if (a.realized && tr.side === 'sell') {
        const r = a.realized;
        const note = [usdText(r.pnl, ctx), t('realizedNote'), r.closed ? t('closed') : null].filter(Boolean).join(' · ');
        main.push({ label: t('l.pnl'), value: pnlValue(r.pct, r.pnl), note, tone: r.pnl >= 0 ? 'up' : 'down' });
      }
      const routeTxt = tr.route.map((x) => f.sym(x)).join(' → ');
      const fees = [...new Set(tr.pools.map(poolFee).filter(Boolean))];
      main.push({ label: t('l.route'), value: routeTxt, note: `${tr.legs} ${tp('poolWord', tr.legs)}${fees.length ? t('feeNote', fees.join('/')) : ''}` });
      main.push(tokenLine(tr.token, f));
      if (tr.pools.length) out.details.push({ label: t('l.pools'), value: tr.pools.join('\n'), mono: true });
      out.csv = { side: tr.side, token: tr.token, in: f.full(tr.amountIn, tr.tokenIn), out: f.full(tr.amountOut, tr.tokenOut) };
      out.tags.push(t(tr.side === 'buy' ? 'tag.buy' : tr.side === 'sell' ? 'tag.sell' : 'tag.swap'));
      break;
    }
    case 'trade_failed':
    case 'trade_pending': {
      const it = a.intent;
      const pending = a.kind === 'trade_pending';
      const mode = pending ? 'pend' : 'fail';
      out.tone = pending ? 'neutral' : 'fail';
      const target = it.tokenIn === NEAR_ID ? it.tokenOut : it.tokenIn;
      out.icon = { token: target };
      if (it.tokenIn === NEAR_ID) out.title = t(`${mode}.buy`, { sym: f.sym(it.tokenOut), amt: f.amt(it.amountIn, NEAR_ID) });
      else if (it.tokenOut === NEAR_ID) out.title = t(`${mode}.sell`, { amt: f.amt(it.amountIn, it.tokenIn) });
      else out.title = t(`${mode}.swap`, { amt: f.amt(it.amountIn, it.tokenIn), sym: f.sym(it.tokenOut) });
      sub.push(t('via', contractName(it.dex)));
      const fam = familyText(target);
      if (fam) sub.push(fam);
      if (!pending) {
        const msg = a.failures.map((x) => x.message).filter(Boolean)[0] || t(it.stopPoint ? 'err.stop' : 'err.noSwap');
        main.push({ label: t('l.error'), value: humanError(msg), title: msg, tone: 'down' });
        const lost = deltaParts(a, f).filter((p) => p.amount < 0n);
        main.push({ label: t('l.outcome'), value: lost.length ? lost.map((p) => p.text).join(', ') : t('refunded') });
      } else {
        main.push({ label: t('l.status'), value: t('executingTx') });
      }
      main.push(tokenLine(target, f));
      out.tags.push(t(pending ? 'tag.pending' : 'tag.error'));
      break;
    }
    case 'transfer_out': {
      out.title = t('t.sent', { amt: f.amt(a.amount, NEAR_ID), to: shortAccount(a.counterparty) });
      if (a.createdAccount) sub.push(t('createdAccount'));
      main.push({ label: t('l.amount'), value: f.amt(a.amount, NEAR_ID), title: f.full(a.amount, NEAR_ID), note: f.usd(a.amount) });
      main.push(accountLine(t('l.recipient'), a.counterparty));
      out.csv = { out: f.full(a.amount, NEAR_ID) };
      break;
    }
    case 'transfer_in': {
      out.title = t('t.received', { amt: f.amt(a.amount, NEAR_ID), from: shortAccount(a.counterparty) });
      if (isImplicit(a.counterparty)) sub.push(t('implicit'));
      if (a.memo) sub.push(`memo: ${a.memo}`);
      main.push({ label: t('l.amount'), value: f.amt(a.amount, NEAR_ID), title: f.full(a.amount, NEAR_ID), note: f.usd(a.amount) });
      main.push(accountLine(t('l.sender'), a.counterparty));
      out.tone = 'buy';
      out.csv = { in: f.full(a.amount, NEAR_ID) };
      break;
    }
    case 'ft_out': {
      out.icon = { token: a.token };
      const actual = a.deltas[a.token] ? absBig(a.deltas[a.token]) : a.amount;
      out.title = t('t.sent', { amt: f.amt(actual, a.token), to: shortAccount(a.counterparty) });
      if (a.call) sub.push(t('withCall', contractName(a.counterparty)));
      if (a.memo) sub.push(`memo: ${a.memo}`);
      main.push({ label: t('l.amount'), value: f.amt(actual, a.token), title: f.full(actual, a.token) });
      main.push(accountLine(t('l.recipient'), a.counterparty));
      main.push(tokenLine(a.token, f));
      out.csv = { token: a.token, out: f.full(actual, a.token) };
      break;
    }
    case 'ft_in': {
      if (a.token) {
        out.icon = { token: a.token };
        out.title = t('t.received', { amt: f.amt(a.amount, a.token), from: shortAccount(a.counterparty) });
        if (a.memo) sub.push(`memo: ${a.memo}`);
        main.push({ label: t('l.amount'), value: f.amt(a.amount, a.token), title: f.full(a.amount, a.token) });
        main.push(accountLine(t('l.sender'), a.counterparty));
        main.push(tokenLine(a.token, f));
        out.csv = { token: a.token, in: f.full(a.amount, a.token) };
      } else {
        out.title = t('t.nftIn', shortAccount(a.counterparty));
      }
      out.tone = 'buy';
      break;
    }
    case 'receive_multi':
    case 'debit':
      out.title = a.kind === 'debit' ? t('t.debit', shortAccount(a.counterparty)) : t('t.receiveMulti', shortAccount(a.counterparty));
      break;
    case 'dex_deposit':
      out.icon = { token: a.token };
      out.title = t('t.dexDeposit', { amt: f.amt(a.amount, a.token), dex: contractName(a.counterparty) });
      main.push(tokenLine(a.token, f));
      break;
    case 'dex_withdraw':
      out.icon = { token: a.token };
      out.title = t('t.dexWithdraw', { amt: a.amount > 0n ? f.amt(a.amount, a.token) : f.sym(a.token), dex: contractName(a.counterparty) });
      main.push(tokenLine(a.token, f));
      break;
    case 'wrap':
      out.title = t('t.wrap', f.amt(a.amount, NEAR_ID));
      break;
    case 'unwrap':
      out.title = t('t.unwrap', f.amt(a.amount, WNEAR));
      break;
    case 'payout': {
      const token = ctx.launchToken ? ctx.launchToken(a.launchId) : null;
      if (token) out.icon = { token };
      const parts = deltaParts(a, f).filter((p) => p.amount > 0n);
      const got = parts.map((p) => p.text).join(', ') || '0';
      out.title = t('t.payout', { sym: token ? f.sym(token) : '', got });
      sub.push(t('launchSub', a.launchId));
      if (parts[0]) main.push({ label: t('l.got'), value: parts.map((p) => p.text).join(', '), title: parts.map((p) => p.title).join(', '), note: a.nearDelta > 0n ? f.usd(a.nearDelta) : '' });
      const unit = a.nearDelta > 0n ? NEAR_ID : parts[0]?.token;
      if (unit && a.totalPaid > 0n) {
        main.push({ label: t('l.totalPaid'), value: f.amt(a.totalPaid, unit), note: `${a.recipients} ${tp('recipientWord', a.recipients)}` });
        if (a.share > 0n) main.push({ label: t('l.share'), value: fmtPct((f.num(a.share, unit) / f.num(a.totalPaid, unit)) * 100, { sign: false }) });
      }
      if (token) main.push(tokenLine(token, f));
      out.tone = 'buy';
      out.csv = { token: token || '', in: parts.map((p) => p.title).join('; ') };
      break;
    }
    case 'claim': {
      const token = a.claimed?.token || (ctx.launchToken ? ctx.launchToken(a.launchId) : null);
      if (token) out.icon = { token };
      out.title = t('t.claim', token ? f.sym(token) : '');
      sub.push(t('launchSub', a.launchId));
      const c = a.claimed;
      if (c) {
        const items = [];
        if (big0(c.fee_near)) items.push(f.amt(BigInt(c.fee_near), NEAR_ID));
        if (big0(c.fee_token) && token) items.push(f.amt(BigInt(c.fee_token), token));
        main.push({ label: t('l.collected'), value: items.length ? items.join(' + ') : t('noFees') });
      }
      if (token) main.push(tokenLine(token, f));
      break;
    }
    case 'storage': {
      const isToken = a.contract !== 'v2.ref-finance.near' && a.contract !== 'dclv2.ref-labs.near';
      if (isToken) out.icon = { token: a.contract };
      const target = isToken ? f.sym(a.contract) : contractName(a.contract);
      out.title = a.forAccount && a.forAccount !== a.account
        ? t('t.storageFor', { who: shortAccount(a.forAccount), target })
        : t('t.storageSelf', { target, isToken });
      sub.push(t('storageDeposit', f.amt(a.amount, NEAR_ID)));
      if (isToken && tokenFamily(a.contract)) sub.push(t('prepBuy'));
      if (isToken) main.push(tokenLine(a.contract, f));
      break;
    }
    case 'register':
      out.title = t('t.register', { syms: a.registered.map((x) => f.sym(x)).join(', '), dex: contractName(a.contract) });
      if (a.registered[0]) out.icon = { token: a.registered[0] };
      a.registered.forEach((x) => main.push(tokenLine(x, f)));
      break;
    case 'stake':
      out.title = t('t.stake', { amt: f.amt(a.amount, NEAR_ID), pool: a.pool });
      break;
    case 'unstake':
      out.title = t('t.unstake', { amt: a.amount > 0n ? f.amt(a.amount, NEAR_ID) : '', pool: a.pool });
      break;
    case 'withdraw_stake':
      out.title = t('t.withdrawStake', { amt: a.amount > 0n ? f.amt(a.amount, NEAR_ID) : '', pool: a.pool });
      break;
    case 'key_add': {
      out.tone = 'warn';
      const p = a.key.permission;
      const fc = p && typeof p === 'object' ? p.FunctionCall : null;
      out.title = fc ? t('t.keyAddFc', fc.receiver_id) : t('t.keyAddFull');
      main.push({ label: t('l.key'), value: a.key.publicKey, mono: true, copy: a.key.publicKey });
      main.push({ label: t('l.rights'), value: fc ? t('rightsFc', { r: fc.receiver_id, m: fc.method_names?.length ? ' (' + fc.method_names.join(', ') + ')' : '' }) : t('fullAccess') });
      break;
    }
    case 'key_delete':
      out.tone = 'warn';
      out.title = t('t.keyDelete');
      main.push({ label: t('l.key'), value: a.key.publicKey, mono: true, copy: a.key.publicKey });
      break;
    case 'deploy':
      out.tone = 'warn';
      out.title = t('t.deploy');
      break;
    case 'account_created':
      out.title = t('t.accountCreated');
      sub.push(t('via', `${contractName(a.via)}${contractName(a.via) !== a.via ? ` (${a.via})` : ''}`));
      break;
    case 'account_deleted':
      out.tone = 'warn';
      out.title = t('t.accountDeleted', shortAccount(a.beneficiary));
      break;
    case 'order':
    case 'liquidity': {
      const names = [...new Set(a.dclEvents.map((e) => e.event))].join(', ');
      out.title = t(a.kind === 'order' ? 't.order' : 't.liquidity', names);
      const pools = [...new Set(a.dclEvents.flatMap((e) => e.data.map((d) => d.pool_id)).filter(Boolean))];
      pools.forEach((p) => main.push({ label: t('l.pool'), value: p, mono: true }));
      break;
    }
    case 'contract_call': {
      const methods = [...new Set(a.methods)].join(', ') || t('actions');
      out.title = t('t.call', { methods, contract: contractName(a.contract) });
      if (contractName(a.contract) !== a.contract) sub.push(a.contract);
      break;
    }
    case 'mention':
    default: {
      const m = [...new Set(a.calls.filter((c) => c.method).map((c) => c.method))].slice(0, 3).join(', ');
      out.title = t('t.mention', { from: shortAccount(a.signer), to: shortAccount(a.receiver) });
      if (m) sub.push(m);
    }
  }

  // Balance changes are shown for every non-trade post (trades already list them).
  const deltas = deltaParts(a, f);
  if (deltas.length && !['trade', 'payout', 'transfer_in', 'transfer_out', 'ft_in', 'ft_out'].includes(a.kind)) {
    main.push({ label: t('l.balance'), value: deltas.map((p) => p.text).join(' · '), title: deltas.map((p) => p.title).join('\n') });
  } else if (deltas.length) {
    out.details.push({ label: t('l.balance'), value: deltas.map((p) => p.text).join(' · '), title: deltas.map((p) => p.title).join('\n') });
  }
  if (a.nfts.length) out.details.push({ label: 'NFT', value: a.nfts.map((n) => `${n.dir === 'in' ? '+' : '−'} ${n.contract} #${n.ids.join(', #')}`).join('\n') });

  main.push(txLine(a));

  if (a.relayer) out.details.push(accountLine(t('l.relayer'), a.relayer));
  if (!a.isSigner) out.details.push(accountLine(t('l.signer'), a.signer));
  out.details.push({ label: t('l.block'), value: a.blockHeight != null ? a.blockHeight.toLocaleString(getLocale()) : '—' });
  if (a.isSigner && !a.relayer) out.details.push({ label: t('l.fee'), value: f.amt(a.fee, NEAR_ID), title: f.full(a.fee, NEAR_ID) });
  if (a.status !== 'success') {
    out.details.push({ label: t('l.status'), value: t(a.status === 'failed' ? 'txFailed' : 'partialFail') });
    a.failures.forEach((x) => out.details.push({ label: t('l.error'), value: `${x.contract}: ${x.message}`, mono: true }));
  }
  const calls = a.calls.filter((c) => c.kind === 'FunctionCall' || c.kind === 'Transfer');
  if (calls.length) {
    out.details.push({
      label: t('l.calls'),
      mono: true,
      value: calls.slice(0, 40).map((c) => `${c.status === 'failure' ? '✕ ' : ''}${shortAccount(c.from)} → ${shortAccount(c.to)}: ${c.kind === 'Transfer' ? 'transfer' : c.method}${c.deposit > 1n ? ` (${fmtNum(toNumber(c.deposit, 24))} NEAR)` : ''}`).join('\n') + (calls.length > 40 ? `\n${t('moreCalls', calls.length - 40)}` : ''),
    });
  }
  const evs = a.events.map((e) => `${e.standard || '?'}:${e.event}`);
  if (evs.length) out.details.push({ label: t('l.events'), value: [...new Set(evs)].join(', '), mono: true });

  if (a.pending && a.kind !== 'trade_pending') out.tags.push(t('tag.executing'));
  out.subtitle = sub.filter(Boolean).join(' · ');
  out.csv = { kind: a.kind, title: out.title, hash: a.hash, time: new Date(a.timestampMs).toISOString(), nearDelta: toDecimalString(a.nearDelta, 24), ...out.csv };
  return out;
}

function big0(v) {
  try {
    return BigInt(v || 0) > 0n;
  } catch {
    return false;
  }
}

export function humanError(msg) {
  const m = String(msg || '');
  if (/slippage|E204|E68|min_amount|insufficient output/i.test(m)) return t('err.slippage');
  if (/E101|insufficient balance|not enough balance|doesn't have enough balance/i.test(m)) return t('err.funds');
  if (/not registered|E10\b|storage/i.test(m)) return t('err.notRegistered');
  if (/Exceeded the prepaid gas|GasExceeded/i.test(m)) return t('err.gas');
  return m.replace(/^Smart contract panicked:\s*/, '').slice(0, 200);
}
