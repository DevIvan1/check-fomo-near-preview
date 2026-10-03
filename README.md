# Check fomo

**English** · [Русский](README.ru.md)

Follow NEAR traders live, FomoApp-style. Check fomo shows every buy, sell and transfer of any NEAR wallet as a post with its transaction hash. It adds PnL boards for 24h, 7d and 30d, lets you connect your wallet and follow traders, and shows a live feed of the wallets you follow with loud sound alerts.

The home page is just a search box. A wallet opens when you enter its address, and you can bookmark a wallet with `?account=name.near` in the URL.

Created by [@Checker1crypto](https://x.com/Checker1crypto).

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

  Sort by date opened or by size (invested amount); click the active option again to reverse. Cards refresh live with the pool price. The right column now holds only the following feed.
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

## Reliability

- **No stale-cache breakage.** GitHub Pages caches files for 10 minutes. Every module URL carries the same content hash (`?v=…`, set by `tools/stamp.py`), so a browser never mixes old and new files.
- **Load watchdog.** `js/boot.js` checks that the app actually started. If not, it reloads once from a fresh URL; if that fails too, it shows how to force-refresh instead of a blank page.
- **Backup data source.** If the FastNEAR transactions API is unavailable or rate-limited, the feed switches to NearBlocks for the history and to RPC `EXPERIMENTAL_tx_status` for the details. Both are converted to the same format and parsed by the same code; the status line shows "backup API". When FastNEAR is back, the full history reloads quietly, without false alerts.
- **Several RPC providers** (FastNEAR, dRPC, shitzuapes, archival FastNEAR). A provider that errors or rate-limits is skipped for a minute.

## Data sources

Everything runs in the browser, no server needed.

| What | Where from |
|---|---|
| Transaction history, receipts, logs | [FastNEAR Transactions API](https://tx.main.fastnear.com); backup: NearBlocks + RPC |
| NEAR balance, token metadata, DCL pool state (live prices) | NEAR RPC (rotating providers) |
| Token balances | FastNEAR API (`/v1/account/{id}/full`) |
| Nearly launch data (price, icon, launch id → token) | `nearly.trade/api` |
| Prices | Rhea DCL pools (live), Intear Prices, Rhea price list |

Amounts come from NEP-141 events (`ft_transfer`, `ft_mint`, `ft_burn`), wNEAR text logs, Rhea DCL (`dcl.ref`) and Rhea v2 (`Swapped … for …`) swap events, and receipt deposits. Gas refunds are ignored.

## Development

No build step: plain ES modules.

```bash
python -m http.server 8000
```

- **App:** http://localhost:8000/
- **Tests:** http://localhost:8000/tests/ (63 tests: parser, both languages, PnL and summary, backup-source conversion, alert rules, XSS safety). `tests/` and `tools/` are not deployed to Vercel (see `.vercelignore`).

Before every commit, stamp the module versions:

```bash
python tools/stamp.py
```

## Limitations

- **Long histories.** For accounts with more than 1000 transactions only the latest 200 load at first; use "Load earlier" for the rest. PnL and the summary cover the loaded history.
- **USD values** use the current NEAR price.
- **Backup mode** shows only the latest ~25 receipts' transactions until FastNEAR is back.
- **FastNEAR browser key.** To lift FastNEAR's anonymous rate limit, create a free *browser* key restricted to your domain (https://docs.fastnear.com/auth) and put it into `FASTNEAR_API_KEY` in `js/config.js`.
