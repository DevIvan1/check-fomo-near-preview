// Connected wallet session and the follow list (kept in this browser, per connected account),
// plus read-only helpers for the NEAR Social graph (social.near).

const SESSION_KEY = 'cf.session.v1';
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/; // NEAR account id rules
const FOLLOWS_PREFIX = 'cf.follows.v1.';
const listeners = new Set();

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or full */
  }
}

function emit() {
  listeners.forEach((fn) => fn());
}

// Other tabs (and connect.html) change the same keys: re-render when they do.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === SESSION_KEY || e.key.startsWith(FOLLOWS_PREFIX)) emit();
  });
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// { accountId, wallet, watchOnly, at } | null
export function getSession() {
  const s = read(SESSION_KEY, null);
  return s && typeof s.accountId === 'string' && s.accountId ? s : null;
}

export function setSession(s) {
  write(SESSION_KEY, s ? { accountId: s.accountId, wallet: s.wallet || null, watchOnly: !!s.watchOnly, at: Date.now() } : null);
  emit();
}

export function clearSession() {
  write(SESSION_KEY, null);
  emit();
}

// [{ account, since }], newest first
export function getFollows(owner) {
  if (!owner) return [];
  const list = read(FOLLOWS_PREFIX + owner, []);
  return Array.isArray(list) ? list.filter((x) => x && typeof x.account === 'string') : [];
}

function saveFollows(owner, list) {
  write(FOLLOWS_PREFIX + owner, list);
  emit();
}

export function isFollowing(owner, account) {
  return getFollows(owner).some((x) => x.account === account);
}

export function follow(owner, account) {
  if (!owner || !account || owner === account || isFollowing(owner, account)) return false;
  saveFollows(owner, [{ account, since: Date.now() }, ...getFollows(owner)]);
  return true;
}

export function unfollow(owner, account) {
  const list = getFollows(owner);
  const next = list.filter((x) => x.account !== account);
  if (next.length === list.length) return false;
  saveFollows(owner, next);
  return true;
}

export const IMPORT_LIMIT = 50;

// Adds several accounts at once (import, capped); returns how many were new.
export function followMany(owner, accounts, limit = IMPORT_LIMIT) {
  const list = getFollows(owner);
  const have = new Set(list.map((x) => x.account));
  const fresh = [...new Set(accounts)].filter((a) => a && a !== owner && !have.has(a)).slice(0, limit).map((account) => ({ account, since: Date.now() }));
  if (fresh.length) saveFollows(owner, [...fresh, ...list]);
  return fresh.length;
}

// ---- NEAR Social (read-only) ----

// Parses social.near `get` output for "<acc>/graph/follow/*".
export function parseSocialFollows(json, account) {
  const f = json?.[account]?.graph?.follow;
  if (!f || typeof f !== 'object') return [];
  return Object.keys(f).filter((k) => k.length >= 2 && k.length <= 64 && ACCOUNT_ID.test(k));
}

// Profile image from social.near: { url } | { ipfs_cid } | { nft: … } (nft not resolved).
export function socialImageUrl(image) {
  if (!image || typeof image !== 'object') return null;
  if (typeof image.url === 'string' && /^https:\/\//.test(image.url)) return image.url;
  if (typeof image.ipfs_cid === 'string' && /^[a-zA-Z0-9]+$/.test(image.ipfs_cid)) return `https://ipfs.near.social/ipfs/${image.ipfs_cid}`;
  return null;
}

export async function nearSocialFollows(account, viewFn) {
  const r = await viewFn('social.near', 'get', { keys: [`${account}/graph/follow/*`] });
  return parseSocialFollows(r, account);
}

const profileCache = new Map();
export async function nearSocialProfile(account, viewFn) {
  if (profileCache.has(account)) return profileCache.get(account);
  const p = (async () => {
    try {
      const r = await viewFn('social.near', 'get', { keys: [`${account}/profile/name`, `${account}/profile/image/**`] });
      const prof = r?.[account]?.profile || {};
      const name = typeof prof.name === 'string' ? prof.name.replace(/[\u0000-\u001f]/g, '').slice(0, 40) : '';
      return { name, image: socialImageUrl(prof.image) };
    } catch {
      setTimeout(() => profileCache.delete(account), 60000); // a network hiccup is not "no profile": ask again later
      return { name: '', image: null };
    }
  })();
  profileCache.set(account, p);
  return p;
}
