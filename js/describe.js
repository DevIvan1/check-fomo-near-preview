// Builds the human-readable post (Russian) for an analysed transaction.
// Pure: everything external comes through `ctx`.

import { NEAR_ID, WNEAR, contractName, tokenFamily, explorer } from './config.js';
import { toNumber, toDecimalString, fmtNum, fmtUsd, fmtPct, shortAccount, shortHash, absBig, isImplicit, plural } from './util.js';

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
    if (d === null) return `${sign && amount > 0n ? '+' : ''}${amount.toString()} (сырое) ${sym(id)}`;
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
  return f ? `токен лаунчпада ${f.name}` : '';
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
    label: 'Транзакция', value: shortHash(a.hash, 8, 6), title: a.hash, mono: true, copy: a.hash,
    links: [{ text: 'NearBlocks', href: explorer.tx(a.hash) }, { text: 'Pikespeak', href: explorer.txAlt(a.hash) }],
  };
}

function tokenLine(id, f, label = 'Токен') {
  return { label, value: id, mono: true, copy: id, links: tokenLinks(id), title: f.sym(id) };
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
  const t = a.trade;
  if (!t || t.side === 'swap') return null;
  const nearAmt = t.side === 'buy' ? t.amountIn : t.amountOut;
  const tokAmt = t.side === 'buy' ? t.amountOut + (t.taxAmount || 0n) : t.amountIn;
  const nearN = f.num(nearAmt, NEAR_ID);
  const tokN = f.num(tokAmt, t.token);
  if (!nearN || !tokN) return null;
  const price = nearN / tokN;
  const supply = ctx.supply ? ctx.supply(t.token) : null;
  const supplyN = supply ? f.num(supply, t.token) : null;
  return { price, fdv: supplyN ? price * supplyN : null };
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
      const t = a.trade;
      out.icon = { token: t.token };
      const venue = venueText(t.venues);
      const fam = familyText(t.token);
      sub.push(`через ${venue}`);
      if (t.internal) sub.push('с внутреннего баланса DEX');
      if (fam) sub.push(fam);
      const pi = priceInfo(a, f, ctx);
      if (t.side === 'buy') {
        out.tone = 'buy';
        out.title = `Купил ${f.sym(t.token)} на ${f.amt(t.amountIn, NEAR_ID)}`;
        main.push({ label: 'Потратил', value: f.amt(t.amountIn, NEAR_ID), title: f.full(t.amountIn, NEAR_ID), note: f.usd(t.amountIn) });
        main.push({ label: 'Получил', value: f.amt(t.amountOut, t.token), title: f.full(t.amountOut, t.token) });
        if (t.taxAmount > 0n) {
          const pct = (f.num(t.taxAmount, t.token) / f.num(t.amountOut + t.taxAmount, t.token)) * 100;
          main.push({ label: 'Налог токена', value: `${f.amt(t.taxAmount, t.token)} (${fmtPct(pct, { sign: false })})`, title: f.full(t.taxAmount, t.token) });
        }
      } else if (t.side === 'sell') {
        out.tone = 'sell';
        out.title = `Продал ${f.sym(t.token)} за ${f.amt(t.amountOut, NEAR_ID)}`;
        main.push({ label: 'Отдал', value: f.amt(t.amountIn, t.token), title: f.full(t.amountIn, t.token) });
        if (t.taxAmount > 0n) {
          const pct = (f.num(t.taxAmount, t.token) / f.num(t.amountIn, t.token)) * 100;
          main.push({ label: 'Налог токена', value: `${f.amt(t.taxAmount, t.token)} (${fmtPct(pct, { sign: false })})`, title: f.full(t.taxAmount, t.token) });
        }
        main.push({ label: 'Получил', value: f.amt(t.amountOut, NEAR_ID), title: f.full(t.amountOut, NEAR_ID), note: f.usd(t.amountOut) });
      } else {
        out.title = `Обменял ${f.amt(t.amountIn, t.tokenIn)} на ${f.amt(t.amountOut, t.tokenOut)}`;
        main.push({ label: 'Отдал', value: f.amt(t.amountIn, t.tokenIn), title: f.full(t.amountIn, t.tokenIn) });
        main.push({ label: 'Получил', value: f.amt(t.amountOut, t.tokenOut), title: f.full(t.amountOut, t.tokenOut) });
      }
      if (pi) {
        const priceUsd = ctx.nearUsd ? ` ≈ ${fmtUsd(pi.price * ctx.nearUsd)}` : '';
        main.push({ label: 'Цена', value: `${fmtNum(pi.price, { compact: false })} NEAR за 1 ${f.sym(t.token)}`, note: priceUsd.trim() });
        if (pi.fdv) main.push({ label: 'FDV на сделке', value: `${fmtNum(pi.fdv)} NEAR`, note: f.usd(BigInt(Math.round(pi.fdv)) * 10n ** 24n) });
        out.entryPrice = pi.price;
        const now = ctx.priceNear ? ctx.priceNear(t.token) : null;
        if (now && pi.price) {
          const ch = (now / pi.price - 1) * 100;
          main.push({ label: 'Сейчас', value: `${fmtNum(now, { compact: false })} NEAR`, note: `${fmtPct(ch)} с момента сделки`, tone: ch >= 0 ? 'up' : 'down', dyn: true });
        }
      }
      if (a.realized && t.side === 'sell') {
        const r = a.realized;
        const tone = r.pnl >= 0 ? 'up' : 'down';
        main.push({ label: 'Результат', value: `${fmtNum(r.pnl, { sign: true })} NEAR`, note: `${fmtPct(r.pct)} к средней цене входа${r.closed ? ' · позиция закрыта' : ''}`, tone });
      }
      const routeTxt = t.route.map((x) => f.sym(x)).join(' → ');
      const fees = [...new Set(t.pools.map(poolFee).filter(Boolean))];
      main.push({ label: 'Маршрут', value: routeTxt, note: `${t.legs} ${plural(t.legs, ['пул', 'пула', 'пулов'])}${fees.length ? ', комиссия ' + fees.join('/') : ''}` });
      main.push(tokenLine(t.token, f));
      if (t.pools.length) out.details.push({ label: 'Пулы', value: t.pools.join('\n'), mono: true });
      out.csv = { side: t.side, token: t.token, in: f.full(t.amountIn, t.tokenIn), out: f.full(t.amountOut, t.tokenOut) };
      out.tags.push(t.side === 'buy' ? 'покупка' : t.side === 'sell' ? 'продажа' : 'обмен');
      break;
    }
    case 'trade_failed':
    case 'trade_pending': {
      const it = a.intent;
      const pending = a.kind === 'trade_pending';
      out.tone = pending ? 'neutral' : 'fail';
      const target = it.tokenIn === NEAR_ID ? it.tokenOut : it.tokenIn;
      out.icon = { token: target };
      const verb = it.tokenIn === NEAR_ID ? (pending ? 'Покупает' : 'Не удалось купить') : it.tokenOut === NEAR_ID ? (pending ? 'Продаёт' : 'Не удалось продать') : pending ? 'Обменивает' : 'Не удалось обменять';
      if (it.tokenIn === NEAR_ID) out.title = `${verb} ${f.sym(it.tokenOut)} на ${f.amt(it.amountIn, NEAR_ID)}`;
      else if (it.tokenOut === NEAR_ID) out.title = `${verb} ${f.amt(it.amountIn, it.tokenIn)}`;
      else out.title = `${verb} ${f.amt(it.amountIn, it.tokenIn)} на ${f.sym(it.tokenOut)}`;
      sub.push(`через ${contractName(it.dex)}`);
      const fam = familyText(target);
      if (fam) sub.push(fam);
      if (!pending) {
        const msg = a.failures.map((x) => x.message).filter(Boolean)[0]
          || (it.stopPoint ? 'цена уже за пределом stop point — ордер не исполнен' : 'обмен не состоялся');
        main.push({ label: 'Ошибка', value: humanError(msg), title: msg, tone: 'down' });
        const lost = deltaParts(a, f).filter((p) => p.amount < 0n);
        main.push({ label: 'Итог', value: lost.length ? lost.map((p) => p.text).join(', ') : 'средства вернулись на кошелёк' });
      } else {
        main.push({ label: 'Статус', value: 'транзакция исполняется…' });
      }
      main.push(tokenLine(target, f));
      out.tags.push(pending ? 'в процессе' : 'ошибка');
      break;
    }
    case 'transfer_out': {
      out.title = `Отправил ${f.amt(a.amount, NEAR_ID)} → ${shortAccount(a.counterparty)}`;
      if (a.createdAccount) sub.push('создал новый аккаунт');
      main.push({ label: 'Сумма', value: f.amt(a.amount, NEAR_ID), title: f.full(a.amount, NEAR_ID), note: f.usd(a.amount) });
      main.push(accountLine('Получатель', a.counterparty));
      out.csv = { out: f.full(a.amount, NEAR_ID) };
      break;
    }
    case 'transfer_in': {
      out.title = `Получил ${f.amt(a.amount, NEAR_ID)} от ${shortAccount(a.counterparty)}`;
      if (isImplicit(a.counterparty)) sub.push('с implicit-аккаунта');
      if (a.memo) sub.push(`memo: ${a.memo}`);
      main.push({ label: 'Сумма', value: f.amt(a.amount, NEAR_ID), title: f.full(a.amount, NEAR_ID), note: f.usd(a.amount) });
      main.push(accountLine('Отправитель', a.counterparty));
      out.tone = 'buy';
      out.csv = { in: f.full(a.amount, NEAR_ID) };
      break;
    }
    case 'ft_out': {
      out.icon = { token: a.token };
      const actual = a.deltas[a.token] ? absBig(a.deltas[a.token]) : a.amount;
      out.title = `Отправил ${f.amt(actual, a.token)} → ${shortAccount(a.counterparty)}`;
      if (a.call) sub.push(`с вызовом контракта ${contractName(a.counterparty)}`);
      if (a.memo) sub.push(`memo: ${a.memo}`);
      main.push({ label: 'Сумма', value: f.amt(actual, a.token), title: f.full(actual, a.token) });
      main.push(accountLine('Получатель', a.counterparty));
      main.push(tokenLine(a.token, f));
      out.csv = { token: a.token, out: f.full(actual, a.token) };
      break;
    }
    case 'ft_in': {
      if (a.token) {
        out.icon = { token: a.token };
        out.title = `Получил ${f.amt(a.amount, a.token)} от ${shortAccount(a.counterparty)}`;
        if (a.memo) sub.push(`memo: ${a.memo}`);
        main.push({ label: 'Сумма', value: f.amt(a.amount, a.token), title: f.full(a.amount, a.token) });
        main.push(accountLine('Отправитель', a.counterparty));
        main.push(tokenLine(a.token, f));
        out.csv = { token: a.token, in: f.full(a.amount, a.token) };
      } else {
        out.title = `Получил NFT от ${shortAccount(a.counterparty)}`;
      }
      out.tone = 'buy';
      break;
    }
    case 'receive_multi':
    case 'debit': {
      out.title = a.kind === 'debit' ? `Списание с кошелька (${shortAccount(a.counterparty)})` : `Получил токены от ${shortAccount(a.counterparty)}`;
      break;
    }
    case 'dex_deposit': {
      out.icon = { token: a.token };
      out.title = `Внёс ${f.amt(a.amount, a.token)} на внутренний баланс ${contractName(a.counterparty)}`;
      main.push(tokenLine(a.token, f));
      break;
    }
    case 'dex_withdraw': {
      out.icon = { token: a.token };
      out.title = `Вывел ${a.amount > 0n ? f.amt(a.amount, a.token) : f.sym(a.token)} с внутреннего баланса ${contractName(a.counterparty)}`;
      main.push(tokenLine(a.token, f));
      break;
    }
    case 'wrap':
      out.title = `Обернул ${f.amt(a.amount, NEAR_ID)} в wNEAR`;
      break;
    case 'unwrap':
      out.title = `Развернул ${f.amt(a.amount, WNEAR)} в NEAR`;
      break;
    case 'payout': {
      const token = ctx.launchToken ? ctx.launchToken(a.launchId) : null;
      if (token) out.icon = { token };
      const parts = deltaParts(a, f).filter((p) => p.amount > 0n);
      const got = parts.map((p) => p.text).join(', ') || '0';
      out.title = `Выплата холдерам${token ? ' ' + f.sym(token) : ''}: ${got}`;
      sub.push(`Nearly · запуск #${a.launchId}`);
      if (parts[0]) main.push({ label: 'Получено', value: parts.map((p) => p.text).join(', '), title: parts.map((p) => p.title).join(', '), note: a.nearDelta > 0n ? f.usd(a.nearDelta) : '' });
      const unit = a.nearDelta > 0n ? NEAR_ID : parts[0]?.token;
      if (unit && a.totalPaid > 0n) {
        main.push({ label: 'Всего в выплате', value: f.amt(a.totalPaid, unit), note: `${a.recipients} ${plural(a.recipients, ['получатель', 'получателя', 'получателей'])}` });
        if (a.share > 0n) main.push({ label: 'Доля кошелька', value: fmtPct((f.num(a.share, unit) / f.num(a.totalPaid, unit)) * 100, { sign: false }) });
      }
      if (token) main.push(tokenLine(token, f, 'Токен'));
      out.tone = 'buy';
      out.csv = { token: token || '', in: parts.map((p) => p.title).join('; ') };
      break;
    }
    case 'claim': {
      const token = a.claimed?.token || (ctx.launchToken ? ctx.launchToken(a.launchId) : null);
      if (token) out.icon = { token };
      out.title = `Запустил сбор комиссий пула${token ? ' ' + f.sym(token) : ''}`;
      sub.push(`Nearly · запуск #${a.launchId}`);
      const c = a.claimed;
      if (c) {
        const items = [];
        if (big0(c.fee_near)) items.push(f.amt(BigInt(c.fee_near), NEAR_ID));
        if (big0(c.fee_token) && token) items.push(f.amt(BigInt(c.fee_token), token));
        main.push({ label: 'Собрано', value: items.length ? items.join(' + ') : 'новых комиссий не было' });
      }
      if (token) main.push(tokenLine(token, f));
      break;
    }
    case 'storage': {
      const isToken = a.contract !== 'v2.ref-finance.near' && a.contract !== 'dclv2.ref-labs.near';
      if (isToken) out.icon = { token: a.contract };
      const target = isToken ? f.sym(a.contract) : contractName(a.contract);
      out.title = a.forAccount && a.forAccount !== a.account
        ? `Оплатил регистрацию ${shortAccount(a.forAccount)} в ${target}`
        : `Зарегистрировался в ${isToken ? 'токене ' : ''}${target}`;
      sub.push(`storage deposit ${f.amt(a.amount, NEAR_ID)}`);
      if (isToken && tokenFamily(a.contract)) sub.push('обычно это подготовка к покупке');
      if (isToken) main.push(tokenLine(a.contract, f));
      break;
    }
    case 'register': {
      out.title = `Зарегистрировал ${a.registered.map((t) => f.sym(t)).join(', ')} во внутреннем балансе ${contractName(a.contract)}`;
      if (a.registered[0]) out.icon = { token: a.registered[0] };
      a.registered.forEach((t) => main.push(tokenLine(t, f)));
      break;
    }
    case 'stake':
      out.title = `Застейкал ${f.amt(a.amount, NEAR_ID)} у валидатора ${a.pool}`;
      break;
    case 'unstake':
      out.title = a.amount > 0n ? `Запросил анстейк ${f.amt(a.amount, NEAR_ID)} у ${a.pool}` : `Запросил анстейк всего у ${a.pool}`;
      break;
    case 'withdraw_stake':
      out.title = a.amount > 0n ? `Вывел ${f.amt(a.amount, NEAR_ID)} из стейкинга (${a.pool})` : `Вывел средства из стейкинга (${a.pool})`;
      break;
    case 'key_add': {
      out.tone = 'warn';
      const p = a.key.permission;
      const fc = p && typeof p === 'object' ? p.FunctionCall : null;
      out.title = fc ? `Добавил ключ доступа для ${fc.receiver_id}` : 'Добавил ключ с ПОЛНЫМ доступом к кошельку';
      main.push({ label: 'Ключ', value: a.key.publicKey, mono: true, copy: a.key.publicKey });
      main.push({ label: 'Права', value: fc ? `вызовы ${fc.receiver_id}${fc.method_names?.length ? ' (' + fc.method_names.join(', ') + ')' : ''}` : 'полный доступ' });
      break;
    }
    case 'key_delete':
      out.tone = 'warn';
      out.title = 'Удалил ключ доступа';
      main.push({ label: 'Ключ', value: a.key.publicKey, mono: true, copy: a.key.publicKey });
      break;
    case 'deploy':
      out.tone = 'warn';
      out.title = 'Задеплоил смарт-контракт на кошелёк';
      break;
    case 'account_created':
      out.title = 'Аккаунт создан';
      sub.push(`через ${contractName(a.via)}${contractName(a.via) !== a.via ? ` (${a.via})` : ''}`);
      break;
    case 'account_deleted':
      out.tone = 'warn';
      out.title = `Удалил аккаунт, остаток ушёл на ${shortAccount(a.beneficiary)}`;
      break;
    case 'order':
    case 'liquidity': {
      const names = [...new Set(a.dclEvents.map((e) => e.event))].join(', ');
      out.title = a.kind === 'order' ? `Лимитный ордер на Rhea DCL (${names})` : `Изменил ликвидность на Rhea DCL (${names})`;
      const pools = [...new Set(a.dclEvents.flatMap((e) => e.data.map((d) => d.pool_id)).filter(Boolean))];
      pools.forEach((p) => main.push({ label: 'Пул', value: p, mono: true }));
      break;
    }
    case 'contract_call': {
      const methods = [...new Set(a.methods)].join(', ') || 'действия';
      out.title = `Вызвал ${methods} в ${contractName(a.contract)}`;
      if (contractName(a.contract) !== a.contract) sub.push(a.contract);
      break;
    }
    case 'mention':
    default: {
      const m = [...new Set(a.calls.filter((c) => c.method).map((c) => c.method))].slice(0, 3).join(', ');
      out.title = `Упомянут в транзакции ${shortAccount(a.signer)} → ${shortAccount(a.receiver)}`;
      if (m) sub.push(m);
    }
  }

  // Balance changes are shown for every non-trade post (trades already list them).
  const deltas = deltaParts(a, f);
  if (deltas.length && !['trade', 'payout', 'transfer_in', 'transfer_out', 'ft_in', 'ft_out'].includes(a.kind)) {
    main.push({ label: 'Баланс', value: deltas.map((p) => p.text).join(' · '), title: deltas.map((p) => p.title).join('\n') });
  } else if (deltas.length) {
    out.details.push({ label: 'Баланс', value: deltas.map((p) => p.text).join(' · '), title: deltas.map((p) => p.title).join('\n') });
  }
  if (a.nfts.length) out.details.push({ label: 'NFT', value: a.nfts.map((n) => `${n.dir === 'in' ? '+' : '−'} ${n.contract} #${n.ids.join(', #')}`).join('\n') });

  main.push(txLine(a));

  if (a.relayer) out.details.push(accountLine('Релеер', a.relayer));
  if (!a.isSigner) out.details.push(accountLine('Подписант', a.signer));
  out.details.push({ label: 'Блок', value: a.blockHeight != null ? a.blockHeight.toLocaleString('ru-RU') : '—' });
  if (a.isSigner && !a.relayer) out.details.push({ label: 'Комиссия сети', value: f.amt(a.fee, NEAR_ID), title: f.full(a.fee, NEAR_ID) });
  if (a.status !== 'success') {
    out.details.push({ label: 'Статус', value: a.status === 'failed' ? 'транзакция не удалась' : 'часть вызовов завершилась ошибкой' });
    a.failures.forEach((x) => out.details.push({ label: 'Ошибка', value: `${x.contract}: ${x.message}`, mono: true }));
  }
  const calls = a.calls.filter((c) => c.kind === 'FunctionCall' || c.kind === 'Transfer');
  if (calls.length) {
    out.details.push({
      label: 'Вызовы',
      mono: true,
      value: calls.slice(0, 40).map((c) => `${c.status === 'failure' ? '✕ ' : ''}${shortAccount(c.from)} → ${shortAccount(c.to)}: ${c.kind === 'Transfer' ? 'transfer' : c.method}${c.deposit > 1n ? ` (${fmtNum(toNumber(c.deposit, 24))} NEAR)` : ''}`).join('\n') + (calls.length > 40 ? `\n… ещё ${calls.length - 40}` : ''),
    });
  }
  const evs = a.events.map((e) => `${e.standard || '?'}:${e.event}`);
  if (evs.length) out.details.push({ label: 'События', value: [...new Set(evs)].join(', '), mono: true });

  if (a.pending && a.kind !== 'trade_pending') out.tags.push('исполняется');
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
  if (/slippage|E204|E68|min_amount|insufficient output/i.test(m)) return 'проскальзывание: цена ушла сильнее допустимого';
  if (/E101|insufficient balance|not enough balance|doesn't have enough balance/i.test(m)) return 'недостаточно средств';
  if (/not registered|E10\b|storage/i.test(m)) return 'аккаунт не зарегистрирован в контракте';
  if (/Exceeded the prepaid gas|GasExceeded/i.test(m)) return 'не хватило газа';
  return m.replace(/^Smart contract panicked:\s*/, '').slice(0, 200);
}
