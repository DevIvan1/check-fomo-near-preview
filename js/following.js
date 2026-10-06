// Feed of trades made by the wallets the user follows.
// Gentle on public APIs: each followed wallet gets one cheap balance check in turn
// (round-robin), and its transactions are fetched only when that balance changes,
// plus a slow safety refresh that also catches token-only transfers.

const DETECT_EVERY_MS = 2500; // one followed wallet checked per interval
const INITIAL_EVERY_MS = 2000; // first loads of newly followed wallets are spaced out
const SAFETY_MS = 120000; // full refresh of each wallet at least this often
const PAGE = 10; // latest transactions read per wallet
const LIVE_WINDOW_MS = 10 * 60 * 1000; // only fresh trades alert
const MAX_EVENTS = 200;

const FEED_KINDS = new Set(['trade', 'order', 'transfer_in', 'transfer_out', 'ft_in', 'ft_out']);

// Trades, limit orders and real transfers make the feed; payouts, registrations and mentions do not.
// (The feed reads transactions the wallet signed itself, so these are its own moves.)
export function isFeedEvent(a) {
  return !!a && FEED_KINDS.has(a.kind) && a.importance !== 'minor';
}

export class FollowFeed {
  // deps: { listTxs(acc, limit), fetchRaw(acc, rows), viewAccount(acc), analyze(raw, acc),
  //         enrich(analyses), onUpdate(), onNewEvent(ev) }
  constructor(deps) {
    this.deps = deps;
    this.owner = null;
    this.accounts = new Map(); // account -> { sig, lastFull, loaded, known:Set }
    this.events = new Map(); // hash|account -> { account, hash, a, live, seenAt }
    this.turn = 0;
    this.nextDetectAt = 0;
    this.nextInitialAt = 0;
    this.busy = false;
    this.generation = 0;
  }

  setFollows(owner, list) {
    if (owner !== this.owner) {
      this.owner = owner;
      this.accounts.clear();
      this.events.clear();
      this.generation += 1;
      this.busy = false; // a step still in flight belongs to the old owner and no longer clears it
    }
    const wanted = new Set(list.map((x) => x.account));
    for (const acc of [...this.accounts.keys()]) {
      if (!wanted.has(acc)) {
        this.accounts.delete(acc);
        for (const [k, ev] of this.events) if (ev.account === acc) this.events.delete(k);
      }
    }
    for (const acc of wanted) {
      if (!this.accounts.has(acc)) this.accounts.set(acc, { sig: null, lastFull: 0, loaded: false, known: new Set() });
    }
    this.deps.onUpdate();
  }

  get size() {
    return this.accounts.size;
  }

  get loading() {
    return [...this.accounts.values()].some((s) => !s.loaded);
  }

  // Newest first.
  list(limit = 40) {
    return [...this.events.values()].sort((x, y) => y.a.timestampMs - x.a.timestampMs).slice(0, limit);
  }

  // Called by the app's ticker; does at most one network step at a time.
  async tick(now = Date.now()) {
    if (this.busy || !this.accounts.size) return;
    const gen = this.generation;
    this.busy = true;
    try {
      const pending = [...this.accounts.entries()].find(([, s]) => !s.loaded);
      if (pending) {
        if (now < this.nextInitialAt) return;
        this.nextInitialAt = now + INITIAL_EVERY_MS;
        await this.refresh(pending[0], true, gen);
        return;
      }
      if (now < this.nextDetectAt) return;
      this.nextDetectAt = now + DETECT_EVERY_MS;
      const accs = [...this.accounts.keys()];
      const acc = accs[this.turn++ % accs.length];
      const st = this.accounts.get(acc);
      let changed = false;
      try {
        const v = await this.deps.viewAccount(acc);
        const sig = `${v.amount}|${v.locked}|${v.storage_usage}`;
        changed = st.sig !== null && sig !== st.sig;
        st.sig = sig;
      } catch {
        /* RPC hiccup: the safety refresh covers it */
      }
      if (gen !== this.generation) return;
      if (changed || now - st.lastFull > SAFETY_MS) await this.refresh(acc, false, gen);
    } finally {
      if (gen === this.generation) this.busy = false;
    }
  }

  async refresh(acc, initial, gen) {
    const st = this.accounts.get(acc);
    if (!st) return;
    st.lastFull = Date.now();
    try {
      const r = await this.deps.listTxs(acc, PAGE);
      if (gen !== this.generation) return;
      const rows = (r.account_txs || []).filter((row) => !st.known.has(row.transaction_hash));
      if (rows.length) {
        const raws = await this.deps.fetchRaw(acc, rows);
        if (gen !== this.generation || !this.accounts.has(acc)) return;
        const fresh = [];
        for (const raw of raws) {
          const hash = raw.transaction?.hash;
          if (!hash || st.known.has(hash)) continue;
          let a;
          try {
            a = this.deps.analyze(raw, acc);
          } catch {
            continue;
          }
          if (a.pending) continue; // picked up complete on a later refresh
          st.known.add(hash);
          if (!isFeedEvent(a)) continue;
          const live = !initial && Date.now() - a.timestampMs < LIVE_WINDOW_MS;
          const ev = { account: acc, hash, a, live, seenAt: Date.now() };
          this.events.set(`${hash}|${acc}`, ev);
          fresh.push(ev);
        }
        if (fresh.length) await this.deps.enrich(fresh.map((e) => e.a));
        if (gen !== this.generation) return;
        this.trim();
        for (const ev of fresh) if (ev.live) this.deps.onNewEvent(ev);
      }
    } catch {
      /* network error: retried by the next refresh */
    } finally {
      if (st) st.loaded = true;
      if (gen === this.generation) this.deps.onUpdate();
    }
  }

  trim() {
    if (this.events.size <= MAX_EVENTS) return;
    const keep = this.list(MAX_EVENTS);
    const keys = new Set(keep.map((e) => `${e.hash}|${e.account}`));
    for (const k of [...this.events.keys()]) if (!keys.has(k)) this.events.delete(k);
  }
}
