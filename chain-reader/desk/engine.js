"use strict";
var EliteEngine = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // chain-reader/src/config.js
  var require_config = __commonJS({
    "chain-reader/src/config.js"(exports, module) {
      "use strict";
      var PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
      var DEFAULTS = Object.freeze({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        timeoutMs: 1e4,
        maxRetries: 2,
        retryBaseMs: 400,
        signatureLimit: 30,
        minCleanSample: 30,
        programId: PUMP_PROGRAM_ID
      });
      function readNumber(raw, fallback, name) {
        if (raw === void 0 || raw === "") {
          return fallback;
        }
        const value = Number(raw);
        if (!Number.isInteger(value)) {
          throw new ConfigError(`${name} must be an integer`);
        }
        return value;
      }
      function loadConfig(env = process.env) {
        const config = {
          rpcUrl: env.ELITE_SOLANA_RPC_URL || DEFAULTS.rpcUrl,
          timeoutMs: readNumber(env.ELITE_RPC_TIMEOUT_MS, DEFAULTS.timeoutMs, "ELITE_RPC_TIMEOUT_MS"),
          maxRetries: readNumber(env.ELITE_RPC_MAX_RETRIES, DEFAULTS.maxRetries, "ELITE_RPC_MAX_RETRIES"),
          retryBaseMs: readNumber(env.ELITE_RPC_RETRY_BASE_MS, DEFAULTS.retryBaseMs, "ELITE_RPC_RETRY_BASE_MS"),
          signatureLimit: readNumber(env.ELITE_SIGNATURE_LIMIT, DEFAULTS.signatureLimit, "ELITE_SIGNATURE_LIMIT"),
          minCleanSample: readNumber(env.ELITE_MIN_CLEAN_SAMPLE, DEFAULTS.minCleanSample, "ELITE_MIN_CLEAN_SAMPLE"),
          programId: env.ELITE_PROGRAM_ID || DEFAULTS.programId
        };
        validateConfig(config);
        return Object.freeze(config);
      }
      function validateConfig(config) {
        let url;
        try {
          url = new URL(config.rpcUrl);
        } catch {
          throw new ConfigError("rpcUrl must be an http(s) URL");
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new ConfigError("rpcUrl must be an http(s) URL");
        }
        if (config.timeoutMs < 1 || config.timeoutMs > 6e4) {
          throw new ConfigError("timeoutMs must be from 1 to 60000");
        }
        if (config.maxRetries < 0 || config.maxRetries > 5) {
          throw new ConfigError("maxRetries must be from 0 to 5");
        }
        if (config.retryBaseMs < 0 || config.retryBaseMs > 1e4) {
          throw new ConfigError("retryBaseMs must be from 0 to 10000");
        }
        if (config.signatureLimit < 1 || config.signatureLimit > 100) {
          throw new ConfigError("signatureLimit must be from 1 to 100");
        }
        if (config.minCleanSample < 1) {
          throw new ConfigError("minCleanSample must be at least 1");
        }
        if (config.minCleanSample > config.signatureLimit) {
          throw new ConfigError("minCleanSample cannot exceed signatureLimit");
        }
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.programId)) {
          throw new ConfigError("programId must be a base58 address");
        }
      }
      var ConfigError = class extends Error {
        constructor(message) {
          super(message);
          this.name = "ConfigError";
          this.category = "alert";
        }
      };
      module.exports = {
        DEFAULTS,
        PUMP_PROGRAM_ID,
        loadConfig,
        validateConfig,
        ConfigError
      };
    }
  });

  // chain-reader/src/rpc.js
  var require_rpc = __commonJS({
    "chain-reader/src/rpc.js"(exports, module) {
      "use strict";
      var ALLOWED_METHODS = /* @__PURE__ */ new Set([
        "getHealth",
        "getSlot",
        "getSignaturesForAddress",
        "getTransaction"
      ]);
      var RpcError = class extends Error {
        constructor(message, category, details = {}) {
          super(message);
          this.name = "RpcError";
          this.category = category;
          this.details = details;
        }
      };
      function createRpcClient(config, fetchImpl = globalThis.fetch) {
        if (typeof fetchImpl !== "function") {
          throw new RpcError("fetch is not available", "alert");
        }
        return {
          async call(method, params = []) {
            if (!ALLOWED_METHODS.has(method)) {
              throw new RpcError(`method ${method} is not allowed`, "alert", { method });
            }
            return callWithRetry(config, fetchImpl, method, params);
          }
        };
      }
      async function callWithRetry(config, fetchImpl, method, params) {
        let attempt = 0;
        let lastError;
        while (attempt <= config.maxRetries) {
          try {
            return await callOnce(config, fetchImpl, method, params);
          } catch (error) {
            lastError = error;
            if (!(error instanceof RpcError) || error.category !== "retry" || attempt === config.maxRetries) {
              throw error;
            }
            const delay = config.retryBaseMs * 2 ** attempt;
            await sleep(delay);
            attempt += 1;
          }
        }
        throw lastError;
      }
      async function callOnce(config, fetchImpl, method, params) {
        let response;
        try {
          response = await fetchImpl(config.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(config.timeoutMs)
          });
        } catch (error) {
          throw new RpcError(`rpc transport failed: ${redact(error.message)}`, "retry", { method });
        }
        if (response.status === 429 || response.status >= 500) {
          throw new RpcError(`rpc http ${response.status}`, "retry", { method, status: response.status });
        }
        if (!response.ok) {
          throw new RpcError(`rpc http ${response.status}`, "alert", { method, status: response.status });
        }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new RpcError("rpc response was not json", "alert", { method });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new RpcError("rpc response was not an object", "alert", { method });
        }
        if (body.error) {
          const code = body.error.code;
          const category = code === 429 ? "retry" : "alert";
          throw new RpcError(redact(body.error.message || "rpc error"), category, { method, code });
        }
        if (!Object.prototype.hasOwnProperty.call(body, "result")) {
          throw new RpcError("rpc response missing result", "alert", { method });
        }
        return body.result;
      }
      function redact(value) {
        return String(value).replace(/api-key=[^&\s'"]+/gi, "api-key=redacted");
      }
      function sleep(ms) {
        if (ms <= 0) {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          setTimeout(resolve, ms);
        });
      }
      module.exports = {
        ALLOWED_METHODS,
        RpcError,
        createRpcClient,
        redact
      };
    }
  });

  // chain-reader/src/classify.js
  var require_classify = __commonJS({
    "chain-reader/src/classify.js"(exports, module) {
      "use strict";
      function classifyTrade(tx, payer) {
        const blockTime = Number.isInteger(tx && tx.blockTime) ? tx.blockTime : null;
        const meta = tx && tx.meta;
        if (!meta) {
          return { side: "unknown", mint: null, blockTime };
        }
        const index = accountIndex(tx, payer);
        if (index < 0 || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) {
          return { side: "unknown", mint: null, blockTime };
        }
        const solDelta = meta.postBalances[index] - meta.preBalances[index];
        const token = tokenDeltaForOwner(meta, payer);
        if (!token) {
          return { side: "unknown", mint: null, blockTime };
        }
        if (solDelta < 0 && token.delta > 0n) {
          return { side: "buy", mint: token.mint, blockTime };
        }
        if (solDelta > 0 && token.delta < 0n) {
          return { side: "sell", mint: token.mint, blockTime };
        }
        return { side: "unknown", mint: token.mint, blockTime };
      }
      function accountIndex(tx, payer) {
        const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
        if (!Array.isArray(keys)) {
          return -1;
        }
        return keys.findIndex((key) => key === payer || key && key.pubkey === payer);
      }
      function tokenDeltaForOwner(meta, owner) {
        const totals = /* @__PURE__ */ new Map();
        addTokenSide(totals, meta.preTokenBalances, owner, "pre");
        addTokenSide(totals, meta.postTokenBalances, owner, "post");
        let best = null;
        for (const [mint, row] of totals) {
          const delta = row.post - row.pre;
          if (delta === 0n) {
            continue;
          }
          const size = delta < 0n ? -delta : delta;
          if (!best || size > best.size) {
            best = { mint, delta, size };
          }
        }
        return best;
      }
      function addTokenSide(totals, entries, owner, side) {
        if (!Array.isArray(entries)) {
          return;
        }
        for (const entry of entries) {
          if (!entry || entry.owner !== owner || typeof entry.mint !== "string") {
            continue;
          }
          const amount = rawAmount(entry);
          if (amount === null) {
            continue;
          }
          const row = totals.get(entry.mint) || { pre: 0n, post: 0n };
          row[side] += amount;
          totals.set(entry.mint, row);
        }
      }
      function rawAmount(entry) {
        const amount = entry.uiTokenAmount && entry.uiTokenAmount.amount;
        if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
          return null;
        }
        return BigInt(amount);
      }
      module.exports = { classifyTrade };
    }
  });

  // chain-reader/src/discover.js
  var require_discover = __commonJS({
    "chain-reader/src/discover.js"(exports, module) {
      "use strict";
      var { createRpcClient } = require_rpc();
      var { classifyTrade } = require_classify();
      async function discoverRecentWallets(config, options = {}) {
        const client = options.client || createRpcClient(config, options.fetch);
        const limit = options.limit || config.signatureLimit;
        const params = { limit };
        if (options.before) {
          params.before = options.before;
        }
        const signatures = await client.call("getSignaturesForAddress", [config.programId, params]);
        if (!Array.isArray(signatures)) {
          throw Object.assign(new Error("signature list was not an array"), { category: "alert" });
        }
        const counts = /* @__PURE__ */ new Map();
        const trades = [];
        let skipped = 0;
        for (const row of signatures) {
          if (!row || row.err || typeof row.signature !== "string") {
            skipped += 1;
            continue;
          }
          const tx = await client.call("getTransaction", [
            row.signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }
          ]);
          const payer = feePayer(tx);
          if (!payer) {
            skipped += 1;
            continue;
          }
          counts.set(payer, (counts.get(payer) || 0) + 1);
          const trade = classifyTrade(tx, payer);
          trades.push({
            signature: row.signature,
            address: payer,
            side: trade.side,
            mint: trade.mint,
            blockTime: trade.blockTime
          });
        }
        const wallets = [...counts.entries()].map(([address, txCount]) => ({ address, txCount })).sort((a, b) => b.txCount - a.txCount || a.address.localeCompare(b.address));
        const fetched = signatures.length;
        const oldest = signatures.length > 0 ? signatures[signatures.length - 1].signature : null;
        return {
          source: "solana-rpc",
          programId: config.programId,
          fetchedSignatures: fetched,
          skipped,
          sample: fetched >= config.minCleanSample ? "ok" : "insufficient",
          nextCursor: oldest,
          wallets,
          trades
        };
      }
      function feePayer(tx) {
        const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
        if (!Array.isArray(keys) || keys.length === 0) {
          return null;
        }
        const first = keys[0];
        if (typeof first === "string") {
          return first;
        }
        if (first && first.signer === true && typeof first.pubkey === "string") {
          return first.pubkey;
        }
        return null;
      }
      module.exports = {
        discoverRecentWallets,
        feePayer
      };
    }
  });

  // chain-reader/src/helius-key.js
  var require_helius_key = __commonJS({
    "chain-reader/src/helius-key.js"(exports, module) {
      "use strict";
      var RPC_KEY = /^[A-Za-z0-9_-]{8,64}$/;
      var HELIUS_HOSTS = /* @__PURE__ */ new Set(["mainnet.helius-rpc.com", "beta.helius-rpc.com"]);
      function parseHeliusKey(value) {
        const text = String(value || "").trim();
        if (!text) {
          return "";
        }
        if (text.includes("://") || text.startsWith("//")) {
          return keyFromUrl(text);
        }
        if (!RPC_KEY.test(text)) {
          throw badKey();
        }
        return text;
      }
      function keyFromUrl(text) {
        let url;
        try {
          url = new URL(text);
        } catch {
          throw badKey();
        }
        if (url.protocol !== "https:" || !HELIUS_HOSTS.has(url.hostname)) {
          throw badKey();
        }
        const key = url.searchParams.get("api-key") || "";
        if (!RPC_KEY.test(key)) {
          throw badKey();
        }
        return key;
      }
      function badKey() {
        const error = new Error("K\u013E\xFA\u010D m\xE1 zl\xFD tvar. S\xFAkromn\xFD k\u013E\xFA\u010D pe\u0148a\u017Eenky sa neprij\xEDma.");
        error.statusCode = 400;
        return error;
      }
      module.exports = {
        HELIUS_HOSTS,
        RPC_KEY,
        parseHeliusKey
      };
    }
  });

  // chain-reader/src/paper/cycle.js
  var require_cycle = __commonJS({
    "chain-reader/src/paper/cycle.js"(exports, module) {
      "use strict";
      var LIMITS = Object.freeze({
        maxOpenPositions: 3,
        maxOrdersPerDay: 10,
        minTraderSamples: 30,
        maxEventAgeSec: 60,
        paperUnits: 1
      });
      function emptyLedger() {
        return { version: 1, mode: "paper", halted: false, trades: [], orders: [], positions: [] };
      }
      function loadLedger(raw) {
        const source = raw && raw.version === 1 ? raw : emptyLedger();
        return {
          version: 1,
          mode: "paper",
          halted: Boolean(source.halted),
          trades: Array.isArray(source.trades) ? source.trades.map((trade) => ({ ...trade })) : [],
          orders: Array.isArray(source.orders) ? source.orders.map((order) => ({ ...order })) : [],
          positions: Array.isArray(source.positions) ? source.positions.map((position) => ({ ...position })) : []
        };
      }
      function haltLedger(raw) {
        return { ...loadLedger(raw), halted: true };
      }
      function releaseLedger(raw) {
        return { ...loadLedger(raw), halted: false, mode: "paper" };
      }
      function traderLadder(trades) {
        return rankWallets(trades).slice(0, 5).map((row) => ({
          address: row.address,
          classified: row.classified,
          side: row.last ? row.last.side : null,
          mint: row.last ? row.last.mint : null
        }));
      }
      function runCycle(rawLedger, observation, nowSeconds) {
        const ledger = loadLedger(rawLedger);
        ledger.trades = mergeTrades(ledger.trades, observation && observation.trades);
        const best = rankWallets(ledger.trades)[0] || null;
        const analyst = propose(best);
        const skeptic = review(best, nowSeconds);
        const order = skeptic.veto ? null : analyst.order;
        const risk = govern(order, ledger, nowSeconds);
        const executed = apply(risk, ledger, nowSeconds);
        const events = [
          { role: "reader", note: `${Array.isArray(observation && observation.trades) ? observation.trades.length : 0} z\xE1znamov v tomto kole` },
          { role: "analyst", note: analyst.note },
          { role: "skeptic", note: skeptic.note },
          { role: "ceo", note: skeptic.veto ? "veto plat\xED, limity sa nemenia" : "n\xE1vrh ide \u010Falej bez zmeny limitov" },
          { role: "risk", note: risk.note },
          { role: "executor", note: executed.note },
          { role: "notifier", note: executed.note }
        ];
        return { ledger: executed.ledger, events, decision: skeptic.veto ? skeptic.note : executed.note };
      }
      function mergeTrades(existing, incoming) {
        const seen = new Set(existing.map((trade) => trade.signature));
        const trades = existing.map((trade) => ({ ...trade }));
        for (const trade of incoming || []) {
          if (!trade || typeof trade.signature !== "string" || seen.has(trade.signature)) {
            continue;
          }
          seen.add(trade.signature);
          trades.push({ ...trade });
        }
        return trades;
      }
      function rankWallets(trades) {
        const wallets = /* @__PURE__ */ new Map();
        for (const trade of trades) {
          if (!trade || typeof trade.address !== "string") {
            continue;
          }
          const row = wallets.get(trade.address) || { address: trade.address, classified: 0, last: null };
          if (trade.side === "buy" || trade.side === "sell") {
            row.classified += 1;
            if (!row.last || (trade.blockTime || 0) >= (row.last.blockTime || 0)) {
              row.last = trade;
            }
          }
          wallets.set(trade.address, row);
        }
        return [...wallets.values()].sort((a, b) => b.classified - a.classified || a.address.localeCompare(b.address));
      }
      function propose(best) {
        if (!best || best.classified < LIMITS.minTraderSamples || !best.last || !best.last.mint) {
          return { order: null, note: "menej ako 30 \u010Dist\xFDch obchodov jedn\xE9ho obchodn\xEDka" };
        }
        const last = best.last;
        return {
          order: {
            id: `${last.address}:${last.mint}:${last.side}:${last.signature}`,
            wallet: last.address,
            mint: last.mint,
            side: last.side,
            signature: last.signature,
            blockTime: last.blockTime,
            units: LIMITS.paperUnits
          },
          note: `${last.side} po ${best.classified} \u010Dist\xFDch obchodoch`
        };
      }
      function review(best, nowSeconds) {
        if (!best || best.classified < LIMITS.minTraderSamples) {
          return { veto: true, note: "veto: vzorka pod 30" };
        }
        const last = best.last;
        if (!last || last.side !== "buy" && last.side !== "sell" || !last.mint) {
          return { veto: true, note: "veto: smer nie je jasn\xFD" };
        }
        if (!Number.isInteger(last.blockTime) || !Number.isInteger(nowSeconds) || nowSeconds - last.blockTime > LIMITS.maxEventAgeSec) {
          return { veto: true, note: "veto: udalos\u0165 je star\u0161ia ako 60 s" };
        }
        if (nowSeconds < last.blockTime) {
          return { veto: true, note: "veto: \u010Das udalosti je v bud\xFAcnosti" };
        }
        return { veto: false, note: "bez veta" };
      }
      function govern(order, ledger, nowSeconds) {
        if (!order) {
          return { approved: false, order: null, note: "bez pr\xEDkazu" };
        }
        if (ledger.halted) {
          return { approved: false, order: null, note: "kill dr\u017E\xED poz\xEDcie" };
        }
        if (ledger.orders.some((item) => item.id === order.id)) {
          return { approved: false, order: null, note: "pr\xEDkaz u\u017E je zaznamenan\xFD" };
        }
        if (order.side === "buy" && ledger.positions.length >= LIMITS.maxOpenPositions) {
          return { approved: false, order: null, note: "tri paper poz\xEDcie s\xFA pln\xE9" };
        }
        const day = utcDay(nowSeconds);
        const today = ledger.orders.filter((item) => utcDay(item.recordedAt) === day).length;
        if (today >= LIMITS.maxOrdersPerDay) {
          return { approved: false, order: null, note: "denn\xFD strop 10 paper pr\xEDkazov" };
        }
        return { approved: true, order, note: "paper pr\xEDkaz povolen\xFD" };
      }
      function apply(risk, ledger, nowSeconds) {
        if (!risk.approved || !risk.order) {
          return { ledger, note: risk.note };
        }
        const order = { ...risk.order, recordedAt: nowSeconds, mode: "paper" };
        const orders = ledger.orders.concat(order);
        let positions = ledger.positions;
        if (order.side === "buy") {
          positions = positions.concat({
            id: order.id,
            wallet: order.wallet,
            mint: order.mint,
            units: order.units,
            openedAt: nowSeconds
          });
        }
        if (order.side === "sell") {
          const index = positions.findIndex((position) => position.wallet === order.wallet && position.mint === order.mint);
          if (index >= 0) {
            positions = positions.slice(0, index).concat(positions.slice(index + 1));
          }
        }
        return {
          ledger: { ...ledger, mode: "paper", orders, positions },
          note: `paper ${order.side} zaznamenan\xFD`
        };
      }
      function utcDay(seconds) {
        if (!Number.isInteger(seconds)) {
          return "";
        }
        return new Date(seconds * 1e3).toISOString().slice(0, 10);
      }
      module.exports = {
        LIMITS,
        emptyLedger,
        loadLedger,
        haltLedger,
        releaseLedger,
        traderLadder,
        runCycle
      };
    }
  });

  // chain-reader/src/browser-session.js
  var require_browser_session = __commonJS({
    "chain-reader/src/browser-session.js"(exports, module) {
      var { PUMP_PROGRAM_ID } = require_config();
      var { discoverRecentWallets } = require_discover();
      var { parseHeliusKey } = require_helius_key();
      var { LIMITS, emptyLedger, haltLedger, loadLedger, releaseLedger, runCycle, traderLadder } = require_cycle();
      var POLL_CREDITS = 31;
      var USABLE_CREDITS = 95e4;
      var MONTH_MS = 30 * 24 * 60 * 60 * 1e3;
      var PUBLIC_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      var PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      var BOOK_KEY = "elite-desk-book";
      var ROLES = Object.freeze([
        { id: "reader", name: "\u010C\xEDta\u010D", detail: "\u010C\xEDta posledn\xFDch 30 podpisov programu pump a z pohybov zostatkov ur\u010D\xED buy alebo sell." },
        { id: "analyst", name: "Analytik", detail: "N\xE1vrh vznikne a\u017E ke\u010F m\xE1 jedna pe\u0148a\u017Eenka 30 \u010Dist\xFDch obchodov." },
        { id: "skeptic", name: "Skeptik", detail: "Zamietne vzorku pod 30, nejasn\xFD smer a udalos\u0165 star\u0161iu ako 60 sek\xFAnd." },
        { id: "ceo", name: "CEO", detail: "N\xE1vrh posunie \u010Falej. Limity nezmen\xED a veto neprep\xED\u0161e." },
        { id: "risk", name: "Risk governor", detail: "Pust\xED pr\xEDkaz len do 3 otvoren\xFDch poz\xEDci\xED a 10 pr\xEDkazov za UTC de\u0148." },
        { id: "executor", name: "Executor", detail: "Zap\xED\u0161e paper pr\xEDkaz do knihy. Na sie\u0165 ni\u010D neposiela." },
        { id: "notifier", name: "Hl\xE1senie", detail: "Posledn\xFD riadok je na tejto ploche. Telegram zatia\u013E nie je zapojen\xFD." },
        { id: "wallet", name: "Phantom", detail: "Ost\xE1va odpojen\xE1. Live podpis nie je v tomto behu." }
      ]);
      function createBrowserDesk(options = {}) {
        const fetchImpl = options.fetch || globalThis.fetch;
        const storage = options.storage || null;
        const onUpdate = options.onUpdate || (() => {
        });
        const auto = options.auto !== false;
        const usable = options.usableCredits || USABLE_CREDITS;
        let keys = ["", "", ""];
        let projects = ["", "", ""];
        let wallet = null;
        let ledger = loadStored(storage);
        let running = false;
        let timer = null;
        let cursor = 0;
        let generation = 0;
        let last = null;
        let decision = ledger.halted ? "kill dr\u017E\xED poz\xEDcie" : "bez pr\xEDkazu";
        let error = null;
        const used = [0, 0, 0];
        function snapshot() {
          return {
            mode: "paper",
            localLoop: true,
            running,
            keys: keys.map(Boolean),
            projectIds: projects.map(Boolean),
            wallet,
            endpoint: "mainnet.helius-rpc.com",
            last,
            decision,
            halted: ledger.halted,
            error,
            limits: LIMITS,
            config: {
              ok: true,
              signatureLimit: LIMITS.minTraderSamples,
              minCleanSample: LIMITS.minTraderSamples,
              programId: PUMP_PROGRAM_ID
            },
            book: bookOf(ledger),
            roles: ROLES.map((role) => ({
              ...role,
              state: roleState(role.id, running, ledger.halted, wallet),
              detail: role.id === "wallet" && wallet ? `${shortId(wallet)} \xB7 verejn\xE1 adresa, s\xFAkromn\xFD k\u013E\xFA\u010D sa neuklad\xE1` : role.detail
            }))
          };
        }
        function connectRpc(body) {
          if (running) {
            error = "Najprv pauza, potom v\xFDmena RPC.";
            throw fail(error, 409);
          }
          const source = body && typeof body === "object" ? body : {};
          const incoming = [1, 2, 3].map((index) => parseHeliusKey(source[`key${index}`]));
          const nextProjects = [1, 2, 3].map((index) => String(source[`project${index}`] || "").trim());
          for (const project of nextProjects) {
            if (project && !PROJECT_UUID.test(project)) {
              error = "ID projektu m\xE1 by\u0165 UUID.";
              throw fail(error, 400);
            }
          }
          keys = incoming.map((key, index) => key || keys[index] || "");
          projects = nextProjects.map((project, index) => project || projects[index] || "");
          if (!keys.some(Boolean)) {
            error = "Ch\xFDba aspo\u0148 jeden Helius k\u013E\xFA\u010D.";
            throw fail(error, 400);
          }
          error = null;
          return snapshot();
        }
        function connectWallet(body) {
          if (body && body.disconnect) {
            wallet = null;
          } else {
            const address = String(body && body.address ? body.address : "").trim();
            if (!PUBLIC_ADDRESS.test(address)) {
              error = "Povolen\xE1 je len verejn\xE1 adresa. S\xFAkromn\xFD k\u013E\xFA\u010D sa neprij\xEDma.";
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
            error = keys.some(Boolean) ? "Mesa\u010Dn\xFD strop k\u013E\xFA\u010Dov je pln\xFD." : "Ch\xFDba aspo\u0148 jeden Helius k\u013E\xFA\u010D.";
            return snapshot();
          }
          const result = await discoverRecentWallets({
            rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(keys[slot])}`,
            timeoutMs: 2e4,
            maxRetries: 1,
            retryBaseMs: 400,
            signatureLimit: 30,
            minCleanSample: 30,
            programId: PUMP_PROGRAM_ID
          }, { fetch: fetchImpl, limit: 30 });
          if (token !== generation) {
            return null;
          }
          used[slot] += 1 + result.fetchedSignatures;
          const cycle = runCycle(ledger, result, Math.floor(Date.now() / 1e3));
          ledger = cycle.ledger;
          decision = cycle.decision;
          last = {
            sample: result.sample,
            walletCount: Array.isArray(result.wallets) ? result.wallets.length : 0,
            fetchedSignatures: result.fetchedSignatures,
            creditsRemaining: usable - used[slot]
          };
          error = null;
          store(storage, ledger);
          return snapshot();
        }
        function readySlots() {
          return keys.map((key, index) => key && used[index] + POLL_CREDITS <= usable ? index : -1).filter((index) => index >= 0);
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
            error = "RPC nie je pripojen\xE9. Vlo\u017E Helius k\u013E\xFA\u010D v\u013Eavo.";
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
          if (error === "Najprv pauza, potom v\xFDmena RPC.") {
            error = null;
          }
          return snapshot();
        }
        function kill() {
          halt();
          ledger = haltLedger(ledger);
          decision = "kill dr\u017E\xED poz\xEDcie";
          store(storage, ledger);
          return snapshot();
        }
        function release() {
          ledger = releaseLedger(ledger);
          decision = "kill uvo\u013Enen\xFD, poz\xEDcie ost\xE1vaj\xFA";
          store(storage, ledger);
          return snapshot();
        }
        async function handle(path, body) {
          if (path === "/api/rpc") return connectRpc(body);
          if (path === "/api/wallet") return connectWallet(body);
          if (path === "/api/start") return start();
          if (path === "/api/stop") return halt();
          if (path === "/api/kill") return kill();
          if (path === "/api/release") return release();
          throw fail("nezn\xE1ma po\u017Eiadavka", 404);
        }
        return { snapshot, connectRpc, connectWallet, tick, start, halt, kill, release, handle };
      }
      function paceMs(keyCount) {
        const perKey = Math.ceil(POLL_CREDITS * MONTH_MS / USABLE_CREDITS);
        return Math.ceil(perKey / Math.max(1, keyCount));
      }
      function loadStored(storage) {
        if (!storage) {
          return emptyLedger();
        }
        try {
          return loadLedger(JSON.parse(storage.getItem(BOOK_KEY) || "null"));
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
          mode: "paper",
          halted: ledger.halted,
          trades: ledger.trades,
          orders: ledger.orders,
          positions: ledger.positions
        };
        storage.setItem(BOOK_KEY, JSON.stringify(copy));
      }
      function bookOf(ledger) {
        const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        return {
          halted: ledger.halted,
          openPositions: ledger.positions.length,
          ordersToday: ledger.orders.filter((order) => dayOf(order.recordedAt) === day).length,
          ordersTotal: ledger.orders.length,
          trades: ledger.trades.length,
          positions: ledger.positions.slice(-5).map((position) => ({
            wallet: shortId(position.wallet),
            mint: shortId(position.mint),
            units: position.units
          })),
          recentOrders: ledger.orders.slice(-5).map((order) => ({
            side: order.side,
            wallet: shortId(order.wallet),
            mint: shortId(order.mint)
          })),
          ladder: traderLadder(ledger.trades).map((row) => ({
            address: shortId(row.address),
            classified: row.classified,
            need: LIMITS.minTraderSamples,
            side: row.side,
            mint: shortId(row.mint)
          }))
        };
      }
      function roleState(id, running, halted, wallet) {
        if (id === "wallet") {
          return wallet ? "pripojen\xE1" : "nepripojen\xE1";
        }
        if (halted && id === "executor") {
          return "dr\u017E\xED poz\xEDcie";
        }
        return running ? "be\u017E\xED" : "pripraven\xFD";
      }
      function dayOf(seconds) {
        if (!Number.isInteger(seconds)) {
          return "";
        }
        return new Date(seconds * 1e3).toISOString().slice(0, 10);
      }
      function shortId(value) {
        const text = String(value || "");
        if (text.length <= 12) {
          return text;
        }
        return `${text.slice(0, 4)}\u2026${text.slice(-4)}`;
      }
      function redact(value) {
        return String(value).replace(/api-key=[^&\s'"]+/gi, "api-key=redacted");
      }
      function publicRpcError(caught) {
        const message = redact(caught && caught.message ? caught.message : "");
        if (message.includes("401") || message.includes("403")) {
          return "Helius k\u013E\xFA\u010D bol odmietnut\xFD.";
        }
        return message || "\u010D\xEDtanie zlyhalo";
      }
      function fail(message, statusCode) {
        const error = new Error(message);
        error.statusCode = statusCode;
        return error;
      }
      module.exports = {
        createBrowserDesk,
        paceMs
      };
    }
  });
  return require_browser_session();
})();
