// Network layer: FastNEAR tx API, NEAR RPC, FastNEAR balances, Nearly and price APIs.

import { TX_API, FASTNEAR_API, RPC_URLS, RPC_FAST, RPC_ARCHIVAL, NEARBLOCKS_API, NEARLY_API, INTEAR_PRICES, REF_PRICES, FASTNEAR_API_KEY } from './config.js?v=ea9cb0bb';
import { fromRpcTxStatus } from './parser.js?v=ea9cb0bb';
import { sleep, chunk } from './util.js?v=ea9cb0bb';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} — ${url}`);
    this.status = status;
  }
}

// An optional FastNEAR browser key (see config.js) lifts the anonymous rate limit.
function authHeaders(url) {
  return FASTNEAR_API_KEY && /^https:\/\/[^/]*fastnear\.com\//.test(url) ? { Authorization: `Bearer ${FASTNEAR_API_KEY}` } : {};
}

export async function fetchJson(url, { method = 'GET', body, timeout = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders(url) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        const err = new HttpError(res.status, url);
        // 4xx (except 408/429) will not get better on retry.
        if (res.status < 500 && res.status !== 429 && res.status !== 408) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal || attempt === retries) break;
      await sleep(400 * 2 ** attempt + Math.random() * 200);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---- FastNEAR transactions API ----

// signerOnly: only transactions the account signed itself (its own trades and actions).
export async function accountTxs(accountId, { limit = 200, resumeToken, fromHeight, signerOnly = false } = {}) {
  const body = { account_id: accountId, limit };
  if (signerOnly) body.is_real_signer = true;
  if (resumeToken) body.resume_token = resumeToken;
  if (fromHeight) body.from_tx_block_height = fromHeight;
  return fetchJson(`${TX_API}/account`, { method: 'POST', body, retries: 1 });
}

export async function transactions(hashes, { concurrency = 3 } = {}) {
  const groups = chunk(hashes, 20);
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < groups.length) {
      const g = groups[i++];
      const r = await fetchJson(`${TX_API}/transactions`, { method: 'POST', body: { tx_hashes: g }, timeout: 25000, retries: 1 });
      out.push(...(r.transactions || []));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  return out;
}

// ---- RPC with endpoint rotation ----

let rpcIndex = 0;
let rpcTurn = 0;
const rpcCooldown = new Map(); // url -> timestamp until which the endpoint is skipped (429 / network errors)

// spread: start each call on the next fast endpoint (round-robin) to share frequent polling.
export async function rpc(method, params, { spread = false } = {}) {
  let lastErr;
  const start = spread ? rpcTurn++ % Math.min(RPC_FAST, RPC_URLS.length) : rpcIndex;
  const order = RPC_URLS.map((_, n) => (start + n) % RPC_URLS.length);
  const now = Date.now();
  // Endpoints in cooldown go last instead of being dropped, so something is always tried.
  order.sort((a, b) => ((rpcCooldown.get(RPC_URLS[a]) || 0) > now) - ((rpcCooldown.get(RPC_URLS[b]) || 0) > now));
  for (const i of order) {
    const url = RPC_URLS[i];
    try {
      const r = await fetchJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 'm', method, params }, timeout: 8000, retries: 0 });
      if (r.error) {
        const msg = r.error.data || r.error.message || JSON.stringify(r.error);
        // Errors about the request itself are returned as-is, no point rotating.
        const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        e.rpc = true;
        throw e;
      }
      rpcCooldown.delete(url);
      if (!spread) rpcIndex = i;
      return r.result;
    } catch (e) {
      lastErr = e;
      if (e.rpc) throw e;
      rpcCooldown.set(url, Date.now() + 60000);
    }
  }
  throw lastErr;
}

function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export async function viewFunction(contract, method, args = {}, opts) {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: contract, method_name: method,
    args_base64: toB64(JSON.stringify(args)),
  }, opts);
  if (r.error) throw new Error(r.error);
  const text = new TextDecoder().decode(new Uint8Array(r.result));
  return JSON.parse(text);
}

// ---- Backup history: NearBlocks for the list, RPC tx status for the details ----

export async function accountTxsBackup(accountId, { limit = 25, signerOnly = false } = {}) {
  const path = signerOnly ? 'txns-only' : 'txns';
  const r = await fetchJson(`${NEARBLOCKS_API}/account/${encodeURIComponent(accountId)}/${path}?per_page=${Math.min(25, limit)}`, { timeout: 12000, retries: 0 });
  const rows = new Map();
  for (const x of r.txns || []) {
    const h = x.transaction_hash;
    if (!h || rows.has(h)) continue;
    rows.set(h, {
      account_id: accountId,
      transaction_hash: h,
      tx_block_height: Number(x.block?.block_height ?? x.receipt_block?.block_height) || null,
      tx_block_timestamp: String(x.block_timestamp ?? x.receipt_block?.block_timestamp ?? ''),
      tx_index: 0,
    });
  }
  return { account_txs: [...rows.values()] };
}

async function txStatus(hash, sender) {
  const params = { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' };
  try {
    return await rpc('EXPERIMENTAL_tx_status', params, { spread: true });
  } catch (e) {
    // Regular nodes forget transactions after a few epochs; ask an archival node.
    const r = await fetchJson(RPC_ARCHIVAL, { method: 'POST', body: { jsonrpc: '2.0', id: 'a', method: 'EXPERIMENTAL_tx_status', params }, timeout: 15000, retries: 0 });
    if (r.error) throw new Error(r.error.data || r.error.message || 'tx status failed');
    return r.result;
  }
}

// rows: account history rows (hash + block height/timestamp); returns FastNEAR-shaped raw transactions.
export async function transactionsBackup(rows, accountId, { concurrency = 3 } = {}) {
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const row = rows[i++];
      try {
        const res = await txStatus(row.transaction_hash, accountId);
        out.push(fromRpcTxStatus(res, { height: row.tx_block_height, timestampNs: row.tx_block_timestamp }));
      } catch {
        /* skipped: picked up by a later poll */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return out;
}

export async function viewAccount(accountId, opts) {
  return rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId }, opts);
}

export async function accountFull(accountId) {
  return fetchJson(`${FASTNEAR_API}/account/${encodeURIComponent(accountId)}/full`, { timeout: 12000, retries: 1 });
}

// ---- Nearly launchpad ----

export async function nearlyLaunch(idOrToken) {
  return fetchJson(`${NEARLY_API}/launch/${encodeURIComponent(idOrToken)}`, { timeout: 10000, retries: 1 });
}

// ---- Prices ----

export async function intearPrice(tokenId) {
  const v = await fetchJson(`${INTEAR_PRICES}/price?token_id=${encodeURIComponent(tokenId)}`, { timeout: 8000, retries: 1 });
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function refPriceList() {
  return fetchJson(REF_PRICES, { timeout: 15000, retries: 1 });
}
