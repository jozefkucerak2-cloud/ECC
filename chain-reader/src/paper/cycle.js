'use strict';

const LIMITS = Object.freeze({
  maxOpenPositions: 3,
  maxOrdersPerDay: 10,
  minTraderSamples: 30,
  maxEventAgeSec: 60,
  paperUnits: 1,
  paperUsd: 50,
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
    programSeen: [],
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
    programSeen: normalizeSignatures(source.programSeen),
    notice: typeof source.notice === 'string' ? source.notice : emptyLedger().notice,
  };
}

function normalizeSignatures(list) {
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(0, LIMITS.seenCap) : [];
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

function traderLadder(ledger, nowSeconds) {
  const now = Number.isInteger(nowSeconds) ? nowSeconds : null;
  return rankWallets(loadLedger(ledger).wallets).slice(0, 8).map((row, index) => {
    const age = now == null || !row.last ? null : tradeAge(row.last, now);
    const fresh = age != null && Number.isFinite(age) && age >= 0 && age <= LIMITS.maxEventAgeSec;
    const qualified = row.classified >= LIMITS.minTraderSamples && fresh && Boolean(row.last && row.last.mint);
    return {
      rank: index + 1,
      address: row.address,
      classified: row.classified,
      need: LIMITS.minTraderSamples,
      side: row.last ? row.last.side : null,
      mint: row.last ? row.last.mint : null,
      lastSignature: row.last ? row.last.signature : null,
      ageSec: age != null && Number.isFinite(age) ? age : null,
      qualified,
      stakeUsd: LIMITS.paperUsd,
      reason: ladderReason(row, fresh),
    };
  });
}

function ladderReason(row, fresh) {
  if (row.classified >= LIMITS.minTraderSamples && fresh) {
    return 'pripravený na paper 50 USD';
  }
  if (row.classified >= LIMITS.minTraderSamples) {
    return 'čaká na čerstvý signál';
  }
  if (row.exhausted) {
    return 'história vyčerpaná pred 30';
  }
  return 'agenti zbierajú vzorku';
}

function focusAddress(raw, nowSeconds) {
  const ledger = loadLedger(raw);
  const rows = rankWallets(ledger.wallets);
  const filling = rows.filter((row) => row.classified < LIMITS.minTraderSamples && !row.exhausted);
  if (filling.length > 0) {
    return { address: filling[0].address, seen: skipSet(filling[0]), before: filling[0].cursor, tip: false };
  }
  const now = Number.isInteger(nowSeconds) ? nowSeconds : 0;
  const stale = rows.filter((row) => row.classified >= LIMITS.minTraderSamples && tradeAge(row.last, now) > LIMITS.maxEventAgeSec);
  if (stale.length > 0) {
    return { address: stale[0].address, seen: skipSet(stale[0]), before: null, tip: true };
  }
  return null;
}

function readTarget(raw, nowSeconds, account, programId) {
  if (!PUBLIC_ADDRESS.test(String(account || ''))) {
    return null;
  }
  const ledger = loadLedger(raw);
  if (ledger.halted) {
    return null;
  }
  const focus = focusAddress(ledger, nowSeconds);
  if (focus) {
    return focus;
  }
  if (typeof programId !== 'string' || programId.length === 0) {
    return null;
  }
  return {
    address: programId,
    seen: ledger.programSeen.slice(),
    before: null,
    tip: true,
  };
}

function runCycle(rawLedger, observation, nowSeconds, account) {
  let ledger = loadLedger(rawLedger);
  const incoming = Array.isArray(observation && observation.trades) ? observation.trades : [];
  const wallets = incoming.reduce((next, trade) => absorb(next, trade), ledger.wallets);
  ledger = {
    ...ledger,
    wallets: markExamined(wallets, observation),
    programSeen: rememberProgram(ledger.programSeen, observation),
  };
  const best = rankWallets(ledger.wallets)[0] || null;
  const analyst = propose(best);
  const skeptic = review(best, nowSeconds);
  const copy = skeptic.veto ? null : analyst.order;
  const stopped = applyStops(ledger, incoming, nowSeconds);
  ledger = stopped.ledger;
  const risk = govern(copy, ledger, nowSeconds, account);
  const executed = apply(risk, ledger, nowSeconds, account);
  ledger = { ...executed.ledger, notice: noticeFor(stopped.closed, executed) };
  const judgement = evaluateBook(ledger, nowSeconds);
  const events = [
    { role: 'reader', note: `${incoming.filter((trade) => trade && (trade.side === 'buy' || trade.side === 'sell')).length} čistých v tomto kole` },
    { role: 'analyst', note: analyst.note },
    { role: 'skeptic', note: skeptic.note },
    { role: 'ceo', note: skeptic.veto ? 'veto platí, limity sa nemenia' : 'návrh ide ďalej bez zmeny limitov' },
    { role: 'risk', note: risk.note },
    { role: 'executor', note: executed.note },
    { role: 'evaluator', note: judgement.verdict },
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
  const resume = typeof observation.resumeBefore === 'string' && observation.resumeBefore
    ? observation.resumeBefore
    : (examined.length > 0 ? examined[examined.length - 1] : null);
  const cursor = resume && (!prior.cursor || walkingOlder) ? resume : prior.cursor;
  return {
    ...wallets,
    [observation.address]: {
      ...prior,
      skip: walkingOlder ? prior.skip : rememberTip(prior.skip, examined),
      cursor,
      exhausted: prior.exhausted || observation.historyDone === true,
    },
  };
}

function rememberProgram(programSeen, observation) {
  if (!observation || typeof observation.address !== 'string' || observation.address !== observation.programId) {
    return Array.isArray(programSeen) ? programSeen : [];
  }
  const examined = Array.isArray(observation.examined)
    ? observation.examined.filter((item) => typeof item === 'string')
    : [];
  return rememberTip(programSeen, examined);
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
      stakeUsd: LIMITS.paperUsd,
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
      stakeUsd: order.stakeUsd,
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
      entryPrice: position.entryPrice,
      exitPrice: price,
      units: position.units,
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

function summarizePaper(ledger) {
  const source = ledger && typeof ledger === 'object' ? ledger : {};
  const orders = Array.isArray(source.orders) ? source.orders : [];
  const open = new Map();
  const rounds = [];
  for (const order of orders) {
    if (!order || typeof order !== 'object') {
      continue;
    }
    if (order.side === 'buy' && order.id) {
      open.set(order.id, order);
      continue;
    }
    if (order.side === 'sell') {
      const entry = [...open.values()].find((item) => item.account === order.account && item.source === order.source && item.mint === order.mint);
      if (entry) {
        open.delete(entry.id);
      }
      rounds.push(closedRound(entry, order, 'sell', finite(order.entryPrice)));
      continue;
    }
    if (order.side !== 'stop' || typeof order.id !== 'string' || !order.id.startsWith('stop:')) {
      continue;
    }
    const positionId = order.id.slice('stop:'.length, order.id.lastIndexOf(':'));
    const entry = open.get(positionId) || null;
    if (entry) {
      open.delete(positionId);
    }
    const exitPrice = finite(order.exitPrice) ?? finite(entry && entry.stopPrice);
    rounds.push(closedRound(entry, order, 'stop', exitPrice));
  }
  for (const position of Array.isArray(source.positions) ? source.positions : []) {
    const stakeUsd = stakeOf(position, null);
    rounds.push({
      id: position.id || '',
      mint: position.mint || '',
      source: position.source || '',
      account: position.account || '',
      entryPrice: finite(position.entryPrice),
      exitPrice: null,
      resultBps: null,
      stakeUsd,
      resultUsd: null,
      state: 'otvorený',
      at: Number.isInteger(position.openedAt) ? position.openedAt : null,
    });
  }
  const scored = rounds.filter((round) => round.state !== 'otvorený' && round.resultBps != null);
  return {
    realizedBps: scored.reduce((sum, round) => sum + round.resultBps, 0),
    realizedUsd: Math.round(scored.reduce((sum, round) => sum + round.resultUsd, 0) * 100) / 100,
    profitUsd: money(scored.reduce((sum, round) => sum + (round.resultUsd > 0 ? round.resultUsd : 0), 0)),
    lossUsd: money(scored.reduce((sum, round) => sum + (round.resultUsd < 0 ? round.resultUsd : 0), 0)),
    stakeUsd: LIMITS.paperUsd,
    closed: scored.length,
    wins: scored.filter((round) => round.resultBps > 0).length,
    losses: scored.filter((round) => round.resultBps < 0).length,
    open: Array.isArray(source.positions) ? source.positions.length : 0,
    rounds: rounds.slice(-12).reverse(),
  };
}

function closedRound(entry, order, state, exitPrice) {
  const entryPrice = finite(entry && entry.entryPrice) ?? finite(order.entryPrice);
  const result = resultBps(entryPrice, exitPrice);
  const stakeUsd = stakeOf(entry, order);
  return {
    id: order.id || '',
    mint: (entry && entry.mint) || order.mint || '',
    source: (entry && entry.source) || order.source || '',
    account: (entry && entry.account) || order.account || '',
    entryPrice,
    exitPrice,
    resultBps: result,
    stakeUsd,
    resultUsd: result == null ? null : Math.round((result / 10_000) * stakeUsd * 100) / 100,
    state,
    at: Number.isInteger(order.recordedAt) ? order.recordedAt : null,
  };
}

function stakeOf(entry, order) {
  const stake = finite(entry && entry.stakeUsd) ?? finite(order && order.stakeUsd) ?? LIMITS.paperUsd;
  return stake > 0 ? stake : LIMITS.paperUsd;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resultBps(entry, exit) {
  if (entry == null || exit == null || entry <= 0) {
    return null;
  }
  return Math.round(((exit - entry) / entry) * 10_000);
}

function evaluateBook(raw, nowSeconds) {
  const ledger = loadLedger(raw);
  const summary = summarizePaper(ledger);
  const watching = traderLadder(ledger, nowSeconds).map((row) => ({
    ...row,
    verdict: watchVerdict(row),
  }));
  const trades = summary.rounds.map((round) => ({
    id: round.id,
    side: round.state === 'otvorený' ? 'buy' : round.state,
    source: round.source,
    mint: round.mint,
    account: round.account,
    stakeUsd: round.stakeUsd,
    entryPrice: round.entryPrice,
    exitPrice: round.exitPrice,
    resultBps: round.resultBps,
    resultUsd: round.resultUsd,
    state: round.state,
    verdict: tradeVerdict(round.state, round.resultUsd),
  }));
  const profitUsd = summary.profitUsd;
  const lossUsd = summary.lossUsd;
  return {
    watching,
    trades,
    profitUsd,
    lossUsd,
    netUsd: summary.realizedUsd,
    wins: summary.wins,
    losses: summary.losses,
    open: summary.open,
    verdict: deskVerdict(watching, summary, profitUsd, lossUsd),
  };
}

function watchVerdict(row) {
  if (row.qualified) {
    return 'pripravený, ďalší môže navrhnúť 50 USD';
  }
  if (row.classified >= LIMITS.minTraderSamples) {
    return 'má 30, ďalší čaká na čerstvý obchod';
  }
  if (row.reason === 'história vyčerpaná pred 30') {
    return 'história nestačila, ďalší ho nekopíruje';
  }
  return 'sledujeme, ďalší vyhodnotí pri 30';
}

function tradeVerdict(state, resultUsd) {
  if (state === 'otvorený') {
    return 'otvorený, ďalší vyhodnotí po uzavretí';
  }
  if (resultUsd == null) {
    return 'bez ceny, ďalší čaká na cenu';
  }
  if (resultUsd > 0) {
    return 'zisk, ďalší ho drží v sledovaní';
  }
  if (resultUsd < 0) {
    return 'strata, ďalší berie stop ako platný';
  }
  return 'nula, ďalší ho necháva v rebríčku';
}

function deskVerdict(watched, summary, profitUsd, lossUsd) {
  if (watched.length === 0 && summary.closed === 0 && summary.open === 0) {
    return 'Rebríček je prázdny. Ďalší vyhodnotí prvý čistý obchod.';
  }
  const lead = watched[0] ? ` Vedie ${watched[0].classified}/${watched[0].need}.` : '';
  return `Sledujeme ${walletCountLabel(watched.length)}.${lead} Zisk ${plainUsd(profitUsd)} USD, strata ${plainUsd(Math.abs(lossUsd))} USD, čistý ${plainUsd(summary.realizedUsd)} USD. Ďalší vyhodnocuje každý uzavretý paper obchod.`;
}

function walletCountLabel(count) {
  if (count === 1) {
    return '1 peňaženku';
  }
  if (count >= 2 && count <= 4) {
    return `${count} peňaženky`;
  }
  return `${count} peňaženiek`;
}

function money(value) {
  return Math.round(value * 100) / 100;
}

function plainUsd(value) {
  const number = Number.isFinite(value) ? value : 0;
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
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
  readTarget,
  ordersOnDay,
  summarizePaper,
  evaluateBook,
  runCycle,
};
