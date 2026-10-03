// Network layer: FastNEAR tx API, NEAR RPC, FastNEAR balances, Nearly and price APIs.

import { TX_API, FASTNEAR_API, RPC_URLS, NEARLY_API, INTEAR_PRICES, REF_PRICES } from './config.js';
import { sleep, chunk } from './util.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} — ${url}`);
    this.status = status;
  }
}

export async function fetchJson(url, { method = 'GET', body, timeout = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
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

export async function accountTxs(accountId, { limit = 200, resumeToken, fromHeight } = {}) {
  const body = { account_id: accountId, limit };
  if (resumeToken) body.resume_token = resumeToken;
  if (fromHeight) body.from_tx_block_height = fromHeight;
  return fetchJson(`${TX_API}/account`, { method: 'POST', body });
}

export async function transactions(hashes, { concurrency = 3 } = {}) {
  const groups = chunk(hashes, 20);
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < groups.length) {
      const g = groups[i++];
      const r = await fetchJson(`${TX_API}/transactions`, { method: 'POST', body: { tx_hashes: g }, timeout: 25000 });
      out.push(...(r.transactions || []));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  return out;
}

// ---- RPC with endpoint rotation ----

let rpcIndex = 0;
export async function rpc(method, params) {
  let lastErr;
  for (let n = 0; n < RPC_URLS.length; n++) {
    const url = RPC_URLS[(rpcIndex + n) % RPC_URLS.length];
    try {
      const r = await fetchJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 'm', method, params }, timeout: 10000, retries: 1 });
      if (r.error) {
        const msg = r.error.data || r.error.message || JSON.stringify(r.error);
        // Errors about the request itself are returned as-is, no point rotating.
        const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        e.rpc = true;
        throw e;
      }
      rpcIndex = (rpcIndex + n) % RPC_URLS.length;
      return r.result;
    } catch (e) {
      lastErr = e;
      if (e.rpc) throw e;
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

export async function viewFunction(contract, method, args = {}) {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: contract, method_name: method,
    args_base64: toB64(JSON.stringify(args)),
  });
  if (r.error) throw new Error(r.error);
  const text = new TextDecoder().decode(new Uint8Array(r.result));
  return JSON.parse(text);
}

export async function viewAccount(accountId) {
  return rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
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
