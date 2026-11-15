'use strict';

const { PUMP_PROGRAM_ID } = require('./config');
const { discoverRecentWallets } = require('./discover');
const { parseHeliusKey } = require('./helius-key');
const { LIMITS, emptyLedger, haltLedger, loadLedger, releaseLedger, runCycle, traderLadder } = require('./paper/cycle');

const POLL_CREDITS = 31;
const USABLE_CREDITS = 950_000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOK_KEY = 'elite-desk-book';

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

function createBrowserDesk(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const storage = options.storage || null;
  const onUpdate = options.onUpdate || (() => {});
  const auto = options.auto !== false;
  const usable = options.usableCredits || USABLE_CREDITS;
  let keys = ['', '', ''];
  let projects = ['', '', ''];
  let wallet = null;
  let ledger = loadStored(storage);
  let running = false;
  let timer = null;
  let cursor = 0;
  let generation = 0;
  let last = null;
  let decision = ledger.halted ? 'kill drží pozície' : 'bez príkazu';
  let error = null;
  const used = [0, 0, 0];

  function snapshot() {
    return {
      mode: 'paper',
      localLoop: true,
      running,
      keys: keys.map(Boolean),
      projectIds: projects.map(Boolean),
      wallet,
      endpoint: 'mainnet.helius-rpc.com',
      last,
      decision,
      halted: ledger.halted,
      error,
      limits: LIMITS,
      config: {
        ok: true,
        signatureLimit: LIMITS.minTraderSamples,
        minCleanSample: LIMITS.minTraderSamples,
        programId: PUMP_PROGRAM_ID,
      },
      book: bookOf(ledger),
      roles: ROLES.map((role) => ({
        ...role,
        state: roleState(role.id, running, ledger.halted, wallet),
        detail: role.id === 'wallet' && wallet
          ? `${shortId(wallet)} · verejná adresa, súkromný kľúč sa neukladá`
          : role.detail,
      })),
    };
  }

  function connectRpc(body) {
    if (running) {
      error = 'Najprv pauza, potom výmena RPC.';
      throw fail(error, 409);
    }
    const source = body && typeof body === 'object' ? body : {};
    const incoming = [1, 2, 3].map((index) => parseHeliusKey(source[`key${index}`]));
    const nextProjects = [1, 2, 3].map((index) => String(source[`project${index}`] || '').trim());
    for (const project of nextProjects) {
      if (project && !PROJECT_UUID.test(project)) {
        error = 'ID projektu má byť UUID.';
        throw fail(error, 400);
      }
    }
    keys = incoming.map((key, index) => key || keys[index] || '');
    projects = nextProjects.map((project, index) => project || projects[index] || '');
    if (!keys.some(Boolean)) {
      error = 'Chýba aspoň jeden Helius kľúč.';
      throw fail(error, 400);
    }
    error = null;
    return snapshot();
  }

  function connectWallet(body) {
    if (body && body.disconnect) {
      wallet = null;
    } else {
      const address = String(body && body.address ? body.address : '').trim();
      if (!PUBLIC_ADDRESS.test(address)) {
        error = 'Povolená je len verejná adresa. Súkromný kľúč sa neprijíma.';
        throw fail(error, 400);
      }
      wallet = address;
    }
    error = null;
    return snapshot();
  }

  async function tick(token = generation) {
    if (token !== generation) {
      return null;
    }
    const slot = pickSlot();
    if (slot < 0) {
      if (token !== generation) {
        return null;
      }
      running = false;
      error = keys.some(Boolean) ? 'Mesačný strop kľúčov je plný.' : 'Chýba aspoň jeden Helius kľúč.';
      return snapshot();
    }
    const result = await discoverRecentWallets({
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(keys[slot])}`,
      timeoutMs: 20_000,
      maxRetries: 1,
      retryBaseMs: 400,
      signatureLimit: 30,
      minCleanSample: 30,
      programId: PUMP_PROGRAM_ID,
    }, { fetch: fetchImpl, limit: 30 });
    if (token !== generation) {
      return null;
    }
    used[slot] += 1 + result.fetchedSignatures;
    const cycle = runCycle(ledger, result, Math.floor(Date.now() / 1000));
    ledger = cycle.ledger;
    decision = cycle.decision;
    last = {
      sample: result.sample,
      walletCount: Array.isArray(result.wallets) ? result.wallets.length : 0,
      fetchedSignatures: result.fetchedSignatures,
      creditsRemaining: usable - used[slot],
    };
    error = null;
    store(storage, ledger);
    return snapshot();
  }

  function readySlots() {
    return keys
      .map((key, index) => (key && used[index] + POLL_CREDITS <= usable ? index : -1))
      .filter((index) => index >= 0);
  }

  function pickSlot() {
    const ready = readySlots();
    if (ready.length === 0) {
      return -1;
    }
    const slot = ready[cursor % ready.length];
    cursor += 1;
    return slot;
  }

  function start() {
    if (running) {
      return snapshot();
    }
    if (!keys.some(Boolean)) {
      error = 'RPC nie je pripojené. Vlož Helius kľúč vľavo.';
      throw fail(error, 409);
    }
    generation += 1;
    running = true;
    error = null;
    if (auto) {
      schedule(0, generation);
    }
    return snapshot();
  }

  function schedule(delay, token) {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      if (token !== generation || !running) {
        return;
      }
      try {
        const next = await tick(token);
        if (next && token === generation && running) {
          onUpdate(next);
        }
      } catch (caught) {
        if (token !== generation) {
          return;
        }
        running = false;
        error = publicRpcError(caught);
        onUpdate(snapshot());
        return;
      }
      if (token === generation && running) {
        schedule(paceMs(Math.max(1, readySlots().length)), token);
      }
    }, delay);
  }

  function halt() {
    generation += 1;
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (error === 'Najprv pauza, potom výmena RPC.') {
      error = null;
    }
    return snapshot();
  }

  function kill() {
    halt();
    ledger = haltLedger(ledger);
    decision = 'kill drží pozície';
    store(storage, ledger);
    return snapshot();
  }

  function release() {
    ledger = releaseLedger(ledger);
    decision = 'kill uvoľnený, pozície ostávajú';
    store(storage, ledger);
    return snapshot();
  }

  async function handle(path, body) {
    if (path === '/api/rpc') return connectRpc(body);
    if (path === '/api/wallet') return connectWallet(body);
    if (path === '/api/start') return start();
    if (path === '/api/stop') return halt();
    if (path === '/api/kill') return kill();
    if (path === '/api/release') return release();
    throw fail('neznáma požiadavka', 404);
  }

  return { snapshot, connectRpc, connectWallet, tick, start, halt, kill, release, handle };
}

function paceMs(keyCount) {
  const perKey = Math.ceil((POLL_CREDITS * MONTH_MS) / USABLE_CREDITS);
  return Math.ceil(perKey / Math.max(1, keyCount));
}

function loadStored(storage) {
  if (!storage) {
    return emptyLedger();
  }
  try {
    return loadLedger(JSON.parse(storage.getItem(BOOK_KEY) || 'null'));
  } catch {
    return emptyLedger();
  }
}

function store(storage, ledger) {
  if (!storage) {
    return;
  }
  const copy = {
    version: 1,
    mode: 'paper',
    halted: ledger.halted,
    trades: ledger.trades,
    orders: ledger.orders,
    positions: ledger.positions,
  };
  storage.setItem(BOOK_KEY, JSON.stringify(copy));
}

function bookOf(ledger) {
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
    ladder: traderLadder(ledger.trades).map((row) => ({
      address: shortId(row.address),
      classified: row.classified,
      need: LIMITS.minTraderSamples,
      side: row.side,
      mint: shortId(row.mint),
    })),
  };
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

function redact(value) {
  return String(value).replace(/api-key=[^&\s'"]+/gi, 'api-key=redacted');
}

function publicRpcError(caught) {
  const message = redact(caught && caught.message ? caught.message : '');
  if (message.includes('401') || message.includes('403')) {
    return 'Helius kľúč bol odmietnutý.';
  }
  return message || 'čítanie zlyhalo';
}

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  createBrowserDesk,
  paceMs,
};
