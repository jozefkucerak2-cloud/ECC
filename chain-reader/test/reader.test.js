'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig, ConfigError } = require('../src/config');
const { createRpcClient, RpcError } = require('../src/rpc');
const { discoverRecentWallets, feePayer } = require('../src/discover');

function baseEnv(extra = {}) {
  return {
    ELITE_SOLANA_RPC_URL: 'https://rpc.example',
    ELITE_RPC_TIMEOUT_MS: '1000',
    ELITE_RPC_MAX_RETRIES: '1',
    ELITE_RPC_RETRY_BASE_MS: '0',
    ELITE_SIGNATURE_LIMIT: '5',
    ELITE_MIN_CLEAN_SAMPLE: '5',
    ELITE_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    ...extra,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('invalid rpc url refuses to start', () => {
  assert.throws(() => loadConfig(baseEnv({ ELITE_SOLANA_RPC_URL: 'not a url' })), ConfigError);
});

test('signature limit above 100 refuses to start', () => {
  assert.throws(() => loadConfig(baseEnv({ ELITE_SIGNATURE_LIMIT: '101' })), ConfigError);
});

test('sample size cannot exceed one page', () => {
  assert.throws(() => loadConfig(baseEnv({ ELITE_MIN_CLEAN_SAMPLE: '30' })), ConfigError);
});

test('defaults fit one sufficient page', () => {
  const config = loadConfig({ ELITE_SOLANA_RPC_URL: 'https://rpc.example' });
  assert.equal(config.signatureLimit, 30);
  assert.equal(config.minCleanSample, 30);
});

test('send transaction is rejected before any request', async () => {
  let calls = 0;
  const client = createRpcClient(loadConfig(baseEnv()), async () => {
    calls += 1;
    return jsonResponse({ result: null });
  });
  await assert.rejects(() => client.call('sendTransaction', []), RpcError);
  assert.equal(calls, 0);
});

test('429 is retried once and then returns the slot', async () => {
  const calls = [];
  const client = createRpcClient(loadConfig(baseEnv()), async (_url, init) => {
    calls.push(JSON.parse(init.body).method);
    if (calls.length === 1) {
      return jsonResponse({}, 429);
    }
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: 10 });
  });
  const slot = await client.call('getSlot');
  assert.equal(slot, 10);
  assert.deepEqual(calls, ['getSlot', 'getSlot']);
});

test('failed signature is skipped and fee payers are counted', async () => {
  const config = loadConfig(baseEnv({ ELITE_MIN_CLEAN_SAMPLE: '4' }));
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body.method);
    if (body.method === 'getSignaturesForAddress') {
      return jsonResponse({
        result: [
          { signature: 'sig-ok', err: null },
          { signature: 'sig-bad', err: { InstructionError: [0, 'x'] } },
          { signature: 'sig-ok-2', err: null },
        ],
      });
    }
    const signature = body.params[0];
    const pubkey = signature === 'sig-ok' ? 'WalletA' : 'WalletA';
    return jsonResponse({
      result: {
        transaction: {
          message: { accountKeys: [{ pubkey, signer: true, writable: true }] },
        },
      },
    });
  };
  const found = await discoverRecentWallets(config, { fetch: fetchImpl });
  assert.equal(found.fetchedSignatures, 3);
  assert.equal(found.skipped, 1);
  assert.equal(found.sample, 'insufficient');
  assert.deepEqual(found.wallets, [{ address: 'WalletA', txCount: 2 }]);
  assert.equal(found.nextCursor, 'sig-ok-2');
  assert.ok(!requests.includes('sendTransaction'));
});

test('a wallet page skips a signature that was already counted', async () => {
  const methods = [];
  const addresses = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    methods.push(body.method);
    if (body.method === 'getSignaturesForAddress') {
      addresses.push(body.params[0]);
      return jsonResponse({
        result: [
          { signature: 'known', err: null },
          { signature: 'fresh', err: null },
        ],
      });
    }
    assert.equal(body.params[0], 'fresh');
    return jsonResponse({
      result: { transaction: { message: { accountKeys: ['WalletA'] } } },
    });
  };
  const found = await discoverRecentWallets(loadConfig(baseEnv()), {
    fetch: fetchImpl,
    address: 'WalletA',
    seen: ['known'],
    budget: 31,
  });
  assert.deepEqual(addresses, ['WalletA']);
  assert.deepEqual(methods, ['getSignaturesForAddress', 'getTransaction']);
  assert.equal(found.calls, 2);
  assert.equal(found.trades[0].signature, 'fresh');
});

test('a page of already seen signatures walks to the older page', async () => {
  const fetched = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'getSignaturesForAddress') {
      if (body.params[1] && body.params[1].before === 'known') {
        return jsonResponse({ result: [{ signature: 'older', err: null }] });
      }
      return jsonResponse({ result: [{ signature: 'known', err: null }] });
    }
    fetched.push(body.params[0]);
    return jsonResponse({
      result: { transaction: { message: { accountKeys: ['WalletA'] } } },
    });
  };
  const found = await discoverRecentWallets(loadConfig(baseEnv()), {
    fetch: fetchImpl,
    address: 'WalletA',
    seen: ['known'],
    budget: 31,
  });
  assert.deepEqual(fetched, ['older']);
  assert.equal(found.examined.includes('older'), true);
  assert.equal(found.examined.includes('known'), false);
  assert.equal(found.startedBefore, null);
});

test('fee payer accepts a legacy string account key', () => {
  assert.equal(feePayer({
    transaction: { message: { accountKeys: ['LegacyPayer'] } },
  }), 'LegacyPayer');
  assert.equal(feePayer({ transaction: { message: { accountKeys: [{ pubkey: 'X', signer: false }] } } }), null);
});
