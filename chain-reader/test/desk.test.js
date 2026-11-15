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
  const desk = createDesk({
    env: {
      HELIUS_API_KEY_1: KEY,
      ELITE_SOLANA_RPC_URL: 'https://rpc.example',
    },
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
  const desk = createDesk({ env: { ELITE_SOLANA_RPC_URL: 'https://rpc.example' } });
  await assert.rejects(() => desk.start(), (error) => error.statusCode === 409);
  assert.match(desk.snapshot().error, /kľúče/);
  const server = createServer(desk);
  const port = await listen(server);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Spustiť paper/);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    const json = await status.json();
    assert.equal(json.running, false);
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
