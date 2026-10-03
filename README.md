# NEAR Wallet Monitor

A live, post-style feed of everything a NEAR wallet does: buys, sells, transfers, holder payouts and contract registrations. Every post links its transaction hash.

The home page is just a search box. A wallet opens when you enter its address, and you can bookmark a wallet with `?account=name.near` in the URL.

Created by [@Checker1crypto](https://x.com/Checker1crypto).

## Features

- **Live feed.** Every 3 seconds (configurable) a lightweight RPC call checks the wallet balance. Any transaction the wallet signs burns gas, so a change shows up right away and triggers a fetch of the new transactions. A 15-second safety poll also catches token-only transfers. Events usually appear 4–8 seconds after the block. Posts whose receipts are still executing are marked "executing" and update themselves.
- **Trade details.** NEAR spent or received, token amount, token tax (1–2% on Nearly tokens), price per token, FDV at the time of the trade, route (`NEAR → NEARLY → NEARLEE`), pools and fees, venue (Rhea DCL / Rhea / NEAR Intents) and launchpad (Nearly and others).
- **Live PnL on buys.** While the wallet still holds the token, the buy post refreshes every 3 seconds from the Rhea DCL pool price. It shows the current PnL in %, the unrealized profit in NEAR in brackets, and the USD equivalent, for example `+10% (+50 NEAR) ≈ +$235`. The "Now" line shows the current price, current FDV and the change since the trade.
- **Sell results.** Every sell shows its PnL against the average entry price and marks closed positions.
- **Failed trades** are explained in plain words: slippage, insufficient funds, stop-point order not filled.
- **Signals:** `storage_deposit` into a token (often a step before buying), new access keys and contract deploys are highlighted.
- **Alerts.**
  - Sounds are generated in the browser (Web Audio): rising for buys, falling for sells, a warning tone for errors.
  - A `(N)` counter appears in the tab title and a dot on the favicon; desktop notifications are optional.
  - Polling runs in a Web Worker, so alerts keep coming while the tab is in the background.
  - You choose what to be alerted about (everything, important events, or trades only) and can set a minimum trade size in NEAR.
- **Positions & PnL** per token: invested, returned, holder payouts received, current value of the remainder and total result.
- **Wallet & stats:** NEAR and token balances with values, volume, trades in the last 24h, deposits and the main funding source.
- **Filters** (trades / transfers / payouts / other), **search** by token, hash or account, **CSV export**. Runs of small holder payouts are folded into one card.
- **Language:** English (default) or Russian. **Theme:** system, light or dark. Both are in Settings and are remembered.

## Data sources

Everything runs in the browser, no server needed.

| What | Where from |
|---|---|
| Transaction history, receipts, logs | [FastNEAR Transactions API](https://tx.main.fastnear.com) (`/v0/account`, `/v0/transactions`) |
| NEAR balance, token metadata, DCL pool state (live prices) | NEAR RPC, rotating between FastNEAR, dRPC and other public nodes |
| Token balances | FastNEAR API (`/v1/account/{id}/full`) |
| Nearly launch data (price, icon, launch id → token) | `nearly.trade/api` |
| Prices | Rhea DCL pools (live), Intear Prices, Rhea price list as a fallback |

Amounts come from NEP-141 events (`ft_transfer`, `ft_mint`, `ft_burn`), wNEAR text logs, Rhea DCL (`dcl.ref`) and Rhea v2 (`Swapped … for …`) swap events, and receipt deposits. Gas refunds are ignored.

## Tests

`tests/index.html` runs about 50 tests in the browser. They cover the parser, post texts in both languages, PnL, alert rules and XSS safety, using real transactions and synthetic edge cases. Open the tests through any static server:

```bash
python -m http.server 8000
```

Then open http://localhost:8000/tests/. The `tests/` folder is not deployed to Vercel (see `.vercelignore`).

## Limitations

- **Long histories.** For accounts with more than 1000 transactions only the latest 200 load at first; use "Load earlier" for the rest. PnL covers the loaded history only.
- **USD values** use the current NEAR price.
- **Rate limits.** Public APIs rate-limit anonymous clients. A normal visitor stays well within the limits, but many tabs from one IP can hit them. Then the status shows "Transactions API not responding" and the app retries with growing pauses.
  - RPC calls rotate between several providers, so one provider's limit does not stop the feed.
  - To lift the FastNEAR limit, create a free *browser* key restricted to your site's domain (https://docs.fastnear.com/auth) and put it into `FASTNEAR_API_KEY` in `js/config.js`.
