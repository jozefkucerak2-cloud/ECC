'use strict';

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const DEFAULTS = Object.freeze({
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  timeoutMs: 10_000,
  maxRetries: 2,
  retryBaseMs: 400,
  signatureLimit: 25,
  minCleanSample: 30,
  programId: PUMP_PROGRAM_ID,
});

function readNumber(raw, fallback, name) {
  if (raw === undefined || raw === '') {
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
    timeoutMs: readNumber(env.ELITE_RPC_TIMEOUT_MS, DEFAULTS.timeoutMs, 'ELITE_RPC_TIMEOUT_MS'),
    maxRetries: readNumber(env.ELITE_RPC_MAX_RETRIES, DEFAULTS.maxRetries, 'ELITE_RPC_MAX_RETRIES'),
    retryBaseMs: readNumber(env.ELITE_RPC_RETRY_BASE_MS, DEFAULTS.retryBaseMs, 'ELITE_RPC_RETRY_BASE_MS'),
    signatureLimit: readNumber(env.ELITE_SIGNATURE_LIMIT, DEFAULTS.signatureLimit, 'ELITE_SIGNATURE_LIMIT'),
    minCleanSample: readNumber(env.ELITE_MIN_CLEAN_SAMPLE, DEFAULTS.minCleanSample, 'ELITE_MIN_CLEAN_SAMPLE'),
    programId: env.ELITE_PROGRAM_ID || DEFAULTS.programId,
  };
  validateConfig(config);
  return Object.freeze(config);
}

function validateConfig(config) {
  let url;
  try {
    url = new URL(config.rpcUrl);
  } catch {
    throw new ConfigError('rpcUrl must be an http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('rpcUrl must be an http(s) URL');
  }
  if (config.timeoutMs < 1 || config.timeoutMs > 60_000) {
    throw new ConfigError('timeoutMs must be from 1 to 60000');
  }
  if (config.maxRetries < 0 || config.maxRetries > 5) {
    throw new ConfigError('maxRetries must be from 0 to 5');
  }
  if (config.retryBaseMs < 0 || config.retryBaseMs > 10_000) {
    throw new ConfigError('retryBaseMs must be from 0 to 10000');
  }
  if (config.signatureLimit < 1 || config.signatureLimit > 100) {
    throw new ConfigError('signatureLimit must be from 1 to 100');
  }
  if (config.minCleanSample < 1) {
    throw new ConfigError('minCleanSample must be at least 1');
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.programId)) {
    throw new ConfigError('programId must be a base58 address');
  }
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.category = 'alert';
  }
}

module.exports = {
  DEFAULTS,
  PUMP_PROGRAM_ID,
  loadConfig,
  validateConfig,
  ConfigError,
};
