# Check fomo

**English** · [Русский](README.ru.md)

Follow NEAR traders live, FomoApp-style. Check fomo shows every buy, sell and transfer of any NEAR wallet as a post with its transaction hash. It adds PnL boards for 24h, 7d and 30d, a leaderboard of the top 100 meme-coin traders on NEAR, lets you connect your wallet and follow traders, and shows a live feed of the wallets you follow with loud sound alerts.

The home page is just a search box. A wallet opens when you enter its address, and you can bookmark a wallet with `?account=name.near` in the URL.

Created by [@Checker1crypto](https://x.com/Checker1crypto).

## Top traders leaderboard

The left column of every wallet page ranks the 100 most profitable meme-coin traders on NEAR, FomoApp-style.

- **Periods:** 24h, 7d or 30d. A period holds the positions opened in it, each with its full result: realized plus unrealized at the current price, in USD. This is the same rule Nearly uses for its own ranking.
- **Rank by PnL** (profit in USD) or **ROI** (profit relative to the amount invested; positions of $25 or more in total).
- **Every row** shows the rank, wallet, PnL, ROI, number of trades and the platforms the profit came from. Hover a row for realized and unrealized PnL and the best token. Click a row to open that wallet.
- **Refresh** reloads everything (about 10–15 seconds, with a progress bar); the old board stays on screen meanwhile. The board is cached in the browser and refreshes itself on load when it is older than 10 minutes.
- **Only profitable wallets** are listed. Protocol accounts (NEAR Intents solvers, routers, launchpad and token contracts) are excluded.

Where the numbers come from, without counting anything twice:

- **Nearly tokens** (`*.nearlytrade.near`): Nearly's own ranking (`/api/traders`, top 100 per period). Wallets outside it that made money on other launchpads get their Nearly result from `/api/trader/{account}` with the same period rule, so a loss on Nearly is not left out.
- **Every other meme** (Hoot, Shore, Meme Cooking, tkn.near, Token0, NearPad, Neara, NearBased, Intear launchpad, AIdols and others, plus classic memes on Rhea such as SHITZU, NEKO, LONK, GEAR): calculated in the browser from on-chain swaps indexed by [Intear](https://docs.intear.tech/docs/events-api/historical). The 20 most traded of these tokens are taken from Rhea's pool list (24h volume), their latest swaps reveal who trades them, and the latest swaps of the 60 most active of those wallets are read as well. Positions are tracked like in the Positions tab (average cost, a re-buy after a full exit is a new position). A sell without a known buy before it is ignored, because its cost is unknown. Swaps paid in RHEA, ZEC, USDC and other tokens are converted to NEAR at the current price.

## Social: wallet, profile, follows

- **Connect wallet.** HOT, Meteor, Intear, MyNearWallet, Ledger, OKX, Nightly and other NEAR wallets through the official lightweight [NEAR Connect](https://github.com/hot-dao/near-selector). Check fomo only reads your address: there are no transactions and nothing to approve. You can also continue without a wallet by entering your account. Wallet code runs only on a separate `connect.html` page; the main app keeps its strict Content-Security-Policy.
- **Profile.** Every wallet page shows PnL tiles for 24h, 7 days and 30 days (click one to open the detailed summary), plus the NEAR Social name and avatar when the wallet has them. Your own page is marked "You" and has Disconnect.
- **Follow.** Every wallet page has a Follow button; if you are not connected, it signs you in and follows right after. Follows are kept in this browser per connected account, and you can import your follows from NEAR Social (`social.near`, up to 50 at a time).
- **Following feed** (bottom right) — live trades of the wallets you follow:
  - **Activity** tab: the trades, with sound and desktop alerts for fresh trades (can be switched off in Settings);
  - **Wallets** tab: manage the followed wallets.

  Each followed wallet gets one cheap balance check in turn, and its transactions are read only when the balance changes, plus a safety refresh every 2 minutes. This keeps the feed within public API limits even with dozens of follows.
- **Positions tab** (right after All), FomoApp-style. A header shows realized and unrealized PnL, win rate on closed positions, average hold time and trade count. Below it, one simple card per position. A position opens with a buy from an empty balance and closes when everything is sold; buying the same token again starts a new position, so an old closed loss is never mixed into a new trade. Each card shows:
  - status OPEN (green) or CLOSED (red);
  - position size in NEAR and USD: invested, and the current value (or what was returned for closed positions);
  - entry market cap in USD (average entry of the position's buys) and the market cap now, or at exit;
  - realized and unrealized PnL in NEAR and USD, total PnL with % on invested;
  - tokens held, holder payouts, hold time, number of buys and sells.

  Sort by date opened or by size (invested amount); click the active option again to reverse. Cards refresh live with the pool price. The right column holds only the following feed.
- **Louder, longer alerts.** Three-note sounds through a compressor: rising for buys, falling for sells.

## Features

- **Live feed.** Every 3 seconds (configurable) a lightweight RPC call checks the wallet balance. Any transaction the wallet signs burns gas, so a change shows up right away and triggers a fetch of the new transactions. A 15-second safety poll also catches token-only transfers. Events usually appear 4–8 seconds after the block. Posts whose receipts are still executing are marked "executing" and update themselves.
- **Trade details.** NEAR spent or received, token amount, token tax (1–2% on Nearly tokens), price per token, FDV at the time of the trade, route (`NEAR → NEARLY → NEARLEE`), pools and fees, venue (Rhea DCL / Rhea / NEAR Intents) and launchpad (Nearly and others).
- **Live PnL on buys.** While the wallet holds the token, the buy post refreshes every 3 seconds from the Rhea DCL pool price. It shows `+10% (+50 NEAR) ≈ +$235`: PnL in %, unrealized profit in NEAR and the USD equivalent. The "Now" line shows the current price, current FDV and the change since the trade.
- **Closed trades.** Sells show the realized PnL against the average entry price in %, NEAR and USD. Buys of positions that are already closed show the position's final PnL the same way.
- **Summary tab.** Pick 24h, 7 days or 30 days to see the PnL of all trades in that period. Realized PnL of sells is added to the live unrealized PnL of positions still open. You also get holder payouts, a total including payouts, bought/sold volume, trade count, share of profitable sells, best and worst token, and a per-token breakdown.
- **Failed trades** are explained in plain words: slippage, insufficient funds, stop-point order not filled.
- **Signals:** a `storage_deposit` into a token (often a step before buying), new access keys and contract deploys are highlighted.
- **Alerts.** Sounds are generated in the browser (Web Audio): rising for buys, falling for sells, a warning tone for errors. A `(N)` counter appears in the tab title and a dot on the favicon, and desktop notifications are optional. Polling runs in a Web Worker, so alerts keep coming while the tab is in the background. Settings let you choose what to be alerted about and the minimum trade size.
- **Positions & PnL** per token, **wallet balances**, **stats**, **filters**, **search** (token, hash, account), **CSV export**. Runs of small holder payouts are folded into one card.
- **Language:** English (default) or Russian. **Theme:** system, light or dark. Both are in Settings and are remembered.

## Security

Check fomo never asks a wallet to sign anything: connecting only reveals the account address. The protections below keep it that way and keep injected code out.

- **Strict Content-Security-Policy on the app** (`index.html`): scripts, styles and workers only from the site itself, network calls only to the listed APIs, no plugins, no `<base>` tricks, forms only to the site.
- **Wallet code is isolated.** It loads only on `connect.html`, only after a click, and the main app never loads it. Each wallet runs in a sandboxed iframe (`allow-scripts` only) with no access to the page.
- **No CDN for the connector.** NEAR Connect 0.11.4 is served from this site (`vendor/`, sha256 in the file header), so a CDN cannot change the code that runs on the connect page.
- **All outside data is text.** Token names, symbols, accounts and API answers are rendered with `textContent`, never as HTML. Icons pass an image-only filter (`https:` or `data:image/…`). Account ids from outside APIs must match the NEAR account format before they are shown or opened. Spreadsheet formulas are neutralised in the CSV export.
- **No open redirect.** The connect page returns only to pages of the same site.
- **Headers on Vercel** (`vercel.json`): the site cannot be framed (clickjacking), no MIME sniffing, no referrer, camera / microphone / geolocation / payment disabled.
- **No secrets in the code.** The usage-log storage token lives only in Vercel's environment; the local sync uses a read-only token from an ignored file.
- **The GitHub Pages copy** shares the `devivan1.github.io` origin with the owner's other Pages sites; the Vercel site is the one meant for real users.

## Usage log

The site records which wallets use it, so the owner can see who connects:

- **What is stored:** the account address, the kind of event (wallet connected, signed in without a wallet, a connected wallet came back, an address typed into search), the wallet app name, and the first/last time and count. No IP addresses (a hash of the IP lives two minutes as a rate limit), no cookies, nothing else. The same event from one browser is sent at most once per 6 hours. Local development is not logged.
- **How:** the page sends a beacon to `api/track.py`, a Vercel function that validates the address, checks the origin, limits the rate (20 a minute per IP) and the size of the log (50,000 entries), and writes to Upstash Redis. Nothing can be read back over HTTP.
- **Setup:** Vercel → the project → Storage → Create Database → Upstash for Redis → connect it to the project and redeploy. For the local list, copy `KV_REST_API_URL` and `KV_REST_API_READ_ONLY_TOKEN` from the database's `.env.local` tab into `tools/.wallets.env`.
- **Local list:** `python tools/sync_wallets.py` writes `КОШЕЛЬКИ.txt` in the project folder (newest first, in three groups); Windows Task Scheduler runs it every 10 minutes. The file, its cache and the credentials are git-ignored.
- **Note:** "signed in without a wallet" and "searched" are just typed addresses; only "wallet connected" means the person approved it in a wallet.

## Reliability

- **No stale-cache breakage.** GitHub Pages caches files for 10 minutes. Every module URL carries the same content hash (`?v=…`, set by `tools/stamp.py`), so a browser never mixes old and new files.
- **Load watchdog.** `js/boot.js` checks that the app actually started. If not, it reloads once from a fresh URL; if that fails too, it shows how to force-refresh instead of a blank page.
- **Backup data source.** If the FastNEAR transactions API is unavailable or rate-limited, the feed switches to NearBlocks for the history and to RPC `EXPERIMENTAL_tx_status` for the details. Both are converted to the same format and parsed by the same code; the status line shows "backup API". When FastNEAR is back, the full history reloads quietly, without false alerts.
- **Several RPC providers** (FastNEAR, dRPC, shitzuapes, archival FastNEAR). A provider that errors or rate-limits is skipped for a minute.

## Data sources

Everything is calculated in the browser. The only server part is the usage log (`api/track.py`, see above).

| What | Where from |
|---|---|
| Transaction history, receipts, logs | [FastNEAR Transactions API](https://tx.main.fastnear.com); backup: NearBlocks + RPC |
| NEAR balance, token metadata, DCL pool state (live prices) | NEAR RPC (rotating providers) |
| Token balances | FastNEAR API (`/v1/account/{id}/full`) |
| Nearly launch data (price, icon, launch id → token) | `nearly.trade/api` |
| Prices | Rhea DCL pools (live), Intear Prices, Rhea price list |
| Leaderboard | Nearly (`/api/traders`, `/api/trader/{account}`), Intear Events API (swaps by token and by trader), Intear token list (prices, decimals), Rhea pool list (24h volume) |

Amounts come from NEP-141 events (`ft_transfer`, `ft_mint`, `ft_burn`), wNEAR text logs, Rhea DCL (`dcl.ref`) and Rhea v2 (`Swapped … for …`) swap events, and receipt deposits. Gas refunds are ignored.

## Development

No build step: plain ES modules.

```bash
python -m http.server 8000
```

- **App:** http://localhost:8000/
- **Tests:** http://localhost:8000/tests/ (75 tests: parser, both languages, PnL and summary, positions, leaderboard maths and engine, usage-log client, backup-source conversion, alert rules, XSS safety). Usage-log server and sync, offline against a fake Redis: `python tests/test_usage_log.py` (7 tests). `tests/` and `tools/` are not deployed to Vercel (see `.vercelignore`).

Before every commit, stamp the module versions:

```bash
python tools/stamp.py
```

## Limitations

- **Long histories.** For accounts with more than 1000 transactions only the latest 200 load at first; use "Load earlier" for the rest. PnL and the summary cover the loaded history.
- **USD values** use the current NEAR price.
- **Leaderboard depth.** Intear's public API returns the latest 50 swaps per token or wallet, so on other launchpads the board sees recent activity best; very active wallets may have older positions cut off. Nearly numbers come from Nearly and are complete. Only the 20 busiest non-Nearly memes are scanned on each refresh.
- **Backup mode** shows only the latest ~25 receipts' transactions until FastNEAR is back.
- **FastNEAR browser key.** To lift FastNEAR's anonymous rate limit, create a free *browser* key restricted to your domain (https://docs.fastnear.com/auth) and put it into `FASTNEAR_API_KEY` in `js/config.js`.
