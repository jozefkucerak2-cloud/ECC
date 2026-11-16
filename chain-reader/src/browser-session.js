'use strict';

const { PUMP_PROGRAM_ID } = require('./config');
const { discoverRecentWallets } = require('./discover');
const { parseHeliusKey, RPC_KEY } = require('./helius-key');
const { LIMITS, emptyLedger, haltLedger, loadLedger, ordersOnDay, readTarget, releaseLedger, rollCredits, runCycle, summarizePaper, traderLadder } = require('./paper/cycle');

const POLL_CREDITS = 31;
const USABLE_CREDITS = 950_000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOK_KEY = 'elite-desk-book';
const SECRET_KEY = 'elite-desk-secrets';

const ROLES = Object.freeze([
  { id: 'reader', name: 'Čítač', detail: 'Číta len s pripojenou verejnou adresou. Najprv peňaženku pod 30, potom čerstvý signál, inak len nové podpisy špičky programu. Jedno kolo má strop 31 volaní.' },
  { id: 'analyst', name: 'Analytik', detail: 'Návrh vznikne až keď má jedna peňaženka 30 čistých obchodov.' },
  { id: 'skeptic', name: 'Skeptik', detail: 'Zamietne vzorku pod 30, nejasný smer a udalosť staršiu ako 60 sekúnd.' },
  { id: 'ceo', name: 'CEO', detail: 'Návrh posunie ďalej. Limity nezmení a veto neprepíše.' },
  { id: 'risk', name: 'Risk governor', detail: 'Pustí príkaz len na pripojenú verejnú adresu, do 3 pozícií a 10 príkazov za deň. Stop je 15 % pod vstupom.' },
  { id: 'executor', name: 'Executor', detail: 'Zapíše paper príkaz na našu verejnú adresu. Na sieť nič neposiela.' },
  { id: 'notifier', name: 'Hlásenie', detail: 'Samostatný riadok na tejto ploche. Telefón sa zapojí až po zvolení kanála.' },
  { id: 'wallet', name: 'Phantom', detail: 'Ostáva odpojená. Live podpis nie je v tomto behu.' },
]);

function createBrowserDesk(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const storage = options.storage || null;
  const onUpdate = options.onUpdate || (() => {});
  const auto = options.auto !== false;
  const usable = options.usableCredits ?? USABLE_CREDITS;
  const now = options.now || Date.now;
  const secrets = loadSecrets(storage);
  let keys = secrets.keys;
  let projects = secrets.projects;
  let wallet = secrets.wallet;
  let ledger = loadStored(storage);
  let running = false;
  let timer = null;
  let cursor = 0;
  let generation = 0;
  let last = null;
  let decision = ledger.halted ? 'kill drží pozície' : 'bez príkazu';
  let error = null;
  let used = ledger.credits.used.slice();

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
      notice: ledger.notice,
      credits: creditRows(),
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
        detail: roleDetail(role),
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
    saveSecrets(storage, { keys, projects, wallet });
    return snapshot();
  }

  function connectWallet(body) {
    if (body && body.disconnect) {
      wallet = null;
    } else {
      const address = readPublicAddress(body && body.address);
      if (!address) {
        error = 'Povolená je len verejná adresa. Súkromný kľúč sa neprijíma.';
        throw fail(error, 400);
      }
      wallet = address;
    }
    error = null;
    saveSecrets(storage, { keys, projects, wallet });
    return snapshot();
  }

  function roleDetail(role) {
    if (role.id === 'wallet' && wallet) {
      return `${shortId(wallet)} · verejná adresa, súkromný kľúč sa neukladá`;
    }
    if (role.id === 'notifier') {
      return ledger.notice;
    }
    return role.detail;
  }

  function creditRows() {
    return [0, 1, 2].map((index) => ({
      slot: index + 1,
      present: Boolean(keys[index]),
      remaining: keys[index] ? Math.max(0, usable - used[index]) : null,
    }));
  }

  function remember(slot, calls) {
    const next = used.slice();
    next[slot] += calls;
    used = next;
    ledger = {
      ...ledger,
      credits: { ...ledger.credits, used: next },
    };
    store(storage, ledger);
  }

  async function tick(token = generation) {
    if (token !== generation) {
      return null;
    }
    ledger = { ...ledger, credits: rollCredits(ledger.credits, now(), MONTH_MS) };
    used = ledger.credits.used.slice();
    const tried = new Set();
    let limited = false;
    while (tried.size < 3) {
      if (token !== generation) {
        return null;
      }
      const slot = pickSlot(tried);
      if (slot < 0) {
        break;
      }
      tried.add(slot);
      let calls = 0;
      try {
        const target = readTarget(ledger, Math.floor(now() / 1000), wallet, PUMP_PROGRAM_ID);
        if (!target) {
          decision = ledger.halted ? 'kill drží pozície' : 'pripoj verejnú adresu';
          error = null;
          store(storage, ledger);
          return snapshot();
        }
        const result = await discoverRecentWallets({
          rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(keys[slot])}`,
          timeoutMs: 20_000,
          maxRetries: 0,
          retryBaseMs: 0,
          signatureLimit: 30,
          minCleanSample: 30,
          programId: PUMP_PROGRAM_ID,
        }, {
          fetch: async (url, init) => {
            calls += 1;
            const response = await fetchImpl(url, init);
            if (response && response.status === 429) {
              const error = new Error('rpc http 429');
              error.statusCode = 429;
              throw error;
            }
            return response;
          },
          limit: 30,
          budget: POLL_CREDITS,
          address: target.address,
          seen: target.seen,
          before: target.before || undefined,
          tipOnly: target.tip === true,
        });
        remember(slot, calls);
        if (token !== generation) {
          return null;
        }
        const cycle = runCycle(ledger, result, Math.floor(now() / 1000), wallet);
        ledger = { ...cycle.ledger, credits: ledger.credits };
        decision = cycle.decision;
        last = {
          sample: result.sample,
          walletCount: Array.isArray(result.wallets) ? result.wallets.length : 0,
          fetchedSignatures: result.fetchedSignatures,
          creditsRemaining: usable - used[slot],
          focus: target.address === PUMP_PROGRAM_ID ? 'program' : 'peňaženka',
        };
        error = null;
        store(storage, ledger);
        return snapshot();
      } catch (caught) {
        remember(slot, calls || 1);
        if (token !== generation) {
          return null;
        }
        if (caught && (caught.statusCode === 429 || String(caught.message || '').includes('429'))) {
          limited = true;
          continue;
        }
        throw caught;
      }
    }
    if (token !== generation) {
      return null;
    }
    if (!keys.some(Boolean)) {
      running = false;
      error = 'Chýba aspoň jeden Helius kľúč.';
    } else if (readySlots(new Set()).length === 0) {
      running = false;
      error = 'Mesačný strop kľúčov je plný.';
    } else if (limited) {
      error = 'Helius obmedzil tempo. Ďalší kľúč príde v ďalšom kole.';
    }
    store(storage, ledger);
    return snapshot();
  }

  function readySlots(skip) {
    return keys
      .map((key, index) => (key && !skip.has(index) && used[index] + POLL_CREDITS <= usable ? index : -1))
      .filter((index) => index >= 0);
  }

  function pickSlot(skip = new Set()) {
    const ready = readySlots(skip);
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
      error = 'RPC nie je pripojené. Vlož Helius kľúč v kroku 1.';
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
        if (next && token === generation) {
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
        schedule(paceMs(Math.max(1, readySlots(new Set()).length)), token);
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

function secretsForProcess(stored, server) {
  const serverKeys = server && Array.isArray(server.keys) ? server.keys : [];
  if (serverKeys.some(Boolean) || !stored || typeof stored !== 'object') {
    return null;
  }
  const keys = [0, 1, 2].map((index) => {
    const value = Array.isArray(stored.keys) ? String(stored.keys[index] || '') : '';
    return RPC_KEY.test(value) ? value : '';
  });
  if (!keys.some(Boolean)) {
    return null;
  }
  const projects = [0, 1, 2].map((index) => {
    const value = Array.isArray(stored.projects) ? String(stored.projects[index] || '') : '';
    return PROJECT_UUID.test(value) ? value : '';
  });
  const wallet = readPublicAddress(stored.wallet);
  return {
    key1: keys[0],
    key2: keys[1],
    key3: keys[2],
    project1: projects[0],
    project2: projects[1],
    project3: projects[2],
    wallet: wallet || null,
  };
}

function tabHoldsDesk(snapshot) {
  if (!snapshot) {
    return false;
  }
  if (snapshot.running || snapshot.halted) {
    return true;
  }
  const book = snapshot.book || {};
  return (book.openPositions || 0) + (book.ordersTotal || 0) + (book.trades || 0) > 0;
}

function paceMs(keyCount) {
  const perKey = Math.ceil((POLL_CREDITS * MONTH_MS) / USABLE_CREDITS);
  return Math.ceil(perKey / Math.max(1, keyCount));
}

function readPublicAddress(value) {
  const text = String(value || '').replace(/\s+/g, '');
  return PUBLIC_ADDRESS.test(text) ? text : '';
}

function loadSecrets(storage) {
  const empty = { keys: ['', '', ''], projects: ['', '', ''], wallet: null };
  if (!storage) {
    return empty;
  }
  try {
    const raw = JSON.parse(storage.getItem(SECRET_KEY) || 'null');
    if (!raw || typeof raw !== 'object') {
      return empty;
    }
    const keys = [0, 1, 2].map((index) => {
      const value = Array.isArray(raw.keys) ? String(raw.keys[index] || '') : '';
      return RPC_KEY.test(value) ? value : '';
    });
    const projects = [0, 1, 2].map((index) => {
      const value = Array.isArray(raw.projects) ? String(raw.projects[index] || '') : '';
      return PROJECT_UUID.test(value) ? value : '';
    });
    const wallet = readPublicAddress(raw.wallet);
    return { keys, projects, wallet: wallet || null };
  } catch {
    return empty;
  }
}

function saveSecrets(storage, secrets) {
  if (!storage) {
    return;
  }
  storage.setItem(SECRET_KEY, JSON.stringify({
    keys: secrets.keys,
    projects: secrets.projects,
    wallet: secrets.wallet,
  }));
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
    wallets: ledger.wallets,
    orders: ledger.orders,
    positions: ledger.positions,
    credits: ledger.credits,
    programSeen: ledger.programSeen,
    notice: ledger.notice,
  };
  storage.setItem(BOOK_KEY, JSON.stringify(copy));
}

function bookOf(ledger) {
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
    summary: summarizePaper(ledger),
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
  secretsForProcess,
  tabHoldsDesk,
};
