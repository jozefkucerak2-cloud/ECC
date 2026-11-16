'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyTrade } = require('../src/classify');
const { emptyLedger, evaluateBook, focusAddress, loadLedger, haltLedger, ordersOnDay, readTarget, releaseLedger, rollCredits, runCycle, summarizePaper, traderLadder, LIMITS } = require('../src/paper/cycle');

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

test('the agent ladder ranks a filling wallet and prices the paper stake at 50 USD', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(4, 'buy') }, NOW, OUR);
  const ladder = traderLadder(opened.ledger, NOW);
  assert.equal(LIMITS.paperUsd, 50);
  assert.equal(ladder.length, 1);
  assert.equal(ladder[0].rank, 1);
  assert.equal(ladder[0].classified, 4);
  assert.equal(ladder[0].need, 30);
  assert.equal(ladder[0].qualified, false);
  assert.equal(ladder[0].stakeUsd, 50);
  assert.equal(ladder[0].reason, 'agenti zbierajú vzorku');
  assert.equal(opened.ledger.mode, 'paper');
});

test('the next agent evaluates who we watch, the transactions, and the dollar result', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(4, 'buy') }, NOW, OUR);
  const early = evaluateBook(opened.ledger, NOW);
  assert.equal(early.watching.length, 1);
  assert.equal(early.watching[0].classified, 4);
  assert.equal(early.watching[0].lastSignature, 'buy-3');
  assert.equal(early.trades.length, 0);
  assert.equal(early.profitUsd, 0);
  assert.equal(early.lossUsd, 0);
  assert.match(early.watching[0].verdict, /ďalší/);
  assert.match(early.verdict, /Sledujeme 1 peňaženku/);
  assert.match(opened.events.find((event) => event.role === 'evaluator').note, /Sledujeme/);

  const review = evaluateBook({
    wallets: {},
    orders: [
      { id: 'a', side: 'buy', source: 'WalletA', mint: 'MintA', account: OUR, entryPrice: 1, stakeUsd: 50, recordedAt: 1 },
      { id: 'stop:a:s', side: 'stop', source: 'WalletA', mint: 'MintA', account: OUR, entryPrice: 1, exitPrice: 0.85, recordedAt: 2 },
      { id: 'b', side: 'buy', source: 'WalletA', mint: 'MintB', account: OUR, entryPrice: 2, stakeUsd: 50, recordedAt: 3 },
      { id: 'c', side: 'sell', source: 'WalletA', mint: 'MintB', account: OUR, entryPrice: 2.2, recordedAt: 4 },
    ],
    positions: [],
  }, NOW);
  assert.equal(review.profitUsd, 5);
  assert.equal(review.lossUsd, -7.5);
  assert.equal(review.netUsd, -2.5);
  assert.match(review.trades.find((trade) => trade.side === 'stop').verdict, /strata/);
  assert.match(review.trades.find((trade) => trade.side === 'sell').verdict, /zisk/);
  assert.match(review.verdict, /Zisk 5 USD/);
  assert.match(review.verdict, /strata 7\.5 USD/);
});

test('profit and loss count every closed trade, including those older than the last twelve rows', () => {
  const orders = [
    { id: 'loss', side: 'buy', source: 'WalletA', mint: 'MintLoss', account: OUR, entryPrice: 1, stakeUsd: 50, recordedAt: 1 },
    { id: 'stop:loss:s', side: 'stop', source: 'WalletA', mint: 'MintLoss', account: OUR, entryPrice: 1, exitPrice: 0.85, recordedAt: 2 },
  ];
  for (let index = 0; index < 12; index += 1) {
    orders.push(
      { id: `buy-${index}`, side: 'buy', source: 'WalletA', mint: `Mint${index}`, account: OUR, entryPrice: 1, stakeUsd: 50, recordedAt: 10 + index * 2 },
      { id: `sell-${index}`, side: 'sell', source: 'WalletA', mint: `Mint${index}`, account: OUR, entryPrice: 1.1, stakeUsd: 50, recordedAt: 11 + index * 2 },
    );
  }
  const ledger = { wallets: {}, orders, positions: [] };
  const summary = summarizePaper(ledger);
  const review = evaluateBook(ledger, NOW);
  assert.equal(summary.rounds.length, 12);
  assert.equal(summary.closed, 13);
  assert.equal(summary.realizedUsd, 52.5);
  assert.equal(summary.profitUsd, 60);
  assert.equal(summary.lossUsd, -7.5);
  assert.equal(review.trades.length, 12);
  assert.equal(review.profitUsd, 60);
  assert.equal(review.lossUsd, -7.5);
  assert.equal(review.netUsd, 52.5);
  assert.match(review.verdict, /Zisk 60 USD, strata 7\.5 USD, čistý 52\.5 USD/);
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
  assert.equal(first.ledger.orders[0].stakeUsd, 50);
  assert.equal(first.ledger.positions[0].stakeUsd, 50);
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
  const stop = closed.ledger.orders.find((order) => order.side === 'stop');
  assert.equal(stop.entryPrice, 1);
  assert.equal(stop.exitPrice, 1 / 1_000_000);
  const summary = summarizePaper(closed.ledger);
  assert.equal(summary.open, 0);
  assert.equal(summary.closed, 1);
  assert.equal(summary.losses, 1);
  assert.ok(summary.realizedBps < 0);
});

test('paper summary sums closed results and keeps the open row', () => {
  const summary = summarizePaper({
    orders: [
      { id: 'A:S:M:buy:sig', account: 'A', source: 'S', mint: 'Mint', side: 'buy', entryPrice: 2, recordedAt: 10 },
      { id: 'stop:A:S:M:buy:sig:exit', account: 'A', source: 'S', mint: 'Mint', side: 'stop', entryPrice: 2, exitPrice: 1.7, recordedAt: 20 },
      { id: 'A:S:N:buy:sig2', account: 'A', source: 'S', mint: 'Next', side: 'buy', entryPrice: 4, stopPrice: 3.4, recordedAt: 30 },
      { id: 'A:S:N:sell:sig3', account: 'A', source: 'S', mint: 'Next', side: 'sell', entryPrice: 4.4, recordedAt: 40 },
    ],
    positions: [],
  });
  assert.equal(summary.realizedBps, -500);
  assert.equal(summary.realizedUsd, -2.5);
  assert.equal(summary.stakeUsd, 50);
  assert.equal(summary.rounds[0].resultUsd, 5);
  assert.equal(summary.rounds[1].resultUsd, -7.5);
  assert.equal(summary.closed, 2);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.open, 0);
  assert.equal(summary.rounds[0].state, 'sell');
  assert.equal(summary.rounds[0].resultBps, 1000);
  assert.equal(summary.rounds[1].state, 'stop');
  assert.equal(summary.rounds[1].resultBps, -1500);
});

test('an unknown signature is remembered so the next poll can walk older history', () => {
  const first = runCycle(emptyLedger(), {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    examined: ['junk', 'buy-0'],
    trades: trades(1, 'buy'),
  }, NOW, OUR);
  assert.equal(first.ledger.wallets.WalletA.classified, 1);
  assert.equal(first.ledger.wallets.WalletA.seen.includes('junk'), false);
  assert.equal(first.ledger.wallets.WalletA.skip.includes('junk'), true);
  const focus = focusAddress(first.ledger, NOW);
  assert.equal(focus.seen.includes('junk'), true);
  assert.equal(focus.before, 'buy-0');
  const again = runCycle(first.ledger, {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    examined: ['junk'],
    trades: [],
  }, NOW, OUR);
  assert.equal(again.ledger.wallets.WalletA.classified, 1);
  assert.equal(focusAddress(again.ledger, NOW).seen.includes('junk'), true);
  assert.equal(focusAddress(again.ledger, NOW).before, 'buy-0');
});

test('a cap of junk signatures still leaves the wallet open for older history', () => {
  const junk = Array.from({ length: LIMITS.seenCap }, (_item, index) => `junk-${index}`);
  const first = runCycle(emptyLedger(), {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    examined: junk.concat(['buy-0']),
    trades: trades(1, 'buy'),
  }, NOW, OUR);
  assert.equal(first.ledger.wallets.WalletA.classified, 1);
  assert.equal(first.ledger.wallets.WalletA.seen.includes('junk-0'), false);
  const focus = focusAddress(first.ledger, NOW);
  assert.equal(focus.address, 'WalletA');
  assert.equal(focus.before, 'buy-0');
  assert.equal(focus.seen.includes('junk-0'), true);
  const older = runCycle(first.ledger, {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    startedBefore: 'buy-0',
    examined: ['older-junk'],
    trades: [],
  }, NOW, OUR);
  const next = focusAddress(older.ledger, NOW);
  assert.equal(older.ledger.wallets.WalletA.classified, 1);
  assert.equal(next.address, 'WalletA');
  assert.equal(next.before, 'older-junk');
  assert.equal(next.seen.includes('junk-0'), true);
});

test('an empty older page ends the wallet walk', () => {
  const started = runCycle(emptyLedger(), {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    examined: ['junk'],
    trades: [],
  }, NOW, OUR);
  const done = runCycle(started.ledger, {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    startedBefore: 'junk',
    examined: [],
    historyDone: true,
    trades: [],
  }, NOW, OUR);
  assert.equal(done.ledger.wallets.WalletA.exhausted, true);
  assert.equal(focusAddress(done.ledger, NOW), null);
});

test('failed signatures in an older walk keep the wallet and move the cursor', () => {
  const started = runCycle(emptyLedger(), {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    examined: ['junk'],
    trades: [],
  }, NOW, OUR);
  const older = runCycle(started.ledger, {
    address: 'WalletA',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    startedBefore: 'junk',
    examined: [],
    resumeBefore: 'failed-oldest',
    historyDone: false,
    trades: [],
  }, NOW, OUR);
  const focus = focusAddress(older.ledger, NOW);
  assert.equal(older.ledger.wallets.WalletA.exhausted, false);
  assert.equal(focus.address, 'WalletA');
  assert.equal(focus.before, 'failed-oldest');
});

test('a dump in the entry block closes even when the book was written later', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(30, 'buy', NOW) }, NOW + 8, OUR);
  assert.equal(opened.ledger.positions[0].entryBlockTime, NOW);
  assert.equal(opened.ledger.positions[0].openedAt, NOW + 8);
  const closed = runCycle(opened.ledger, {
    trades: [{
      signature: 'same-block',
      address: 'WalletB',
      side: 'sell',
      mint: MINT,
      blockTime: NOW,
      solLamports: 1,
      tokenRaw: '1000000',
    }],
  }, NOW + 8, OUR);
  assert.equal(closed.ledger.positions.length, 0);
  assert.equal(closed.ledger.orders.some((order) => order.side === 'stop'), true);
});

test('a dump after the copied swap and before the local write closes the row', () => {
  const opened = runCycle(emptyLedger(), { trades: trades(30, 'buy', NOW) }, NOW + 8, OUR);
  const closed = runCycle(opened.ledger, {
    trades: [{
      signature: 'between',
      address: 'WalletB',
      side: 'sell',
      mint: MINT,
      blockTime: NOW + 2,
      solLamports: 1,
      tokenRaw: '1000000',
    }],
  }, NOW + 8, OUR);
  assert.equal(closed.ledger.positions.length, 0);
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

const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

test('a repeated program tip keeps the signatures already counted', () => {
  const first = runCycle(emptyLedger(), {
    address: PROGRAM,
    programId: PROGRAM,
    examined: ['tip-a', 'tip-b'],
    trades: [],
  }, NOW, OUR);
  assert.deepEqual(first.ledger.programSeen, ['tip-a', 'tip-b']);
  const target = readTarget(first.ledger, NOW, OUR, PROGRAM);
  assert.equal(target.address, PROGRAM);
  assert.equal(target.tip, true);
  assert.equal(target.seen.includes('tip-a'), true);
  assert.equal(target.seen.includes('tip-b'), true);
});

test('there is no read without a public address or while kill holds', () => {
  assert.equal(readTarget(emptyLedger(), NOW, '', PROGRAM), null);
  assert.equal(readTarget(haltLedger(emptyLedger()), NOW, OUR, PROGRAM), null);
});

test('a fresh full sample has no wallet to reread and a stale one is only the tip', () => {
  const full = runCycle(emptyLedger(), { trades: trades(30, 'buy') }, NOW, OUR);
  assert.equal(focusAddress(full.ledger, NOW), null);
  const stale = focusAddress(full.ledger, NOW + 120);
  assert.equal(stale.address, 'WalletA');
  assert.equal(stale.tip, true);
  assert.equal(stale.before, null);
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
