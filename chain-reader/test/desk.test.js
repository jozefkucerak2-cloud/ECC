'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDesk, createServer } = require('../src/serve');

const KEY = 'helius-key-aaaa';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('desk status names keys without revealing them', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const desk = createDesk({
    env: {
      HELIUS_API_KEY_1: KEY,
      ELITE_SOLANA_RPC_URL: 'https://rpc.example',
    },
    paperPath: path.join(directory, 'paper.json'),
  });
  const body = JSON.stringify(desk.snapshot());
  assert.equal(body.includes(KEY), false);
  const status = desk.snapshot();
  assert.deepEqual(status.keys, [true, false, false]);
  assert.equal(status.mode, 'paper');
  assert.equal(status.roles.find((role) => role.id === 'wallet').state, 'nepripojená');
  assert.equal(status.roles.find((role) => role.id === 'executor').state, 'pripravený');
  assert.equal(status.roles.find((role) => role.id === 'skeptic').state, 'pripravený');
});

test('start without keys is refused and the page is served', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const desk = createDesk({
    env: { ELITE_SOLANA_RPC_URL: 'https://rpc.example' },
    paperPath: path.join(directory, 'paper.json'),
  });
  await assert.rejects(() => desk.start(), (error) => error.statusCode === 409);
  assert.match(desk.snapshot().error, /kľúč/);
  const server = createServer(desk);
  const port = await listen(server);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Spustiť paper/);
    assert.match(html, /node chain-reader\/src\/serve\.js/);
    assert.match(html, /127\.0\.0\.1:8787/);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    const json = await status.json();
    assert.equal(json.running, false);
    assert.equal(json.limits.maxOpenPositions, 3);
    assert.equal(json.limits.minTraderSamples, 30);
    assert.equal(json.book.openPositions, 0);
    assert.equal(json.book.ordersToday, 0);
    assert.equal(json.config.ok, true);
    assert.equal(JSON.stringify(json).includes('tvoj-kľúč'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a bad limit stays visible after start fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const desk = createDesk({
    env: {
      HELIUS_API_KEY_1: KEY,
      ELITE_SOLANA_RPC_URL: 'https://rpc.example',
      ELITE_SIGNATURE_LIMIT: '5',
      ELITE_MIN_CLEAN_SAMPLE: '30',
    },
    paperPath: path.join(directory, 'paper.json'),
  });
  await assert.rejects(() => desk.start(), (error) => error.statusCode === 400);
  assert.match(desk.snapshot().error, /minCleanSample/);
  assert.equal(desk.snapshot().running, false);
  assert.equal(JSON.stringify(desk.snapshot()).includes(KEY), false);
});

test('a second start waits until the first loop has stopped', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  let active = 0;
  let peak = 0;
  const desk = createDesk({
    env: {
      HELIUS_API_KEY_1: KEY,
      ELITE_SOLANA_RPC_URL: 'https://rpc.example',
    },
    paperPath: path.join(directory, 'paper.json'),
    createPool: () => ({
      async refreshUsage() {},
      msUntilPoll() {
        return 0;
      },
      async discover() {
        return { trades: [], wallets: [], fetchedSignatures: 0, skipped: 0, sample: 'insufficient' };
      },
    }),
    watch: async (_pool, options) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }
        options.signal.addEventListener('abort', resolve, { once: true });
      });
      active -= 1;
    },
  });
  await desk.start();
  const stopping = desk.halt();
  await desk.start();
  await stopping;
  assert.equal(peak, 1);
  assert.equal(active, 1);
  await desk.halt();
  assert.equal(active, 0);
});

test('an rpc key is stored locally and is absent from the status', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const secretPath = path.join(directory, 'rpc.json');
  const desk = createDesk({
    env: { ELITE_SOLANA_RPC_URL: 'https://rpc.example' },
    paperPath: path.join(directory, 'paper.json'),
    secretPath,
  });
  const project = '11111111-1111-4111-8111-111111111111';
  const body = desk.connectRpc({ key1: KEY, project1: project });
  assert.equal(JSON.stringify(body).includes(KEY), false);
  assert.deepEqual(body.keys, [true, false, false]);
  assert.deepEqual(body.projectIds, [true, false, false]);
  const saved = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  assert.equal(saved.keys[0], KEY);
  const server = createServer(desk);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    const status = await response.json();
    assert.equal(JSON.stringify(status).includes(KEY), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a private key is refused and a public address is kept', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const desk = createDesk({
    env: {},
    paperPath: path.join(directory, 'paper.json'),
    secretPath: path.join(directory, 'rpc.json'),
  });
  const secret = '5'.repeat(88);
  await assert.rejects(() => Promise.resolve().then(() => desk.connectRpc({ key1: secret })), (error) => error.statusCode === 400);
  await assert.rejects(() => Promise.resolve().then(() => desk.connectWallet({ address: secret })), (error) => error.statusCode === 400);
  assert.match(desk.snapshot().error, /verejná adresa/);
  const address = 'So11111111111111111111111111111111111111112';
  const body = desk.connectWallet({ address });
  assert.equal(body.wallet, address);
  assert.equal(body.roles.find((role) => role.id === 'wallet').state, 'pripojená');
  assert.equal(JSON.stringify(body).includes(secret), false);
});

test('a restarted desk still shows kill from the book', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const paperPath = path.join(directory, 'paper.json');
  fs.writeFileSync(paperPath, JSON.stringify({
    version: 1,
    mode: 'live',
    halted: true,
    trades: [],
    orders: [],
    positions: [{
      id: 'kept',
      wallet: 'So11111111111111111111111111111111111111112',
      mint: 'So11111111111111111111111111111111111111112',
      units: 1,
    }],
  }));
  const desk = createDesk({
    env: { HELIUS_API_KEY_1: KEY, ELITE_SOLANA_RPC_URL: 'https://rpc.example' },
    paperPath,
    secretPath: path.join(directory, 'rpc.json'),
    createPool: () => ({
      async refreshUsage() {},
      msUntilPoll() {
        return 0;
      },
      async discover() {
        return { trades: [], wallets: [], fetchedSignatures: 0, skipped: 0, sample: 'insufficient' };
      },
    }),
    watch: (_pool, options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  });
  const before = desk.snapshot();
  assert.equal(before.halted, true);
  assert.equal(before.decision, 'kill drží pozície');
  assert.equal(before.book.openPositions, 1);
  assert.equal(before.roles.find((role) => role.id === 'executor').state, 'drží pozície');
  await desk.start();
  const during = desk.snapshot();
  assert.equal(during.running, true);
  assert.equal(during.halted, true);
  assert.equal(during.roles.find((role) => role.id === 'executor').state, 'drží pozície');
  await desk.halt();
});

test('kill keeps the paper book and does not echo a key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const desk = createDesk({
    env: { HELIUS_API_KEY_1: KEY, ELITE_SOLANA_RPC_URL: 'https://rpc.example' },
    paperPath: path.join(directory, 'paper.json'),
  });
  const server = createServer(desk);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/kill`, { method: 'POST' });
    const body = await response.json();
    assert.equal(body.decision, 'kill drží pozície');
    assert.equal(body.roles.find((role) => role.id === 'executor').state, 'drží pozície');
    assert.equal(JSON.stringify(body).includes(KEY), false);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'paper.json'), 'utf8'));
    assert.equal(saved.mode, 'paper');
    assert.equal(saved.halted, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
