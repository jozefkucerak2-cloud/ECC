'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyTrade } = require('../src/classify');
const { emptyLedger, focusAddress, loadLedger, haltLedger, ordersOnDay, releaseLedger, rollCredits, runCycle, LIMITS } = require('../src/paper/cycle');

const NOW = 1_700_000_000;
const MINT = 'Mint111111111111111111111111111111111111111';
const OUR = 'So11111111111111111111111111111111111111112';

function trades(count, side, blockTime = NOW) {
  return Array.from({ length: count }, (_item, index) => ({
    signature: `${side}-${index}`,
    address: 'WalletA',
    side,
    mint: MINT,
    blockTime,
    solLamports: 1_000_000,
    tokenRaw: '1000000',
  }));
}

test('a sol drop and token rise is a buy', () => {
  const trade = classifyTrade({
    blockTime: NOW,
    meta: {
      preBalances: [2_000_000, 0],
      postBalances: [1_000_000, 0],
      preTokenBalances: [],
      postTokenBalances: [{
        owner: 'WalletA',
        mint: MINT,
        uiTokenAmount: { amount: '5' },
      }],
    },
    transaction: { message: { accountKeys: ['WalletA', 'Other'] } },
  }, 'WalletA');
  assert.equal(trade.side, 'buy');
  assert.equal(trade.mint, MINT);
  assert.equal(trade.solLamports, 1_000_000);
  assert.equal(trade.tokenRaw, '5');
});

test('the fee is not counted as the price of the buy', () => {
  const trade = classifyTrade({
    blockTime: NOW,
    meta: {
      fee: 100_000,
      preBalances: [2_000_000, 0],
      postBalances: [900_000, 0],
      preTokenBalances: [],
      postTokenBalances: [{
        owner: 'WalletA',
        mint: MINT,
        uiTokenAmount: { amount: '5' },
      }],
    },
    transaction: { message: { accountKeys: ['WalletA', 'Other'] } },
  }, 'WalletA');
  assert.equal(trade.side, 'buy');
  assert.equal(trade.solLamports, 1_000_000);
});

test('fewer than 30 clean trades produces no order', () => {
  const result = runCycle(emptyLedger(), { trades: trades(29, 'buy') }, NOW);
  assert.equal(result.ledger.orders.length, 0);
  assert.match(result.decision, /30/);
  assert.equal(result.events.find((event) => event.role === 'skeptic').note.startsWith('veto'), true);
});

test('thirty fresh buys become one paper order and a repeat is ignored', () => {
  const first = runCycle(emptyLedger(), { trades: trades(LIMITS.minTraderSamples, 'buy') }, NOW, OUR);
  assert.equal(first.ledger.mode, 'paper');
  assert.equal(first.ledger.orders.length, 1);
  assert.equal(first.ledger.orders[0].account, OUR);
  assert.equal(first.ledger.orders[0].source, 'WalletA');
  assert.equal(first.ledger.positions[0].stopPrice, 0.85);
  assert.equal(first.ledger.positions.length, 1);
  assert.match(first.decision, /paper buy/);
  assert.notEqual(
    first.events.find((event) => event.role === 'notifier').note,
    first.events.find((event) => event.role === 'executor').note,
  );
  const second = runCycle(first.ledger, { trades: trades(LIMITS.minTraderSamples, 'buy') }, NOW, OUR);
  assert.equal(second.ledger.orders.length, 1);
  assert.match(second.decision, /zaznamenan/);
});

test('thirty fresh buys without our address stay out of the book', () => {
  const result = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW);
  assert.equal(result.ledger.orders.length, 0);
  assert.match(result.decision, /verejnú adresu/);
});

test('a stale sample is vetoed and live mode cannot stick', () => {
  const result = runCycle(
    { version: 1, mode: 'live', trades: [], orders: [], positions: [] },
    { trades: trades(30, 'buy', NOW - 120) },
    NOW,
  );
  assert.equal(result.ledger.mode, 'paper');
  assert.equal(result.ledger.orders.length, 0);
  assert.match(result.events.find((event) => event.role === 'skeptic').note, /60/);
  assert.equal(loadLedger({ version: 1, mode: 'live' }).mode, 'paper');
});

test('kill keeps the open position and blocks the next entry', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW, OUR);
  const held = haltLedger(opened.ledger);
  assert.equal(held.positions.length, 1);
  const later = trades(1, 'buy', NOW + 10).map((trade) => ({ ...trade, signature: 'buy-next' }));
  const blocked = runCycle(held, { trades: later }, NOW + 10, OUR);
  assert.equal(blocked.ledger.positions.length, 1);
  assert.equal(blocked.ledger.orders.length, 1);
  assert.match(blocked.decision, /kill/);
  const released = releaseLedger(blocked.ledger);
  assert.equal(released.halted, false);
  assert.equal(released.positions.length, 1);
  assert.equal(released.mode, 'paper');
});

test('a price through the stop closes the paper row and the notice is its own line', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW, OUR);
  const closed = runCycle(opened.ledger, {
    trades: [{
      signature: 'cheap',
      address: 'WalletB',
      side: 'sell',
      mint: MINT,
      blockTime: NOW + 5,
      solLamports: 1,
      tokenRaw: '1000000',
    }],
  }, NOW + 5, OUR);
  assert.equal(closed.ledger.positions.length, 0);
  assert.equal(closed.ledger.orders.some((order) => order.side === 'stop'), true);
  const notifier = closed.events.find((event) => event.role === 'notifier').note;
  const executor = closed.events.find((event) => event.role === 'executor').note;
  assert.match(notifier, /Stop/);
  assert.match(notifier, /Telefón/);
  assert.notEqual(notifier, executor);
});

test('an unknown signature is remembered so the next poll can walk older history', () => {
  const first = runCycle(emptyLedger(), {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    examined: ['junk', 'buy-0'],
    trades: trades(1, 'buy'),
  }, NOW, OUR);
  assert.equal(first.ledger.wallets.WalletA.classified, 1);
  assert.equal(first.ledger.wallets.WalletA.seen.includes('junk'), true);
  const again = runCycle(first.ledger, {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    examined: ['junk'],
    trades: [],
  }, NOW, OUR);
  assert.equal(again.ledger.wallets.WalletA.classified, 1);
  assert.equal(focusAddress(again.ledger, NOW).seen.includes('junk'), true);
});

test('a price from before the entry does not close the paper row', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW, OUR);
  const kept = runCycle(opened.ledger, {
    trades: [{
      signature: 'old-dump',
      address: 'WalletB',
      side: 'sell',
      mint: MINT,
      blockTime: NOW - 30,
      solLamports: 1,
      tokenRaw: '1000000',
    }],
  }, NOW + 5, OUR);
  assert.equal(kept.ledger.positions.length, 1);
  assert.equal(kept.ledger.orders.some((order) => order.side === 'stop'), false);
});

test('a stop fill does not count toward the daily order cap', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW, OUR);
  const closed = runCycle(opened.ledger, {
    trades: [{
      signature: 'cheap',
      address: 'WalletB',
      side: 'sell',
      mint: MINT,
      blockTime: NOW + 5,
      solLamports: 1,
      tokenRaw: '1000000',
    }],
  }, NOW + 5, OUR);
  assert.equal(ordersOnDay(closed.ledger.orders, '2023-11-14'), 1);
});

test('a stored trade list becomes a capped wallet and the next read follows it', () => {
  const loaded = loadLedger({ version: 1, mode: 'live', trades: trades(200, 'buy') });
  assert.equal(loaded.mode, 'paper');
  assert.equal(loaded.wallets.WalletA.seen.length, LIMITS.seenCap);
  assert.equal(loaded.trades, undefined);
  const partial = loadLedger({ version: 1, trades: trades(4, 'buy') });
  assert.equal(focusAddress(partial, NOW).address, 'WalletA');
  const rotated = runCycle(loaded, {
    trades: [{ ...trades(1, 'buy', NOW + 5)[0], signature: 'newer' }],
  }, NOW + 5, OUR);
  assert.equal(rotated.ledger.wallets.WalletA.seen.length, LIMITS.seenCap);
  assert.equal(rotated.ledger.wallets.WalletA.last.signature, 'newer');
  const full = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW, OUR);
  assert.equal(focusAddress(full.ledger, NOW), null);
});

test('the credit cycle resets after 30 days and keeps the key out of the book', () => {
  const month = 30 * 24 * 60 * 60 * 1000;
  const rolled = rollCredits({ cycleStartedAt: 5_000, used: [9, 0, 0] }, 5_000 + month, month);
  assert.deepEqual(rolled.used, [0, 0, 0]);
  assert.equal(JSON.stringify(rolled).includes('helius'), false);
});
