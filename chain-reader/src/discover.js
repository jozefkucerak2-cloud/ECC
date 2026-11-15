'use strict';

const { createRpcClient } = require('./rpc');
const { classifyTrade } = require('./classify');

async function discoverRecentWallets(config, options = {}) {
  const client = options.client || createRpcClient(config, options.fetch);
  const limit = options.limit || config.signatureLimit;
  const address = options.address || config.programId;
  const seen = new Set(Array.isArray(options.seen) ? options.seen : []);
  const budget = Number.isInteger(options.budget) ? options.budget : 1 + limit;
  const counts = new Map();
  const trades = [];
  const examined = [];
  let skipped = 0;
  let fetched = 0;
  let calls = 0;
  let before = options.before || null;
  let cursor = null;

  for (let page = 0; page < 4 && calls < budget; page += 1) {
    const params = { limit };
    if (before) {
      params.before = before;
    }
    const signatures = await client.call('getSignaturesForAddress', [address, params]);
    calls += 1;
    if (!Array.isArray(signatures)) {
      throw Object.assign(new Error('signature list was not an array'), { category: 'alert' });
    }
    fetched += signatures.length;
    cursor = signatures.length > 0 ? signatures[signatures.length - 1].signature : cursor;
    let read = 0;
    for (const row of signatures) {
      if (calls >= budget) {
        break;
      }
      if (!row || row.err || typeof row.signature !== 'string' || seen.has(row.signature)) {
        skipped += 1;
        continue;
      }
      const tx = await client.call('getTransaction', [
        row.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 },
      ]);
      calls += 1;
      read += 1;
      seen.add(row.signature);
      examined.push(row.signature);
      const payer = feePayer(tx);
      if (!payer) {
        skipped += 1;
        continue;
      }
      counts.set(payer, (counts.get(payer) || 0) + 1);
      const trade = classifyTrade(tx, payer);
      trades.push({
        signature: row.signature,
        address: payer,
        side: trade.side,
        mint: trade.mint,
        blockTime: trade.blockTime,
        solLamports: trade.solLamports,
        tokenRaw: trade.tokenRaw,
      });
    }
    if (read > 0 || signatures.length === 0 || !cursor || cursor === before) {
      break;
    }
    before = cursor;
  }

  const wallets = [...counts.entries()]
    .map(([wallet, txCount]) => ({ address: wallet, txCount }))
    .sort((a, b) => b.txCount - a.txCount || a.address.localeCompare(b.address));

  return {
    source: 'solana-rpc',
    programId: config.programId,
    address,
    fetchedSignatures: fetched,
    skipped,
    calls,
    examined,
    sample: fetched >= config.minCleanSample ? 'ok' : 'insufficient',
    nextCursor: cursor,
    wallets,
    trades,
  };
}

function feePayer(tx) {
  const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return null;
  }
  const first = keys[0];
  if (typeof first === 'string') {
    return first;
  }
  if (first && first.signer === true && typeof first.pubkey === 'string') {
    return first.pubkey;
  }
  return null;
}

module.exports = {
  discoverRecentWallets,
  feePayer,
};
