// Static configuration: endpoints, known contracts and labels.

import { t } from './i18n.js';

export const TX_API = 'https://tx.main.fastnear.com/v0';
export const FASTNEAR_API = 'https://api.fastnear.com/v1';
// The first RPC_FAST endpoints share frequent polling (round-robin); the rest are fallbacks.
// Several providers, so one provider's rate limit does not stop the live feed.
export const RPC_URLS = [
  'https://rpc.mainnet.fastnear.com',
  'https://near.drpc.org',
  'https://rpc.shitzuapes.xyz',
  'https://free.rpc.fastnear.com',
  'https://rpc.mainnet.near.org',
];
export const RPC_FAST = 3;
export const DCL_CONTRACT = 'dclv2.ref-labs.near';
export const NEARLY_API = 'https://nearly.trade/api';
export const INTEAR_PRICES = 'https://prices.intear.tech';
export const REF_PRICES = 'https://api.ref.finance/list-token-price';

// Optional FastNEAR *browser* key (see https://docs.fastnear.com/auth), restricted to your
// site's domain. Without it the public anonymous limits apply. Never put a server key here.
export const FASTNEAR_API_KEY = '';

export const NEAR_ID = 'near'; // pseudo token id for native NEAR
export const WNEAR = 'wrap.near';

export const HISTORY_PAGE = 200; // tx-api max page size
export const POLL_PAGE = 25;

export const DEFAULT_SETTINGS = {
  lang: 'en', // 'en' | 'ru'
  theme: 'auto', // 'auto' | 'light' | 'dark'
  sound: true,
  volume: 0.6,
  notify: false,
  alertLevel: 'normal', // 'all' | 'normal' | 'trades'
  alertMinNear: 0,
  pollSec: 3,
  showPayouts: true,
  showMentions: false,
};

// Known contracts. kind: dex | launchpad | wrap | lending | wallet
export const CONTRACTS = {
  'dclv2.ref-labs.near': { name: 'Rhea DCL', kind: 'dex' },
  'v2.ref-finance.near': { name: 'Rhea', kind: 'dex' },
  'intents.near': { name: 'NEAR Intents', kind: 'dex' },
  'wrap.near': { name: 'wNEAR', kind: 'wrap' },
  'nearlytrade.near': { name: 'Nearly', kind: 'launchpad' },
  'lock2.nearlytrade.near': { name: 'Nearly LP lock', kind: 'launchpad' },
  'meme-cooking.near': { name: 'Meme Cooking', kind: 'launchpad' },
  'contract.main.burrow.near': { name: 'Rhea Lending', kind: 'lending' },
  'meteor-relayer.near': { name: 'Meteor Wallet', kind: 'wallet' },
  'near': { name: 'near', kind: 'registrar' },
};

// Token families recognised by account suffix (launchpads).
export const TOKEN_FAMILIES = [
  { suffix: '.nearlytrade.near', name: 'Nearly', site: (id) => `https://nearly.trade/${encodeURIComponent(id)}` },
  { suffix: '.meme-cooking.near', name: 'Meme Cooking', site: null },
  { suffix: '.launchpad.justhoot.near', name: 'Hoot', site: null },
];

export function tokenFamily(id) {
  if (!id) return null;
  return TOKEN_FAMILIES.find((f) => id.endsWith(f.suffix)) || null;
}

export function contractName(id) {
  if (!id) return '';
  if (CONTRACTS[id]) return CONTRACTS[id].name;
  if (/\.pool(v1)?\.near$/.test(id)) return t('validator', id);
  return id;
}

export function isDex(id) {
  return CONTRACTS[id]?.kind === 'dex';
}

export function isStakingPool(id) {
  return /\.(poolv1|pool|pools)\.near$/.test(id || '');
}

const enc = encodeURIComponent;
export const explorer = {
  tx: (h) => `https://nearblocks.io/txns/${enc(h)}`,
  txAlt: (h) => `https://pikespeak.ai/transaction-viewer/${enc(h)}`,
  account: (a) => `https://nearblocks.io/address/${enc(a)}`,
  accountAlt: (a) => `https://pikespeak.ai/wallet-explorer/${enc(a)}`,
  token: (t) => `https://nearblocks.io/token/${enc(t)}`,
};
