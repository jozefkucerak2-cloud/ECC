'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBrowserDesk, paceMs, tabOwnsLoop } = require('../src/browser-session');

const KEY = 'helius-key-aaaa';
const OUR = 'So11111111111111111111111111111111111111112';

test('one Helius key waits long enough to last the month', () => {
  assert.equal(paceMs(1), 84582);
  assert.equal(paceMs(3), 28194);
});

test('a browser desk accepts a Helius address and does not send a transaction', async () => {
  const methods = [];
  const desk = createBrowserDesk({
    auto: false,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      methods.push(body.method);
      if (body.method === 'getSignaturesForAddress') {
        return json({ result: [] });
      }
      throw new Error(`unexpected ${body.method}`);
    },
  });
  const connected = desk.connectRpc({
    key1: `https://mainnet.helius-rpc.com/?api-key=${KEY}`,
  });
  desk.connectWallet({ address: OUR });
  assert.deepEqual(connected.keys, [true, false, false]);
  assert.equal(JSON.stringify(connected).includes(KEY), false);
  const after = await desk.tick();
  assert.equal(after.last.fetchedSignatures, 0);
  assert.equal(after.last.sample, 'insufficient');
  assert.deepEqual(methods, ['getSignaturesForAddress']);
  assert.equal(methods.includes('sendTransaction'), false);
});

test('a rejected Helius key stops the loop without the key in the error', async () => {
  const updates = [];
  const desk = createBrowserDesk({
    auto: true,
    onUpdate(snapshot) {
      updates.push(snapshot.error);
    },
    fetch: async () => ({ ok: false, status: 401, async json() { return {}; } }),
  });
  desk.connectRpc({ key1: KEY });
  desk.connectWallet({ address: OUR });
  desk.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(updates.at(-1), 'Helius kľúč bol odmietnutý.');
  assert.equal(JSON.stringify(updates).includes(KEY), false);
  desk.halt();
});

test('an exhausted key leaves the next key running', async () => {
  const seen = [];
  const desk = createBrowserDesk({
    auto: false,
    usableCredits: 31,
    fetch: async (url) => {
      seen.push(new URL(url).searchParams.get('api-key'));
      return json({ result: [] });
    },
  });
  desk.connectRpc({ key1: KEY, key2: 'helius-key-bbbb' });
  desk.connectWallet({ address: OUR });
  await desk.tick();
  await desk.tick();
  const stopped = await desk.tick();
  assert.deepEqual(seen, [KEY, 'helius-key-bbbb']);
  assert.equal(stopped.error, 'Mesačný strop kľúčov je plný.');
  assert.equal(stopped.running, false);
});

test('a full month reaches the page and releases start', async () => {
  const updates = [];
  const desk = createBrowserDesk({
    auto: true,
    usableCredits: 30,
    onUpdate(snapshot) {
      updates.push({ running: snapshot.running, error: snapshot.error });
    },
    fetch: async () => {
      throw new Error('rpc by sa nemal volať');
    },
  });
  desk.connectRpc({ key1: KEY });
  desk.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(updates.at(-1), {
    running: false,
    error: 'Mesačný strop kľúčov je plný.',
  });
});

test('a late tick does not stop the loop that started after pause', async () => {
  const pending = [];
  const desk = createBrowserDesk({
    auto: true,
    fetch: () => new Promise((resolve) => {
      pending.push(resolve);
    }),
  });
  desk.connectRpc({ key1: KEY });
  desk.connectWallet({ address: OUR });
  desk.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  desk.halt();
  desk.start();
  pending[0](json({ result: [] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(desk.snapshot().running, true);
  assert.equal(desk.snapshot().decision, 'bez príkazu');
  desk.halt();
});

test('credits stay across a reload and reset when the month turns', async () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  };
  const started = 1_700_000_000_000;
  const desk = createBrowserDesk({
    auto: false,
    storage,
    now: () => started,
    fetch: async () => json({ result: [] }),
  });
  desk.connectRpc({ key1: KEY });
  desk.connectWallet({ address: OUR });
  await desk.tick();
  assert.equal(desk.snapshot().credits[0].remaining, 950_000 - 1);
  const reloaded = createBrowserDesk({
    auto: false,
    storage,
    now: () => started + 1000,
    fetch: async () => json({ result: [] }),
  });
  reloaded.connectRpc({ key1: KEY });
  assert.equal(reloaded.snapshot().credits[0].remaining, 950_000 - 1);
  assert.equal(memory.get('elite-desk-book').includes(KEY), false);
  const month = 30 * 24 * 60 * 60 * 1000;
  const rolled = createBrowserDesk({
    auto: false,
    storage,
    now: () => started + month,
    fetch: async () => json({ result: [] }),
  });
  rolled.connectRpc({ key1: KEY });
  rolled.connectWallet({ address: OUR });
  const after = await rolled.tick();
  assert.equal(after.credits[0].remaining, 950_000 - 1);
});

test('a 429 spends the attempt and the next key continues', async () => {
  const seen = [];
  const desk = createBrowserDesk({
    auto: false,
    fetch: async (url) => {
      const key = new URL(url).searchParams.get('api-key');
      seen.push(key);
      if (key === KEY) {
        return { ok: false, status: 429, async json() { return {}; } };
      }
      return json({ result: [] });
    },
  });
  desk.connectRpc({ key1: KEY, key2: 'helius-key-bbbb' });
  desk.connectWallet({ address: OUR });
  const after = await desk.tick();
  assert.deepEqual(seen, [KEY, 'helius-key-bbbb']);
  assert.equal(after.error, null);
  assert.equal(after.credits[0].remaining, 950_000 - 1);
  assert.equal(after.credits[1].remaining, 950_000 - 1);
});

test('a tick without a public address does not call rpc', async () => {
  let calls = 0;
  const desk = createBrowserDesk({
    auto: false,
    fetch: async () => {
      calls += 1;
      return json({ result: [] });
    },
  });
  desk.connectRpc({ key1: KEY });
  const after = await desk.tick();
  assert.equal(calls, 0);
  assert.match(after.decision, /verejnú adresu/);
});

test('a known program signature is not fetched again', async () => {
  const memory = new Map();
  memory.set('elite-desk-book', JSON.stringify({
    version: 2,
    programSeen: ['old-tip'],
    wallets: {},
  }));
  const storage = {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  };
  const fetched = [];
  const desk = createBrowserDesk({
    auto: false,
    storage,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getSignaturesForAddress') {
        return json({
          result: [
            { signature: 'fresh-tip', err: null },
            { signature: 'old-tip', err: null },
          ],
        });
      }
      fetched.push(body.params[0]);
      return json({ result: { transaction: { message: { accountKeys: ['WalletA'] } } } });
    },
  });
  desk.connectRpc({ key1: KEY });
  desk.connectWallet({ address: OUR });
  await desk.tick();
  assert.deepEqual(fetched, ['fresh-tip']);
});

test('the next poll reads the wallet that is still under 30', async () => {
  const memory = new Map();
  memory.set('elite-desk-book', JSON.stringify({
    version: 2,
    wallets: {
      WalletA: {
        seen: ['s1', 's2', 's3', 's4'],
        last: { signature: 's4', side: 'buy', mint: 'Mint', blockTime: 10 },
      },
    },
  }));
  const storage = {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  };
  const addresses = [];
  const desk = createBrowserDesk({
    auto: false,
    storage,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getSignaturesForAddress') {
        addresses.push(body.params[0]);
      }
      return json({ result: [] });
    },
  });
  desk.connectRpc({ key1: KEY });
  desk.connectWallet({ address: OUR });
  await desk.tick();
  assert.deepEqual(addresses, ['WalletA']);
});

test('a filling wallet asks for signatures older than its cursor', async () => {
  const memory = new Map();
  memory.set('elite-desk-book', JSON.stringify({
    version: 2,
    wallets: {
      WalletA: {
        classified: 4,
        seen: ['t1'],
        skip: ['junk'],
        cursor: 'old-sig',
        last: { signature: 't1', side: 'buy', mint: 'Mint', blockTime: 10 },
      },
    },
  }));
  const storage = {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  };
  const pages = [];
  const desk = createBrowserDesk({
    auto: false,
    storage,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getSignaturesForAddress') {
        pages.push(body.params[1]);
      }
      return json({ result: [] });
    },
  });
  desk.connectRpc({ key1: KEY });
  desk.connectWallet({ address: OUR });
  await desk.tick();
  assert.equal(pages[0].before, 'old-sig');
});

test('a saved key does not keep the tab in front of the local process', () => {
  assert.equal(tabOwnsLoop({ running: false, wallet: OUR, keys: [true, false, false] }), false);
  assert.equal(tabOwnsLoop({ running: true, wallet: null, keys: [false, false, false] }), true);
  assert.equal(tabOwnsLoop(null), false);
});

test('a saved key and address return in the next desk and stay out of the snapshot', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  };
  const desk = createBrowserDesk({ auto: false, storage });
  desk.connectRpc({ key1: `"${KEY}"`, key2: 'api-key=helius-key-bbbb' });
  desk.connectWallet({ address: `  ${OUR}  ` });
  const again = createBrowserDesk({ auto: false, storage });
  const snap = again.snapshot();
  assert.deepEqual(snap.keys, [true, true, false]);
  assert.equal(snap.wallet, OUR);
  assert.equal(JSON.stringify(snap).includes(KEY), false);
  assert.equal((memory.get('elite-desk-book') || '').includes(KEY), false);
  assert.equal(memory.get('elite-desk-secrets').includes(KEY), true);
  const cleared = again.connectWallet({ disconnect: true });
  assert.equal(cleared.wallet, null);
  const restored = createBrowserDesk({ auto: false, storage });
  assert.equal(restored.snapshot().wallet, null);
  assert.deepEqual(restored.snapshot().keys, [true, true, false]);
});

test('a browser desk keeps a public Phantom address', () => {
  const desk = createBrowserDesk({ auto: false });
  const address = 'So11111111111111111111111111111111111111112';
  const body = desk.connectWallet({ address });
  assert.equal(body.wallet, address);
  assert.equal(body.roles.find((role) => role.id === 'wallet').state, 'pripojená');
  assert.match(body.roles.find((role) => role.id === 'wallet').detail, /verejná adresa/);
  const cleared = desk.connectWallet({ disconnect: true });
  assert.equal(cleared.wallet, null);
});

function json(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}
