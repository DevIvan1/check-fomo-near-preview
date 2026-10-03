// connect.html: signs the user in with a NEAR wallet (NEAR Connect) or a typed account,
// stores the session for the app and returns to where the user came from.

import { setSession, clearSession, follow } from './session.js?v=4f17072b';
import { normalizeAccount } from './rules.js?v=4f17072b';
import { viewAccount } from './api.js?v=4f17072b';
import { setLang, t, applyStatic } from './i18n.js?v=4f17072b';
import { track } from './track.js?v=4f17072b';

// Pinned official lightweight NEAR wallet connector (zero dependencies), served from this site:
// no CDN can change the code that runs here. Resolved relative to this module.
const NEAR_CONNECT = '../vendor/near-connect-0.11.4.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
window.__nwmReady = true; // tells boot.js this page started

try {
  setLang(JSON.parse(localStorage.getItem('nwm.settings.v1') || '{}').lang);
} catch {
  setLang('en');
}
applyStatic();

// Only same-origin return targets, so this page cannot be used as an open redirect.
function returnUrl(account) {
  let url;
  try {
    url = new URL(params.get('return') || './', location.href);
  } catch {
    url = new URL('./', location.href);
  }
  if (url.origin !== location.origin) url = new URL('./', location.href);
  if (account && !url.searchParams.get('account')) url.searchParams.set('account', account);
  return url.href;
}
$('#backLink').href = returnUrl(null);

function status(text) {
  $('#connectStatus').textContent = text;
}

function finish(accountId, wallet, watchOnly) {
  const acc = normalizeAccount(accountId);
  if (!acc) return;
  setSession({ accountId: acc, wallet, watchOnly });
  track(watchOnly ? 'manual' : 'connect', acc, wallet); // a beacon: survives the redirect below
  const target = normalizeAccount(params.get('follow'));
  if (target) follow(acc, target);
  status(t('cn.done', acc));
  location.replace(returnUrl(params.get('return') ? null : acc));
}

let connectorPromise = null;
function loadConnector() {
  connectorPromise ||= import(NEAR_CONNECT).then(({ NearConnector }) => {
    const connector = new NearConnector({ network: 'mainnet' });
    connector.on('wallet:signIn', async (e) => {
      const accountId = e?.accounts?.[0]?.accountId;
      let wallet = null;
      try {
        wallet = (await connector.wallet())?.manifest?.name || null;
      } catch {
        /* name is optional */
      }
      finish(accountId, wallet, false);
    });
    return connector;
  });
  return connectorPromise;
}

async function connect() {
  status(t('cn.loading'));
  try {
    const connector = await loadConnector();
    status('');
    await connector.connect();
  } catch (e) {
    console.warn('connect failed', e);
    connectorPromise = null;
    status(t('cn.failed'));
  }
}

async function logout() {
  status(t('cn.signingOut'));
  try {
    const connector = await Promise.race([loadConnector(), new Promise((_, rej) => setTimeout(rej, 6000))]);
    await connector.disconnect();
  } catch {
    /* the local session is cleared regardless */
  }
  clearSession();
  location.replace(returnUrl(null));
}

$('#connectBtn').addEventListener('click', connect);

$('#manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const acc = normalizeAccount($('#manualInput').value);
  if (!acc) {
    status(t('badAccount'));
    return;
  }
  status(t('cn.checking'));
  try {
    await viewAccount(acc);
    finish(acc, null, true);
  } catch (err) {
    status(/does not exist|UNKNOWN_ACCOUNT/i.test(String(err?.message)) ? t('accountMissing') : t('netErrorRetry'));
  }
});

if (params.get('logout') === '1') logout();
