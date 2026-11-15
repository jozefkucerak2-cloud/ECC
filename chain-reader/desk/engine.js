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
          return { side: "unknown", mint: null, blockTime, solLamports: null, tokenRaw: null };
        }
        const fee = index === 0 && Number.isInteger(meta.fee) ? meta.fee : 0;
        const solLamports = solDelta < 0 ? Math.max(0, -solDelta - fee) : solDelta + fee;
        const tokenRaw = (token.delta < 0n ? -token.delta : token.delta).toString();
        if (solDelta < 0 && token.delta > 0n) {
          return { side: "buy", mint: token.mint, blockTime, solLamports, tokenRaw };
        }
        if (solDelta > 0 && token.delta < 0n) {
          return { side: "sell", mint: token.mint, blockTime, solLamports, tokenRaw };
        }
        return { side: "unknown", mint: token.mint, blockTime, solLamports, tokenRaw };
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
        const address = options.address || config.programId;
        const seen = new Set(Array.isArray(options.seen) ? options.seen : []);
        const budget = Number.isInteger(options.budget) ? options.budget : 1 + limit;
        const counts = /* @__PURE__ */ new Map();
        const trades = [];
        let skipped = 0;
        let fetched = 0;
        let calls = 0;
        let before = options.before || null;
        let cursor = null;
        for (let page = 0; page < 4 && calls < budget; page += 1) {
          const params = { limit };
          if (before) {
            params.before = before;
          }
          const signatures = await client.call("getSignaturesForAddress", [address, params]);
          calls += 1;
          if (!Array.isArray(signatures)) {
            throw Object.assign(new Error("signature list was not an array"), { category: "alert" });
          }
          fetched += signatures.length;
          cursor = signatures.length > 0 ? signatures[signatures.length - 1].signature : cursor;
          let read = 0;
          for (const row of signatures) {
            if (calls >= budget) {
              break;
            }
            if (!row || row.err || typeof row.signature !== "string" || seen.has(row.signature)) {
              skipped += 1;
              continue;
            }
            const tx = await client.call("getTransaction", [
              row.signature,
              { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }
            ]);
            calls += 1;
            read += 1;
            seen.add(row.signature);
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
              blockTime: trade.blockTime,
              solLamports: trade.solLamports,
              tokenRaw: trade.tokenRaw
            });
          }
          if (read > 0 || signatures.length === 0 || !cursor || cursor === before) {
            break;
          }
          before = cursor;
        }
        const wallets = [...counts.entries()].map(([wallet, txCount]) => ({ address: wallet, txCount })).sort((a, b) => b.txCount - a.txCount || a.address.localeCompare(b.address));
        return {
          source: "solana-rpc",
          programId: config.programId,
          address,
          fetchedSignatures: fetched,
          skipped,
          calls,
          sample: fetched >= config.minCleanSample ? "ok" : "insufficient",
          nextCursor: cursor,
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
        paperUnits: 1,
        stopBps: 1500,
        seenCap: 120
      });
      var PUBLIC_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      function emptyLedger() {
        return {
          version: 2,
          mode: "paper",
          halted: false,
          wallets: {},
          orders: [],
          positions: [],
          credits: { cycleStartedAt: 0, used: [0, 0, 0] },
          notice: "Bez nov\xE9ho paper z\xE1pisu. Telef\xF3n nie je zapojen\xFD."
        };
      }
      function loadLedger(raw) {
        const source = raw && typeof raw === "object" ? raw : emptyLedger();
        const wallets = source.wallets && typeof source.wallets === "object" && !Array.isArray(source.wallets) ? normalizeWallets(source.wallets) : walletsFromTrades(source.trades);
        return {
          version: 2,
          mode: "paper",
          halted: Boolean(source.halted),
          wallets,
          orders: Array.isArray(source.orders) ? source.orders.map((order) => ({ ...order })) : [],
          positions: Array.isArray(source.positions) ? source.positions.map((position) => ({ ...position })) : [],
          credits: normalizeCredits(source.credits),
          notice: typeof source.notice === "string" ? source.notice : emptyLedger().notice
        };
      }
      function normalizeCredits(credits) {
        const used = [0, 1, 2].map((index) => {
          const value = credits && Array.isArray(credits.used) ? Number(credits.used[index]) : 0;
          return Number.isFinite(value) && value > 0 ? value : 0;
        });
        const started = credits && Number.isFinite(Number(credits.cycleStartedAt)) ? Number(credits.cycleStartedAt) : 0;
        return { cycleStartedAt: started > 0 ? started : 0, used };
      }
      function rollCredits(credits, nowMs, monthMs) {
        const current = normalizeCredits(credits);
        if (!current.cycleStartedAt) {
          return { cycleStartedAt: nowMs, used: current.used };
        }
        if (nowMs - current.cycleStartedAt >= monthMs) {
          return { cycleStartedAt: nowMs, used: [0, 0, 0] };
        }
        return current;
      }
      function haltLedger(raw) {
        return { ...loadLedger(raw), halted: true };
      }
      function releaseLedger(raw) {
        return { ...loadLedger(raw), halted: false, mode: "paper" };
      }
      function traderLadder(ledger) {
        return rankWallets(loadLedger(ledger).wallets).slice(0, 5).map((row) => ({
          address: row.address,
          classified: row.classified,
          side: row.last ? row.last.side : null,
          mint: row.last ? row.last.mint : null
        }));
      }
      function focusAddress(raw, nowSeconds) {
        const ledger = loadLedger(raw);
        const rows = rankWallets(ledger.wallets);
        const filling = rows.filter((row) => row.classified < LIMITS.minTraderSamples && row.seen.length < LIMITS.seenCap);
        if (filling.length > 0) {
          return { address: filling[0].address, seen: filling[0].seen.slice() };
        }
        const now = Number.isInteger(nowSeconds) ? nowSeconds : 0;
        const stale = rows.filter((row) => row.classified >= LIMITS.minTraderSamples && tradeAge(row.last, now) > LIMITS.maxEventAgeSec);
        if (stale.length > 0) {
          return { address: stale[0].address, seen: stale[0].seen.slice() };
        }
        return null;
      }
      function runCycle(rawLedger, observation, nowSeconds, account) {
        let ledger = loadLedger(rawLedger);
        const incoming = Array.isArray(observation && observation.trades) ? observation.trades : [];
        ledger = { ...ledger, wallets: incoming.reduce((wallets, trade) => absorb(wallets, trade), ledger.wallets) };
        const best = rankWallets(ledger.wallets)[0] || null;
        const analyst = propose(best);
        const skeptic = review(best, nowSeconds);
        const copy = skeptic.veto ? null : analyst.order;
        const stopped = applyStops(ledger, incoming, nowSeconds);
        ledger = stopped.ledger;
        const risk = govern(copy, ledger, nowSeconds, account);
        const executed = apply(risk, ledger, nowSeconds, account);
        ledger = { ...executed.ledger, notice: noticeFor(stopped.closed, executed) };
        const events = [
          { role: "reader", note: `${incoming.filter((trade) => trade && (trade.side === "buy" || trade.side === "sell")).length} \u010Dist\xFDch v tomto kole` },
          { role: "analyst", note: analyst.note },
          { role: "skeptic", note: skeptic.note },
          { role: "ceo", note: skeptic.veto ? "veto plat\xED, limity sa nemenia" : "n\xE1vrh ide \u010Falej bez zmeny limitov" },
          { role: "risk", note: risk.note },
          { role: "executor", note: executed.note },
          { role: "notifier", note: ledger.notice }
        ];
        const decision = stopped.closed ? "paper stop zatvoril poz\xEDciu v knihe" : skeptic.veto ? skeptic.note : executed.note;
        return { ledger, events, decision };
      }
      function walletsFromTrades(trades) {
        return (Array.isArray(trades) ? trades : []).reduce((wallets, trade) => absorb(wallets, trade), {});
      }
      function normalizeWallets(source) {
        return Object.entries(source).reduce((wallets, [address, row]) => {
          if (!row || typeof row !== "object") {
            return wallets;
          }
          const seen = Array.isArray(row.seen) ? row.seen.filter((item) => typeof item === "string").slice(0, LIMITS.seenCap) : [];
          return {
            ...wallets,
            [address]: {
              classified: seen.length,
              seen,
              last: row.last && typeof row.last === "object" ? { ...row.last } : null
            }
          };
        }, {});
      }
      function absorb(wallets, trade) {
        if (!trade || typeof trade.address !== "string" || typeof trade.signature !== "string") {
          return wallets;
        }
        if (trade.side !== "buy" && trade.side !== "sell") {
          return wallets;
        }
        const prior = wallets[trade.address] || { classified: 0, seen: [], last: null };
        if (prior.seen.includes(trade.signature)) {
          return wallets;
        }
        const seen = prior.seen.length >= LIMITS.seenCap ? prior.seen.slice(prior.seen.length - LIMITS.seenCap + 1).concat(trade.signature) : prior.seen.concat(trade.signature);
        const last = !prior.last || (trade.blockTime || 0) >= (prior.last.blockTime || 0) ? compactTrade(trade) : prior.last;
        return {
          ...wallets,
          [trade.address]: { classified: Math.max(prior.classified, seen.length), seen, last }
        };
      }
      function compactTrade(trade) {
        return {
          signature: trade.signature,
          address: trade.address,
          side: trade.side,
          mint: trade.mint,
          blockTime: trade.blockTime,
          solLamports: Number.isFinite(trade.solLamports) ? trade.solLamports : null,
          tokenRaw: typeof trade.tokenRaw === "string" ? trade.tokenRaw : null
        };
      }
      function rankWallets(wallets) {
        return Object.entries(wallets).map(([address, row]) => ({
          address,
          classified: row.classified,
          seen: row.seen,
          last: row.last
        })).sort((a, b) => b.classified - a.classified || a.address.localeCompare(b.address));
      }
      function propose(best) {
        if (!best || best.classified < LIMITS.minTraderSamples || !best.last || !best.last.mint) {
          return { order: null, note: "menej ako 30 \u010Dist\xFDch obchodov jedn\xE9ho obchodn\xEDka" };
        }
        const last = best.last;
        const entryPrice = priceOf(last);
        const stopPrice = entryPrice == null ? null : entryPrice * (1e4 - LIMITS.stopBps) / 1e4;
        return {
          order: {
            source: last.address,
            mint: last.mint,
            side: last.side,
            signature: last.signature,
            blockTime: last.blockTime,
            units: LIMITS.paperUnits,
            entryPrice,
            stopPrice
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
        if (tradeAge(last, nowSeconds) > LIMITS.maxEventAgeSec) {
          return { veto: true, note: "veto: udalos\u0165 je star\u0161ia ako 60 s" };
        }
        if (Number.isInteger(last.blockTime) && Number.isInteger(nowSeconds) && nowSeconds < last.blockTime) {
          return { veto: true, note: "veto: \u010Das udalosti je v bud\xFAcnosti" };
        }
        return { veto: false, note: "bez veta" };
      }
      function tradeAge(last, nowSeconds) {
        if (!last || !Number.isInteger(last.blockTime) || !Number.isInteger(nowSeconds)) {
          return Number.POSITIVE_INFINITY;
        }
        return nowSeconds - last.blockTime;
      }
      function govern(order, ledger, nowSeconds, account) {
        if (!order) {
          return { approved: false, order: null, note: "bez pr\xEDkazu" };
        }
        if (!PUBLIC_ADDRESS.test(String(account || ""))) {
          return { approved: false, order: null, note: "pripoj verejn\xFA adresu" };
        }
        if (ledger.halted) {
          return { approved: false, order: null, note: "kill dr\u017E\xED poz\xEDcie" };
        }
        const id = orderId(account, order);
        if (ledger.orders.some((item) => item.id === id)) {
          return { approved: false, order: null, note: "pr\xEDkaz u\u017E je zaznamenan\xFD" };
        }
        if (order.side === "sell" && !matchingPosition(ledger.positions, account, order)) {
          return { approved: false, order: null, note: "bez otvorenej poz\xEDcie" };
        }
        if (order.side === "buy" && ledger.positions.length >= LIMITS.maxOpenPositions) {
          return { approved: false, order: null, note: "tri paper poz\xEDcie s\xFA pln\xE9" };
        }
        const day = utcDay(nowSeconds);
        const today = ledger.orders.filter((item) => item.side !== "stop" && utcDay(item.recordedAt) === day).length;
        if (today >= LIMITS.maxOrdersPerDay) {
          return { approved: false, order: null, note: "denn\xFD strop 10 paper pr\xEDkazov" };
        }
        return { approved: true, order: { ...order, id, account }, note: "paper pr\xEDkaz povolen\xFD" };
      }
      function apply(risk, ledger, nowSeconds) {
        if (!risk.approved || !risk.order) {
          return { ledger, note: risk.note, opened: false };
        }
        const order = { ...risk.order, recordedAt: nowSeconds, mode: "paper" };
        const orders = ledger.orders.concat(order);
        let positions = ledger.positions;
        if (order.side === "buy") {
          positions = positions.concat({
            id: order.id,
            account: order.account,
            source: order.source,
            mint: order.mint,
            units: order.units,
            entryPrice: order.entryPrice,
            stopPrice: order.stopPrice,
            openedAt: nowSeconds
          });
        }
        if (order.side === "sell") {
          const index = positions.findIndex((position) => matchingPosition([position], order.account, order));
          if (index >= 0) {
            positions = positions.slice(0, index).concat(positions.slice(index + 1));
          }
        }
        return {
          ledger: { ...ledger, mode: "paper", orders, positions },
          note: `paper ${order.side} zaznamenan\xFD`,
          opened: order.side === "buy"
        };
      }
      function applyStops(ledger, trades, nowSeconds) {
        let positions = ledger.positions;
        let orders = ledger.orders;
        let closed = false;
        for (const trade of trades) {
          const price = priceOf(trade);
          if (price == null || typeof trade.mint !== "string") {
            continue;
          }
          const hitting = positions.filter((position) => position.mint === trade.mint && position.stopPrice != null && price <= position.stopPrice);
          if (hitting.length === 0) {
            continue;
          }
          closed = true;
          const ids = new Set(hitting.map((position) => position.id));
          positions = positions.filter((position) => !ids.has(position.id));
          orders = orders.concat(hitting.map((position) => ({
            id: `stop:${position.id}:${trade.signature}`,
            account: position.account,
            source: position.source,
            mint: position.mint,
            side: "stop",
            signature: trade.signature,
            recordedAt: nowSeconds,
            mode: "paper"
          })));
        }
        return { ledger: { ...ledger, positions, orders }, closed };
      }
      function noticeFor(closed, executed) {
        if (closed) {
          return "Stop zatvoril paper poz\xEDciu v knihe. Na sie\u0165 ni\u010D ne\u0161lo. Telef\xF3n nie je zapojen\xFD.";
        }
        if (executed.opened) {
          return "Paper buy je na na\u0161ej adrese. Stop je 15 % pod vstupom. Telef\xF3n nie je zapojen\xFD.";
        }
        return "Bez nov\xE9ho paper z\xE1pisu. Telef\xF3n nie je zapojen\xFD.";
      }
      function matchingPosition(positions, account, order) {
        return positions.some((position) => position.account === account && position.source === order.source && position.mint === order.mint);
      }
      function orderId(account, order) {
        return `${account}:${order.source}:${order.mint}:${order.side}:${order.signature}`;
      }
      function priceOf(trade) {
        const sol = Number(trade && trade.solLamports);
        const tokens = Number(trade && trade.tokenRaw);
        if (!Number.isFinite(sol) || !Number.isFinite(tokens) || sol <= 0 || tokens <= 0) {
          return null;
        }
        return sol / tokens;
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
        rollCredits,
        haltLedger,
        releaseLedger,
        traderLadder,
        focusAddress,
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
      var { LIMITS, emptyLedger, focusAddress, haltLedger, loadLedger, releaseLedger, rollCredits, runCycle, traderLadder } = require_cycle();
      var POLL_CREDITS = 31;
      var USABLE_CREDITS = 95e4;
      var MONTH_MS = 30 * 24 * 60 * 60 * 1e3;
      var PUBLIC_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      var PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      var BOOK_KEY = "elite-desk-book";
      var ROLES = Object.freeze([
        { id: "reader", name: "\u010C\xEDta\u010D", detail: "Najprv \u0161pi\u010Dka programu, potom vlastn\xE9 podpisy pe\u0148a\u017Eenky, ktor\xE1 e\u0161te nem\xE1 30 \u010Dist\xFDch obchodov. Jedno kolo m\xE1 strop 31 volan\xED." },
        { id: "analyst", name: "Analytik", detail: "N\xE1vrh vznikne a\u017E ke\u010F m\xE1 jedna pe\u0148a\u017Eenka 30 \u010Dist\xFDch obchodov." },
        { id: "skeptic", name: "Skeptik", detail: "Zamietne vzorku pod 30, nejasn\xFD smer a udalos\u0165 star\u0161iu ako 60 sek\xFAnd." },
        { id: "ceo", name: "CEO", detail: "N\xE1vrh posunie \u010Falej. Limity nezmen\xED a veto neprep\xED\u0161e." },
        { id: "risk", name: "Risk governor", detail: "Pust\xED pr\xEDkaz len na pripojen\xFA verejn\xFA adresu, do 3 poz\xEDci\xED a 10 pr\xEDkazov za de\u0148. Stop je 15 % pod vstupom." },
        { id: "executor", name: "Executor", detail: "Zap\xED\u0161e paper pr\xEDkaz na na\u0161u verejn\xFA adresu. Na sie\u0165 ni\u010D neposiela." },
        { id: "notifier", name: "Hl\xE1senie", detail: "Samostatn\xFD riadok na tejto ploche. Telef\xF3n sa zapoj\xED a\u017E po zvolen\xED kan\xE1la." },
        { id: "wallet", name: "Phantom", detail: "Ost\xE1va odpojen\xE1. Live podpis nie je v tomto behu." }
      ]);
      function createBrowserDesk(options = {}) {
        const fetchImpl = options.fetch || globalThis.fetch;
        const storage = options.storage || null;
        const onUpdate = options.onUpdate || (() => {
        });
        const auto = options.auto !== false;
        const usable = options.usableCredits ?? USABLE_CREDITS;
        const now = options.now || Date.now;
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
        let used = ledger.credits.used.slice();
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
            notice: ledger.notice,
            credits: creditRows(),
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
              detail: roleDetail(role)
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
        function roleDetail(role) {
          if (role.id === "wallet" && wallet) {
            return `${shortId(wallet)} \xB7 verejn\xE1 adresa, s\xFAkromn\xFD k\u013E\xFA\u010D sa neuklad\xE1`;
          }
          if (role.id === "notifier") {
            return ledger.notice;
          }
          return role.detail;
        }
        function creditRows() {
          return [0, 1, 2].map((index) => ({
            slot: index + 1,
            present: Boolean(keys[index]),
            remaining: keys[index] ? Math.max(0, usable - used[index]) : null
          }));
        }
        function remember(slot, calls) {
          const next = used.slice();
          next[slot] += calls;
          used = next;
          ledger = {
            ...ledger,
            credits: { ...ledger.credits, used: next }
          };
          store(storage, ledger);
        }
        async function tick(token = generation) {
          if (token !== generation) {
            return null;
          }
          ledger = { ...ledger, credits: rollCredits(ledger.credits, now(), MONTH_MS) };
          used = ledger.credits.used.slice();
          const tried = /* @__PURE__ */ new Set();
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
              const focus = focusAddress(ledger, Math.floor(now() / 1e3));
              const result = await discoverRecentWallets({
                rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(keys[slot])}`,
                timeoutMs: 2e4,
                maxRetries: 0,
                retryBaseMs: 0,
                signatureLimit: 30,
                minCleanSample: 30,
                programId: PUMP_PROGRAM_ID
              }, {
                fetch: async (url, init) => {
                  calls += 1;
                  const response = await fetchImpl(url, init);
                  if (response && response.status === 429) {
                    const error2 = new Error("rpc http 429");
                    error2.statusCode = 429;
                    throw error2;
                  }
                  return response;
                },
                limit: 30,
                budget: POLL_CREDITS,
                address: focus ? focus.address : void 0,
                seen: focus ? focus.seen : []
              });
              remember(slot, calls);
              if (token !== generation) {
                return null;
              }
              const cycle = runCycle(ledger, result, Math.floor(now() / 1e3), wallet);
              ledger = { ...cycle.ledger, credits: ledger.credits };
              decision = cycle.decision;
              last = {
                sample: result.sample,
                walletCount: Array.isArray(result.wallets) ? result.wallets.length : 0,
                fetchedSignatures: result.fetchedSignatures,
                creditsRemaining: usable - used[slot],
                focus: focus ? "pe\u0148a\u017Eenka" : "program"
              };
              error = null;
              store(storage, ledger);
              return snapshot();
            } catch (caught) {
              remember(slot, calls || 1);
              if (token !== generation) {
                return null;
              }
              if (caught && (caught.statusCode === 429 || String(caught.message || "").includes("429"))) {
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
            error = "Ch\xFDba aspo\u0148 jeden Helius k\u013E\xFA\u010D.";
          } else if (readySlots(/* @__PURE__ */ new Set()).length === 0) {
            running = false;
            error = "Mesa\u010Dn\xFD strop k\u013E\xFA\u010Dov je pln\xFD.";
          } else if (limited) {
            error = "Helius obmedzil tempo. \u010Eal\u0161\xED k\u013E\xFA\u010D pr\xEDde v \u010Fal\u0161om kole.";
          }
          store(storage, ledger);
          return snapshot();
        }
        function readySlots(skip) {
          return keys.map((key, index) => key && !skip.has(index) && used[index] + POLL_CREDITS <= usable ? index : -1).filter((index) => index >= 0);
        }
        function pickSlot(skip = /* @__PURE__ */ new Set()) {
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
              schedule(paceMs(Math.max(1, readySlots(/* @__PURE__ */ new Set()).length)), token);
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
          wallets: ledger.wallets,
          orders: ledger.orders,
          positions: ledger.positions,
          credits: ledger.credits,
          notice: ledger.notice
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
          trades: Object.values(ledger.wallets).reduce((sum, row) => sum + row.classified, 0),
          positions: ledger.positions.slice(-5).map((position) => ({
            wallet: shortId(position.account || position.wallet),
            account: shortId(position.account),
            source: shortId(position.source),
            mint: shortId(position.mint),
            units: position.units,
            stop: position.stopPrice == null ? null : position.stopPrice
          })),
          recentOrders: ledger.orders.slice(-5).map((order) => ({
            side: order.side,
            wallet: shortId(order.account || order.wallet),
            source: shortId(order.source),
            mint: shortId(order.mint)
          })),
          ladder: traderLadder(ledger).map((row) => ({
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
