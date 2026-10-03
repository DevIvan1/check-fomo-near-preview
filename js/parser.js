// Turns a raw FastNEAR transaction (tx + receipts + outcomes) into a structured
// description of what happened to one account. Pure: no network, no DOM.

import { NEAR_ID, WNEAR, isDex, isStakingPool, tokenFamily } from './config.js?v=90330b4f';
import { b64ToText, tryJson, big } from './util.js?v=90330b4f';

export function statusKind(status) {
  if (!status) return 'unknown';
  if (typeof status === 'string') return status === 'Unknown' ? 'unknown' : status.toLowerCase();
  if ('Failure' in status) return 'failure';
  if ('SuccessValue' in status || 'SuccessReceiptId' in status) return 'success';
  return 'unknown';
}

export function failureMessage(status) {
  const f = status && typeof status === 'object' ? status.Failure : null;
  if (!f) return null;
  const kind = f.ActionError?.kind;
  if (kind) {
    if (typeof kind === 'string') return kind;
    const fce = kind.FunctionCallError;
    if (fce) {
      if (typeof fce === 'string') return fce;
      if (fce.ExecutionError) return String(fce.ExecutionError);
      return JSON.stringify(fce);
    }
    const [k, v] = Object.entries(kind)[0] || [];
    return k ? `${k}${v ? ': ' + JSON.stringify(v) : ''}` : JSON.stringify(kind);
  }
  if (f.InvalidTxError) return 'InvalidTxError: ' + JSON.stringify(f.InvalidTxError);
  return JSON.stringify(f);
}

function decodeArgs(v) {
  if (v && typeof v === 'object') return { args: v, text: null };
  const text = b64ToText(v);
  const args = tryJson(text);
  return { args: args && typeof args === 'object' ? args : null, text: args ? null : text };
}

export function normalizeAction(a) {
  if (typeof a === 'string') return { kind: a, deposit: 0n };
  const kind = Object.keys(a || {})[0] || 'Unknown';
  const v = (a && a[kind]) || {};
  switch (kind) {
    case 'FunctionCall': {
      const { args, text } = decodeArgs(v.args);
      if (args && typeof args.msg === 'string') {
        const m = tryJson(args.msg);
        if (m && typeof m === 'object') args.msgParsed = m;
      }
      return { kind, method: v.method_name, args, argsText: text, deposit: big(v.deposit), gas: big(v.gas) };
    }
    case 'Transfer':
      return { kind, deposit: big(v.deposit) };
    case 'Stake':
      return { kind, stake: big(v.stake), publicKey: v.public_key, deposit: 0n };
    case 'AddKey':
      return { kind, publicKey: v.public_key, permission: v.access_key?.permission, deposit: 0n };
    case 'DeleteKey':
      return { kind, publicKey: v.public_key, deposit: 0n };
    case 'DeleteAccount':
      return { kind, beneficiary: v.beneficiary_id, deposit: 0n };
    case 'Delegate': {
      const d = v.delegate_action || {};
      return { kind, sender: d.sender_id, receiver: d.receiver_id, actions: (d.actions || []).map(normalizeAction), deposit: 0n };
    }
    default:
      return { kind, deposit: big(v.deposit) };
  }
}

export function parseLog(log) {
  if (typeof log !== 'string') return { type: 'text', text: String(log) };
  if (log.startsWith('EVENT_JSON:')) {
    const j = tryJson(log.slice(11).trim());
    if (j && typeof j === 'object') {
      const data = Array.isArray(j.data) ? j.data : j.data != null ? [j.data] : [];
      return { type: 'event', standard: j.standard, event: j.event, version: j.version, data };
    }
    return { type: 'text', text: log };
  }
  let m;
  if ((m = /^Transfer (\d+) from (\S+) to (\S+?)\.?$/.exec(log))) return { type: 'ft_text', op: 'transfer', amount: m[1], from: m[2], to: m[3] };
  if ((m = /^Refund (\d+) from (\S+) to (\S+?)\.?$/.exec(log))) return { type: 'ft_text', op: 'transfer', amount: m[1], from: m[2], to: m[3] };
  if ((m = /^Deposit (\d+) NEAR to (\S+?)\.?$/.exec(log))) return { type: 'ft_text', op: 'mint', amount: m[1], to: m[2] };
  if ((m = /^Withdraw (\d+) NEAR from (\S+?)\.?$/.exec(log))) return { type: 'ft_text', op: 'burn', amount: m[1], from: m[2] };
  if ((m = /^Swapped (\d+) (\S+) for (\d+) (\S+?)(?:,|$)/.exec(log))) {
    return { type: 'ref_swap', amountIn: m[1], tokenIn: m[2], amountOut: m[3], tokenOut: m[4] };
  }
  return { type: 'text', text: log };
}

function normalizeReceipts(raw) {
  return (raw.receipts || [])
    .filter((r) => r && r.receipt)
    .map((r) => {
      const rc = r.receipt;
      const out = r.execution_outcome?.outcome || {};
      const act = rc.receipt?.Action;
      const actions = act ? (act.actions || []).map(normalizeAction) : [];
      return {
        id: rc.receipt_id || r.execution_outcome?.id,
        predecessor: rc.predecessor_id,
        receiver: rc.receiver_id,
        signer: act?.signer_id,
        actions,
        status: statusKind(out.status),
        failure: failureMessage(out.status),
        logs: (out.logs || []).map(parseLog),
        tokensBurnt: big(out.tokens_burnt),
        outIds: out.receipt_ids || [],
        blockHeight: r.execution_outcome?.block_height ?? rc.block_height,
      };
    });
}

const norm = (t) => (t === WNEAR ? NEAR_ID : t);
const intentsToken = (id) => (typeof id === 'string' && id.startsWith('nep141:') ? id.slice(7) : id);

function sumDeposits(actions) {
  let s = 0n;
  for (const a of actions) if (a.kind === 'Transfer' || a.kind === 'FunctionCall') s += a.deposit || 0n;
  return s;
}

function firstMethod(actions) {
  const fc = actions.find((a) => a.kind === 'FunctionCall');
  return fc ? fc.method : actions[0]?.kind;
}

export function analyzeTx(raw, account) {
  const tx = raw.transaction || {};
  const eo = raw.execution_outcome || {};
  const actions = (tx.actions || []).map(normalizeAction);

  // Meta-transactions: the relayer signs, the real actor is the delegate sender.
  let effSigner = tx.signer_id;
  let effReceiver = tx.receiver_id;
  let effActions = actions;
  let relayer = null;
  const del = actions.length === 1 && actions[0].kind === 'Delegate' ? actions[0] : null;
  if (del) {
    relayer = tx.signer_id;
    effSigner = del.sender;
    effReceiver = del.receiver;
    effActions = del.actions;
  }

  const receipts = normalizeReceipts(raw);
  const a = {
    hash: tx.hash || eo.id,
    blockHeight: eo.block_height ?? null,
    txIndex: eo.index ?? 0,
    timestampMs: eo.block_timestamp ? Math.floor(Number(eo.block_timestamp) / 1e6) : Date.now(),
    account,
    signer: tx.signer_id,
    receiver: tx.receiver_id,
    relayer,
    effSigner,
    effReceiver,
    effActions,
    isSigner: effSigner === account,
    methods: effActions.filter((x) => x.kind === 'FunctionCall').map((x) => x.method),
    calls: [],
    movements: [],
    deltas: {},
    nearDelta: 0n,
    nfts: [],
    swaps: [],
    allSwaps: [],
    events: [],
    taxes: [],
    failures: [],
    fee: big(eo.outcome?.tokens_burnt),
    storageNear: 0n,
    pending: false,
    tokens: new Set(),
  };

  // Completeness: every receipt referenced by an outcome must be present.
  const have = new Set(receipts.map((r) => r.id));
  const referenced = [...(eo.outcome?.receipt_ids || [])];
  for (const r of receipts) referenced.push(...r.outIds);
  a.pending = referenced.some((id) => !have.has(id)) || receipts.length === 0;

  const txStatus = statusKind(eo.outcome?.status);
  if (txStatus === 'failure') a.failures.push({ contract: tx.receiver_id, message: failureMessage(eo.outcome.status) });

  const storageContracts = new Set();
  const mv = (m) => a.movements.push(m);

  for (const r of receipts) {
    a.fee += r.tokensBurnt;
    if (r.predecessor !== 'system') {
      for (const act of r.actions) {
        a.calls.push({
          from: r.predecessor, to: r.receiver, kind: act.kind, method: act.method, args: act.args,
          deposit: act.deposit || 0n, status: r.status, failure: r.failure,
        });
      }
    }
    if (r.status === 'failure') {
      a.failures.push({ contract: r.receiver, message: r.failure });
      continue;
    }
    if (r.status !== 'success') continue;

    // Native NEAR carried by the receipt (gas refunds from "system" are ignored).
    if (r.predecessor !== 'system') {
      const dep = sumDeposits(r.actions);
      if (dep > 0n && r.predecessor !== r.receiver) {
        mv({ kind: 'near', token: NEAR_ID, from: r.predecessor, to: r.receiver, amount: dep, method: firstMethod(r.actions) });
      }
      if (r.predecessor === account) {
        for (const act of r.actions) {
          if (act.kind === 'FunctionCall' && act.method === 'storage_deposit' && act.deposit > 0n) {
            a.storageNear += act.deposit;
            storageContracts.add(r.receiver);
          }
        }
      }
    }

    const hasNep141Event = r.logs.some((l) => l.type === 'event' && l.standard === 'nep141');
    for (const l of r.logs) {
      if (l.type === 'event') {
        if (l.standard === 'nep141') {
          for (const d of l.data) {
            if (l.event === 'ft_transfer') mv({ kind: 'ft', token: r.receiver, from: d.old_owner_id, to: d.new_owner_id, amount: big(d.amount), memo: d.memo || null });
            else if (l.event === 'ft_mint') mv({ kind: 'ft', token: r.receiver, from: null, to: d.owner_id, amount: big(d.amount), memo: d.memo || null });
            else if (l.event === 'ft_burn') mv({ kind: 'ft', token: r.receiver, from: d.owner_id, to: null, amount: big(d.amount), memo: d.memo || null });
          }
        } else if (l.standard === 'nep245') {
          for (const d of l.data) {
            const ids = d.token_ids || [];
            ids.forEach((tid, i) => {
              const token = `mt:${r.receiver}:${tid}`;
              const amount = big((d.amounts || [])[i]);
              if (l.event === 'mt_transfer') mv({ kind: 'mt', token, from: d.old_owner_id, to: d.new_owner_id, amount, memo: d.memo || null });
              else if (l.event === 'mt_mint') mv({ kind: 'mt', token, from: null, to: d.owner_id, amount, memo: d.memo || null });
              else if (l.event === 'mt_burn') mv({ kind: 'mt', token, from: d.owner_id, to: null, amount, memo: d.memo || null });
            });
          }
        } else if (l.standard === 'nep171') {
          for (const d of l.data) {
            const from = l.event === 'nft_mint' ? null : d.old_owner_id || d.owner_id;
            const to = l.event === 'nft_burn' ? null : d.new_owner_id || d.owner_id;
            if (from === account || to === account) a.nfts.push({ contract: r.receiver, ids: d.token_ids || [], dir: to === account ? 'in' : 'out', event: l.event });
          }
        } else {
          a.events.push({ contract: r.receiver, standard: l.standard, event: l.event, data: l.data });
          if (l.event === 'swap') {
            for (const d of l.data) {
              if (d && d.token_in && d.token_out) {
                a.allSwaps.push({ venue: r.receiver, pool: d.pool_id || null, tokenIn: d.token_in, tokenOut: d.token_out, amountIn: big(d.amount_in), amountOut: big(d.amount_out), swapper: d.swapper || null });
              }
            }
          }
          if (l.event === 'token_diff') {
            for (const d of l.data) {
              if (!d || !d.diff) continue;
              const ins = Object.entries(d.diff).filter(([, v]) => big(v) < 0n);
              const outs = Object.entries(d.diff).filter(([, v]) => big(v) > 0n);
              if (ins.length && outs.length) {
                a.allSwaps.push({ venue: r.receiver, pool: null, tokenIn: intentsToken(ins[0][0]), tokenOut: intentsToken(outs[0][0]), amountIn: -big(ins[0][1]), amountOut: big(outs[0][1]), swapper: d.account_id || null });
              }
            }
          }
        }
      } else if (l.type === 'ft_text' && !hasNep141Event) {
        if (l.op === 'transfer') mv({ kind: 'ft', token: r.receiver, from: l.from, to: l.to, amount: big(l.amount), memo: null });
        else if (l.op === 'mint') mv({ kind: 'ft', token: r.receiver, from: null, to: l.to, amount: big(l.amount), memo: null });
        else if (l.op === 'burn') mv({ kind: 'ft', token: r.receiver, from: l.from, to: null, amount: big(l.amount), memo: null });
      } else if (l.type === 'ref_swap') {
        const fc = r.actions.find((x) => x.kind === 'FunctionCall');
        const user = fc?.method === 'ft_on_transfer' ? fc.args?.sender_id : r.predecessor;
        a.allSwaps.push({ venue: r.receiver, pool: null, tokenIn: l.tokenIn, tokenOut: l.tokenOut, amountIn: big(l.amountIn), amountOut: big(l.amountOut), swapper: user || null });
      }
    }
  }

  // Storage deposits partly refunded by the same contract are not a cost.
  for (const m of a.movements) {
    if (m.kind === 'near' && m.to === account && storageContracts.has(m.from) && !isDex(m.from)) a.storageNear -= m.amount;
  }
  if (a.storageNear < 0n) a.storageNear = 0n;

  for (const m of a.movements) {
    if (m.from === m.to) continue;
    if (m.to === account) a.deltas[m.token] = (a.deltas[m.token] || 0n) + m.amount;
    if (m.from === account) a.deltas[m.token] = (a.deltas[m.token] || 0n) - m.amount;
    if (m.memo === 'tax' && m.kind === 'ft') a.taxes.push({ token: m.token, amount: m.amount, from: m.from });
  }
  for (const k of Object.keys(a.deltas)) if (a.deltas[k] === 0n) delete a.deltas[k];
  a.nearDelta = (a.deltas[NEAR_ID] || 0n) + (a.deltas[WNEAR] || 0n);

  // Zero-for-zero legs (e.g. SwapByStopPoint when the price is already past the stop) are not trades.
  a.swaps = a.allSwaps.filter((s) => (s.swapper === account || (!s.swapper && a.isSigner)) && (s.amountIn > 0n || s.amountOut > 0n));
  a.trade = buildTrade(a);
  a.intent = a.isSigner ? detectSwapIntent(a) : null;
  a.status = txStatus === 'failure' || (receipts[0] && receipts[0].status === 'failure')
    ? 'failed'
    : a.failures.length ? 'partial' : 'success';

  classify(a, account, tx);
  collectTokens(a);
  return a;
}

function buildTrade(a) {
  const legs = a.swaps;
  if (!legs.length) return null;
  const insSet = new Set(legs.map((l) => norm(l.tokenIn)));
  const outsSet = new Set(legs.map((l) => norm(l.tokenOut)));
  let inputs = [...insSet].filter((t) => !outsSet.has(t));
  let outputs = [...outsSet].filter((t) => !insSet.has(t));
  let circular = false;
  if (!inputs.length || !outputs.length) {
    circular = true;
    inputs = [norm(legs[0].tokenIn)];
    outputs = [norm(legs[legs.length - 1].tokenOut)];
  }
  const tokenIn = inputs[0];
  const tokenOut = outputs[0];

  let legIn = 0n;
  let legOut = 0n;
  if (circular) {
    legIn = legs[0].amountIn;
    legOut = legs[legs.length - 1].amountOut;
  } else {
    for (const l of legs) {
      if (norm(l.tokenIn) === tokenIn) legIn += l.amountIn;
      if (norm(l.tokenOut) === tokenOut) legOut += l.amountOut;
    }
  }

  const walletDelta = (t) => (t === NEAR_ID ? a.nearDelta + a.storageNear : a.deltas[t] || 0n);
  const dIn = circular ? 0n : walletDelta(tokenIn);
  const dOut = circular ? 0n : walletDelta(tokenOut);
  // Wallet deltas include token taxes, so prefer them — but only when they are of the
  // same order as the swap itself (swaps from a DEX's internal balance move just 1 yocto).
  const comparable = (d, leg) => d > 0n && (leg === 0n || d * 2n >= leg);
  const inFromWallet = comparable(-dIn, legIn);
  const outToWallet = comparable(dOut, legOut);
  const amountIn = inFromWallet ? -dIn : legIn;
  const amountOut = outToWallet ? dOut : legOut;
  const side = circular ? 'swap' : tokenIn === NEAR_ID ? 'buy' : tokenOut === NEAR_ID ? 'sell' : 'swap';
  const token = side === 'buy' ? tokenOut : side === 'sell' ? tokenIn : tokenOut;

  // Ordered path following the legs from the input token.
  const route = [tokenIn];
  const used = new Set();
  let cur = tokenIn;
  for (let i = 0; i < legs.length; i++) {
    const idx = legs.findIndex((l, j) => !used.has(j) && norm(l.tokenIn) === cur);
    if (idx < 0) break;
    used.add(idx);
    cur = norm(legs[idx].tokenOut);
    route.push(cur);
    if (cur === tokenOut) break;
  }

  let taxAmount = 0n;
  for (const t of a.taxes) if (t.token === token) taxAmount += t.amount;

  return {
    side, token, tokenIn, tokenOut, amountIn, amountOut, legIn, legOut, circular,
    internal: !circular && !inFromWallet && !outToWallet,
    extraInputs: inputs.slice(1), extraOutputs: outputs.slice(1),
    venues: [...new Set(legs.map((l) => l.venue))],
    pools: legs.map((l) => l.pool).filter(Boolean),
    route, taxAmount, legs: legs.length,
  };
}

function swapTargetFromMsg(msg, tokenIn) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.Swap) return { tokenOut: msg.Swap.output_token, minOut: big(msg.Swap.min_output_amount), recipient: msg.Swap.swap_out_recipient };
  if (msg.SwapByStopPoint) {
    const [x, y] = String(msg.SwapByStopPoint.pool_id || '').split('|');
    const other = x === tokenIn ? y : x;
    return other ? { tokenOut: other, minOut: 0n, stopPoint: true } : null;
  }
  if (msg.SwapByOutput) return { tokenOut: msg.SwapByOutput.output_token, minOut: big(msg.SwapByOutput.output_amount) };
  if (Array.isArray(msg.actions) && msg.actions.length) {
    const last = msg.actions[msg.actions.length - 1];
    return { tokenOut: last.token_out, minOut: big(last.min_amount_out) };
  }
  return null;
}

function detectSwapIntent(a) {
  const acts = a.effActions;
  const hasWrap = acts.some((x) => x.kind === 'FunctionCall' && x.method === 'near_deposit');
  for (const x of acts) {
    if (x.kind !== 'FunctionCall') continue;
    if (x.method === 'ft_transfer_call' && isDex(x.args?.receiver_id)) {
      const target = swapTargetFromMsg(x.args.msgParsed, a.effReceiver);
      if (!target) continue;
      const tokenIn = a.effReceiver === WNEAR && hasWrap ? NEAR_ID : norm(a.effReceiver);
      return { tokenIn, tokenOut: norm(target.tokenOut), amountIn: big(x.args.amount), minOut: target.minOut, dex: x.args.receiver_id, stopPoint: !!target.stopPoint };
    }
    if (isDex(a.effReceiver) && ['swap', 'swap_by_output', 'execute_actions'].includes(x.method)) {
      const list = x.args?.actions || [];
      if (!list.length) continue;
      return {
        tokenIn: norm(list[0].token_in), tokenOut: norm(list[list.length - 1].token_out),
        amountIn: big(list[0].amount_in), minOut: big(list[list.length - 1].min_amount_out), dex: a.effReceiver,
      };
    }
  }
  return null;
}

// kind -> [category, importance]
export const KIND_META = {
  trade: ['trades', 'major'],
  trade_failed: ['trades', 'major'],
  trade_pending: ['trades', 'major'],
  order: ['trades', 'normal'],
  liquidity: ['trades', 'normal'],
  transfer_out: ['transfers', 'major'],
  ft_out: ['transfers', 'major'],
  transfer_in: ['transfers', 'major'],
  ft_in: ['transfers', 'major'],
  receive_multi: ['transfers', 'major'],
  debit: ['transfers', 'major'],
  dex_deposit: ['transfers', 'normal'],
  dex_withdraw: ['transfers', 'normal'],
  wrap: ['transfers', 'normal'],
  unwrap: ['transfers', 'normal'],
  payout: ['payouts', 'minor'],
  claim: ['payouts', 'normal'],
  storage: ['other', 'normal'],
  register: ['other', 'normal'],
  stake: ['other', 'major'],
  unstake: ['other', 'major'],
  withdraw_stake: ['other', 'major'],
  key_add: ['other', 'major'],
  key_delete: ['other', 'major'],
  deploy: ['other', 'major'],
  account_created: ['other', 'normal'],
  account_deleted: ['other', 'major'],
  contract_call: ['other', 'normal'],
  mention: ['other', 'minor'],
};

const DUST_NEAR = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
const NEAR_NOISE = 1_000_000_000_000_000_000n; // 0.000001 NEAR

function classify(a, account, tx) {
  const acts = a.effActions;
  const fcs = acts.filter((x) => x.kind === 'FunctionCall');
  const kinds = new Set(acts.map((x) => x.kind));
  const set = (kind, extra = {}) => {
    a.kind = kind;
    Object.assign(a, extra);
  };

  const dclOwnEvents = a.events.filter((e) => e.contract === 'dclv2.ref-labs.near' && e.data.some((d) => d && (d.owner_id === account || d.user_id === account || d.account_id === account)));

  if (a.trade) {
    set('trade');
  } else if (a.isSigner) {
    const fc0 = fcs[0];
    const methodSet = new Set(fcs.map((x) => x.method));
    const self = a.effReceiver === account;
    if (kinds.has('CreateAccount') && !self) {
      set('transfer_out', { counterparty: a.effReceiver, amount: sumDeposits(acts), token: NEAR_ID, createdAccount: true });
    } else if (self && kinds.has('AddKey')) {
      const k = acts.find((x) => x.kind === 'AddKey');
      set('key_add', { key: { publicKey: k.publicKey, permission: k.permission } });
    } else if (self && kinds.has('DeleteKey')) {
      set('key_delete', { key: { publicKey: acts.find((x) => x.kind === 'DeleteKey').publicKey } });
    } else if (self && kinds.has('DeployContract')) {
      set('deploy');
    } else if (self && kinds.has('DeleteAccount')) {
      set('account_deleted', { beneficiary: acts.find((x) => x.kind === 'DeleteAccount').beneficiary });
    } else if (a.intent) {
      set(a.pending ? 'trade_pending' : 'trade_failed');
    } else if (dclOwnEvents.some((e) => /order/.test(e.event))) {
      set('order', { dclEvents: dclOwnEvents });
    } else if (dclOwnEvents.some((e) => /liquidity/.test(e.event))) {
      set('liquidity', { dclEvents: dclOwnEvents });
    } else if (kinds.has('Transfer') && a.effReceiver !== account && !fcs.length) {
      set('transfer_out', { counterparty: a.effReceiver, amount: sumDeposits(acts), token: NEAR_ID });
    } else if (fc0 && fc0.method === 'ft_transfer' && methodSet.size === 1) {
      set('ft_out', { counterparty: fc0.args?.receiver_id, amount: big(fc0.args?.amount), token: a.effReceiver, memo: fc0.args?.memo });
    } else if (fc0 && fc0.method === 'ft_transfer_call' && fcs.length === 1) {
      const to = fc0.args?.receiver_id;
      if (to === 'v2.ref-finance.near' && !fc0.args?.msgParsed) {
        set('dex_deposit', { counterparty: to, amount: big(fc0.args?.amount), token: a.effReceiver });
      } else {
        set('ft_out', { counterparty: to, amount: big(fc0.args?.amount), token: a.effReceiver, call: true, msg: fc0.args?.msg });
      }
    } else if (methodSet.has('near_deposit') && fcs.every((x) => ['near_deposit', 'storage_deposit'].includes(x.method))) {
      set('wrap', { amount: fcs.filter((x) => x.method === 'near_deposit').reduce((s, x) => s + x.deposit, 0n) });
    } else if (methodSet.has('near_withdraw') && methodSet.size === 1) {
      set('unwrap', { amount: big(fc0.args?.amount) });
    } else if (methodSet.size === 1 && methodSet.has('storage_deposit')) {
      set('storage', { contract: a.effReceiver, forAccount: fc0.args?.account_id || account, amount: fcs.reduce((s, x) => s + x.deposit, 0n) });
    } else if (methodSet.has('register_tokens')) {
      set('register', { contract: a.effReceiver, registered: fcs.flatMap((x) => x.args?.token_ids || []) });
    } else if (isStakingPool(a.effReceiver) && fc0) {
      const m = fc0.method;
      if (/^(deposit_and_stake|deposit|stake)$/.test(m)) set('stake', { pool: a.effReceiver, amount: fc0.deposit || big(fc0.args?.amount) });
      else if (/^unstake/.test(m)) set('unstake', { pool: a.effReceiver, amount: big(fc0.args?.amount) });
      else if (/^withdraw/.test(m)) set('withdraw_stake', { pool: a.effReceiver, amount: big(fc0.args?.amount) });
      else set('contract_call', { contract: a.effReceiver });
    } else if (a.effReceiver === 'v2.ref-finance.near' && methodSet.has('withdraw')) {
      set('dex_withdraw', { counterparty: a.effReceiver, token: fc0.args?.token_id, amount: big(fc0.args?.amount) });
    } else if (a.effReceiver === 'nearlytrade.near' && methodSet.has('claim_fees')) {
      const ev = a.events.find((e) => e.standard === 'nearpad' && e.event === 'fees_claimed');
      set('claim', { launchId: fc0.args?.launch_id ?? ev?.data?.[0]?.id, claimed: ev?.data?.[0] || null });
    } else {
      set('contract_call', { contract: a.effReceiver });
    }
  } else {
    const top = actions0(tx);
    const created = top.find((x) => (x.kind === 'FunctionCall' && x.method === 'create_account' && x.args?.new_account_id === account));
    if (created || (a.receiver === account && top.some((x) => x.kind === 'CreateAccount'))) {
      set('account_created', { via: a.signer, initial: created?.deposit || sumDeposits(top) });
    } else if (a.receiver === 'nearlytrade.near' && top.some((x) => x.method === 'pay_tax_holders')) {
      const call = top.find((x) => x.method === 'pay_tax_holders');
      const payouts = call.args?.payouts || [];
      const mine = payouts.find((p) => p[0] === account);
      const ev = a.events.find((e) => e.standard === 'nearpad' && e.event === 'tax_holders_paid');
      set('payout', {
        launchId: call.args?.launch_id ?? ev?.data?.[0]?.id,
        recipients: payouts.length,
        share: mine ? big(mine[1]) : 0n,
        totalPaid: ev ? big(ev.data?.[0]?.amount) : payouts.reduce((s, p) => s + big(p[1]), 0n),
      });
    } else {
      // 1-yocto deposits attached to calls are noise, not transfers.
      const significant = ([t, v]) => (t === NEAR_ID || t === WNEAR ? (v < 0n ? -v : v) >= NEAR_NOISE : true);
      const pos = Object.entries(a.deltas).filter(([, v]) => v > 0n).filter(significant);
      const neg = Object.entries(a.deltas).filter(([, v]) => v < 0n).filter(significant);
      const fromOf = (token) => {
        const m = a.movements.find((x) => x.to === account && (x.token === token || (token === NEAR_ID && x.token === WNEAR)));
        return m ? m.from : a.signer;
      };
      if (pos.length && !neg.length) {
        const merged = new Set(pos.map(([t]) => norm(t)));
        if (merged.size === 1) {
          const tok = [...merged][0];
          const amount = tok === NEAR_ID ? a.nearDelta : a.deltas[tok];
          const tokRaw = pos[0][0];
          set(tok === NEAR_ID ? 'transfer_in' : 'ft_in', { token: tok, amount, counterparty: fromOf(tokRaw), memo: a.movements.find((x) => x.to === account && x.memo)?.memo || null });
        } else {
          set('receive_multi', { counterparty: a.signer });
        }
      } else if (neg.length) {
        set('debit', { counterparty: a.signer });
      } else if (a.nfts.length) {
        set('ft_in', { token: null, counterparty: a.signer });
      } else {
        set('mention', { counterparty: a.signer });
      }
    }
  }

  const [category, importance] = KIND_META[a.kind] || ['other', 'normal'];
  a.category = category;
  a.importance = importance;
  if (a.kind === 'transfer_in' && a.amount < DUST_NEAR) a.importance = 'minor';
  if (a.kind === 'payout') a.category = 'payouts';
}

function actions0(tx) {
  return (tx.actions || []).map(normalizeAction);
}

function collectTokens(a) {
  const add = (t) => {
    if (!t || t === NEAR_ID) return;
    if (t.startsWith('mt:')) {
      const inner = intentsToken(t.split(':').slice(2).join(':'));
      if (inner && !inner.includes(':')) a.tokens.add(inner);
      return;
    }
    a.tokens.add(t);
  };
  Object.keys(a.deltas).forEach(add);
  if (a.trade) a.trade.route.forEach(add);
  if (a.intent) {
    add(a.intent.tokenIn);
    add(a.intent.tokenOut);
  }
  if (a.token) add(a.token);
  if (a.registered) a.registered.forEach(add);
  if (a.kind === 'storage' && (tokenFamily(a.contract) || !isDex(a.contract))) add(a.contract);
  for (const t of a.taxes) add(t.token);
}

// Converts an RPC EXPERIMENTAL_tx_status result into the FastNEAR raw shape analyzeTx expects.
// meta: { height, timestampNs } from the account-history index (RPC outcomes carry only block hashes).
export function fromRpcTxStatus(res, meta = {}) {
  const tx = res.transaction || {};
  const txo = res.transaction_outcome || {};
  const outcomes = new Map((res.receipts_outcome || []).map((o) => [o.id, o]));
  const receipts = (res.receipts || []).map((r) => ({
    receipt: { receipt_id: r.receipt_id, predecessor_id: r.predecessor_id, receiver_id: r.receiver_id, receipt: r.receipt },
    execution_outcome: outcomes.get(r.receipt_id) || null,
  }));
  // RPC leaves out the receipt the transaction itself was converted into; rebuild it.
  const firstId = txo.outcome?.receipt_ids?.[0];
  if (firstId && outcomes.has(firstId) && !receipts.some((r) => r.receipt.receipt_id === firstId)) {
    receipts.unshift({
      receipt: {
        receipt_id: firstId, predecessor_id: tx.signer_id, receiver_id: tx.receiver_id,
        receipt: { Action: { signer_id: tx.signer_id, actions: tx.actions || [] } },
      },
      execution_outcome: outcomes.get(firstId),
    });
  }
  return {
    transaction: { ...tx, hash: tx.hash || txo.id },
    execution_outcome: { ...txo, block_height: meta.height ?? null, block_timestamp: meta.timestampNs ?? null, index: 0 },
    receipts: receipts.filter((r) => r.execution_outcome),
  };
}
