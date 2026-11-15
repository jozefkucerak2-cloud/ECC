'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { loadConfig } = require('./config');
const { createHeliusPool, watchPool } = require('./helius');
const { LIMITS, emptyLedger, haltLedger, loadLedger, runCycle } = require('./paper/cycle');

const DESK_FILE = path.join(__dirname, '..', 'desk', 'index.html');

const ROLES = Object.freeze([
  { id: 'reader', name: 'Čítač', detail: 'Číta posledných 30 podpisov programu pump a z pohybov zostatkov určí buy alebo sell.' },
  { id: 'analyst', name: 'Analytik', detail: 'Návrh vznikne až keď má jedna peňaženka 30 čistých obchodov.' },
  { id: 'skeptic', name: 'Skeptik', detail: 'Zamietne vzorku pod 30, nejasný smer a udalosť staršiu ako 60 sekúnd.' },
  { id: 'ceo', name: 'CEO', detail: 'Návrh posunie ďalej. Limity nezmení a veto neprepíše.' },
  { id: 'risk', name: 'Risk governor', detail: 'Pustí príkaz len do 3 otvorených pozícií a 10 príkazov za UTC deň.' },
  { id: 'executor', name: 'Executor', detail: 'Zapíše paper príkaz do knihy. Na sieť nič neposiela.' },
  { id: 'notifier', name: 'Hlásenie', detail: 'Posledný riadok je na tejto ploche. Telegram zatiaľ nie je zapojený.' },
  { id: 'wallet', name: 'Phantom', detail: 'Ostáva odpojená. Live podpis nie je v tomto behu.' },
]);

function publicError(error, env) {
  let text = String(error && error.message ? error.message : 'štart zlyhal');
  for (const index of [1, 2, 3]) {
    const secret = env[`HELIUS_API_KEY_${index}`];
    if (secret) {
      text = text.split(String(secret)).join('[redacted]');
    }
  }
  return text;
}

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
  const paperFile = options.paperPath || path.join(__dirname, '..', 'data', 'paper-ledger.json');
  const state = {
    running: false,
    last: null,
    error: null,
    decision: 'bez príkazu',
    events: [],
    halted: false,
    controller: null,
    loop: null,
    token: null,
  };

  function snapshot() {
    return {
      mode: 'paper',
      running: state.running,
      keys: keyPresence(env),
      projectIds: projectPresence(env),
      last: state.last,
      decision: state.decision,
      halted: state.halted,
      error: state.error,
      limits: LIMITS,
      config: publicConfig(env),
      book: bookOf(paperFile),
      roles: ROLES.map((role) => ({
        ...role,
        state: roleState(role.id, state.running, state.halted),
        detail: eventNote(state.events, role.id) || role.detail,
      })),
    };
  }

  async function start() {
    if (state.running) {
      return snapshot();
    }
    if (state.loop) {
      await state.loop;
    }
    if (state.running) {
      return snapshot();
    }
    if (!keyPresence(env).some(Boolean)) {
      state.error = 'Helius kľúče nie sú v prostredí tohto procesu';
      const error = new Error(state.error);
      error.statusCode = 409;
      throw error;
    }
    let config;
    let pool;
    try {
      config = loadConfig(env);
      pool = createPool(env, {
        usagePath: env.HELIUS_USAGE_PATH || path.join(__dirname, '..', 'data', 'helius-usage.json'),
        signatureLimit: config.signatureLimit,
        minCleanSample: config.minCleanSample,
        timeoutMs: config.timeoutMs,
        programId: config.programId,
        fetch: options.fetch,
        now: options.now,
      });
    } catch (error) {
      state.running = false;
      state.error = publicError(error, env);
      const wrapped = new Error(state.error);
      wrapped.statusCode = error.statusCode || (error.name === 'ConfigError' ? 400 : 500);
      throw wrapped;
    }
    const token = Symbol('loop');
    const controller = new AbortController();
    state.token = token;
    state.controller = controller;
    state.running = true;
    state.error = null;
    state.loop = watch(pool, {
      signal: controller.signal,
      onResult(result) {
        if (state.token !== token || controller.signal.aborted) {
          return;
        }
        const cycle = runCycle(readPaper(paperFile), result, Math.floor(Date.now() / 1000));
        writePaper(paperFile, cycle.ledger);
        state.last = publicResult(result);
        state.events = cycle.events;
        state.decision = cycle.decision;
        state.halted = cycle.ledger.halted;
      },
    }).catch((error) => {
      if (state.token !== token) {
        return;
      }
      state.error = publicError(error, env);
    }).finally(() => {
      if (state.token !== token) {
        return;
      }
      state.running = false;
      state.loop = null;
    });
    return snapshot();
  }

  async function halt() {
    const token = state.token;
    if (state.controller) {
      state.controller.abort();
    }
    state.running = false;
    if (state.loop) {
      await state.loop;
    }
    if (state.token === token) {
      state.loop = null;
    }
    return snapshot();
  }

  function kill() {
    const ledger = haltLedger(readPaper(paperFile));
    writePaper(paperFile, ledger);
    state.halted = true;
    state.error = null;
    state.decision = 'kill drží pozície';
    return snapshot();
  }

  return { snapshot, start, halt, kill };
}

function readPaper(file) {
  try {
    return loadLedger(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return emptyLedger();
    }
    throw error;
  }
}

function writePaper(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ledger));
  fs.renameSync(temporary, file);
}

function eventNote(events, roleId) {
  const match = (events || []).find((event) => event.role === roleId);
  return match && match.note ? match.note : '';
}

function publicConfig(env) {
  try {
    const config = loadConfig(env);
    return {
      ok: true,
      signatureLimit: config.signatureLimit,
      minCleanSample: config.minCleanSample,
      programId: config.programId,
    };
  } catch (error) {
    return {
      ok: false,
      signatureLimit: null,
      minCleanSample: null,
      programId: null,
      error: publicError(error, env),
    };
  }
}

function bookOf(file) {
  let ledger;
  try {
    ledger = readPaper(file);
  } catch {
    ledger = emptyLedger();
  }
  const day = new Date().toISOString().slice(0, 10);
  return {
    halted: ledger.halted,
    openPositions: ledger.positions.length,
    ordersToday: ledger.orders.filter((order) => dayOf(order.recordedAt) === day).length,
    ordersTotal: ledger.orders.length,
    trades: ledger.trades.length,
    positions: ledger.positions.slice(-5).map((position) => ({
      wallet: shortId(position.wallet),
      mint: shortId(position.mint),
      units: position.units,
    })),
    recentOrders: ledger.orders.slice(-5).map((order) => ({
      side: order.side,
      wallet: shortId(order.wallet),
      mint: shortId(order.mint),
    })),
  };
}

function dayOf(seconds) {
  if (!Number.isInteger(seconds)) {
    return '';
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 12) {
    return text;
  }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function roleState(id, running, halted) {
  if (id === 'wallet') {
    return 'nepripojená';
  }
  if (halted && id === 'executor') {
    return 'drží pozície';
  }
  return running ? 'beží' : 'pripravený';
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
        sendJson(response, 200, await desk.halt());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/kill') {
        sendJson(response, 200, desk.kill());
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
