// Browser test suite. Open tests/index.html through any static server.

import { analyzeTx, parseLog, statusKind, failureMessage, fromRpcTxStatus } from '../js/parser.js?v=ea9cb0bb';
import { describe, humanError } from '../js/describe.js?v=ea9cb0bb';
import { computePositions, positionRows, accountStats, periodSummary, positionCards, positionsOverview } from '../js/positions.js?v=ea9cb0bb';
import { normalizeAccount, shouldAlert, nearSize, soundKind } from '../js/rules.js?v=ea9cb0bb';
import { toDecimalString, toNumber, fmtNum, big, shortHash, shortAccount, fmtPct, relTime } from '../js/util.js?v=ea9cb0bb';
import { safeIcon, dclPrice, routePrice } from '../js/tokens.js?v=ea9cb0bb';
import { NEAR_ID } from '../js/config.js?v=ea9cb0bb';
import * as session from '../js/session.js?v=ea9cb0bb';
import { FollowFeed, isFeedEvent } from '../js/following.js?v=ea9cb0bb';
import { setLang, t, tp, dictKeys } from '../js/i18n.js?v=ea9cb0bb';

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
    const buy = describe(list[0], ctx({ positionOpen: () => false, positionStats: (tk) => pos.get(tk) }));
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
