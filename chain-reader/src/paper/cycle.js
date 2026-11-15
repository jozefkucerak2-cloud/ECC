'use strict';

const LIMITS = Object.freeze({
  maxOpenPositions: 3,
  maxOrdersPerDay: 10,
  minTraderSamples: 30,
  maxEventAgeSec: 60,
  paperUnits: 1,
  stopBps: 1500,
  seenCap: 120,
});

const PUBLIC_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function emptyLedger() {
  return {
    version: 2,
    mode: 'paper',
    halted: false,
    wallets: {},
    orders: [],
    positions: [],
    credits: { cycleStartedAt: 0, used: [0, 0, 0] },
    notice: 'Bez nového paper zápisu. Telefón nie je zapojený.',
  };
}

function loadLedger(raw) {
  const source = raw && typeof raw === 'object' ? raw : emptyLedger();
  const wallets = source.wallets && typeof source.wallets === 'object' && !Array.isArray(source.wallets)
    ? normalizeWallets(source.wallets)
    : walletsFromTrades(source.trades);
  return {
    version: 2,
    mode: 'paper',
    halted: Boolean(source.halted),
    wallets,
    orders: Array.isArray(source.orders) ? source.orders.map((order) => ({ ...order })) : [],
    positions: Array.isArray(source.positions) ? source.positions.map((position) => ({ ...position })) : [],
    credits: normalizeCredits(source.credits),
    notice: typeof source.notice === 'string' ? source.notice : emptyLedger().notice,
  };
}

function normalizeCredits(credits) {
  const used = [0, 1, 2].map((index) => {
    const value = credits && Array.isArray(credits.used) ? Number(credits.used[index]) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const started = credits && Number.isFinite(Number(credits.cycleStartedAt)) ? Number(credits.cycleStartedAt) : 0;
  return { cycleStartedAt: started > 0 ? started : 0, used };
}

function rollCredits(credits, nowMs, monthMs) {
  const current = normalizeCredits(credits);
  if (!current.cycleStartedAt) {
    return { cycleStartedAt: nowMs, used: current.used };
  }
  if (nowMs - current.cycleStartedAt >= monthMs) {
    return { cycleStartedAt: nowMs, used: [0, 0, 0] };
  }
  return current;
}

function haltLedger(raw) {
  return { ...loadLedger(raw), halted: true };
}

function releaseLedger(raw) {
  return { ...loadLedger(raw), halted: false, mode: 'paper' };
}

function traderLadder(ledger) {
  return rankWallets(loadLedger(ledger).wallets).slice(0, 5).map((row) => ({
    address: row.address,
    classified: row.classified,
    side: row.last ? row.last.side : null,
    mint: row.last ? row.last.mint : null,
  }));
}

function focusAddress(raw, nowSeconds) {
  const ledger = loadLedger(raw);
  const rows = rankWallets(ledger.wallets);
  const filling = rows.filter((row) => row.classified < LIMITS.minTraderSamples && !row.exhausted);
  if (filling.length > 0) {
    return { address: filling[0].address, seen: skipSet(filling[0]), before: filling[0].cursor };
  }
  const now = Number.isInteger(nowSeconds) ? nowSeconds : 0;
  const stale = rows.filter((row) => row.classified >= LIMITS.minTraderSamples && tradeAge(row.last, now) > LIMITS.maxEventAgeSec);
  if (stale.length > 0) {
    return { address: stale[0].address, seen: skipSet(stale[0]), before: null };
  }
  return null;
}

function runCycle(rawLedger, observation, nowSeconds, account) {
  let ledger = loadLedger(rawLedger);
  const incoming = Array.isArray(observation && observation.trades) ? observation.trades : [];
  const wallets = incoming.reduce((next, trade) => absorb(next, trade), ledger.wallets);
  ledger = { ...ledger, wallets: markExamined(wallets, observation) };
  const best = rankWallets(ledger.wallets)[0] || null;
  const analyst = propose(best);
  const skeptic = review(best, nowSeconds);
  const copy = skeptic.veto ? null : analyst.order;
  const stopped = applyStops(ledger, incoming, nowSeconds);
  ledger = stopped.ledger;
  const risk = govern(copy, ledger, nowSeconds, account);
  const executed = apply(risk, ledger, nowSeconds, account);
  ledger = { ...executed.ledger, notice: noticeFor(stopped.closed, executed) };
  const events = [
    { role: 'reader', note: `${incoming.filter((trade) => trade && (trade.side === 'buy' || trade.side === 'sell')).length} čistých v tomto kole` },
    { role: 'analyst', note: analyst.note },
    { role: 'skeptic', note: skeptic.note },
    { role: 'ceo', note: skeptic.veto ? 'veto platí, limity sa nemenia' : 'návrh ide ďalej bez zmeny limitov' },
    { role: 'risk', note: risk.note },
    { role: 'executor', note: executed.note },
    { role: 'notifier', note: ledger.notice },
  ];
  const decision = stopped.closed ? 'paper stop zatvoril pozíciu v knihe' : (skeptic.veto ? skeptic.note : executed.note);
  return { ledger, events, decision };
}

function walletsFromTrades(trades) {
  return (Array.isArray(trades) ? trades : []).reduce((wallets, trade) => absorb(wallets, trade), {});
}

function normalizeWallets(source) {
  return Object.entries(source).reduce((wallets, [address, row]) => {
    if (!row || typeof row !== 'object') {
      return wallets;
    }
    const seen = Array.isArray(row.seen) ? row.seen.filter((item) => typeof item === 'string').slice(0, LIMITS.seenCap) : [];
    const skip = Array.isArray(row.skip) ? row.skip.filter((item) => typeof item === 'string').slice(0, LIMITS.seenCap) : [];
    const classified = Number.isInteger(row.classified) ? row.classified : seen.length;
    return {
      ...wallets,
      [address]: {
        classified,
        seen,
        skip,
        cursor: typeof row.cursor === 'string' && row.cursor ? row.cursor : null,
        exhausted: Boolean(row.exhausted),
        last: row.last && typeof row.last === 'object' ? { ...row.last } : null,
      },
    };
  }, {});
}

function absorb(wallets, trade) {
  if (!trade || typeof trade.address !== 'string' || typeof trade.signature !== 'string') {
    return wallets;
  }
  if (trade.side !== 'buy' && trade.side !== 'sell') {
    return wallets;
  }
  const prior = wallets[trade.address] || blankWallet();
  if (prior.seen.includes(trade.signature)) {
    return wallets;
  }
  const seen = rememberSignature(prior.seen, trade.signature);
  const last = !prior.last || (trade.blockTime || 0) >= (prior.last.blockTime || 0) ? compactTrade(trade) : prior.last;
  return {
    ...wallets,
    [trade.address]: {
      classified: prior.classified + 1,
      seen,
      skip: prior.skip,
      cursor: prior.cursor,
      exhausted: prior.exhausted,
      last,
    },
  };
}

function blankWallet() {
  return { classified: 0, seen: [], skip: [], cursor: null, exhausted: false, last: null };
}

function markExamined(wallets, observation) {
  if (!observation || typeof observation.address !== 'string' || observation.address === observation.programId) {
    return wallets;
  }
  const examined = Array.isArray(observation.examined)
    ? observation.examined.filter((item) => typeof item === 'string')
    : [];
  const prior = wallets[observation.address] || blankWallet();
  const walkingOlder = typeof observation.startedBefore === 'string' && observation.startedBefore.length > 0;
  const cursor = examined.length > 0 && (!prior.cursor || walkingOlder)
    ? examined[examined.length - 1]
    : prior.cursor;
  return {
    ...wallets,
    [observation.address]: {
      ...prior,
      skip: walkingOlder ? prior.skip : rememberTip(prior.skip, examined),
      cursor,
      exhausted: prior.exhausted || (walkingOlder && examined.length === 0),
    },
  };
}

function rememberTip(skip, examined) {
  const prior = Array.isArray(skip) ? skip : [];
  const known = new Set(prior);
  const fresh = [];
  for (const signature of examined) {
    if (!known.has(signature)) {
      known.add(signature);
      fresh.push(signature);
    }
  }
  return fresh.concat(prior).slice(0, LIMITS.seenCap);
}

function skipSet(row) {
  const skip = Array.isArray(row.skip) ? row.skip : [];
  const seen = Array.isArray(row.seen) ? row.seen : [];
  const known = new Set();
  const merged = [];
  for (const signature of skip.concat(seen)) {
    if (typeof signature === 'string' && !known.has(signature)) {
      known.add(signature);
      merged.push(signature);
    }
  }
  return merged;
}

function rememberSignature(seen, signature) {
  if (seen.length >= LIMITS.seenCap) {
    return seen.slice(seen.length - LIMITS.seenCap + 1).concat(signature);
  }
  return seen.concat(signature);
}

function compactTrade(trade) {
  return {
    signature: trade.signature,
    address: trade.address,
    side: trade.side,
    mint: trade.mint,
    blockTime: trade.blockTime,
    solLamports: Number.isFinite(trade.solLamports) ? trade.solLamports : null,
    tokenRaw: typeof trade.tokenRaw === 'string' ? trade.tokenRaw : null,
  };
}

function rankWallets(wallets) {
  return Object.entries(wallets).map(([address, row]) => ({
    address,
    classified: row.classified,
    seen: row.seen,
    skip: row.skip || [],
    cursor: row.cursor || null,
    exhausted: Boolean(row.exhausted),
    last: row.last,
  })).sort((a, b) => b.classified - a.classified || a.address.localeCompare(b.address));
}

function propose(best) {
  if (!best || best.classified < LIMITS.minTraderSamples || !best.last || !best.last.mint) {
    return { order: null, note: 'menej ako 30 čistých obchodov jedného obchodníka' };
  }
  const last = best.last;
  const entryPrice = priceOf(last);
  const stopPrice = entryPrice == null ? null : entryPrice * (10_000 - LIMITS.stopBps) / 10_000;
  return {
    order: {
      source: last.address,
      mint: last.mint,
      side: last.side,
      signature: last.signature,
      blockTime: last.blockTime,
      units: LIMITS.paperUnits,
      entryPrice,
      stopPrice,
    },
    note: `${last.side} po ${best.classified} čistých obchodoch`,
  };
}

function review(best, nowSeconds) {
  if (!best || best.classified < LIMITS.minTraderSamples) {
    return { veto: true, note: 'veto: vzorka pod 30' };
  }
  const last = best.last;
  if (!last || (last.side !== 'buy' && last.side !== 'sell') || !last.mint) {
    return { veto: true, note: 'veto: smer nie je jasný' };
  }
  if (tradeAge(last, nowSeconds) > LIMITS.maxEventAgeSec) {
    return { veto: true, note: 'veto: udalosť je staršia ako 60 s' };
  }
  if (Number.isInteger(last.blockTime) && Number.isInteger(nowSeconds) && nowSeconds < last.blockTime) {
    return { veto: true, note: 'veto: čas udalosti je v budúcnosti' };
  }
  return { veto: false, note: 'bez veta' };
}

function tradeAge(last, nowSeconds) {
  if (!last || !Number.isInteger(last.blockTime) || !Number.isInteger(nowSeconds)) {
    return Number.POSITIVE_INFINITY;
  }
  return nowSeconds - last.blockTime;
}

function govern(order, ledger, nowSeconds, account) {
  if (!order) {
    return { approved: false, order: null, note: 'bez príkazu' };
  }
  if (!PUBLIC_ADDRESS.test(String(account || ''))) {
    return { approved: false, order: null, note: 'pripoj verejnú adresu' };
  }
  if (ledger.halted) {
    return { approved: false, order: null, note: 'kill drží pozície' };
  }
  const id = orderId(account, order);
  if (ledger.orders.some((item) => item.id === id)) {
    return { approved: false, order: null, note: 'príkaz už je zaznamenaný' };
  }
  if (order.side === 'sell' && !matchingPosition(ledger.positions, account, order)) {
    return { approved: false, order: null, note: 'bez otvorenej pozície' };
  }
  if (order.side === 'buy' && ledger.positions.length >= LIMITS.maxOpenPositions) {
    return { approved: false, order: null, note: 'tri paper pozície sú plné' };
  }
  const today = ordersOnDay(ledger.orders, utcDay(nowSeconds));
  if (today >= LIMITS.maxOrdersPerDay) {
    return { approved: false, order: null, note: 'denný strop 10 paper príkazov' };
  }
  return { approved: true, order: { ...order, id, account }, note: 'paper príkaz povolený' };
}

function apply(risk, ledger, nowSeconds) {
  if (!risk.approved || !risk.order) {
    return { ledger, note: risk.note, opened: false };
  }
  const order = { ...risk.order, recordedAt: nowSeconds, mode: 'paper' };
  const orders = ledger.orders.concat(order);
  let positions = ledger.positions;
  if (order.side === 'buy') {
    positions = positions.concat({
      id: order.id,
      account: order.account,
      source: order.source,
      mint: order.mint,
      units: order.units,
      entryPrice: order.entryPrice,
      stopPrice: order.stopPrice,
      openedAt: nowSeconds,
      entryBlockTime: Number.isInteger(order.blockTime) ? order.blockTime : nowSeconds,
    });
  }
  if (order.side === 'sell') {
    const index = positions.findIndex((position) => matchingPosition([position], order.account, order));
    if (index >= 0) {
      positions = positions.slice(0, index).concat(positions.slice(index + 1));
    }
  }
  return {
    ledger: { ...ledger, mode: 'paper', orders, positions },
    note: `paper ${order.side} zaznamenaný`,
    opened: order.side === 'buy',
  };
}

function applyStops(ledger, trades, nowSeconds) {
  let positions = ledger.positions;
  let orders = ledger.orders;
  let closed = false;
  for (const trade of trades) {
    const price = priceOf(trade);
    if (price == null || typeof trade.mint !== 'string') {
      continue;
    }
    if (trade.side !== 'buy' && trade.side !== 'sell') {
      continue;
    }
    if (!Number.isInteger(trade.blockTime)) {
      continue;
    }
    const hitting = positions.filter((position) => {
      const entry = entryTime(position);
      return position.mint === trade.mint
        && position.stopPrice != null
        && price <= position.stopPrice
        && entry != null
        && trade.blockTime >= entry;
    });
    if (hitting.length === 0) {
      continue;
    }
    closed = true;
    const ids = new Set(hitting.map((position) => position.id));
    positions = positions.filter((position) => !ids.has(position.id));
    orders = orders.concat(hitting.map((position) => ({
      id: `stop:${position.id}:${trade.signature}`,
      account: position.account,
      source: position.source,
      mint: position.mint,
      side: 'stop',
      signature: trade.signature,
      recordedAt: nowSeconds,
      mode: 'paper',
    })));
  }
  return { ledger: { ...ledger, positions, orders }, closed };
}

function entryTime(position) {
  if (Number.isInteger(position.entryBlockTime)) {
    return position.entryBlockTime;
  }
  return Number.isInteger(position.openedAt) ? position.openedAt : null;
}

function noticeFor(closed, executed) {
  if (closed) {
    return 'Stop zatvoril paper pozíciu v knihe. Na sieť nič nešlo. Telefón nie je zapojený.';
  }
  if (executed.opened) {
    return 'Paper buy je na našej adrese. Stop je 15 % pod vstupom. Telefón nie je zapojený.';
  }
  return 'Bez nového paper zápisu. Telefón nie je zapojený.';
}

function matchingPosition(positions, account, order) {
  return positions.some((position) => position.account === account && position.source === order.source && position.mint === order.mint);
}

function orderId(account, order) {
  return `${account}:${order.source}:${order.mint}:${order.side}:${order.signature}`;
}

function priceOf(trade) {
  const sol = Number(trade && trade.solLamports);
  const tokens = Number(trade && trade.tokenRaw);
  if (!Number.isFinite(sol) || !Number.isFinite(tokens) || sol <= 0 || tokens <= 0) {
    return null;
  }
  return sol / tokens;
}

function ordersOnDay(orders, day) {
  return (Array.isArray(orders) ? orders : []).filter((item) => item && item.side !== 'stop' && utcDay(item.recordedAt) === day).length;
}

function utcDay(seconds) {
  if (!Number.isInteger(seconds)) {
    return '';
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

module.exports = {
  LIMITS,
  emptyLedger,
  loadLedger,
  rollCredits,
  haltLedger,
  releaseLedger,
  traderLadder,
  focusAddress,
  ordersOnDay,
  runCycle,
};
