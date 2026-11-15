'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ConfigError } = require('./config');
const { createRpcClient, RpcError, redact } = require('./rpc');
const { discoverRecentWallets } = require('./discover');

const HELIUS_RPC_ORIGIN = 'https://mainnet.helius-rpc.com/';
const MONTHLY_CREDITS = 1_000_000;
const CYCLE_DAYS = 30;
const RESERVE_RATIO = 0.05;
// https://www.helius.dev/docs/billing/credits (read 2026-11-15):
// standard RPC, getSignaturesForAddress and getTransaction are 1 credit.
const CREDIT_COSTS = Object.freeze({
  getHealth: 1,
  getSlot: 1,
  getSignaturesForAddress: 1,
  getTransaction: 1,
});

function loadHeliusKeys(env = process.env) {
  return loadHeliusAccounts(env).map((account) => account.secret);
}

function loadHeliusAccounts(env = process.env) {
  const numbered = [1, 2, 3].flatMap((index) => {
    const secret = env[`HELIUS_API_KEY_${index}`];
    if (secret === undefined || secret === '') {
      return [];
    }
    return [{ secret: secret.trim(), projectId: readProjectId(env[`HELIUS_PROJECT_ID_${index}`], index) }];
  });
  const extra = env.HELIUS_API_KEYS
    ? env.HELIUS_API_KEYS.split(',').map((value) => value.trim()).filter(Boolean).map((secret) => ({
      secret,
      projectId: null,
    }))
    : [];
  const seen = new Set();
  const accounts = [];
  for (const account of [...numbered, ...extra]) {
    if (seen.has(account.secret)) {
      continue;
    }
    seen.add(account.secret);
    if (account.secret.length < 8 || /\s/.test(account.secret)) {
      throw new ConfigError('Helius API key is invalid');
    }
    accounts.push(account);
  }
  if (accounts.length > 3) {
    throw new ConfigError('at most 3 Helius API keys');
  }
  return accounts;
}

function readProjectId(raw, index) {
  if (raw === undefined || raw === '') {
    return null;
  }
  const value = raw.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ConfigError(`HELIUS_PROJECT_ID_${index} must be a UUID`);
  }
  return value;
}

function createHeliusPool(env = process.env, options = {}) {
  const accounts = loadHeliusAccounts(env);
  const secrets = accounts.map((account) => account.secret);
  if (secrets.length === 0) {
    throw new ConfigError('set HELIUS_API_KEY_1, HELIUS_API_KEY_2 and HELIUS_API_KEY_3');
  }
  const now = options.now || Date.now;
  const fetchImpl = options.fetch;
  const usagePath = options.usagePath || null;
  const signatureLimit = options.signatureLimit || 30;
  const minCleanSample = options.minCleanSample || 30;
  const programId = options.programId || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const usable = Math.floor(MONTHLY_CREDITS * (1 - RESERVE_RATIO));
  const refillPerMs = usable / (CYCLE_DAYS * 24 * 60 * 60 * 1000);
  const burst = CREDIT_COSTS.getSignaturesForAddress + (signatureLimit * CREDIT_COSTS.getTransaction);
  const saved = usagePath ? readLedger(usagePath) : {};
  const keys = accounts.map((account, index) => restoreKey({
    secret: account.secret,
    projectId: account.projectId,
    label: `key-${index + 1}`,
    saved: saved[fingerprint(account.secret)],
    now: now(),
    burst,
    fetchImpl,
    timeoutMs: options.timeoutMs || 10_000,
  }));

  function persist() {
    if (!usagePath) {
      return;
    }
    const body = { version: 1, keys: {} };
    for (const key of keys) {
      body.keys[key.id] = {
        creditsUsed: key.creditsUsed,
        calls: key.calls,
        rateLimits: key.rateLimits,
        tokens: key.tokens,
        updatedAt: key.updatedAt,
        cycleStartedAt: key.cycleStartedAt,
        usageSource: key.usageSource,
        rpcRequests: key.rpcRequests,
        officialRemaining: key.officialRemaining,
        cycleStart: key.cycleStart,
        cycleEnd: key.cycleEnd,
      };
    }
    fs.mkdirSync(path.dirname(usagePath), { recursive: true });
    const temporary = `${usagePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(body));
    fs.renameSync(temporary, usagePath);
  }

  function refill(key, at) {
    const cycleMs = CYCLE_DAYS * 24 * 60 * 60 * 1000;
    if (at - key.cycleStartedAt >= cycleMs) {
      key.creditsUsed = 0;
      key.calls = 0;
      key.rateLimits = 0;
      key.tokens = burst;
      key.cycleStartedAt = at;
      key.updatedAt = at;
      return;
    }
    const elapsed = Math.max(0, at - key.updatedAt);
    key.tokens = Math.min(burst, key.tokens + (elapsed * refillPerMs));
    key.updatedAt = at;
  }

  function pollCost() {
    return CREDIT_COSTS.getSignaturesForAddress + (signatureLimit * CREDIT_COSTS.getTransaction);
  }

  function msUntilCost(cost) {
    const at = now();
    let soonest = Infinity;
    for (const key of keys) {
      refill(key, at);
      if (key.creditsUsed + cost > MONTHLY_CREDITS) {
        const cycleMs = CYCLE_DAYS * 24 * 60 * 60 * 1000;
        soonest = Math.min(soonest, key.cycleStartedAt + cycleMs - at);
        continue;
      }
      if (key.cooldownUntil > at) {
        soonest = Math.min(soonest, key.cooldownUntil - at);
        continue;
      }
      if (key.tokens >= cost) {
        return 0;
      }
      soonest = Math.min(soonest, Math.ceil((cost - key.tokens) / refillPerMs));
    }
    return soonest === Infinity ? 0 : soonest;
  }

  function msUntil(method) {
    return msUntilCost(creditCost(method));
  }

  async function call(method, params = []) {
    const cost = creditCost(method);
    const at = now();
    let lastError = null;
    for (let attempt = 0; attempt < keys.length; attempt += 1) {
      const key = pickKey(keys, cost, at, refill);
      if (!key) {
        break;
      }
      try {
        const result = await key.client.call(method, params);
        spend(key, cost);
        persist();
        return result;
      } catch (error) {
        lastError = scrub(error, secrets);
        const status = error.details && error.details.status;
        if (error instanceof RpcError && error.category === 'retry' && status === 429) {
          spend(key, cost);
          key.rateLimits += 1;
          key.cooldownUntil = at + 1000;
          persist();
          continue;
        }
        throw lastError;
      }
    }
    const waitMs = msUntil(method);
    const exhausted = keys.every((key) => key.creditsUsed + cost > MONTHLY_CREDITS);
    throw lastError || new RpcError(
      exhausted ? 'helius monthly credit budget is exhausted' : 'helius credit pace is waiting',
      exhausted ? 'safe mode' : 'retry',
      { method, waitMs },
    );
  }

  return {
    call,
    msUntil,
    msUntilPoll() {
      return msUntilCost(pollCost());
    },
    async discover(discoverOptions = {}) {
      const cost = pollCost();
      const waitMs = msUntilCost(cost);
      if (waitMs > 0) {
        const exhausted = keys.every((key) => key.creditsUsed + cost > MONTHLY_CREDITS);
        throw new RpcError(
          exhausted ? 'helius monthly credit budget is exhausted' : 'helius credit pace is waiting',
          exhausted ? 'safe mode' : 'retry',
          { method: 'discover', waitMs },
        );
      }
      const found = await discoverRecentWallets(
        {
          programId: discoverOptions.programId || programId,
          signatureLimit,
          minCleanSample: discoverOptions.minCleanSample || minCleanSample,
        },
        {
          client: { call },
          limit: signatureLimit,
          before: discoverOptions.before,
          address: discoverOptions.address,
          seen: discoverOptions.seen,
          budget: pollCost(),
        },
      );
      return { ...found, usage: statusOf(keys, now(), refill) };
    },
    status() {
      const at = now();
      return statusOf(keys, at, refill);
    },
    async refreshUsage() {
      const rows = [];
      for (const key of keys) {
        rows.push(await refreshKey(key, fetchImpl));
      }
      persist();
      return rows;
    },
  };
}

function spend(key, cost) {
  key.tokens -= cost;
  key.creditsUsed += cost;
  key.calls += 1;
}

function creditCost(method) {
  const cost = CREDIT_COSTS[method];
  if (!cost) {
    throw new RpcError(`method ${method} is not allowed`, 'alert', { method });
  }
  return cost;
}

function pickKey(keys, cost, at, refill) {
  for (const key of keys) {
    refill(key, at);
    if (key.cooldownUntil > at) {
      continue;
    }
    if (key.creditsUsed + cost > MONTHLY_CREDITS) {
      continue;
    }
    if (key.tokens >= cost) {
      return key;
    }
  }
  return null;
}

function statusOf(keys, at, refill) {
  const rows = keys.map((key) => {
    refill(key, at);
    return {
      label: key.label,
      id: key.id,
      calls: key.calls,
      rateLimits: key.rateLimits,
      creditsUsed: Math.round(key.creditsUsed),
      creditsRemaining: Number.isFinite(key.officialRemaining)
        ? key.officialRemaining
        : Math.max(0, MONTHLY_CREDITS - Math.round(key.creditsUsed)),
      rpcRequests: key.rpcRequests,
      usageSource: key.usageSource || 'local',
      cooldownMs: Math.max(0, key.cooldownUntil - at),
    };
  });
  return {
    plan: 'helius-free',
    monthlyCreditsPerKey: MONTHLY_CREDITS,
    cycleDays: CYCLE_DAYS,
    keys: rows,
    totals: {
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      creditsUsed: rows.reduce((sum, row) => sum + row.creditsUsed, 0),
      creditsRemaining: rows.reduce((sum, row) => sum + row.creditsRemaining, 0),
    },
  };
}

function restoreKey({ secret, projectId, label, saved, now, burst, fetchImpl, timeoutMs }) {
  return {
    id: fingerprint(secret),
    label,
    secret,
    projectId: projectId || null,
    client: createRpcClient({
      rpcUrl: `${HELIUS_RPC_ORIGIN}?api-key=${encodeURIComponent(secret)}`,
      timeoutMs,
      maxRetries: 0,
      retryBaseMs: 0,
    }, fetchImpl),
    creditsUsed: saved ? saved.creditsUsed : 0,
    calls: saved ? saved.calls : 0,
    rateLimits: saved ? saved.rateLimits : 0,
    tokens: saved && Number.isFinite(saved.tokens) ? Math.min(burst, saved.tokens) : burst,
    updatedAt: saved && saved.updatedAt ? saved.updatedAt : now,
    cycleStartedAt: saved && saved.cycleStartedAt ? saved.cycleStartedAt : now,
    usageSource: saved && saved.usageSource ? saved.usageSource : 'local',
    rpcRequests: saved && Number.isFinite(saved.rpcRequests) ? saved.rpcRequests : null,
    officialRemaining: saved && Number.isFinite(saved.officialRemaining) ? saved.officialRemaining : null,
    cycleStart: saved && saved.cycleStart ? saved.cycleStart : null,
    cycleEnd: saved && saved.cycleEnd ? saved.cycleEnd : null,
    cooldownUntil: 0,
  };
}

async function refreshKey(key, fetchImpl) {
  if (!key.projectId) {
    return { label: key.label, source: 'local' };
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await fetchFn(`https://admin-api.helius.xyz/v0/admin/projects/${key.projectId}/usage`, {
      method: 'GET',
      headers: { 'X-Api-Key': key.secret },
    });
  } catch {
    key.usageSource = 'local';
    return { label: key.label, source: 'local', error: 'transport' };
  }
  if (!response.ok) {
    key.usageSource = 'local';
    return { label: key.label, source: 'local', error: `http-${response.status}` };
  }
  const body = await response.json();
  if (!body || !Number.isFinite(body.creditsUsed) || !Number.isFinite(body.creditsRemaining)) {
    key.usageSource = 'local';
    return { label: key.label, source: 'local', error: 'shape' };
  }
  key.creditsUsed = body.creditsUsed;
  key.officialRemaining = body.creditsRemaining;
  key.rpcRequests = body.requests && Number.isFinite(body.requests.rpc) ? body.requests.rpc : null;
  key.cycleStart = body.creditCycle && typeof body.creditCycle.start === 'string' ? body.creditCycle.start : null;
  key.cycleEnd = body.creditCycle && typeof body.creditCycle.end === 'string' ? body.creditCycle.end : null;
  key.usageSource = 'helius';
  return {
    label: key.label,
    source: 'helius',
    creditsUsed: key.creditsUsed,
    creditsRemaining: key.officialRemaining,
    rpcRequests: key.rpcRequests,
  };
}

function fingerprint(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function readLedger(usagePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    return parsed.keys || {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function scrub(error, secrets) {
  const message = secrets.reduce(
    (text, secret) => text.split(secret).join('[redacted]'),
    redact(error.message),
  );
  if (message === error.message) {
    return error;
  }
  const cleaned = new RpcError(message, error.category || 'alert', error.details || {});
  return cleaned;
}

async function watchPool(pool, options = {}) {
  const signal = options.signal || { aborted: false };
  const sleep = options.sleep || ((ms, current) => cancellableSleep(ms, current || signal));
  while (!signal.aborted) {
    if (typeof pool.refreshUsage === 'function') {
      await pool.refreshUsage();
    }
    if (signal.aborted) {
      break;
    }
    const wait = pool.msUntilPoll ? pool.msUntilPoll() : pool.msUntil('getSignaturesForAddress');
    if (wait > 0) {
      await sleep(wait, signal);
      continue;
    }
    try {
      const extra = typeof options.discoverOptions === 'function' ? options.discoverOptions() : {};
      const result = await pool.discover(extra || {});
      if (signal.aborted) {
        break;
      }
      if (options.onResult) {
        options.onResult(result);
      }
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      if (error.category !== 'safe mode' && error.category !== 'retry') {
        throw error;
      }
      const waitMs = error.details && error.details.waitMs;
      await sleep(waitMs > 0 ? waitMs : 1000, signal);
    }
  }
}

function cancellableSleep(ms, signal) {
  if (!ms || ms <= 0 || (signal && signal.aborted)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', finish);
      }
      resolve();
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', finish, { once: true });
    }
  });
}

module.exports = {
  CREDIT_COSTS,
  MONTHLY_CREDITS,
  CYCLE_DAYS,
  loadHeliusKeys,
  createHeliusPool,
  watchPool,
};
