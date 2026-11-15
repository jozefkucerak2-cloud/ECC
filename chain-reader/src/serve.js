'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { loadConfig } = require('./config');
const { createHeliusPool, watchPool } = require('./helius');

const DESK_FILE = path.join(__dirname, '..', 'desk', 'index.html');

const ROLES = Object.freeze([
  { id: 'reader', name: 'Čítač', detail: 'Helius, posledné podpisy pump programu' },
  { id: 'analyst', name: 'Analytik', detail: 'Ešte nie je v kóde' },
  { id: 'skeptic', name: 'Skeptik', detail: 'Ešte nie je v kóde' },
  { id: 'ceo', name: 'CEO', detail: 'Ešte nie je v kóde' },
  { id: 'risk', name: 'Risk governor', detail: 'Ešte nie je v kóde' },
  { id: 'executor', name: 'Executor', detail: 'Transakcie sú zakázané' },
  { id: 'notifier', name: 'Telegram', detail: 'Ešte nie je v kóde' },
  { id: 'wallet', name: 'Phantom', detail: 'Peňaženka nie je pripojená' },
]);

function present(value) {
  return Boolean(value && String(value).trim());
}

function keyPresence(env) {
  return [1, 2, 3].map((index) => present(env[`HELIUS_API_KEY_${index}`]));
}

function projectPresence(env) {
  return [1, 2, 3].map((index) => present(env[`HELIUS_PROJECT_ID_${index}`]));
}

function createDesk(options = {}) {
  const env = options.env || process.env;
  const createPool = options.createPool || createHeliusPool;
  const watch = options.watch || watchPool;
  const state = {
    running: false,
    last: null,
    error: null,
    controller: null,
  };

  function snapshot() {
    return {
      mode: 'paper',
      running: state.running,
      keys: keyPresence(env),
      projectIds: projectPresence(env),
      last: state.last,
      error: state.error,
      roles: ROLES.map((role) => ({
        ...role,
        state: roleState(role.id, state.running),
      })),
    };
  }

  async function start() {
    if (state.running) {
      return snapshot();
    }
    if (!keyPresence(env).some(Boolean)) {
      state.error = 'Helius kľúče nie sú v prostredí tohto procesu';
      const error = new Error(state.error);
      error.statusCode = 409;
      throw error;
    }
    const config = loadConfig(env);
    const pool = createPool(env, {
      usagePath: env.HELIUS_USAGE_PATH || path.join(__dirname, '..', 'data', 'helius-usage.json'),
      signatureLimit: config.signatureLimit,
      minCleanSample: config.minCleanSample,
      timeoutMs: config.timeoutMs,
      programId: config.programId,
      fetch: options.fetch,
      now: options.now,
    });
    const signal = { aborted: false };
    state.controller = signal;
    state.running = true;
    state.error = null;
    watch(pool, {
      signal,
      onResult(result) {
        state.last = publicResult(result);
      },
    }).catch((error) => {
      state.running = false;
      state.error = String(error && error.message ? error.message : 'čítanie zlyhalo');
    });
    return snapshot();
  }

  function halt() {
    if (state.controller) {
      state.controller.aborted = true;
    }
    state.running = false;
    return snapshot();
  }

  return { snapshot, start, halt };
}

function roleState(id, running) {
  if (id === 'reader') {
    return running ? 'beží' : 'pripravený';
  }
  if (id === 'executor') {
    return 'vypnutý';
  }
  if (id === 'wallet') {
    return 'nepripojená';
  }
  return 'chýba';
}

function publicResult(result) {
  const totals = result && result.usage && result.usage.totals;
  return {
    fetchedSignatures: result.fetchedSignatures,
    skipped: result.skipped,
    sample: result.sample,
    walletCount: Array.isArray(result.wallets) ? result.wallets.length : 0,
    creditsRemaining: totals ? totals.creditsRemaining : null,
    creditsUsed: totals ? totals.creditsUsed : null,
    calls: totals ? totals.calls : null,
  };
}

function createServer(desk) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(DESK_FILE);
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(html);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, desk.snapshot());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/start') {
        sendJson(response, 200, await desk.start());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        sendJson(response, 200, desk.halt());
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('nenájdené');
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message || 'chyba' });
    }
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function main() {
  const port = Number(process.env.ELITE_DESK_PORT || 8787);
  const server = createServer(createDesk());
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`elite desk http://127.0.0.1:${port}\n`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  ROLES,
  createDesk,
  createServer,
  keyPresence,
};
