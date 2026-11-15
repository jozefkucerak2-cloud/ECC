'use strict';

const { createRpcClient } = require('./rpc');
const { classifyTrade } = require('./classify');

async function discoverRecentWallets(config, options = {}) {
  const client = options.client || createRpcClient(config, options.fetch);
  const limit = options.limit || config.signatureLimit;
  const params = { limit };
  if (options.before) {
    params.before = options.before;
  }

  const signatures = await client.call('getSignaturesForAddress', [config.programId, params]);
  if (!Array.isArray(signatures)) {
    throw Object.assign(new Error('signature list was not an array'), { category: 'alert' });
  }

  const counts = new Map();
  const trades = [];
  let skipped = 0;
  for (const row of signatures) {
    if (!row || row.err || typeof row.signature !== 'string') {
      skipped += 1;
      continue;
    }
    const tx = await client.call('getTransaction', [
      row.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 },
    ]);
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
    });
  }

  const wallets = [...counts.entries()]
    .map(([address, txCount]) => ({ address, txCount }))
    .sort((a, b) => b.txCount - a.txCount || a.address.localeCompare(b.address));
  const fetched = signatures.length;
  const oldest = signatures.length > 0 ? signatures[signatures.length - 1].signature : null;

  return {
    source: 'solana-rpc',
    programId: config.programId,
    fetchedSignatures: fetched,
    skipped,
    sample: fetched >= config.minCleanSample ? 'ok' : 'insufficient',
    nextCursor: oldest,
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
