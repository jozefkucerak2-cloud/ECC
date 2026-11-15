'use strict';

const assert = require('node:assert/strict');
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
  assert.equal(status.roles.find((role) => role.id === 'executor').state, 'vypnutý');
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
    assert.match(html, /Elite/);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    const json = await status.json();
    assert.equal(json.running, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
