'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { loadConfig } = require('./config');
const { createHeliusPool, watchPool } = require('./helius');
const { parseHeliusKey } = require('./helius-key');
const { LIMITS, emptyLedger, focusAddress, haltLedger, loadLedger, ordersOnDay, releaseLedger, runCycle, traderLadder } = require('./paper/cycle');

const DESK_FILE = path.join(__dirname, '..', 'desk', 'index.html');
const ENGINE_FILE = path.join(__dirname, '..', 'desk', 'engine.js');

const ROLES = Object.freeze([
  { id: 'reader', name: 'Čítač', detail: 'Najprv špička programu, potom vlastné podpisy peňaženky, ktorá ešte nemá 30 čistých obchodov. Jedno kolo má strop 31 volaní.' },
  { id: 'analyst', name: 'Analytik', detail: 'Návrh vznikne až keď má jedna peňaženka 30 čistých obchodov.' },
  { id: 'skeptic', name: 'Skeptik', detail: 'Zamietne vzorku pod 30, nejasný smer a udalosť staršiu ako 60 sekúnd.' },
  { id: 'ceo', name: 'CEO', detail: 'Návrh posunie ďalej. Limity nezmení a veto neprepíše.' },
  { id: 'risk', name: 'Risk governor', detail: 'Pustí príkaz len na pripojenú verejnú adresu, do 3 pozícií a 10 príkazov za deň. Stop je 15 % pod vstupom.' },
  { id: 'executor', name: 'Executor', detail: 'Zapíše paper príkaz na našu verejnú adresu. Na sieť nič neposiela.' },
  { id: 'notifier', name: 'Hlásenie', detail: 'Samostatný riadok na tejto ploche. Telefón sa zapojí až po zvolení kanála.' },
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

function emptySecrets() {
  return { keys: ['', '', ''], projects: ['', '', ''], wallet: null };
}

const PUBLIC_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createDesk(options = {}) {
  const env = options.env || process.env;
  const createPool = options.createPool || createHeliusPool;
  const watch = options.watch || watchPool;
  const paperFile = options.paperPath || path.join(__dirname, '..', 'data', 'paper-ledger.json');
  const secretFile = options.secretPath || null;
  const loaded = secretFile ? readSecrets(secretFile) : emptySecrets();
  const opened = openedLedger(paperFile);
  const state = {
    running: false,
    last: null,
    error: null,
    decision: opened.halted ? 'kill drží pozície' : 'bez príkazu',
    events: [],
    halted: opened.halted,
    controller: null,
    loop: null,
    token: null,
    secrets: loaded,
    wallet: loaded.wallet,
  };

  function runtimeEnv() {
    const next = { ...env };
    for (let index = 1; index <= 3; index += 1) {
      const keyName = `HELIUS_API_KEY_${index}`;
      const projectName = `HELIUS_PROJECT_ID_${index}`;
      if (!present(next[keyName]) && state.secrets.keys[index - 1]) {
        next[keyName] = state.secrets.keys[index - 1];
      }
      if (!present(next[projectName]) && state.secrets.projects[index - 1]) {
        next[projectName] = state.secrets.projects[index - 1];
      }
    }
    return next;
  }

  function snapshot() {
    const current = runtimeEnv();
    return {
      mode: 'paper',
      running: state.running,
      keys: keyPresence(current),
      projectIds: projectPresence(current),
      wallet: state.wallet,
      endpoint: 'mainnet.helius-rpc.com',
      last: state.last,
      decision: state.decision,
      halted: state.halted,
      error: state.error,
      notice: readPaper(paperFile).notice,
      credits: state.last && state.last.credits ? state.last.credits : [],
      limits: LIMITS,
      config: publicConfig(current),
      book: bookOf(paperFile),
      roles: ROLES.map((role) => ({
        ...role,
        state: roleState(role.id, state.running, state.halted, state.wallet),
        detail: walletDetail(role, state.wallet) || eventNote(state.events, role.id) || role.detail,
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
    const current = runtimeEnv();
    if (!keyPresence(current).some(Boolean)) {
      state.error = 'RPC nie je pripojené. Vlož Helius kľúč vľavo.';
      const error = new Error(state.error);
      error.statusCode = 409;
      throw error;
    }
    let config;
    let pool;
    try {
      config = loadConfig(current);
      pool = createPool(current, {
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
      state.error = publicError(error, current);
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
      discoverOptions() {
        const focus = focusAddress(readPaper(paperFile), Math.floor(Date.now() / 1000));
        return focus ? { address: focus.address, seen: focus.seen, before: focus.before || undefined } : {};
      },
      onResult(result) {
        if (state.token !== token || controller.signal.aborted) {
          return;
        }
        const cycle = runCycle(readPaper(paperFile), result, Math.floor(Date.now() / 1000), state.wallet);
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
      state.error = publicError(error, current);
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
    if (state.error === 'Najprv pauza, potom výmena RPC.') {
      state.error = null;
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

  function release() {
    const ledger = releaseLedger(readPaper(paperFile));
    writePaper(paperFile, ledger);
    state.halted = false;
    state.error = null;
    state.decision = 'kill uvoľnený, pozície ostávajú';
    return snapshot();
  }

  function connectRpc(body) {
    if (state.running) {
      state.error = 'Najprv pauza, potom výmena RPC.';
      const error = new Error(state.error);
      error.statusCode = 409;
      throw error;
    }
    let incoming;
    try {
      incoming = normalizeSecrets(body);
    } catch (error) {
      state.error = error.message;
      throw error;
    }
    const next = {
      keys: incoming.keys.map((key, index) => key || state.secrets.keys[index] || ''),
      projects: incoming.projects.map((project, index) => project || state.secrets.projects[index] || ''),
      wallet: state.wallet,
    };
    if (!next.keys.some(Boolean)) {
      state.error = 'Chýba aspoň jeden Helius kľúč.';
      const error = new Error(state.error);
      error.statusCode = 400;
      throw error;
    }
    state.secrets = next;
    if (secretFile) {
      writeSecrets(secretFile, next);
    }
    state.error = null;
    return snapshot();
  }

  function connectWallet(body) {
    if (body && body.disconnect) {
      state.wallet = null;
    } else {
      const address = String(body && body.address || '').trim();
      if (!PUBLIC_ADDRESS.test(address)) {
        state.error = 'Povolená je len verejná adresa. Súkromný kľúč sa neprijíma.';
        const error = new Error(state.error);
        error.statusCode = 400;
        throw error;
      }
      state.wallet = address;
    }
    state.secrets = { ...state.secrets, wallet: state.wallet };
    if (secretFile) {
      writeSecrets(secretFile, state.secrets);
    }
    state.error = null;
    return snapshot();
  }

  return { snapshot, start, halt, kill, release, connectRpc, connectWallet };
}

function openedLedger(file) {
  try {
    return readPaper(file);
  } catch {
    return emptyLedger();
  }
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
    ordersToday: ordersOnDay(ledger.orders, day),
    ordersTotal: ledger.orders.length,
    trades: Object.values(ledger.wallets).reduce((sum, row) => sum + row.classified, 0),
    positions: ledger.positions.slice(-5).map((position) => ({
      wallet: shortId(position.account || position.wallet),
      account: shortId(position.account),
      source: shortId(position.source),
      mint: shortId(position.mint),
      units: position.units,
      stop: position.stopPrice == null ? null : position.stopPrice,
    })),
    recentOrders: ledger.orders.slice(-5).map((order) => ({
      side: order.side,
      wallet: shortId(order.account || order.wallet),
      source: shortId(order.source),
      mint: shortId(order.mint),
    })),
    ladder: traderLadder(ledger).map((row) => ({
      address: shortId(row.address),
      classified: row.classified,
      need: LIMITS.minTraderSamples,
      side: row.side,
      mint: shortId(row.mint),
    })),
  };
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 12) {
    return text;
  }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function normalizeSecrets(body) {
  const source = body && typeof body === 'object' ? body : {};
  const keys = [1, 2, 3].map((index) => cleanField(source[`key${index}`]));
  const projects = [1, 2, 3].map((index) => cleanField(source[`project${index}`]));
  const parsed = keys.map((key) => parseHeliusKey(key));
  keys.splice(0, keys.length, ...parsed);
  for (const project of projects) {
    if (project && !PROJECT_UUID.test(project)) {
      const error = new Error('ID projektu má byť UUID.');
      error.statusCode = 400;
      throw error;
    }
  }
  return { keys, projects, wallet: null };
}

function cleanField(value) {
  return String(value || '').trim();
}

function readSecrets(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const secrets = emptySecrets();
    if (Array.isArray(parsed.keys)) {
      secrets.keys = [0, 1, 2].map((index) => cleanField(parsed.keys[index]));
    }
    if (Array.isArray(parsed.projects)) {
      secrets.projects = [0, 1, 2].map((index) => cleanField(parsed.projects[index]));
    }
    secrets.wallet = PUBLIC_ADDRESS.test(String(parsed.wallet || '')) ? String(parsed.wallet) : null;
    return secrets;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return emptySecrets();
    }
    return emptySecrets();
  }
}

function writeSecrets(file, secrets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const body = JSON.stringify({
    version: 1,
    keys: secrets.keys,
    projects: secrets.projects,
    wallet: secrets.wallet,
  });
  fs.writeFileSync(temporary, body, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function walletDetail(role, wallet) {
  if (role.id !== 'wallet' || !wallet) {
    return '';
  }
  return `${shortId(wallet)} · verejná adresa, súkromný kľúč sa neukladá`;
}

function roleState(id, running, halted, wallet) {
  if (id === 'wallet') {
    return wallet ? 'pripojená' : 'nepripojená';
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
    credits: Array.isArray(result && result.usage && result.usage.keys)
      ? result.usage.keys.map((key, index) => ({
        slot: index + 1,
        present: true,
        remaining: key.creditsRemaining,
      }))
      : [],
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
      if (request.method === 'GET' && url.pathname === '/engine.js') {
        const script = fs.readFileSync(ENGINE_FILE);
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(script);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, desk.snapshot());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/start') {
        assertDesk(request);
        sendJson(response, 200, await desk.start());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        assertDesk(request);
        sendJson(response, 200, await desk.halt());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/kill') {
        assertDesk(request);
        sendJson(response, 200, desk.kill());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/release') {
        assertDesk(request);
        sendJson(response, 200, desk.release());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/rpc') {
        assertDesk(request);
        sendJson(response, 200, desk.connectRpc(await readBody(request)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/wallet') {
        assertDesk(request);
        sendJson(response, 200, desk.connectWallet(await readBody(request)));
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('nenájdené');
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message || 'chyba' });
    }
  });
}

function assertDesk(request) {
  const origin = request.headers.origin;
  if (origin) {
    let hostname = '';
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = '';
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      const error = new Error('RPC a peňaženka sa pripájajú len na lokálnom procese.');
      error.statusCode = 403;
      throw error;
    }
  }
  if (request.headers['x-elite-desk'] !== '1') {
    const error = new Error('požiadavka nemá hlavičku tohto pultu');
    error.statusCode = 403;
    throw error;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        const error = new Error('požiadavka je príliš veľká');
        error.statusCode = 413;
        reject(error);
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        const error = new Error('JSON nie je platný');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
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
  const server = createServer(createDesk({
    secretPath: path.join(__dirname, '..', 'data', 'rpc-session.json'),
  }));
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
