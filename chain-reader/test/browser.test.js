'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBrowserDesk, paceMs } = require('../src/browser-session');

const KEY = 'helius-key-aaaa';

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
  await desk.tick();
  await desk.tick();
  const stopped = await desk.tick();
  assert.deepEqual(seen, [KEY, 'helius-key-bbbb']);
  assert.equal(stopped.error, 'Mesačný strop kľúčov je plný.');
  assert.equal(stopped.running, false);
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
