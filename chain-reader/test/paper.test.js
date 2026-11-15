'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyTrade } = require('../src/classify');
const { emptyLedger, loadLedger, haltLedger, releaseLedger, runCycle, LIMITS } = require('../src/paper/cycle');

const NOW = 1_700_000_000;
const MINT = 'Mint111111111111111111111111111111111111111';

function trades(count, side, blockTime = NOW) {
  return Array.from({ length: count }, (_item, index) => ({
    signature: `${side}-${index}`,
    address: 'WalletA',
    side,
    mint: MINT,
    blockTime,
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
});

test('fewer than 30 clean trades produces no order', () => {
  const result = runCycle(emptyLedger(), { trades: trades(29, 'buy') }, NOW);
  assert.equal(result.ledger.orders.length, 0);
  assert.match(result.decision, /30/);
  assert.equal(result.events.find((event) => event.role === 'skeptic').note.startsWith('veto'), true);
});

test('thirty fresh buys become one paper order and a repeat is ignored', () => {
  const first = runCycle(emptyLedger(), { trades: trades(LIMITS.minTraderSamples, 'buy') }, NOW);
  assert.equal(first.ledger.mode, 'paper');
  assert.equal(first.ledger.orders.length, 1);
  assert.equal(first.ledger.positions.length, 1);
  assert.match(first.decision, /paper buy/);
  const second = runCycle(first.ledger, { trades: trades(LIMITS.minTraderSamples, 'buy') }, NOW);
  assert.equal(second.ledger.orders.length, 1);
  assert.match(second.decision, /zaznamenan/);
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
  const opened = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW);
  const held = haltLedger(opened.ledger);
  assert.equal(held.positions.length, 1);
  const later = trades(1, 'buy', NOW + 10).map((trade) => ({ ...trade, signature: 'buy-next' }));
  const blocked = runCycle(held, { trades: opened.ledger.trades.concat(later) }, NOW + 10);
  assert.equal(blocked.ledger.positions.length, 1);
  assert.equal(blocked.ledger.orders.length, 1);
  assert.match(blocked.decision, /kill/);
  const released = releaseLedger(blocked.ledger);
  assert.equal(released.halted, false);
  assert.equal(released.positions.length, 1);
  assert.equal(released.mode, 'paper');
});
