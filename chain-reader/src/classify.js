'use strict';

function classifyTrade(tx, payer) {
  const blockTime = Number.isInteger(tx && tx.blockTime) ? tx.blockTime : null;
  const meta = tx && tx.meta;
  if (!meta) {
    return { side: 'unknown', mint: null, blockTime };
  }
  const index = accountIndex(tx, payer);
  if (index < 0 || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) {
    return { side: 'unknown', mint: null, blockTime };
  }
  const solDelta = meta.postBalances[index] - meta.preBalances[index];
  const token = tokenDeltaForOwner(meta, payer);
  if (!token) {
    return { side: 'unknown', mint: null, blockTime };
  }
  if (solDelta < 0 && token.delta > 0n) {
    return { side: 'buy', mint: token.mint, blockTime };
  }
  if (solDelta > 0 && token.delta < 0n) {
    return { side: 'sell', mint: token.mint, blockTime };
  }
  return { side: 'unknown', mint: token.mint, blockTime };
}

function accountIndex(tx, payer) {
  const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
  if (!Array.isArray(keys)) {
    return -1;
  }
  return keys.findIndex((key) => key === payer || (key && key.pubkey === payer));
}

function tokenDeltaForOwner(meta, owner) {
  const totals = new Map();
  addTokenSide(totals, meta.preTokenBalances, owner, 'pre');
  addTokenSide(totals, meta.postTokenBalances, owner, 'post');
  let best = null;
  for (const [mint, row] of totals) {
    const delta = row.post - row.pre;
    if (delta === 0n) {
      continue;
    }
    const size = delta < 0n ? -delta : delta;
    if (!best || size > best.size) {
      best = { mint, delta, size };
    }
  }
  return best;
}

function addTokenSide(totals, entries, owner, side) {
  if (!Array.isArray(entries)) {
    return;
  }
  for (const entry of entries) {
    if (!entry || entry.owner !== owner || typeof entry.mint !== 'string') {
      continue;
    }
    const amount = rawAmount(entry);
    if (amount === null) {
      continue;
    }
    const row = totals.get(entry.mint) || { pre: 0n, post: 0n };
    row[side] += amount;
    totals.set(entry.mint, row);
  }
}

function rawAmount(entry) {
  const amount = entry.uiTokenAmount && entry.uiTokenAmount.amount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    return null;
  }
  return BigInt(amount);
}

module.exports = { classifyTrade };
