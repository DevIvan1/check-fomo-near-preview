// Browser test suite. Open tests/index.html through any static server.

import { analyzeTx, parseLog, statusKind, failureMessage, fromRpcTxStatus } from '../js/parser.js?v=cebde690';
import { describe, humanError } from '../js/describe.js?v=cebde690';
import { computePositions, positionRows, accountStats, periodSummary, positionCards, positionsOverview, sortPositionCards } from '../js/positions.js?v=cebde690';
import { normalizeAccount, shouldAlert, nearSize, soundKind } from '../js/rules.js?v=cebde690';
import { toDecimalString, toNumber, fmtNum, big, shortHash, shortAccount, fmtPct, relTime } from '../js/util.js?v=cebde690';
import { safeIcon, dclPrice, routePrice } from '../js/tokens.js?v=cebde690';
import { NEAR_ID } from '../js/config.js?v=cebde690';
import * as session from '../js/session.js?v=cebde690';
import { FollowFeed, isFeedEvent } from '../js/following.js?v=cebde690';
import { setLang, t, tp, dictKeys } from '../js/i18n.js?v=cebde690';
import * as lb from '../js/leaderboard.js?v=cebde690';
import { track, trackEndpoint } from '../js/track.js?v=cebde690';

const ACC = 'hotfrog2879.near';
const results = [];
const pendingTests = [];
const fail = (name, e) => results.push({ name, ok: false, err: e && e.message ? e.message : String(e) });
const test = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pendingTests.push(r.then(() => results.push({ name, ok: true }), (e) => fail(name, e)));
    else results.push({ name, ok: true });
  } catch (e) {
    fail(name, e);
  }
};
const show = (v) => (typeof v === 'bigint' ? v.toString() + 'n' : JSON.stringify(v));
const eq = (a, b, msg = '') => {
  if (a !== b) throw new Error(`${msg} ожидалось ${show(b)}, получено ${show(a)}`);
};
const ok = (v, msg = 'условие не выполнено') => {
  if (!v) throw new Error(msg);
};
const approx = (a, b, eps, msg = '') => {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} ожидалось ≈${b}, получено ${a}`);
};
const has = (s, sub, msg = '') => {
  if (!String(s).includes(sub)) throw new Error(`${msg} «${s}» не содержит «${sub}»`);
};

const META = {
  'singularty.nearlytrade.near': { symbol: 'SINGULARTY', decimals: 18, supply: '1000000000000000000000000000' },
  'nearlee.nearlytrade.near': { symbol: 'NEARLEE', decimals: 18, supply: '1000000000000000000000000000' },
  'nearly-993927.nearlytrade.near': { symbol: 'NEARLY', decimals: 18 },
  'batman-4.nearlytrade.near': { symbol: 'BATMAN', decimals: 18 },
  'linear-protocol.near': { symbol: 'LINEAR', decimals: 24 },
  'zec.omft.near': { symbol: 'ZEC', decimals: 8 },
  'wrap.near': { symbol: 'wNEAR', decimals: 24 },
};
const LAUNCHES = { 1230: 'singularty.nearlytrade.near', 1951: 'nearly-993927.nearlytrade.near' };
const ctx = (extra = {}) => ({
  meta: (id) => (id === NEAR_ID ? { symbol: 'NEAR', decimals: 24 } : META[id] || null),
  nearUsd: 4.7,
  priceNear: () => null,
  launchToken: (id) => LAUNCHES[id] || null,
  supply: (id) => (META[id]?.supply ? BigInt(META[id].supply) : null),
  ...extra,
});
const decimals = (id) => (id === NEAR_ID ? 24 : META[id]?.decimals ?? null);

async function main() {
  setLang('ru'); // most expectations below are the Russian texts; English is checked at the end
  const fx = await (await fetch('./fixtures.json')).json();
  const A = (key, account = ACC) => analyzeTx(fx[key], account);

  // ---------- util ----------
  test('util: toDecimalString', () => {
    eq(toDecimalString(1500000000000000000000000n, 24), '1.5');
    eq(toDecimalString(-5n, 2), '-0.05');
    eq(toDecimalString(0n, 18), '0');
    eq(toDecimalString(123n, 0), '123');
    eq(toDecimalString(385066920780000000000000000n, 24), '385.06692078');
  });
  test('util: big() tolerates garbage', () => {
    eq(big('abc'), 0n);
    eq(big(null), 0n);
    eq(big('12'), 12n);
    eq(big(7.9), 7n);
    eq(big('1e+26'), 0n);
  });
  test('util: fmtNum ru-RU', () => {
    has(fmtNum(7699268.85), 'млн');
    eq(fmtNum(0.0302225), '0,03022');
    eq(fmtNum(500), '500');
    eq(fmtNum(151.808508), '151,81');
    eq(fmtNum(-2.5, { sign: true }), '−2,5');
    eq(fmtNum(2.5, { sign: true }), '+2,5');
    eq(fmtNum(0), '0');
    eq(fmtNum(NaN), '—');
  });
  test('util: fmtPct / shortHash / shortAccount / relTime', () => {
    eq(fmtPct(12.345), '+12%');
    eq(fmtPct(2.56), '+2,6%');
    eq(fmtPct(0.04, { sign: false }), '0%');
    eq(fmtPct(-150), '−150%');
    eq(shortHash('DttuxHBfgQanNmo2gNoqPQjVPocAJ2XiqVUQCTGGc3Sf'), 'DttuxH…c3Sf');
    eq(shortAccount('a9c8669de0ba79fbd634549bcfc9a250c94b49d8f0e021f491cb23b247eac61d'), 'a9c866…c61d');
    eq(shortAccount('hotfrog2879.near'), 'hotfrog2879.near');
    eq(relTime(1000, 1000), 'только что');
    eq(relTime(0, 120000), '2 мин назад');
  });

  // ---------- parser primitives ----------
  test('parseLog: Rhea v2 swap text', () => {
    const l = parseLog('Swapped 7007000000000000000000000000 wrap.near for 4922784062132488818876447938 linear-protocol.near, total fee 1, admin fee 2');
    eq(l.type, 'ref_swap');
    eq(l.tokenIn, 'wrap.near');
    eq(l.tokenOut, 'linear-protocol.near');
    eq(l.amountOut, '4922784062132488818876447938');
  });
  test('parseLog: wNEAR text logs', () => {
    eq(parseLog('Deposit 5 NEAR to a.near').op, 'mint');
    eq(parseLog('Withdraw 5 NEAR from a.near').op, 'burn');
    const t = parseLog('Transfer 5 from a.near to b.near');
    eq(t.from, 'a.near');
    eq(t.to, 'b.near');
    eq(parseLog('Refund 5 from b.near to a.near').to, 'a.near');
  });
  test('parseLog: EVENT_JSON and garbage', () => {
    const e = parseLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"a","new_owner_id":"b","amount":"1"}]}');
    eq(e.type, 'event');
    eq(e.data.length, 1);
    eq(parseLog('EVENT_JSON:{broken').type, 'text');
    eq(parseLog('hello').type, 'text');
    eq(parseLog(42).type, 'text');
  });
  test('statusKind / failureMessage', () => {
    eq(statusKind({ SuccessValue: '' }), 'success');
    eq(statusKind({ SuccessReceiptId: 'x' }), 'success');
    eq(statusKind({ Failure: {} }), 'failure');
    eq(statusKind(null), 'unknown');
    eq(failureMessage({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'boom' } } } } }), 'boom');
    eq(failureMessage({ SuccessValue: '' }), null);
  });

  // ---------- real transactions of hotfrog2879.near ----------
  test('BUY 500 NEAR → SINGULARTY (Rhea DCL, Nearly)', () => {
    const a = A('BUY_SINGULARTY');
    eq(a.kind, 'trade');
    eq(a.trade.side, 'buy');
    eq(a.trade.token, 'singularty.nearlytrade.near');
    approx(toNumber(a.trade.amountIn, 24), 500, 1e-9, 'потрачено NEAR');
    eq(a.trade.amountOut, 7699268852336594642823591n, 'получено токенов (после налога)');
    eq(a.trade.taxAmount, 77770392447844390331551n, 'налог');
    eq(a.trade.route.join('>'), 'near>singularty.nearlytrade.near');
    eq(a.trade.venues[0], 'dclv2.ref-labs.near');
    eq(a.category, 'trades');
    eq(a.importance, 'major');
    eq(a.pending, false);
    eq(a.status, 'success');
    ok(a.fee > 0n, 'комиссия сети');
  });
  test('BUY 200 NEAR → NEARLEE через NEARLY (мультихоп + storage)', () => {
    const a = A('BUY_NEARLEE_MULTIHOP');
    eq(a.kind, 'trade');
    eq(a.trade.side, 'buy');
    eq(a.trade.token, 'nearlee.nearlytrade.near');
    eq(a.trade.route.join('>'), 'near>nearly-993927.nearlytrade.near>nearlee.nearlytrade.near');
    approx(toNumber(a.trade.amountIn, 24), 200, 1e-9, 'storage deposit не входит в сумму сделки');
    eq(a.storageNear, 1250000000000000000000n);
    ok(a.trade.amountOut > 0n);
    eq(a.trade.legs, 2);
  });
  test('SELL NEARLEE → NEAR (мультихоп, налог 2%)', () => {
    const a = A('SELL_NEARLEE_MULTIHOP');
    eq(a.trade.side, 'sell');
    eq(a.trade.token, 'nearlee.nearlytrade.near');
    eq(a.trade.amountIn, 31896573990733847439539718n, 'продано с налогом');
    eq(a.trade.taxAmount, 637931479814676948790794n);
    approx(toNumber(a.trade.amountOut, 24), 151.808508000541, 1e-9);
    eq(a.trade.route.join('>'), 'nearlee.nearlytrade.near>nearly-993927.nearlytrade.near>near');
  });
  test('BUY + SELL BATMAN', () => {
    const b = A('BUY_BATMAN');
    eq(b.trade.side, 'buy');
    approx(toNumber(b.trade.amountIn, 24), 180, 1e-9);
    const s = A('SELL_BATMAN');
    eq(s.trade.side, 'sell');
    approx(toNumber(s.trade.amountOut, 24), 537.956325446286, 1e-6);
  });
  test('storage_deposit в токене = подготовка к покупке', () => {
    const a = A('STORAGE_SINGULARTY');
    eq(a.kind, 'storage');
    eq(a.contract, 'singularty.nearlytrade.near');
    eq(a.amount, 1250000000000000000000n);
    ok(a.tokens.has('singularty.nearlytrade.near'));
  });
  test('storage_deposit в Rhea (не токен)', () => {
    const a = A('REF_STORAGE');
    eq(a.kind, 'storage');
    eq(a.contract, 'v2.ref-finance.near');
    eq(a.tokens.has('v2.ref-finance.near'), false);
  });
  test('register_tokens в Rhea', () => {
    const a = A('REF_REGISTER');
    eq(a.kind, 'register');
    eq(a.registered.join(), 'nearlee.nearlytrade.near');
  });
  test('claim_fees на Nearly', () => {
    const a = A('CLAIM_FEES');
    eq(a.kind, 'claim');
    eq(String(a.launchId), '1230');
    eq(a.claimed.token, 'singularty.nearlytrade.near');
    eq(a.category, 'payouts');
  });
  test('выплата холдерам в NEAR', () => {
    const a = A('PAYOUT_NEAR');
    eq(a.kind, 'payout');
    eq(String(a.launchId), '1230');
    eq(a.nearDelta, 30222588890255817185118n);
    eq(a.share, 30222588890255817185118n);
    eq(a.recipients, 19);
    eq(a.totalPaid, 1149726458291695593755804n);
    eq(a.importance, 'minor');
    eq(a.isSigner, false);
  });
  test('выплата холдерам в токене NEARLY', () => {
    const a = A('PAYOUT_TOKEN');
    eq(a.kind, 'payout');
    eq(String(a.launchId), '1951');
    eq(a.deltas['nearly-993927.nearlytrade.near'], 44633812420630169534n);
    eq(a.nearDelta, 0n);
  });
  test('пополнение 385 NEAR с implicit-аккаунта', () => {
    const a = A('FUNDING');
    eq(a.kind, 'transfer_in');
    eq(a.amount, 385066920780000000000000000n);
    eq(a.counterparty, 'a9c8669de0ba79fbd634549bcfc9a250c94b49d8f0e021f491cb23b247eac61d');
    eq(a.importance, 'major');
  });
  test('создание аккаунта через Meteor relayer', () => {
    const a = A('ACCOUNT_CREATED');
    eq(a.kind, 'account_created');
    eq(a.via, 'meteor-relayer.near');
  });
  test('Rhea v2: свап с кошелька (другой аккаунт)', () => {
    const signer = fx.V2_SWAP_OTHER.transaction.signer_id;
    const a = A('V2_SWAP_OTHER', signer);
    eq(a.kind, 'trade');
    eq(a.trade.side, 'buy');
    eq(a.trade.token, 'linear-protocol.near');
    approx(toNumber(a.trade.amountIn, 24), 7007, 1e-6);
    eq(a.trade.amountOut, 4922784062132488818876447938n);
    eq(a.trade.venues[0], 'v2.ref-finance.near');
  });
  test('Rhea v2: свап с внутреннего баланса (без движений в кошельке)', () => {
    const signer = fx.V2_SWAP_INTERNAL.transaction.signer_id;
    const a = A('V2_SWAP_INTERNAL', signer);
    eq(a.kind, 'trade');
    eq(a.trade.token, 'zec.omft.near');
    eq(a.trade.amountIn, 3284102909933967965683712n);
    eq(a.trade.amountOut, 1172908n);
  });
  test('Rhea v2: прямой swap с 1 yocto не превращается в «купил на 1E-24 NEAR»', () => {
    const raw = structuredClone(fx.V2_SWAP_INTERNAL);
    const signer = raw.transaction.signer_id;
    const first = raw.receipts.find((r) => r.receipt.predecessor_id === signer);
    first.receipt.receipt.Action.actions[0].FunctionCall.deposit = '1';
    const a = analyzeTx(raw, signer);
    eq(a.nearDelta, -1n);
    eq(a.trade.amountIn, 3284102909933967965683712n);
    eq(a.trade.internal, true);
    has(describe(a, ctx()).subtitle, 'внутреннего баланса');
    eq(A('BUY_SINGULARTY').trade.internal, false);
  });
  test('SwapByStopPoint без исполнения (0 → 0) — не сделка, а неисполненный ордер', () => {
    const a = A('STOP_POINT_NOFILL', 'wx-cruce.near');
    eq(a.swaps.length, 0);
    eq(a.kind, 'trade_failed');
    eq(a.intent.stopPoint, true);
    eq(a.intent.tokenIn, NEAR_ID);
    has(describe(a, ctx()).lines.find((l) => l.label === 'Ошибка').value, 'stop point');
  });
  test('входящий 1 yocto на контракт — упоминание, а не перевод', () => {
    const a = A('YOCTO_DEPOSIT_TO_CONTRACT', 'intents.near');
    ok(a.kind !== 'transfer_in', 'kind = ' + a.kind);
    ok(!/E-\d/.test(describe(a, ctx()).title));
  });
  test('резервный источник: ответ RPC tx_status разбирается так же, как данные FastNEAR', () => {
    for (const key of ['RPC_BUY_SINGULARTY', 'RPC_SELL_NEARLEE', 'RPC_PAYOUT_TOKEN']) {
      const { rpc, meta, src } = fx[key];
      const viaRpc = analyzeTx(fromRpcTxStatus(rpc, meta), ACC);
      const viaFast = analyzeTx(fx[src], ACC);
      eq(viaRpc.hash, viaFast.hash, key);
      eq(viaRpc.kind, viaFast.kind, key + ' kind');
      eq(viaRpc.pending, false, key + ' pending');
      eq(viaRpc.blockHeight, viaFast.blockHeight, key + ' block');
      eq(viaRpc.timestampMs, viaFast.timestampMs, key + ' time');
      eq(viaRpc.nearDelta, viaFast.nearDelta, key + ' nearDelta');
      eq(JSON.stringify(Object.keys(viaRpc.deltas).sort()), JSON.stringify(Object.keys(viaFast.deltas).sort()), key + ' tokens');
      for (const tk of Object.keys(viaFast.deltas)) eq(viaRpc.deltas[tk], viaFast.deltas[tk], key + ' ' + tk);
      if (viaFast.trade) {
        eq(viaRpc.trade.amountIn, viaFast.trade.amountIn, key + ' in');
        eq(viaRpc.trade.amountOut, viaFast.trade.amountOut, key + ' out');
        eq(viaRpc.trade.route.join('>'), viaFast.trade.route.join('>'), key + ' route');
      }
    }
  });
  test('неудачная покупка (проскальзывание)', () => {
    const a = A('FAILED_BUY_SYNTHETIC');
    eq(a.kind, 'trade_failed');
    eq(a.intent.tokenIn, NEAR_ID);
    eq(a.intent.tokenOut, 'singularty.nearlytrade.near');
    eq(a.intent.amountIn, 500000000000000000000000000n);
    eq(a.status, 'partial');
    ok(a.failures.some((f) => f.message.includes('E204')));
    ok(a.nearDelta > -10n && a.nearDelta <= 0n, 'средства вернулись (wNEAR)');
    eq(a.pending, false);
  });
  test('незавершённая транзакция определяется как pending', () => {
    const a = A('PENDING_BUY_SYNTHETIC');
    eq(a.pending, true);
    eq(a.kind, 'trade_pending');
  });
  test('чужой аккаунт в выплате не получает дельт', () => {
    const a = A('PAYOUT_NEAR', 'nobody-here.near');
    eq(a.kind, 'payout');
    eq(a.share, 0n);
    eq(Object.keys(a.deltas).length, 0);
  });
  test('пустая/битая транзакция не роняет парсер', () => {
    const a = analyzeTx({ transaction: { hash: 'x', signer_id: 'a.near', receiver_id: 'b.near', actions: ['CreateAccount', { Weird: {} }] }, execution_outcome: {}, receipts: [] }, 'a.near');
    ok(a.kind, 'kind задан');
    eq(a.pending, true);
  });
  test('перевод wNEAR (ft_transfer на wrap.near) — «Отправил 2 wNEAR», а не 1 yocto', () => {
    const act = { FunctionCall: { method_name: 'ft_transfer', args: btoa(JSON.stringify({ receiver_id: 'bob.near', amount: '2000000000000000000000000' })), gas: 1, deposit: '1' } };
    const raw = {
      transaction: { hash: 'SynthWnearTransfer', signer_id: ACC, receiver_id: 'wrap.near', actions: [act] },
      execution_outcome: { block_height: 1, block_timestamp: '1790000000000000000', outcome: { receipt_ids: ['r1'], status: { SuccessReceiptId: 'r1' }, tokens_burnt: '0' } },
      receipts: [{
        receipt: { receipt_id: 'r1', predecessor_id: ACC, receiver_id: 'wrap.near', receipt: { Action: { signer_id: ACC, actions: [act] } } },
        execution_outcome: { block_height: 1, outcome: { logs: [`Transfer 2000000000000000000000000 from ${ACC} to bob.near`], receipt_ids: [], status: { SuccessValue: '' }, tokens_burnt: '0' } },
      }],
    };
    const a = analyzeTx(raw, ACC);
    eq(a.kind, 'ft_out');
    eq(a.token, 'wrap.near');
    eq(a.deltas['wrap.near'], -2000000000000000000000000n);
    eq(describe(a, ctx()).title, 'Отправил 2 wNEAR → bob.near');
  });
  test('мета-транзакция (Delegate) приписывается реальному отправителю', () => {
    const raw = structuredClone(fx.STORAGE_SINGULARTY);
    const inner = raw.transaction.actions;
    raw.transaction.signer_id = 'relayer.near';
    raw.transaction.receiver_id = ACC;
    raw.transaction.actions = [{ Delegate: { delegate_action: { sender_id: ACC, receiver_id: 'singularty.nearlytrade.near', actions: inner } } }];
    const a = analyzeTx(raw, ACC);
    eq(a.isSigner, true);
    eq(a.relayer, 'relayer.near');
    eq(a.kind, 'storage');
  });

  // ---------- describe ----------
  test('текст: покупка', () => {
    const d = describe(A('BUY_SINGULARTY'), ctx());
    eq(d.title, 'Купил SINGULARTY на 500 NEAR');
    eq(d.tone, 'buy');
    has(d.subtitle, 'Rhea DCL');
    has(d.subtitle, 'Nearly');
    const tax = d.lines.find((l) => l.label === 'Налог токена');
    ok(tax, 'строка налога');
    has(tax.value, '(1%)');
    const fdv = d.lines.find((l) => l.label === 'FDV на сделке');
    ok(fdv, 'строка FDV');
    const tx = d.lines.find((l) => l.label === 'Транзакция');
    eq(tx.copy, 'DttuxHBfgQanNmo2gNoqPQjVPocAJ2XiqVUQCTGGc3Sf');
    ok(tx.links.some((l) => l.href.includes('nearblocks.io/txns/')));
    const tok = d.lines.find((l) => l.label === 'Токен');
    eq(tok.value, 'singularty.nearlytrade.near');
    ok(tok.links.some((l) => l.href === 'https://nearly.trade/singularty.nearlytrade.near'));
    eq(d.icon.token, 'singularty.nearlytrade.near');
  });
  test('текст: продажа + налог 2%', () => {
    const d = describe(A('SELL_NEARLEE_MULTIHOP'), ctx());
    eq(d.title, 'Продал NEARLEE за 151,81 NEAR');
    eq(d.tone, 'sell');
    has(d.lines.find((l) => l.label === 'Налог токена').value, '(2%)');
    eq(d.lines.find((l) => l.label === 'Маршрут').value, 'NEARLEE → NEARLY → NEAR');
  });
  test('текст: «Сейчас» с изменением цены', () => {
    const a = A('BUY_SINGULARTY');
    const entry = 500 / ((7699268852336594642823591 + 77770392447844390331551) / 1e18);
    const d = describe(a, ctx({ priceNear: () => entry * 1.1 }));
    const now = d.lines.find((l) => l.label === 'Сейчас');
    ok(now, 'строка Сейчас');
    has(now.note, '+10%');
    eq(now.tone, 'up');
  });
  test('живая цена из пула DCL и маршрут через промежуточный токен', () => {
    approx(dclPrice({ current_point: 43467 }, 18, 24), 7.72064250410077e-05, 1e-15);
    approx(dclPrice({ current_point: 0 }, 24, 24), 1, 1e-12);
    const rates = [
      { x: 'nearly-993927.nearlytrade.near', y: 'wrap.near', p: 0.0009 },
      { x: 'nearlee.nearlytrade.near', y: 'nearly-993927.nearlytrade.near', p: 0.005 },
    ];
    approx(routePrice('nearlee.nearlytrade.near', rates), 0.0009 * 0.005, 1e-15);
    approx(routePrice('nearly-993927.nearlytrade.near', rates), 0.0009, 1e-15);
    approx(routePrice('wrap.near', rates), 1, 0);
    eq(routePrice('unknown.near', rates), null);
    // reversed pool orientation (wNEAR is token_x)
    approx(routePrice('usdc.near', [{ x: 'wrap.near', y: 'usdc.near', p: 4.7 }]), 1 / 4.7, 1e-12);
  });
  test('живой PnL на покупке: процент, нереализованная прибыль в NEAR и в $', () => {
    const a = A('BUY_SINGULARTY');
    const tokens = 7699268.852336594;
    const now = 0.0000816;
    const d = describe(a, ctx({ priceNear: () => now, positionOpen: () => true }));
    const pnl = d.lines.find((l) => l.label === 'PnL');
    ok(pnl, 'строка PnL');
    const exp = tokens * now - 500;
    has(pnl.value, fmtPct((exp / 500) * 100));
    has(pnl.value, `${fmtNum(exp, { sign: true })} NEAR`);
    has(pnl.note, '$');
    eq(pnl.tone, 'up');
    eq(pnl.live, true);
    const nowLine = d.lines.find((l) => l.label === 'Сейчас');
    has(nowLine.note, 'FDV');
    const closed = describe(a, ctx({ priceNear: () => now, positionOpen: () => false }));
    eq(closed.lines.find((l) => l.label === 'PnL').value, 'позиция закрыта');
    const loss = describe(a, ctx({ priceNear: () => 0.00005, positionOpen: () => true })).lines.find((l) => l.label === 'PnL');
    eq(loss.tone, 'down');
    has(loss.value, '−');
    const sell = describe(A('SELL_BATMAN'), ctx({ priceNear: () => 0.00003, positionOpen: () => true }));
    eq(sell.lines.find((l) => l.label === 'PnL'), undefined, 'у продажи нет живого PnL');
  });
  test('текст: неудачная покупка', () => {
    const d = describe(A('FAILED_BUY_SYNTHETIC'), ctx());
    eq(d.title, 'Не удалось купить SINGULARTY на 500 NEAR');
    eq(d.tone, 'fail');
    has(d.lines.find((l) => l.label === 'Ошибка').value, 'проскальзывание');
    eq(d.lines.find((l) => l.label === 'Итог').value, 'средства вернулись на кошелёк');
  });
  test('текст: выплата холдерам', () => {
    const d = describe(A('PAYOUT_NEAR'), ctx());
    eq(d.title, 'Выплата холдерам SINGULARTY: +0,03022 NEAR');
    has(d.subtitle, '#1230');
    has(d.lines.find((l) => l.label === 'Всего в выплате').note, '19');
    has(d.lines.find((l) => l.label === 'Доля кошелька').value, '2,6%');
  });
  test('текст: storage, пополнение, создание аккаунта, claim', () => {
    eq(describe(A('STORAGE_SINGULARTY'), ctx()).title, 'Зарегистрировался в токене SINGULARTY');
    has(describe(A('STORAGE_SINGULARTY'), ctx()).subtitle, 'подготовка к покупке');
    eq(describe(A('REF_STORAGE'), ctx()).title, 'Зарегистрировался в Rhea');
    eq(describe(A('FUNDING'), ctx()).title, 'Получил 385,07 NEAR от a9c866…c61d');
    eq(describe(A('ACCOUNT_CREATED'), ctx()).title, 'Аккаунт создан');
    eq(describe(A('CLAIM_FEES'), ctx()).title, 'Запустил сбор комиссий пула SINGULARTY');
    eq(describe(A('REF_REGISTER'), ctx()).title, 'Зарегистрировал NEARLEE во внутреннем балансе Rhea');
  });
  test('текст: неизвестные decimals не ломают описание', () => {
    const d = describe(A('BUY_SINGULARTY'), ctx({ meta: (id) => (id === NEAR_ID ? { symbol: 'NEAR', decimals: 24 } : null) }));
    has(d.title, 'Купил');
    ok(d.lines.length > 2);
  });
  test('текст: у каждого поста есть хеш транзакции', () => {
    for (const key of Object.keys(fx).filter((k) => !k.startsWith('RPC_'))) {
      const signer = key.startsWith('V2_') ? fx[key].transaction.signer_id : ACC;
      const d = describe(analyzeTx(fx[key], signer), ctx());
      ok(d.lines.some((l) => l.label === 'Транзакция' && l.copy === fx[key].transaction.hash), key);
      ok(d.title && d.title.length > 3, key + ': пустой заголовок');
      JSON.stringify(d); // must be serialisable (used as a render signature)
    }
  });
  test('humanError', () => {
    has(humanError('Smart contract panicked: E204: slippage error'), 'проскальзывание');
    has(humanError('E101: insufficient balance'), 'недостаточно');
    eq(humanError('Smart contract panicked: something'), 'something');
  });

  // ---------- positions ----------
  test('PnL: BATMAN +358 NEAR, NEARLEE −48 NEAR, SINGULARTY открыта', () => {
    const list = ['BUY_NEARLEE_MULTIHOP', 'BUY_BATMAN', 'SELL_BATMAN', 'SELL_NEARLEE_MULTIHOP', 'BUY_SINGULARTY', 'PAYOUT_NEAR'].map((k) => A(k));
    const pos = computePositions(list, { decimals, launchToken: (id) => LAUNCHES[id] || null });
    const bat = pos.get('batman-4.nearlytrade.near');
    approx(bat.nearIn, 180, 1e-6);
    approx(bat.realized, 537.956325446286 - 180, 1e-4);
    eq(bat.qty, 0);
    const lee = pos.get('nearlee.nearlytrade.near');
    approx(lee.realized, 151.808508 - 200, 1e-4);
    const sing = pos.get('singularty.nearlytrade.near');
    approx(sing.qty, 7699268.852336594, 1e-3);
    approx(sing.payoutsNear, 0.0302225888, 1e-9);
    const sell = list[2];
    ok(sell.realized && sell.realized.closed, 'продажа BATMAN закрыла позицию');
    approx(sell.realized.pct, (537.956325446286 / 180 - 1) * 100, 1e-3);
    const rows = positionRows(pos, { balance: (t) => (t === 'singularty.nearlytrade.near' ? 7699268.85 : 0), priceNear: (t) => (t === 'singularty.nearlytrade.near' ? 0.0001 : 0) });
    const r = rows.find((x) => x.token === 'singularty.nearlytrade.near');
    approx(r.valueNear, 769.926885, 1e-4);
    approx(r.pnlTotal, 769.926885 + 0.0302225888 - 500, 1e-4);
    eq(rows[0].token, 'singularty.nearlytrade.near', 'открытые позиции сверху');
    const unpriced = positionRows(pos, { balance: () => 5, priceNear: () => null }).find((x) => x.token === 'singularty.nearlytrade.near');
    eq(unpriced.pnlTotal, null, 'без цены PnL неизвестен, а не −100%');
    eq(unpriced.pnlPct, null);
  });
  test('PnL закрытых сделок в NEAR и $: на продаже и на покупке закрытой позиции', () => {
    const list = ['BUY_BATMAN', 'SELL_BATMAN'].map((k) => A(k));
    const pos = computePositions(list, { decimals, launchToken: () => null });
    const sell = describe(list[1], ctx());
    const line = sell.lines.find((l) => l.label === 'PnL');
    ok(line, 'строка PnL на продаже');
    has(line.value, '+199%');
    has(line.value, '+357,96 NEAR');
    has(line.note, '$');
    has(line.note, 'позиция закрыта');
    const buy = describe(list[0], ctx({ positionOpen: () => false, cycleStats: (tk, id) => pos.get(tk).cycles[id] }));
    const bl = buy.lines.find((l) => l.label === 'PnL');
    has(bl.value, '+199%');
    has(bl.value, '+357,96 NEAR');
    has(bl.note, '$');
    eq(bl.live, undefined, 'закрытая позиция не «живая»');
  });
  test('сводка за период: реализованный + открытый PnL, % от вложенного, выплаты', () => {
    const list = ['BUY_NEARLEE_MULTIHOP', 'BUY_BATMAN', 'SELL_BATMAN', 'SELL_NEARLEE_MULTIHOP', 'BUY_SINGULARTY', 'PAYOUT_NEAR'].map((k) => A(k));
    const pos = computePositions(list, { decimals, launchToken: (id) => LAUNCHES[id] || null });
    const live = {
      decimals,
      balance: (tk) => (tk === 'singularty.nearlytrade.near' ? 7699268.852336594 : 0),
      priceNear: (tk) => (tk === 'singularty.nearlytrade.near' ? 0.0001 : 0.00001),
      isOpen: (tk) => tk === 'singularty.nearlytrade.near',
    };
    const all = periodSummary(list, pos, 0, live);
    eq(all.rows.length, 3);
    approx(all.realized, (537.956325446286 - 180) + (151.808508 - 200), 1e-3);
    approx(all.unrealized, 769.9268852336594 - 500, 1e-6);
    approx(all.total, all.realized + all.unrealized, 1e-9);
    approx(all.base, 180 + 200 + 500, 1e-6);
    approx(all.pct, (all.total / 880) * 100, 1e-6);
    eq(all.payouts, 1);
    approx(all.payoutsNear, 0.0302225888, 1e-9);
    approx(all.totalWithPayouts, all.total + all.payoutsNear, 1e-9);
    eq(all.buys, 3);
    eq(all.sells, 2);
    approx(all.winRate, 50, 1e-9);
    eq(all.best.token, 'batman-4.nearlytrade.near');
    eq(all.worst.token, 'nearlee.nearlytrade.near');
    const sing = all.rows.find((r) => r.token === 'singularty.nearlytrade.near');
    eq(sing.open, true);
    approx(sing.pct, (269.9268852336594 / 500) * 100, 1e-6);
    // window that starts with the BATMAN sell: the earlier BATMAN buy is outside it
    const since = list[2].timestampMs;
    const win = periodSummary(list, pos, since, live);
    const bat = win.rows.find((r) => r.token === 'batman-4.nearlytrade.near');
    eq(bat.buys, 0);
    eq(bat.sells, 1);
    approx(bat.realized, 537.956325446286 - 180, 1e-4, 'реализованный PnL по стоимости из всей истории');
    eq(win.buys, 1);
    const none = periodSummary(list, pos, Date.now() + 1000, live);
    eq(none.rows.length, 0);
    eq(none.total, 0);
  });
  test('карточки позиций: статус, ТВХ/выход по капе, реализованный и нереализованный PnL', () => {
    const list = ['BUY_NEARLEE_MULTIHOP', 'BUY_BATMAN', 'SELL_BATMAN', 'SELL_NEARLEE_MULTIHOP', 'BUY_SINGULARTY', 'PAYOUT_NEAR'].map((k) => A(k));
    const pos = computePositions(list, { decimals, launchToken: (id) => LAUNCHES[id] || null });
    const SING = 'singularty.nearlytrade.near';
    const cards = positionCards(pos, {
      balance: (tk) => (tk === SING ? 7699268.852336594 : 0),
      priceNear: (tk) => (tk === SING ? 0.0001 : 0.00002),
      isOpen: (tk) => tk === SING,
      supply: () => 1e9,
    }, list[4].timestampMs + 3600000);
    eq(cards.length, 3);
    const sing = cards[0];
    eq(sing.token, SING, 'открытые сверху');
    eq(sing.open, true);
    approx(sing.entryMcNear, 500 / ((7699268852336594642823591 + 77770392447844390331551) / 1e18) * 1e9, 1e-3);
    approx(sing.nowMcNear, 0.0001 * 1e9, 1e-6);
    eq(sing.realized, 0);
    approx(sing.unrealized, 769.9268852336594 - 500, 1e-6);
    approx(sing.pct, ((769.9268852336594 - 500) / 500) * 100, 1e-6);
    eq(sing.holdMs, 3600000, 'держит час');
    approx(sing.payoutsNear, 0.0302225888, 1e-9);
    const bat = cards.find((c) => c.token === 'batman-4.nearlytrade.near');
    eq(bat.open, false);
    eq(bat.unrealized, 0);
    approx(bat.realized, 537.956325446286 - 180, 1e-4);
    approx(bat.entryMcNear, 9178.99, 0.5, 'ТВХ BATMAN по капе (как FDV на сделке)');
    ok(bat.exitMcNear > bat.entryMcNear, 'выход выше входа');
    eq(bat.nowMcNear, null);
    ok(bat.holdMs > 0);
    const ov = positionsOverview(cards);
    eq(ov.open, 1);
    eq(ov.closed, 2);
    eq(ov.wins, 1);
    approx(ov.winRate, 50, 1e-9);
    approx(ov.realized, (537.956325446286 - 180) + (151.808508 - 200), 1e-3);
    approx(ov.unrealized, 269.9268852336594, 1e-6);
    eq(ov.trades, 5);
    // unknown price: unrealized unknown, flagged
    const unpriced = positionCards(pos, { balance: () => 1, priceNear: () => null, isOpen: (tk) => tk === SING, supply: () => null })[0];
    eq(unpriced.unpriced, true);
    eq(unpriced.unrealized, null);
    eq(unpriced.entryMcNear, null, 'без supply капы нет');
  });
  test('новая покупка после полного выхода — новая позиция, старый убыток не смешивается', () => {
    // NEARLEE: bought for 200, sold for 151.81 (−48.19, closed); then bought again for 200 later
    const rebuyRaw = structuredClone(fx.BUY_NEARLEE_MULTIHOP);
    rebuyRaw.transaction.hash = 'SyntheticRebuyNearlee11111111111111111111111';
    const later = fx.SELL_NEARLEE_MULTIHOP.execution_outcome;
    rebuyRaw.execution_outcome.block_height = later.block_height + 1000;
    rebuyRaw.execution_outcome.block_timestamp = String(BigInt(later.block_timestamp) + 600000000000n);
    const list = [A('BUY_NEARLEE_MULTIHOP'), A('SELL_NEARLEE_MULTIHOP'), analyzeTx(rebuyRaw, ACC)];
    const pos = computePositions(list, { decimals, launchToken: () => null });
    const p = pos.get('nearlee.nearlytrade.near');
    eq(p.cycles.length, 2, 'две позиции');
    eq(p.cycles[0].closed, true);
    approx(p.cycles[0].realized, 151.808508 - 200, 1e-4);
    eq(p.cycles[1].closed, false);
    eq(p.cycles[1].realized, 0, 'у новой позиции нет старого убытка');
    approx(p.cycles[1].nearIn, 200, 1e-6);
    eq(list[0].cycleId, 0);
    eq(list[2].cycleId, 1);
    approx(p.cost, 200, 1e-6, 'себестоимость текущей позиции — только новая покупка');
    const cards = positionCards(pos, { balance: () => null, priceNear: () => 0.00001, supply: () => 1e9 });
    eq(cards.length, 2);
    const open = cards.find((c) => c.open);
    const closed = cards.find((c) => !c.open);
    eq(open.realized, 0);
    approx(open.invested, 200, 1e-6);
    approx(open.unrealized, open.held * 0.00001 - 200, 1e-6);
    approx(open.total, open.unrealized, 1e-9, 'итог открытой = только её нереализованный');
    approx(closed.realized, 151.808508 - 200, 1e-4);
    approx(closed.returned, 151.808508, 1e-4);
    eq(open.cycles, 2);
    // posts: the old buy shows its closed result, the new buy shows live PnL
    const cx = ctx({ priceNear: () => 0.00001, cycleStats: (tk, id) => pos.get(tk).cycles[id] });
    const oldBuy = describe(list[0], cx).lines.find((l) => l.label === 'PnL');
    has(oldBuy.value, '−24%');
    has(oldBuy.note, 'позиция закрыта');
    const newBuy = describe(list[2], cx).lines.find((l) => l.label === 'PnL');
    eq(newBuy.live, true, 'новая покупка — живой PnL');
  });
  test('сортировка позиций: по дате открытия и по сумме, в обе стороны', () => {
    const cards = [
      { token: 'a', firstTs: 100, invested: 50 },
      { token: 'b', firstTs: 300, invested: 10 },
      { token: 'c', firstTs: 200, invested: 500 },
    ];
    eq(sortPositionCards(cards, 'date', 'desc').map((c) => c.token).join(''), 'bca', 'новые сверху');
    eq(sortPositionCards(cards, 'date', 'asc').map((c) => c.token).join(''), 'acb');
    eq(sortPositionCards(cards, 'size', 'desc').map((c) => c.token).join(''), 'cab', 'крупные сверху');
    eq(sortPositionCards(cards, 'size', 'asc').map((c) => c.token).join(''), 'bac');
    eq(cards.map((c) => c.token).join(''), 'abc', 'исходный массив не меняется');
  });
  test('stats', () => {
    const list = ['BUY_NEARLEE_MULTIHOP', 'SELL_NEARLEE_MULTIHOP', 'FUNDING', 'PAYOUT_NEAR', 'FAILED_BUY_SYNTHETIC'].map((k) => A(k));
    const s = accountStats(list, list[0].timestampMs + 1000);
    eq(s.trades, 2);
    eq(s.buys, 1);
    eq(s.sells, 1);
    approx(s.fundedNear, 385.06692078, 1e-9);
    eq(s.payouts, 1);
    eq(s.failed, 1);
  });

  // ---------- rules ----------
  test('normalizeAccount', () => {
    eq(normalizeAccount(' HotFrog2879.near '), 'hotfrog2879.near');
    eq(normalizeAccount('@alice.near'), 'alice.near');
    eq(normalizeAccount('bad..near'), null);
    eq(normalizeAccount('a'), null);
    eq(normalizeAccount('x.near/<script>'), null);
    eq(normalizeAccount('a9c8669de0ba79fbd634549bcfc9a250c94b49d8f0e021f491cb23b247eac61d'), 'a9c8669de0ba79fbd634549bcfc9a250c94b49d8f0e021f491cb23b247eac61d');
  });
  test('shouldAlert / soundKind', () => {
    const buy = A('BUY_SINGULARTY');
    const payout = A('PAYOUT_NEAR');
    const fund = A('FUNDING');
    const base = { alertLevel: 'normal', alertMinNear: 0 };
    eq(shouldAlert(buy, base), true);
    eq(shouldAlert(payout, base), false, 'выплаты не звенят в режиме normal');
    eq(shouldAlert(payout, { ...base, alertLevel: 'all' }), true);
    eq(shouldAlert(fund, { ...base, alertLevel: 'trades' }), false);
    eq(shouldAlert(buy, { ...base, alertMinNear: 1000 }), false, 'порог 1000 NEAR');
    eq(shouldAlert(buy, { ...base, alertMinNear: 100 }), true);
    approx(nearSize(buy), 500, 1e-9);
    eq(soundKind(buy), 'buy');
    eq(soundKind(A('SELL_BATMAN')), 'sell');
    eq(soundKind(A('FAILED_BUY_SYNTHETIC')), 'warn');
  });

  // ---------- security ----------
  test('safeIcon пропускает только картинки', () => {
    eq(safeIcon('javascript:alert(1)'), null);
    eq(safeIcon('data:text/html,<script>alert(1)</script>'), null);
    eq(safeIcon('http://insecure.example/x.png'), null);
    eq(safeIcon('https://nearly.trade/api/img/x.webp'), 'https://nearly.trade/api/img/x.webp');
    eq(safeIcon('https://x.y/a"onerror="alert(1)'), null);
    ok(safeIcon('data:image/png;base64,iVBORw0KGgo='));
    eq(safeIcon(null), null);
  });
  test('вредоносный символ токена остаётся обычным текстом', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const d = describe(A('BUY_SINGULARTY'), ctx({ meta: (id) => (id === NEAR_ID ? { symbol: 'NEAR', decimals: 24 } : { symbol: evil, decimals: 18 }) }));
    has(d.title, evil);
    const node = document.createElement('div');
    node.textContent = d.title; // the app renders via textContent only
    eq(node.querySelector('img'), null);
  });

  // ---------- English (default UI language) ----------
  setLang('en');
  test('i18n: в русском словаре есть все ключи английского', () => {
    const ru = new Set(dictKeys('ru'));
    const missing = dictKeys('en').filter((k) => !ru.has(k));
    eq(missing.join(', '), '', 'нет перевода для');
  });
  test('en: числа и время', () => {
    eq(fmtNum(7699268.85), '7.7M');
    eq(fmtNum(151.808508), '151.81');
    eq(fmtNum(0.0302225), '0.03022');
    eq(fmtNum(38506.6), '38,507');
    eq(fmtPct(2.56), '+2.6%');
    eq(relTime(0, 120000), '2 min ago');
    eq(relTime(1000, 1000), 'just now');
    eq(tp('txWord', 1), 'transaction');
    eq(tp('txWord', 72), 'transactions');
  });
  test('en: тексты постов', () => {
    const buy = describe(A('BUY_SINGULARTY'), ctx());
    eq(buy.title, 'Bought SINGULARTY for 500 NEAR');
    has(buy.subtitle, 'via Rhea DCL');
    has(buy.subtitle, 'Nearly launchpad token');
    has(buy.lines.find((l) => l.label === 'Token tax').value, '(1%)');
    eq(buy.lines.find((l) => l.label === 'Route').note, '1 pool, fee 1%');
    eq(buy.tags[0], 'buy');
    const sell = describe(A('SELL_NEARLEE_MULTIHOP'), ctx());
    eq(sell.title, 'Sold NEARLEE for 151.81 NEAR');
    eq(sell.lines.find((l) => l.label === 'Route').note, '2 pools, fee 1%');
    eq(describe(A('PAYOUT_NEAR'), ctx()).title, 'SINGULARTY holder payout: +0.03022 NEAR');
    const failed = describe(A('FAILED_BUY_SYNTHETIC'), ctx());
    eq(failed.title, 'Failed to buy SINGULARTY for 500 NEAR');
    has(failed.lines.find((l) => l.label === 'Error').value, 'slippage');
    eq(describe(A('STORAGE_SINGULARTY'), ctx()).title, 'Registered with the SINGULARTY token');
    eq(describe(A('FUNDING'), ctx()).title, 'Received 385.07 NEAR from a9c866…c61d');
    eq(describe(A('ACCOUNT_CREATED'), ctx()).title, 'Account created');
    for (const key of Object.keys(fx).filter((k) => !k.startsWith('RPC_'))) {
      const signer = key.startsWith('V2_') || key === 'STOP_POINT_NOFILL' ? fx[key].transaction.signer_id : ACC;
      const d = describe(analyzeTx(fx[key], signer), ctx());
      ok(!/[А-Яа-яЁё]/.test(JSON.stringify(d)), key + ': в английском посте остался русский текст');
    }
  });
  test('en/ru: переключение языка меняет тексты', () => {
    setLang('ru');
    eq(t('tab.trades'), 'Сделки');
    setLang('en');
    eq(t('tab.trades'), 'Trades');
  });

  // ---------- Check fomo: session, follows, NEAR Social, follow feed ----------
  test('подписки: follow / unfollow / импорт, без дублей и без подписки на себя', () => {
    const owner = 'cf-test-owner.near';
    const key = 'cf.follows.v1.' + owner;
    localStorage.removeItem(key);
    try {
      eq(session.follow(owner, 'alice.near'), true);
      eq(session.follow(owner, 'alice.near'), false, 'дубль');
      eq(session.follow(owner, owner), false, 'на себя');
      eq(session.isFollowing(owner, 'alice.near'), true);
      eq(session.followMany(owner, ['alice.near', 'bob.near', owner, 'carol.near']), 2);
      eq(session.getFollows(owner).map((x) => x.account).join(','), 'bob.near,carol.near,alice.near');
      eq(session.followMany(owner, Array.from({ length: 80 }, (_, i) => `bulk${i}.near`)), 50, 'импорт не больше 50 за раз');
      for (let i = 0; i < 80; i++) session.unfollow(owner, `bulk${i}.near`);
      eq(session.unfollow(owner, 'bob.near'), true);
      eq(session.unfollow(owner, 'bob.near'), false);
      eq(session.getFollows(owner).length, 2);
      eq(session.getFollows(null).length, 0);
    } finally {
      localStorage.removeItem(key);
    }
  });
  test('сессия: сохранение и сброс (настоящая сессия восстанавливается)', () => {
    const saved = localStorage.getItem('cf.session.v1');
    try {
      session.setSession({ accountId: 'cf-test.near', wallet: 'HOT Wallet' });
      eq(session.getSession().accountId, 'cf-test.near');
      eq(session.getSession().wallet, 'HOT Wallet');
      eq(session.getSession().watchOnly, false);
      session.clearSession();
      eq(session.getSession(), null);
      localStorage.setItem('cf.session.v1', JSON.stringify({ accountId: '' }));
      eq(session.getSession(), null, 'пустой аккаунт — нет сессии');
    } finally {
      if (saved === null) localStorage.removeItem('cf.session.v1');
      else localStorage.setItem('cf.session.v1', saved);
    }
  });
  test('NEAR Social: разбор подписок и аватара', () => {
    const json = { 'root.near': { graph: { follow: { 'mob.near': '', 'bad name!': '', 'x.near': '' } } } };
    eq(session.parseSocialFollows(json, 'root.near').join(','), 'mob.near,x.near');
    eq(session.parseSocialFollows({}, 'root.near').length, 0);
    eq(session.socialImageUrl({ url: 'https://example.com/a.png' }), 'https://example.com/a.png');
    eq(session.socialImageUrl({ url: 'javascript:alert(1)' }), null);
    eq(session.socialImageUrl({ ipfs_cid: 'bafkrei123' }), 'https://ipfs.near.social/ipfs/bafkrei123');
    eq(session.socialImageUrl({ ipfs_cid: 'x/../y' }), null);
    eq(session.socialImageUrl(null), null);
  });
  test('лента подписок: только сделки и переводы', () => {
    eq(isFeedEvent(A('BUY_SINGULARTY')), true);
    eq(isFeedEvent(A('SELL_BATMAN')), true);
    eq(isFeedEvent(A('FUNDING')), true);
    eq(isFeedEvent(A('PAYOUT_NEAR')), false);
    eq(isFeedEvent(A('STORAGE_SINGULARTY')), false);
    eq(isFeedEvent(A('CLAIM_FEES')), false);
    eq(isFeedEvent(null), false);
  });
  test('лента подписок: загрузка, живая сделка с оповещением, отписка', async () => {
    const byHash = Object.fromEntries(Object.values(fx).filter((x) => x.transaction).map((x) => [x.transaction.hash, x]));
    const row = (key) => ({ transaction_hash: fx[key].transaction.hash, tx_block_height: fx[key].execution_outcome.block_height });
    let rows = [row('BUY_SINGULARTY'), row('PAYOUT_NEAR'), row('STORAGE_SINGULARTY')];
    let amount = '100';
    const fresh = new Set();
    const alerted = [];
    let updates = 0;
    const feed = new FollowFeed({
      listTxs: async () => ({ account_txs: rows }),
      fetchRaw: async (acc, rs) => rs.map((r) => byHash[r.transaction_hash]),
      viewAccount: async () => ({ amount, locked: '0', storage_usage: 1 }),
      analyze: (raw, acc) => {
        const a = analyzeTx(raw, acc);
        if (fresh.has(a.hash)) a.timestampMs = Date.now() - 5000; // pretend it just happened
        return a;
      },
      enrich: async () => {},
      onUpdate: () => { updates += 1; },
      onNewEvent: (ev) => alerted.push(ev),
    });
    feed.setFollows('me.near', [{ account: ACC, since: 0 }]);
    eq(feed.loading, true);
    await feed.tick();
    eq(feed.loading, false);
    eq(feed.list().length, 1, 'после загрузки в ленте только сделка');
    eq(feed.list()[0].a.kind, 'trade');
    eq(alerted.length, 0, 'история не вызывает оповещений');
    await feed.tick(Date.now() + 3000); // first balance check: remembers the balance
    rows = [row('SELL_BATMAN'), ...rows];
    fresh.add(fx.SELL_BATMAN.transaction.hash);
    amount = '250'; // balance changed -> refresh
    await feed.tick(Date.now() + 6000);
    eq(feed.list().length, 2);
    eq(feed.list()[0].a.trade.side, 'sell', 'новая сделка сверху');
    eq(alerted.length, 1, 'оповещение о живой сделке');
    eq(alerted[0].account, ACC);
    ok(updates > 0);
    feed.setFollows('me.near', []);
    eq(feed.list().length, 0, 'отписка убирает сделки');
    eq(feed.size, 0);
  });

  // ---------- leaderboard: top meme traders ----------
  const DAY = 86400000;
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
  const ns = (ms) => (BigInt(ms) * 1000000n).toString();
  const e24 = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString(); // NEAR -> yocto
  const e18 = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(); // 18-decimal token
  const PRICES = {
    'wrap.near': { price: '5', symbol: 'wNEAR', decimal: 24 },
    'token.rhealab.near': { price: '0.5', symbol: 'RHEA', decimal: 18 },
    'hoot-8ecf65.launchpad.justhoot.near': { price: '0.002', symbol: 'HOOT', decimal: 18 },
    'token.0xshitzu.near': { price: '0.01', symbol: 'SHITZU', decimal: 18 },
    'batman-4.nearlytrade.near': { price: '0.001', symbol: 'BATMAN', decimal: 18 },
  };
  const book = lb.priceBook(PRICES);
  // swap: trader buys (+qty) or sells (-qty) `token` for `near` wNEAR (or another quote)
  const swap = (trader, token, qty, near, ms, { quote = 'wrap.near', id } = {}) => ({
    trader, receipt_id: id || `${trader}-${token}-${ms}-${qty}`, block_height: Math.floor(ms / 1000),
    block_timestamp_nanosec: ns(ms),
    balance_changes: { [token]: qty < 0 ? '-' + e18(-qty) : e18(qty), [quote]: near > 0 ? '-' + (quote === 'wrap.near' ? e24(near) : e18(near)) : (quote === 'wrap.near' ? e24(-near) : e18(-near)) },
  });

  test('рейтинг: какие токены считаются мемами и откуда они', () => {
    eq(lb.memePlatform('batman-4.nearlytrade.near'), 'Nearly');
    eq(lb.memePlatform('hoot-8ecf65.launchpad.justhoot.near'), 'Hoot');
    eq(lb.memePlatform('ribbit-426.meme-cooking.near'), 'Meme Cooking');
    eq(lb.memePlatform('shore-4lzt.launch.shoremarkets.near'), 'Shore');
    eq(lb.memePlatform('blackdragon.tkn.near'), 'tkn.near');
    eq(lb.memePlatform('kat.token0.near'), 'Token0');
    eq(lb.memePlatform('token.0xshitzu.near'), 'Rhea');
    eq(lb.memePlatform('wrap.near'), null);
    eq(lb.memePlatform('usdt.tether-token.near'), null);
    eq(lb.memePlatform('zec.omft.near'), null);
    eq(lb.memePlatform('token.rhealab.near'), null);
    eq(lb.memePlatform('intel.tkn.near'), null, 'утилитарный токен Intear не мем');
    eq(lb.isNearlyToken('nearly-993927.nearlytrade.near'), true);
  });
  test('рейтинг: протокольные аккаунты не трейдеры', () => {
    eq(lb.isTraderAccount('alice.near'), true);
    eq(lb.isTraderAccount('lock.near'), true, 'обычный аккаунт lock.near остаётся');
    eq(lb.isTraderAccount('a9c8669de0ba79fbd634549bcfc9a250c94b49d8f0e021f491cb23b247eac61d'), true);
    eq(lb.isTraderAccount('frigid_polar1.user.intear.near'), true);
    eq(lb.isTraderAccount('intents.near'), false);
    eq(lb.isTraderAccount('lock.nearpadfamily.near'), false);
    eq(lb.isTraderAccount('router.aurabot.near'), false);
    eq(lb.isTraderAccount('v2.ref-finance.near'), false);
    eq(lb.isTraderAccount('batman-4.nearlytrade.near'), false, 'контракт токена');
    eq(lb.isTraderAccount('meme-cooking.near'), false, 'контракт лаунчпада');
    eq(lb.isTraderAccount(''), false);
  });
  test('рейтинг: разбор свопа (покупка, продажа, котировка не в NEAR, мусор)', () => {
    const buy = lb.parseSwap(swap('alice.near', 'hoot-8ecf65.launchpad.justhoot.near', 1000, 10, NOW), book);
    eq(buy.side, 'buy');
    approx(buy.qty, 1000, 1e-9);
    approx(buy.near, 10, 1e-9);
    eq(buy.ts, NOW);
    const sell = lb.parseSwap(swap('alice.near', 'hoot-8ecf65.launchpad.justhoot.near', -500, -7, NOW), book);
    eq(sell.side, 'sell');
    approx(sell.near, 7, 1e-9);
    const viaRhea = lb.parseSwap(swap('alice.near', 'token.0xshitzu.near', 100, 20, NOW, { quote: 'token.rhealab.near' }), book);
    approx(viaRhea.near, 2, 1e-9, '20 RHEA × $0.5 / $5 = 2 NEAR');
    const memeForMeme = { trader: 'a.near', block_timestamp_nanosec: ns(NOW), balance_changes: { 'token.0xshitzu.near': '-1000', 'hoot-8ecf65.launchpad.justhoot.near': '5000' } };
    eq(lb.parseSwap(memeForMeme, book), null, 'мем за мем не считаем');
    const noMeme = { trader: 'a.near', block_timestamp_nanosec: ns(NOW), balance_changes: { 'wrap.near': '-1', 'token.rhealab.near': '5' } };
    eq(lb.parseSwap(noMeme, book), null);
    const unknownDec = { trader: 'a.near', block_timestamp_nanosec: ns(NOW), balance_changes: { 'x-1.meme-cooking.near': '5', 'wrap.near': '-' + e24(1) } };
    eq(lb.parseSwap(unknownDec, book), null, 'без decimals не считаем');
    const sameSign = { trader: 'a.near', block_timestamp_nanosec: ns(NOW), balance_changes: { 'token.0xshitzu.near': e18(5), 'wrap.near': e24(1) } };
    eq(lb.parseSwap(sameSign, book), null, 'получил и мем, и NEAR — это не сделка');
    eq(lb.parseSwap(null, book), null);
  });
  test('рейтинг: позиции-циклы, неизвестная себестоимость, окно по дате открытия', () => {
    const tok = 'hoot-8ecf65.launchpad.justhoot.near';
    const trades = [
      swap('a.near', tok, 1000, 10, NOW - 10 * DAY), // old position: bought 10 NEAR
      swap('a.near', tok, -1000, -30, NOW - 9 * DAY), // closed with +20 NEAR
      swap('a.near', tok, 2000, 20, NOW - 2 * DAY), // new position (entry #2)
      swap('a.near', tok, -1000, -15, NOW - DAY / 2), // half sold: +5 NEAR realized
      swap('a.near', 'token.0xshitzu.near', -50, -3, NOW - DAY / 4), // sell with unknown cost: ignored
    ].map((x) => lb.parseSwap(x, book));
    const cycles = lb.buildCycles(trades);
    eq(cycles.length, 2, 'повторная покупка — новая позиция, продажа без покупки не создаёт позицию');
    eq(cycles[0].closed, true);
    approx(cycles[0].realized, 20, 1e-9);
    eq(cycles[1].closed, false);
    approx(cycles[1].realized, 5, 1e-9);
    approx(cycles[1].qty, 1000, 1e-9);
    approx(cycles[1].cost, 10, 1e-9);
    // 7 days: only the second position (opened 2 days ago); 1000 HOOT left at 0.002$/5$ = 0.4 NEAR
    const w7 = lb.cyclesWindow(cycles, NOW - 7 * DAY, book);
    approx(w7.realized, 5 * 5, 1e-6, 'реализовано $25');
    approx(w7.unrealized, (1000 * 0.0004 - 10) * 5, 1e-6, 'нереализовано −$48');
    approx(w7.pnl, w7.realized + w7.unrealized, 1e-9);
    approx(w7.basis, 20 * 5, 1e-6, 'вложено $100');
    eq(w7.trades, 2);
    eq(w7.open, 1);
    eq([...w7.platforms].join(), 'Hoot');
    eq(w7.best.symbol, 'HOOT');
    // 30 days: both positions; 24h: nothing was opened
    approx(lb.cyclesWindow(cycles, NOW - 30 * DAY, book).realized, 25 * 5, 1e-6);
    eq(lb.cyclesWindow(cycles, NOW - DAY, book).trades, 0, 'позиция открыта 2 дня назад — не попадает в 24ч');
  });
  test('рейтинг: статистика Nearly по кошельку — то же правило периода', () => {
    const detail = { tokens: [
      { token: 'a.nearlytrade.near', symbol: 'A', first_ts: NOW - 2 * DAY, pnl_usd: 300, realized_usd: 100, unrealized_usd: 200, basis_usd: 150, buys: 2, sells: 1, open: true },
      { token: 'b.nearlytrade.near', symbol: 'B', first_ts: NOW - 20 * DAY, pnl_usd: -500, realized_usd: -500, unrealized_usd: 0, basis_usd: 600, buys: 1, sells: 1, open: false },
    ] };
    const w7 = lb.nearlyDetailWindow(detail, NOW - 7 * DAY);
    eq(w7.pnl, 300);
    eq(w7.trades, 3);
    eq(w7.best.symbol, 'A');
    eq(lb.nearlyDetailWindow(detail, NOW - 30 * DAY).pnl, -200, 'убыток на Nearly тоже учитывается');
    eq(lb.nearlyDetailWindow({ tokens: [] }, 0).trades, 0);
    eq(lb.nearlyDetailWindow(null, 0).pnl, 0);
  });
  test('рейтинг: слияние Nearly + других площадок, только прибыльные, сортировка по ROI', () => {
    const part = (pnl, basis, platform, trades = 3) => ({ pnl, realized: pnl, unrealized: 0, basis, trades, tokens: 1, open: 0, best: { symbol: platform.slice(0, 3).toUpperCase(), pnl }, platforms: new Set([platform]) });
    const listRows = [
      { account: 'whale.near', pnl_usd: 5000, realized_usd: 4000, unrealized_usd: 1000, basis_usd: 10000, trades: 20, tokens: 3, open: 1, best: { symbol: 'NEARLY', pnl_usd: 4000 } },
      { account: 'small.near', pnl_usd: 900, realized_usd: 900, unrealized_usd: 0, basis_usd: 100, trades: 4, tokens: 1, open: 0, best: null },
    ];
    const others = new Map([
      ['whale.near', part(-1000, 2000, 'Hoot')],
      ['hooter.near', part(3000, 1000, 'Hoot')],
      ['loser.near', part(-50, 100, 'Shore')],
      ['intents.near', part(99999, 1, 'Hoot')],
    ]);
    const details = new Map([['hooter.near', { tokens: [{ token: 'x.nearlytrade.near', symbol: 'X', first_ts: NOW - DAY, pnl_usd: -2500, basis_usd: 3000, buys: 1, sells: 1 }] }]]);
    const rows = lb.mergeWindow({ listRows, others, details }, NOW - 7 * DAY);
    const by = Object.fromEntries(rows.map((r) => [r.account, r]));
    eq(by['whale.near'].pnl, 4000, 'Nearly 5000 + Hoot −1000');
    eq(by['whale.near'].platforms.join(), 'Nearly,Hoot');
    eq(by['whale.near'].trades, 23);
    approx(by['whale.near'].roi, 4000 / 12000, 1e-12);
    eq(by['hooter.near'].pnl, 500, 'Hoot 3000 + убыток на Nearly −2500');
    eq(by['intents.near'], undefined, 'протокольный аккаунт исключён');
    const top = lb.rankRows(rows, 'pnl');
    eq(top.map((r) => r.account).join(), 'whale.near,small.near,hooter.near');
    eq(top.some((r) => r.account === 'loser.near'), false, 'в топе только прибыльные');
    const roi = lb.rankRows(rows, 'roi');
    eq(roi[0].account, 'small.near', 'ROI 900%');
    eq(lb.rankRows(rows, 'pnl', 1).length, 1);
  });
  test('рейтинг: активные мемы из пулов Rhea (без Nearly и не-мемов)', () => {
    const pools = [
      { token_account_ids: ['wrap.near', 'zec.omft.near'], volume_24h: '1000000' },
      { token_account_ids: ['batman-4.nearlytrade.near', 'wrap.near'], volume_24h: '300000' },
      { token_account_ids: ['hoot-8ecf65.launchpad.justhoot.near', 'wrap.near'], volume_24h: '100000' },
      { token_account_ids: ['token.0xshitzu.near', 'wrap.near'], volume_24h: '15000' },
      { token_account_ids: ['token.0xshitzu.near', 'kat.token0.near'], volume_24h: '3000' },
      { token_account_ids: ['tiny-1.meme-cooking.near', 'wrap.near'], volume_24h: '20' },
    ];
    eq(lb.activeMemeTokens(pools).join(), 'hoot-8ecf65.launchpad.justhoot.near,token.0xshitzu.near,kat.token0.near');
    eq(lb.activeMemeTokens(pools, 1).join(), 'hoot-8ecf65.launchpad.justhoot.near');
    eq(lb.activeMemeTokens(null).length, 0);
  });
  test('рейтинг: движок — загрузка, прогресс, кэш, обновление', async () => {
    const store = new Map();
    const calls = { nearly: 0, token: 0, trader: 0, detail: 0 };
    const tok = 'hoot-8ecf65.launchpad.justhoot.near';
    const deps = {
      now: () => NOW,
      storageGet: (k, fb) => (store.has(k) ? JSON.parse(store.get(k)) : fb),
      storageSet: (k, v) => store.set(k, JSON.stringify(v)),
      nearlyTraders: async (w) => {
        calls.nearly += 1;
        return { traders: 500, rows: [{ account: 'nearlyking.near', pnl_usd: w === '24h' ? 100 : 2000, realized_usd: 0, unrealized_usd: 0, basis_usd: 1000, trades: 5, tokens: 1, open: 1, best: { symbol: 'NEARLY', pnl_usd: 100 } }] };
      },
      refTopPools: async () => [{ token_account_ids: [tok, 'wrap.near'], volume_24h: '50000' }],
      intearTokenList: async () => PRICES,
      swapsByToken: async () => {
        calls.token += 1;
        return [swap('hooter.near', tok, 10000, 10, NOW - 3 * DAY), swap('intents.near', tok, 5, 1, NOW - DAY)];
      },
      swapsByTrader: async (acc) => {
        calls.trader += 1;
        // the Nearly buy must not be counted here: Nearly tokens come from Nearly's own stats
        return acc === 'hooter.near' ? [swap('hooter.near', tok, -5000, -40, NOW - 2 * DAY), swap('hooter.near', 'batman-4.nearlytrade.near', 1000, 50, NOW - DAY)] : [];
      },
      nearlyTrader: async () => {
        calls.detail += 1;
        return { tokens: [] };
      },
    };
    const progress = [];
    const engine = new lb.Leaderboard(deps, { onUpdate: () => progress.push(engine.progress) });
    eq(engine.isStale(), true);
    await engine.load();
    eq(engine.status, 'ready');
    eq(engine.progress, 1);
    ok(progress.some((p) => p > 0 && p < 1), 'есть промежуточный прогресс');
    eq(calls.nearly, 3, 'три периода Nearly');
    eq(calls.token, 1);
    eq(calls.trader, 1, 'протокольный аккаунт не запрашиваем');
    eq(calls.detail, 1, 'статистика Nearly для трейдера с другой площадки');
    // hooter: bought 10000 HOOT for 10 NEAR 3 days ago, sold half for 40 NEAR: +35 NEAR realized,
    // 5000 HOOT left = 2 NEAR at 0.0004 NEAR, cost 5 -> −3 NEAR; total 32 NEAR = $160
    const week = engine.rows('7d');
    eq(week.map((r) => r.account).join(), 'nearlyking.near,hooter.near');
    approx(week[1].pnl, 160, 1e-6);
    eq(week[1].platforms.join(), 'Hoot', 'сделка с токеном Nearly не посчитана дважды');
    eq(week[1].trades, 2);
    eq(engine.rows('24h').map((r) => r.account).join(), 'nearlyking.near', 'позиция открыта 3 дня назад — не 24ч');
    eq(engine.total('7d'), 501, '500 трейдеров Nearly + 1 с другой площадки');
    eq(engine.data.partial, false);
    // cached: a new engine shows it at once and does not refetch while fresh
    const again = new lb.Leaderboard(deps);
    eq(again.status, 'ready');
    eq(again.rows('7d').length, 2);
    eq(again.isStale(), false);
    await again.load();
    eq(calls.nearly, 3, 'свежий кэш — без запросов');
    await again.refresh();
    eq(calls.nearly, 6, 'кнопка «Обновить» запрашивает заново');
    const p1 = again.refresh();
    eq(again.refresh(), p1, 'повторное нажатие во время загрузки не запускает вторую');
    await p1;
  });
  test('рейтинг: источники падают — частичные данные или понятная ошибка', async () => {
    const base = {
      now: () => NOW,
      nearlyTraders: async () => ({ traders: 1, rows: [{ account: 'n.near', pnl_usd: 10, basis_usd: 5, trades: 1 }] }),
      nearlyTrader: async () => ({ tokens: [] }),
      refTopPools: async () => [],
      intearTokenList: async () => { throw new Error('down'); },
      swapsByToken: async () => [],
      swapsByTrader: async () => [],
    };
    const a = new lb.Leaderboard(base);
    await a.refresh();
    eq(a.status, 'ready');
    eq(a.data.partial, true, 'без цен Intear — только Nearly, помечено как неполное');
    eq(a.rows('7d').length, 1);
    const b = new lb.Leaderboard({ ...base, nearlyTraders: async () => { throw new Error('down'); } });
    await b.refresh();
    eq(b.status, 'error');
    ok(b.error);
    eq(b.rows('7d').length, 0);
  });

  // ---------- usage log (who connects / searches) ----------
  test('журнал: куда отправлять (Vercel — к себе, Pages — на Vercel, локально — никуда)', () => {
    eq(trackEndpoint({ protocol: 'https:', hostname: 'check-fomo-near.vercel.app' }), '/api/track');
    eq(trackEndpoint({ protocol: 'https:', hostname: 'devivan1.github.io' }), 'https://check-fomo-near.vercel.app/api/track');
    eq(trackEndpoint({ protocol: 'http:', hostname: 'localhost' }), null);
  });
  test('журнал: проверка адреса, повтор не чаще раза в 6 часов, очистка имени кошелька', () => {
    const sent = [];
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const opts = (now) => ({ send: (url, body) => sent.push({ url, body: JSON.parse(body) }), loc: { protocol: 'https:', hostname: 'x.vercel.app' }, now, storage });
    eq(track('connect', ' Alice.NEAR ', 'HOT <b>Wallet</b>', opts(1000)), 1);
    eq(sent[0].url, '/api/track');
    eq(sent[0].body.account, 'alice.near');
    eq(sent[0].body.kind, 'connect');
    eq(sent[0].body.wallet, 'HOT bWalletb', 'без разметки');
    eq(track('connect', 'alice.near', null, opts(2000)), false, 'повтор в течение 6 часов не отправляется');
    ok(track('search', 'alice.near', null, opts(2000)), 'другой вид события — отправляется');
    ok(track('connect', 'alice.near', null, opts(1000 + 6 * 3600 * 1000 + 1)), 'через 6 часов снова');
    eq(track('connect', '<script>', null, opts(5000)), false, 'неверный адрес не отправляется');
    eq(track('hack', 'bob.near', null, opts(5000)), false, 'неизвестный вид события');
    eq(track('search', 'bob.near', null, { ...opts(5000), loc: { protocol: 'http:', hostname: 'localhost' } }), false, 'локально не пишем');
    eq(sent.length, 3);
    // searches carry the signed-in wallet that searched
    ok(track('search', 'whale.near', null, { ...opts(9000), by: 'Me.near' }));
    eq(sent[3].body.by, 'me.near');
    eq(track('search', 'whale.near', null, { ...opts(9500), by: 'me.near' }), false, 'тот же поиск того же пользователя — не чаще раза в 6 часов');
    ok(track('search', 'whale.near', null, { ...opts(9500), by: 'other.near' }), 'тот же адрес ищет другой пользователь');
    ok(track('search', 'shark.near', null, opts(9500)), 'без входа');
    eq(sent[5].body.by, undefined, 'без входа поле by не отправляется');
    ok(track('connect', 'zed.near', null, { ...opts(9500), by: 'x.near' }));
    eq(sent[6].body.by, undefined, 'by только у поисков');
  });
  test('рейтинг: аккаунты из внешних API проверяются на формат NEAR', () => {
    eq(lb.isTraderAccount('Alice.near'), false, 'заглавные — не канонический адрес');
    eq(lb.isTraderAccount('a.near/<img src=x onerror=alert(1)>'), false);
    eq(lb.isTraderAccount('javascript:alert(1)'), false);
    const rows = lb.mergeWindow({ listRows: [{ account: '<b>x</b>', pnl_usd: 1e6, trades: 1, basis_usd: 1 }, { account: 'ok.near', pnl_usd: 5, trades: 1, basis_usd: 1 }] }, 0);
    eq(rows.map((r) => r.account).join(), 'ok.near');
  });

  await Promise.all(pendingTests);
  render();
}

function render() {
  const pass = results.filter((r) => r.ok).length;
  const summary = document.getElementById('summary');
  summary.textContent = `${pass === results.length ? 'PASS' : 'FAIL'} ${pass}/${results.length}`;
  summary.dataset.status = pass === results.length ? 'pass' : 'fail';
  const list = document.getElementById('results');
  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.ok ? 'ok' : 'fail';
    li.textContent = `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' — ' + r.err}`;
    list.append(li);
  }
}

main().catch((e) => {
  results.push({ name: 'suite crashed', ok: false, err: e.stack || e.message });
  render();
});
