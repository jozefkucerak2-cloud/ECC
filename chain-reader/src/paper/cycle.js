'use strict';

const LIMITS = Object.freeze({
  maxOpenPositions: 3,
  maxOrdersPerDay: 10,
  minTraderSamples: 30,
  maxEventAgeSec: 60,
  paperUnits: 1,
});

function emptyLedger() {
  return { version: 1, mode: 'paper', halted: false, trades: [], orders: [], positions: [] };
}

function loadLedger(raw) {
  const source = raw && raw.version === 1 ? raw : emptyLedger();
  return {
    version: 1,
    mode: 'paper',
    halted: Boolean(source.halted),
    trades: Array.isArray(source.trades) ? source.trades.map((trade) => ({ ...trade })) : [],
    orders: Array.isArray(source.orders) ? source.orders.map((order) => ({ ...order })) : [],
    positions: Array.isArray(source.positions) ? source.positions.map((position) => ({ ...position })) : [],
  };
}

function haltLedger(raw) {
  return { ...loadLedger(raw), halted: true };
}

function runCycle(rawLedger, observation, nowSeconds) {
  const ledger = loadLedger(rawLedger);
  ledger.trades = mergeTrades(ledger.trades, observation && observation.trades);
  const best = rankWallets(ledger.trades)[0] || null;
  const analyst = propose(best);
  const skeptic = review(best, nowSeconds);
  const order = skeptic.veto ? null : analyst.order;
  const risk = govern(order, ledger, nowSeconds);
  const executed = apply(risk, ledger, nowSeconds);
  const events = [
    { role: 'reader', note: `${Array.isArray(observation && observation.trades) ? observation.trades.length : 0} záznamov v tomto kole` },
    { role: 'analyst', note: analyst.note },
    { role: 'skeptic', note: skeptic.note },
    { role: 'ceo', note: skeptic.veto ? 'veto platí, limity sa nemenia' : 'návrh ide ďalej bez zmeny limitov' },
    { role: 'risk', note: risk.note },
    { role: 'executor', note: executed.note },
    { role: 'notifier', note: executed.note },
  ];
  return { ledger: executed.ledger, events, decision: skeptic.veto ? skeptic.note : executed.note };
}

function mergeTrades(existing, incoming) {
  const seen = new Set(existing.map((trade) => trade.signature));
  const trades = existing.map((trade) => ({ ...trade }));
  for (const trade of incoming || []) {
    if (!trade || typeof trade.signature !== 'string' || seen.has(trade.signature)) {
      continue;
    }
    seen.add(trade.signature);
    trades.push({ ...trade });
  }
  return trades;
}

function rankWallets(trades) {
  const wallets = new Map();
  for (const trade of trades) {
    if (!trade || typeof trade.address !== 'string') {
      continue;
    }
    const row = wallets.get(trade.address) || { address: trade.address, classified: 0, last: null };
    if (trade.side === 'buy' || trade.side === 'sell') {
      row.classified += 1;
      if (!row.last || (trade.blockTime || 0) >= (row.last.blockTime || 0)) {
        row.last = trade;
      }
    }
    wallets.set(trade.address, row);
  }
  return [...wallets.values()].sort((a, b) => b.classified - a.classified || a.address.localeCompare(b.address));
}

function propose(best) {
  if (!best || best.classified < LIMITS.minTraderSamples || !best.last || !best.last.mint) {
    return { order: null, note: 'menej ako 30 čistých obchodov jedného obchodníka' };
  }
  const last = best.last;
  return {
    order: {
      id: `${last.address}:${last.mint}:${last.side}:${last.signature}`,
      wallet: last.address,
      mint: last.mint,
      side: last.side,
      signature: last.signature,
      blockTime: last.blockTime,
      units: LIMITS.paperUnits,
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
  if (!Number.isInteger(last.blockTime) || !Number.isInteger(nowSeconds) || nowSeconds - last.blockTime > LIMITS.maxEventAgeSec) {
    return { veto: true, note: 'veto: udalosť je staršia ako 60 s' };
  }
  if (nowSeconds < last.blockTime) {
    return { veto: true, note: 'veto: čas udalosti je v budúcnosti' };
  }
  return { veto: false, note: 'bez veta' };
}

function govern(order, ledger, nowSeconds) {
  if (!order) {
    return { approved: false, order: null, note: 'bez príkazu' };
  }
  if (ledger.halted) {
    return { approved: false, order: null, note: 'kill drží pozície' };
  }
  if (ledger.orders.some((item) => item.id === order.id)) {
    return { approved: false, order: null, note: 'príkaz už je zaznamenaný' };
  }
  if (order.side === 'buy' && ledger.positions.length >= LIMITS.maxOpenPositions) {
    return { approved: false, order: null, note: 'tri paper pozície sú plné' };
  }
  const day = utcDay(nowSeconds);
  const today = ledger.orders.filter((item) => utcDay(item.recordedAt) === day).length;
  if (today >= LIMITS.maxOrdersPerDay) {
    return { approved: false, order: null, note: 'denný strop 10 paper príkazov' };
  }
  return { approved: true, order, note: 'paper príkaz povolený' };
}

function apply(risk, ledger, nowSeconds) {
  if (!risk.approved || !risk.order) {
    return { ledger, note: risk.note };
  }
  const order = { ...risk.order, recordedAt: nowSeconds, mode: 'paper' };
  const orders = ledger.orders.concat(order);
  let positions = ledger.positions;
  if (order.side === 'buy') {
    positions = positions.concat({
      id: order.id,
      wallet: order.wallet,
      mint: order.mint,
      units: order.units,
      openedAt: nowSeconds,
    });
  }
  if (order.side === 'sell') {
    const index = positions.findIndex((position) => position.wallet === order.wallet && position.mint === order.mint);
    if (index >= 0) {
      positions = positions.slice(0, index).concat(positions.slice(index + 1));
    }
  }
  return {
    ledger: { ...ledger, mode: 'paper', orders, positions },
    note: `paper ${order.side} zaznamenaný`,
  };
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
  haltLedger,
  runCycle,
};
