// Token metadata, Nearly launch info and prices, with in-memory + localStorage caches.

import { viewFunction, nearlyLaunch, intearPrice, refPriceList } from './api.js?v=5156bc38';
import { NEAR_ID, WNEAR, DCL_CONTRACT, tokenFamily } from './config.js?v=5156bc38';
import { storageGet, storageSet } from './util.js?v=5156bc38';

const META_KEY = 'nwm.meta.v2';
const LAUNCH_KEY = 'nwm.launchmap.v1';

const metas = new Map(Object.entries(storageGet(META_KEY, {})));
const launchById = new Map(Object.entries(storageGet(LAUNCH_KEY, {})));
const inflight = new Map();
const launches = new Map(); // token -> { data, at }
const prices = new Map(); // token -> { near, at, source }
const POOL_FRESH_MS = 20000;

// A live pool price outranks slower sources (Nearly API, price aggregators) while it is fresh.
function setPrice(token, near, source) {
  const cur = prices.get(token);
  if (source !== 'pool' && cur?.source === 'pool' && Date.now() - cur.at < POOL_FRESH_MS) return;
  prices.set(token, { near, at: Date.now(), source });
}
let nearUsd = null;
let refList = null;
let refAt = 0;

const BUILTIN = {
  [WNEAR]: { id: WNEAR, symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, icon: null },
};

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '').trim().slice(0, max);
}

export function safeIcon(src) {
  if (typeof src !== 'string') return null;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif)[;,]/i.test(src)) return src.length < 400000 ? src : null;
  if (/^https:\/\/[^\s"'<>]+$/i.test(src)) return src;
  return null;
}

function shortId(id) {
  const head = id.split('.')[0];
  return (head.length > 14 ? head.slice(0, 12) + '…' : head).toUpperCase();
}

function persist() {
  const obj = {};
  for (const [k, v] of metas) if (!v.error) obj[k] = { ...v };
  if (JSON.stringify(obj).length > 1_500_000) {
    // Drop embedded icons first if storage gets heavy.
    for (const v of Object.values(obj)) if (v.icon && v.icon.startsWith('data:')) v.icon = null;
  }
  storageSet(META_KEY, obj);
}

export function meta(id) {
  if (!id || id === NEAR_ID) return { id: NEAR_ID, symbol: 'NEAR', name: 'NEAR', decimals: 24, icon: null };
  return metas.get(id) || BUILTIN[id] || null;
}

export function decimals(id) {
  return meta(id)?.decimals ?? null;
}

export async function ensureMeta(ids) {
  const need = [...ids].filter((id) => id && id !== NEAR_ID && !BUILTIN[id] && (!metas.has(id) || metas.get(id).error && !metas.get(id).retried));
  await Promise.all(need.map(loadMeta));
}

async function loadMeta(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const prev = metas.get(id);
    let m;
    try {
      const md = await viewFunction(id, 'ft_metadata', {});
      const dec = Number(md.decimals);
      m = {
        id,
        symbol: cleanText(md.symbol, 24) || shortId(id),
        name: cleanText(md.name, 64),
        decimals: Number.isInteger(dec) && dec >= 0 && dec <= 64 ? dec : null,
        icon: safeIcon(md.icon),
      };
      if (m.decimals === null) Object.assign(m, { error: true, retried: !!prev });
    } catch {
      m = { id, symbol: shortId(id), name: '', decimals: null, icon: null, error: true, retried: !!prev };
    }
    try {
      const supply = await viewFunction(id, 'ft_total_supply', {});
      if (typeof supply === 'string' && /^\d+$/.test(supply)) m.supply = supply;
    } catch {
      /* optional */
    }
    if (tokenFamily(id)?.name === 'Nearly') {
      try {
        const L = await getLaunch(id);
        if (L?.icon && safeIcon(L.icon)?.startsWith('https://')) m.icon = L.icon; // small URL instead of a big data URI
      } catch {
        /* optional */
      }
    }
    metas.set(id, m);
    persist();
    return m;
  })();
  inflight.set(id, p);
  try {
    return await p;
  } finally {
    inflight.delete(id);
  }
}

export function supply(id) {
  const s = meta(id)?.supply;
  return s ? BigInt(s) : null;
}

// ---- Nearly launches ----

export async function getLaunch(token, maxAgeMs = 60000) {
  const c = launches.get(token);
  if (c && Date.now() - c.at < maxAgeMs) return c.data;
  const data = await nearlyLaunch(token);
  rememberLaunch(data);
  return data;
}

function rememberLaunch(data) {
  if (!data || !data.token) return;
  launches.set(data.token, { data, at: Date.now() });
  if (data.id !== undefined && data.id !== null && launchById.get(String(data.id)) !== data.token) {
    launchById.set(String(data.id), data.token);
    storageSet(LAUNCH_KEY, Object.fromEntries(launchById));
  }
  if (Number.isFinite(data.price_near) && data.price_near > 0) setPrice(data.token, data.price_near, 'nearly');
}

export function launchInfo(token) {
  return launches.get(token)?.data || null;
}

export function launchToken(launchId) {
  if (launchId === undefined || launchId === null) return null;
  return launchById.get(String(launchId)) || null;
}

export async function ensureLaunches(ids) {
  const need = [...new Set([...ids].filter((x) => x !== undefined && x !== null).map(String))].filter((id) => !launchById.has(id));
  await Promise.all(need.map(async (id) => {
    try {
      rememberLaunch(await nearlyLaunch(id));
    } catch {
      try {
        const L = await viewFunction('nearlytrade.near', 'get_launch', { launch_id: id });
        if (L?.token) {
          launchById.set(String(id), L.token);
          storageSet(LAUNCH_KEY, Object.fromEntries(launchById));
        }
      } catch {
        /* unknown launch */
      }
    }
  }));
}

// ---- Prices ----

export function getNearUsd() {
  return nearUsd;
}

export function priceNear(token) {
  if (!token || token === NEAR_ID || token === WNEAR) return 1;
  return prices.get(token)?.near ?? null;
}

async function refPrices() {
  if (refList && Date.now() - refAt < 120000) return refList;
  try {
    refList = await refPriceList();
    refAt = Date.now();
  } catch {
    /* keep stale */
  }
  return refList;
}

export async function refreshNearUsd() {
  try {
    nearUsd = (await intearPrice(WNEAR)) ?? nearUsd;
  } catch {
    const list = await refPrices();
    const p = Number(list?.[WNEAR]?.price);
    if (p > 0) nearUsd = p;
  }
  return nearUsd;
}

export async function refreshPrices(tokens) {
  if (!nearUsd) await refreshNearUsd();
  await Promise.all([...tokens].filter((t) => t && t !== NEAR_ID && t !== WNEAR).map(async (t) => {
    try {
      if (tokenFamily(t)?.name === 'Nearly') {
        await getLaunch(t, 20000);
        return;
      }
      const usd = await intearPrice(t);
      if (usd && nearUsd) {
        setPrice(t, usd / nearUsd, 'intear');
        return;
      }
      throw new Error('no price');
    } catch {
      const list = await refPrices();
      const usd = Number(list?.[t]?.price);
      if (usd > 0 && nearUsd) setPrice(t, usd / nearUsd, 'ref');
    }
  }));
}

// ---- Live prices straight from Rhea DCL pools ----

const poolDecimals = (id) => (id === WNEAR ? 24 : decimals(id));

// Price of one token_x in token_y for a DCL pool: 1.0001^current_point scaled by decimals.
export function dclPrice(pool, decX, decY) {
  return 1.0001 ** Number(pool.current_point) * 10 ** (decX - decY);
}

// Walks a set of pair rates from `token` to wNEAR and returns the NEAR price (or null).
export function routePrice(token, rates) {
  if (token === WNEAR || token === NEAR_ID) return 1;
  const seen = new Set([token]);
  let frontier = [[token, 1]];
  while (frontier.length) {
    const next = [];
    for (const [cur, acc] of frontier) {
      for (const r of rates) {
        let to = null;
        let mult = 0;
        if (r.x === cur) [to, mult] = [r.y, r.p];
        else if (r.y === cur) [to, mult] = [r.x, 1 / r.p];
        if (!to || seen.has(to) || !Number.isFinite(mult) || mult <= 0) continue;
        if (to === WNEAR) return acc * mult;
        seen.add(to);
        next.push([to, acc * mult]);
      }
    }
    frontier = next;
  }
  return null;
}

// tokenPools: Map token -> array of DCL pool ids ("x|y|fee") that connect it to wNEAR.
export async function refreshPoolPrices(tokenPools, viewFn) {
  const ids = [...new Set([...tokenPools.values()].flat().filter((id) => id && id.split('|').length === 3))];
  if (!ids.length) return [];
  const states = await Promise.all(ids.map((id) => viewFn(DCL_CONTRACT, 'get_pool', { pool_id: id }, { spread: true }).catch(() => null)));
  const rates = [];
  states.forEach((st) => {
    if (!st || st.current_point === undefined) return;
    const dx = poolDecimals(st.token_x);
    const dy = poolDecimals(st.token_y);
    if (dx === null || dy === null) return;
    rates.push({ x: st.token_x, y: st.token_y, p: dclPrice(st, dx, dy) });
  });
  const updated = [];
  for (const token of tokenPools.keys()) {
    const p = routePrice(token, rates);
    if (p && Number.isFinite(p)) {
      setPrice(token, p, 'pool');
      updated.push(token);
    }
  }
  return updated;
}
