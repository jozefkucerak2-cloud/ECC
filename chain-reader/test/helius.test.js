'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConfigError } = require('../src/config');
const { createRpcClient } = require('../src/rpc');
const { createHeliusPool, loadHeliusKeys, watchPool } = require('../src/helius');

const KEY_A = 'helius-key-aaaa';
const KEY_B = 'helius-key-bbbb';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('more than three keys is rejected', () => {
  assert.throws(
    () => loadHeliusKeys({ HELIUS_API_KEYS: 'abcdefgh,ijklmnop,qrstuvwx,yzabcdef' }),
    ConfigError,
  );
});

test('transport errors do not keep the api key', async () => {
  const client = createRpcClient({
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${KEY_A}`,
    timeoutMs: 1000,
    maxRetries: 0,
    retryBaseMs: 0,
  }, async () => {
    throw new Error(`network down for api-key=${KEY_A}`);
  });
  await assert.rejects(
    () => client.call('getHealth'),
    (error) => {
      assert.equal(error.message.includes(KEY_A), false);
      assert.match(error.message, /api-key=redacted/);
      return true;
    },
  );
});

test('a 429 on the first key uses the second key', async () => {
  const seen = [];
  const pool = createHeliusPool({
    HELIUS_API_KEY_1: KEY_A,
    HELIUS_API_KEY_2: KEY_B,
  }, {
    now: () => 1_000,
    signatureLimit: 1,
    fetch: async (url) => {
      seen.push(url.includes(KEY_A) ? 'a' : 'b');
      if (url.includes(KEY_A)) {
        return jsonResponse({}, 429);
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: 'ok' });
    },
  });
  const result = await pool.call('getHealth');
  assert.equal(result, 'ok');
  assert.deepEqual(seen, ['a', 'b']);
  const report = pool.status();
  assert.equal(report.keys[0].rateLimits, 1);
  assert.equal(report.keys[1].calls, 1);
  assert.equal(report.keys[1].creditsUsed, 1);
  assert.equal(JSON.stringify(report).includes(KEY_A), false);
  assert.equal(JSON.stringify(report).includes(KEY_B), false);
});

test('the monthly cap stops calls and the ledger survives a restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helius-usage-'));
  const usagePath = path.join(directory, 'usage.json');
  const clock = { t: 5_000 };
  const pool = createHeliusPool({ HELIUS_API_KEY_1: KEY_A }, {
    now: () => clock.t,
    usagePath,
    signatureLimit: 1,
    fetch: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: 'ok' }),
  });
  await pool.call('getSlot');
  const saved = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
  const id = Object.keys(saved.keys)[0];
  saved.keys[id].creditsUsed = 1_000_000;
  saved.keys[id].tokens = 0;
  fs.writeFileSync(usagePath, JSON.stringify(saved));
  const restarted = createHeliusPool({ HELIUS_API_KEY_1: KEY_A }, {
    now: () => clock.t,
    usagePath,
    signatureLimit: 1,
    fetch: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: 'ok' }),
  });
  await assert.rejects(
    () => restarted.call('getSlot'),
    (error) => error.category === 'safe mode',
  );
  assert.equal(restarted.status().totals.creditsRemaining, 0);
});

test('one poll spends 1 credit per signature and per transaction', async () => {
  const pool = createHeliusPool({ HELIUS_API_KEY_1: KEY_A }, {
    now: () => 10_000,
    signatureLimit: 1,
    fetch: async (_url, request) => {
      const body = JSON.parse(request.body);
      if (body.method === 'getSignaturesForAddress') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: [{ signature: 'sig-1', err: null }],
        });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          transaction: { message: { accountKeys: ['WalletA'] } },
        },
      });
    },
  });
  const found = await pool.discover();
  assert.equal(found.wallets[0].address, 'WalletA');
  assert.equal(found.usage.totals.calls, 2);
  assert.equal(found.usage.totals.creditsUsed, 2);
});

test('after the burst the pool waits instead of calling again', async () => {
  let clock = 0;
  let calls = 0;
  const pool = createHeliusPool({ HELIUS_API_KEY_1: KEY_A }, {
    now: () => clock,
    signatureLimit: 1,
    fetch: async () => {
      calls += 1;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: 'ok' });
    },
  });
  for (let i = 0; i < 2; i += 1) {
    await pool.call('getSlot');
  }
  await assert.rejects(
    () => pool.call('getSlot'),
    (error) => error.category === 'retry' && error.details.waitMs > 0,
  );
  assert.equal(calls, 2);
  const signal = { aborted: false };
  const slept = [];
  const done = watchPool(pool, {
    signal,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
      signal.aborted = true;
    },
    onResult() {
      throw new Error('watch should wait before the next poll');
    },
  });
  await done;
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 0);
});

test('usage refresh stores Helius credits and drops the api key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helius-usage-'));
  const usagePath = path.join(directory, 'usage.json');
  const projectId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const pool = createHeliusPool({
    HELIUS_API_KEY_1: KEY_A,
    HELIUS_PROJECT_ID_1: projectId,
  }, {
    now: () => 20_000,
    usagePath,
    signatureLimit: 1,
    fetch: async (url, request) => {
      assert.equal(String(url).includes(KEY_A), false);
      assert.equal(request.headers['X-Api-Key'], KEY_A);
      return jsonResponse({
        creditsRemaining: 999900,
        creditsUsed: 100,
        creditCycle: { start: '2026-11-01', end: '2026-12-01' },
        requests: { rpc: 40 },
      });
    },
  });
  const rows = await pool.refreshUsage();
  assert.equal(rows[0].source, 'helius');
  assert.equal(rows[0].rpcRequests, 40);
  const report = pool.status();
  assert.equal(report.keys[0].creditsUsed, 100);
  assert.equal(report.keys[0].creditsRemaining, 999900);
  assert.equal(report.keys[0].usageSource, 'helius');
  const saved = fs.readFileSync(usagePath, 'utf8');
  assert.equal(saved.includes(KEY_A), false);
  assert.equal(JSON.stringify(report).includes(KEY_A), false);
});
