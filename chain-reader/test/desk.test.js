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
    assert.match(html, /tabHoldsDesk/);
    assert.match(html, /secretsForProcess/);
    assert.match(html, /Paper 50 USD/);
    assert.match(html, /node chain-reader\/src\/serve\.js/);
    assert.match(html, /127\.0\.0\.1:8787/);
    const engine = await fetch(`http://127.0.0.1:${port}/engine.js`);
    const script = await engine.text();
    assert.equal(engine.status, 200);
    assert.match(script, /createBrowserDesk/);
    assert.equal(script.includes('sendTransaction'), false);
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

test('a later key keeps the ones already stored', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const secretPath = path.join(directory, 'rpc.json');
  const desk = createDesk({
    env: {},
    paperPath: path.join(directory, 'paper.json'),
    secretPath,
  });
  const project = '11111111-1111-4111-8111-111111111111';
  desk.connectRpc({ key1: KEY, project1: project });
  const body = desk.connectRpc({ key2: 'helius-key-bbbb' });
  assert.deepEqual(body.keys, [true, true, false]);
  assert.deepEqual(body.projectIds, [true, false, false]);
  const saved = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  assert.equal(saved.keys[0], KEY);
  assert.equal(saved.keys[1], 'helius-key-bbbb');
  assert.equal(saved.projects[0], project);
  assert.equal(JSON.stringify(body).includes(KEY), false);
});

test('pause clears the message that asked for a pause', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const desk = createDesk({
    env: { HELIUS_API_KEY_1: KEY, ELITE_SOLANA_RPC_URL: 'https://rpc.example' },
    paperPath: path.join(directory, 'paper.json'),
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
  await desk.start();
  await assert.rejects(() => Promise.resolve().then(() => desk.connectRpc({ key2: 'helius-key-bbbb' })), (error) => error.statusCode === 409);
  assert.match(desk.snapshot().error, /pauza/);
  await desk.halt();
  assert.equal(desk.snapshot().error, null);
  assert.deepEqual(desk.snapshot().keys, [true, false, false]);
});

test('a Helius address is stored as its key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const secretPath = path.join(directory, 'rpc.json');
  const desk = createDesk({
    env: {},
    paperPath: path.join(directory, 'paper.json'),
    secretPath,
  });
  const body = desk.connectRpc({
    key1: `https://mainnet.helius-rpc.com/?api-key=${KEY}`,
  });
  assert.deepEqual(body.keys, [true, false, false]);
  const saved = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  assert.equal(saved.keys[0], KEY);
  assert.equal(JSON.stringify(body).includes(KEY), false);
  assert.equal(JSON.stringify(saved).includes('mainnet.helius-rpc.com'), false);
});

test('a rejected Helius key is named in Slovak and the raw code stays off the page', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const desk = createDesk({
    env: {},
    paperPath: path.join(directory, 'paper.json'),
    secretPath: path.join(directory, 'rpc.json'),
    createPool: () => ({
      async refreshUsage() {},
      msUntilPoll() {
        return 0;
      },
      async discover() {
        throw new Error(`rpc http 401 api-key=${KEY}`);
      },
    }),
    watch: async (pool) => {
      await pool.discover();
    },
  });
  desk.connectRpc({ key1: KEY });
  desk.connectWallet({ address: 'So11111111111111111111111111111111111111112' });
  await desk.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(desk.snapshot().error, 'Helius kľúč bol odmietnutý.');
  assert.equal(desk.snapshot().running, false);
  assert.equal(JSON.stringify(desk.snapshot()).includes(KEY), false);
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

test('the ladder counts clean trades toward 30', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const paperPath = path.join(directory, 'paper.json');
  const address = 'So11111111111111111111111111111111111111112';
  fs.writeFileSync(paperPath, JSON.stringify({
    version: 1,
    mode: 'paper',
    halted: false,
    trades: [0, 1, 2, 3].map((index) => ({
      signature: `sig-${index}`,
      address,
      side: 'buy',
      mint: 'Mint111111111111111111111111111111111111111',
      blockTime: 1000 + index,
    })),
    orders: [],
    positions: [],
  }));
  const desk = createDesk({
    env: {},
    paperPath,
    secretPath: path.join(directory, 'rpc.json'),
  });
  const ladder = desk.snapshot().book.ladder;
  assert.equal(ladder.length, 1);
  assert.equal(ladder[0].classified, 4);
  assert.equal(ladder[0].need, 30);
  assert.equal(ladder[0].side, 'buy');
  assert.equal(JSON.stringify(ladder).includes(address), false);
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
  const released = desk.release();
  assert.equal(released.halted, false);
  assert.equal(released.book.openPositions, 1);
  assert.equal(released.decision, 'kill uvoľnený, pozície ostávajú');
  assert.equal(released.roles.find((role) => role.id === 'executor').state, 'pripravený');
  const saved = JSON.parse(fs.readFileSync(paperPath, 'utf8'));
  assert.equal(saved.halted, false);
  assert.equal(saved.positions.length, 1);
});

test('kill stops the reader and a missing address never calls it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  let calls = 0;
  const desk = createDesk({
    env: { HELIUS_API_KEY_1: KEY, ELITE_SOLANA_RPC_URL: 'https://rpc.example' },
    paperPath: path.join(directory, 'paper.json'),
    createPool: () => ({
      async refreshUsage() {},
      msUntilPoll() {
        return 0;
      },
      async discover() {
        calls += 1;
        return { trades: [], wallets: [], fetchedSignatures: 0, sample: 'insufficient', examined: [] };
      },
    }),
    watch: async (pool, options) => {
      while (!options.signal.aborted) {
        const extra = options.discoverOptions();
        if (!extra || !extra.skip) {
          const result = await pool.discover(extra);
          if (!options.signal.aborted && options.onResult) {
            options.onResult(result);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
  });
  await desk.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 0);
  desk.connectWallet({ address: 'So11111111111111111111111111111111111111112' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(calls >= 1);
  const frozen = calls;
  const killed = await desk.kill();
  assert.equal(killed.running, false);
  assert.equal(killed.halted, true);
  assert.equal(killed.decision, 'kill drží pozície');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, frozen);
});

test('a restarted process keeps the saved Helius key out of the status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-paper-'));
  const paperPath = path.join(directory, 'paper.json');
  const secretPath = path.join(directory, 'rpc.json');
  const first = createDesk({ env: {}, paperPath, secretPath });
  first.connectRpc({ key1: KEY });
  first.connectWallet({ address: 'So11111111111111111111111111111111111111112' });
  const second = createDesk({ env: {}, paperPath, secretPath });
  const snap = second.snapshot();
  assert.deepEqual(snap.keys, [true, false, false]);
  assert.equal(snap.wallet, 'So11111111111111111111111111111111111111112');
  assert.equal(JSON.stringify(snap).includes(KEY), false);
  assert.equal(snap.book.summary.open, 0);
  assert.equal(snap.book.summary.realizedBps, 0);
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
    const blocked = await fetch(`http://127.0.0.1:${port}/api/kill`, { method: 'POST' });
    assert.equal(blocked.status, 403);
    const response = await fetch(`http://127.0.0.1:${port}/api/kill`, {
      method: 'POST',
      headers: { 'x-elite-desk': '1' },
    });
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
