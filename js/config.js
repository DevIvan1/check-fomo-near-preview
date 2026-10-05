// Static configuration: endpoints, known contracts and labels.

import { t } from './i18n.js?v=9489111f';

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
export const RPC_ARCHIVAL = 'https://archival-rpc.mainnet.fastnear.com';
// Backup account history when the FastNEAR tx API is unavailable (details then come from RPC).
export const NEARBLOCKS_API = 'https://api.nearblocks.io/v1';
export const NEARLY_API = 'https://nearly.trade/api';
export const INTEAR_PRICES = 'https://prices.intear.tech';
export const REF_PRICES = 'https://api.ref.finance/list-token-price';
// Leaderboard: Intear's public swap history and Rhea's pool list (24h volume).
export const INTEAR_EVENTS = 'https://events-v3.intear.tech/v3';
export const REF_API = 'https://api.ref.finance';
// Usage log endpoint for the GitHub Pages copy (the Vercel site posts to its own /api/track).
export const TRACK_URL = 'https://check-fomo-near.vercel.app/api/track';

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
  volume: 0.8,
  followAlerts: true, // sound/notify on trades of followed wallets
  notify: false,
  alertLevel: 'normal', // 'all' | 'normal' | 'trades'
  alertMinNear: 0,
  pollSec: 3,
  showPayouts: true,
  showMentions: false,
  summaryDays: 1, // 1 | 7 | 30
  posSort: 'date', // 'date' | 'size'
  posDir: 'desc', // 'desc' | 'asc'
  lbWindow: '7d', // leaderboard period: '24h' | '7d' | '30d'
  lbSort: 'pnl', // 'pnl' | 'roi'
};

// Known contracts. kind: dex | aggregator | launchpad | wrap | lending | wallet | registrar
// about: i18n key explaining on the account's page that it is a system address, not a person.
export const CONTRACTS = {
  'dclv2.ref-labs.near': { name: 'Rhea DCL', kind: 'dex', about: 'sys.rheaDcl' },
  'v2.ref-finance.near': { name: 'Rhea', kind: 'dex', about: 'sys.rhea' },
  'intents.near': { name: 'NEAR Intents', kind: 'dex', about: 'sys.intents' },
  'aggregatedex.near': { name: 'Delta Trade aggregator', kind: 'aggregator', about: 'sys.aggregatedex' },
  'wrap.near': { name: 'wNEAR', kind: 'wrap', about: 'sys.wrap' },
  'nearlytrade.near': { name: 'Nearly', kind: 'launchpad', about: 'sys.nearly' },
  'lock2.nearlytrade.near': { name: 'Nearly LP lock', kind: 'launchpad', about: 'sys.nearlyLock' },
  'meme-cooking.near': { name: 'Meme Cooking', kind: 'launchpad', about: 'sys.memeCooking' },
  'contract.main.burrow.near': { name: 'Rhea Lending', kind: 'lending', about: 'sys.lending' },
  'meteor-relayer.near': { name: 'Meteor Wallet', kind: 'wallet', about: 'sys.meteorRelayer' },
  'near': { name: 'near', kind: 'registrar', about: 'sys.registrar' },
};

// i18n key that explains a known system address, or null for everything else.
export function systemAbout(id) {
  return CONTRACTS[id]?.about || null;
}

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

// Swap aggregators take a wallet's tokens, swap them on DEXes in their own name and send the result back.
export function isAggregator(id) {
  return CONTRACTS[id]?.kind === 'aggregator';
}

// Dollar stablecoins on NEAR (exact contracts: launchpads have meme tokens named "USDC" too).
// A swap between NEAR and a stablecoin is moving money, not a position.
export const STABLECOINS = new Set([
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
  'usdt.tether-token.near', // USDt
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', // USDC.e
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near', // USDT.e
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near', // DAI
  '853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near', // FRAX
  '16.contract.portalbridge.near', // USDC (Wormhole)
  'eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', // USDC (Ethereum, NEAR Intents)
  'eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', // USDT (Ethereum, NEAR Intents)
  'eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near', // DAI (Ethereum, NEAR Intents)
  'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', // USDC (Base, NEAR Intents)
  'arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', // USDC (Arbitrum, NEAR Intents)
  'arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near', // USDT (Arbitrum, NEAR Intents)
  'sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', // USDC (Solana, NEAR Intents)
  'sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near', // USDT (Solana, NEAR Intents)
  'tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', // USDT (Tron, NEAR Intents)
]);

export function isStable(id) {
  return STABLECOINS.has(id);
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
